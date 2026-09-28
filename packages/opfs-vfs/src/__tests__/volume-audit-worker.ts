import { OpenFlags, OpfsVfs, type OpfsVfsOptions } from '../opfs-vfs';
import { deleteVolume } from '../volume-files';

const opts: OpfsVfsOptions = { bufferMode: 'disk', noatime: true };
const fresh: OpfsVfsOptions = { ...opts, openMode: 'create-new' };
const volumes: string[] = [];
const unique = () => {
  const name = `volume-audit-${crypto.randomUUID()}.bin`;
  volumes.push(name);
  return name;
};
function check(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

async function contents(name: string) {
  const root = await navigator.storage.getDirectory();
  const files: Record<string, number[]> = {};
  for await (const [key, handle] of root.entries()) {
    if (key.startsWith(name.slice(0, -4) + '.') && handle.kind === 'file') {
      files[key] = [...new Uint8Array(await (await (handle as FileSystemFileHandle).getFile()).arrayBuffer())];
    }
  }
  return JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

async function make(name: string, data = 42) {
  const vfs = new OpfsVfs(name, opts);
  await vfs.ready;
  const fd = vfs.openSync('/file', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
  vfs.writeSync(fd, new Uint8Array([data]));
  vfs.closeSync(fd);
  void vfs.closeVfs();
}

async function expectFailure(promise: Promise<unknown>, code?: string) {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  check(error instanceof Error, 'operation must reject');
  if (code) check((error as { code?: string }).code === code, `expected ${code}, got ${String(error)}`);
}

async function mountedDelete() {
  const name = unique();
  await make(name);
  const before = await contents(name);
  const vfs = new OpfsVfs(name, opts);
  await vfs.ready;
  try {
    const mountedBefore = await contents(name);
    await expectFailure(deleteVolume(name));
    check((await contents(name)) === mountedBefore, 'locked delete preserved all component bytes');
  } finally {
    void vfs.closeVfs();
  }
  // close checkpoints can alter snapshot bytes; deletion must leave all files
  // and user contents intact, so compare before closing on a second attempt.
  const after = await contents(name);
  check(JSON.parse(after).length === JSON.parse(before).length, 'locked delete retained every component');
  const reopened = new OpfsVfs(name, opts);
  await reopened.ready;
  const fd = reopened.openSync('/file');
  check(reopened.readSync(fd, 1).buffer[0] === 42, 'locked delete retained contents');
  void reopened.closeVfs();
  await deleteVolume(name);
  await deleteVolume(name);
  check((await contents(name)) === '[]', 'closed delete removes all components and is idempotent');
}

async function delayedCreator(closeDuringInit = false) {
  const name = unique();
  const prototype = FileSystemFileHandle.prototype;
  // The saved prototype method is called with its original receiver below.
  // oxlint-disable-next-line typescript/unbound-method
  const original = prototype.createSyncAccessHandle;
  let release!: () => void;
  let reached!: () => void;
  const paused = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let delayed = false;
  prototype.createSyncAccessHandle = async function (...args) {
    if (this.name === name && !delayed) {
      delayed = true;
      reached();
      await gate;
    }
    return original.apply(this, args);
  };
  let creator: OpfsVfs | undefined;
  try {
    creator = new OpfsVfs(name, fresh);
    const outcome = creator.ready.then(
      () => undefined,
      (error: unknown) => error,
    );
    await paused;
    const before = await contents(name);
    await expectFailure(new OpfsVfs(name, opts).ready, 'EBUSY');
    await expectFailure(deleteVolume(name), 'EBUSY');
    if (closeDuringInit) {
      void creator.closeVfs();
      await expectFailure(new OpfsVfs(name, opts).ready, 'EBUSY');
      await expectFailure(deleteVolume(name), 'EBUSY');
    }
    check((await contents(name)) === before, 'contenders leave paused initialization unchanged');
    await make(unique(), 99); // Different volumes remain independent.
    release();
    const error = await outcome;
    if (closeDuringInit) check((error as { code?: string })?.code === 'EBADF', 'close cancels initialization');
    else check(error === undefined, 'owning creator completes');
    void creator.closeVfs();
    await make(name); // Synchronous close followed immediately by a new mount.
    await deleteVolume(name);
  } finally {
    release();
    prototype.createSyncAccessHandle = original;
    void creator?.closeVfs();
  }
}

async function concurrentCreators() {
  const name = unique();
  const a = new OpfsVfs(name, fresh);
  const b = new OpfsVfs(name, fresh);
  try {
    const outcomes = await Promise.allSettled([a.ready, b.ready]);
    check(
      outcomes.filter((result) => result.status === 'fulfilled').length === 1,
      'exactly one creator owns the volume',
    );
    const loser = outcomes.find((result) => result.status === 'rejected');
    check(loser?.status === 'rejected' && loser.reason.code === 'EBUSY', 'competing creator fails promptly');
  } finally {
    void a.closeVfs();
    void b.closeVfs();
  }
  await deleteVolume(name);
}

async function earlyClose() {
  const name = unique();
  const vfs = new OpfsVfs(name, fresh);
  const closed = vfs.closeVfs();
  check(closed === vfs.closeVfs(), 'repeated close shares its completion');
  await closed;
  await expectFailure(vfs.ready, 'EBADF');
  check((await contents(name)) === '[]', 'close before ownership creates no components');
  await make(name);
  await deleteVolume(name);
}

self.onmessage = async ({ data }) => {
  try {
    if (data.scenario === 'delayed') await delayedCreator(data.closeDuringInit);
    else if (data.scenario === 'earlyClose') await earlyClose();
    else if (data.scenario === 'concurrent') await concurrentCreators();
    else await mountedDelete();
    await Promise.all(volumes.map(deleteVolume));
    self.postMessage({ ok: true });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? `${error.message}\n${error.stack}` : String(error) });
  }
};
