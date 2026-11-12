import { OpenFlags, OpfsVfs, type OpfsVfsOptions } from '../opfs-vfs';
import { testPlugin } from './test-plugin';

export type Expected = {
  files: [string, Uint8Array][];
  dirs: string[];
  /** Error code of the injected failed sync, asserted after recovery. */
  failure?: string;
  /** Data file size at the last successful flush. */
  flushedSize?: number;
};
type Request = {
  action:
    | 'prepare'
    | 'verify'
    | 'append-zeros'
    | 'truncate-data'
    | 'truncate-alloc'
    | 'double-claim'
    | 'zero-protected-wal'
    | 'detached-forge'
    | 'detached-verify';
  name: string;
  scenario?:
    | 'shrink-hole'
    | 'shrink-hole-snapshot'
    | 'extend'
    | 'reused-block'
    | 'synced-growth'
    | 'failed-persist'
    | 'failed-hole-fill'
    | 'failed-multi-file'
    | 'failed-flush'
    | 'prior-session'
    | 'legacy-tail-forge'
    | 'legacy-tail'
    | 'wal-only';
  mode?: 'memory' | 'disk';
  recoveryMode?: OpfsVfsOptions['recoveryMode'];
  expected?: Expected;
  bytes?: number;
  round?: number;
};

const BLOCK = 4096;
const create = OpenFlags.O_CREAT | OpenFlags.O_RDWR;

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function put(vfs: OpfsVfs, path: string, data: Uint8Array, offset = 0) {
  const fd = vfs.openSync(path, create);
  try {
    check(vfs.writeSync(fd, data, offset) === data.length, `${path}: write count`);
  } finally {
    vfs.closeSync(fd);
  }
}

function read(vfs: OpfsVfs, path: string) {
  const fd = vfs.openSync(path);
  try {
    return vfs.readSync(fd, vfs.fstatSync(fd).size + 1, 0).buffer;
  } finally {
    vfs.closeSync(fd);
  }
}

function checkFile(vfs: OpfsVfs, path: string, expected: Uint8Array) {
  const actual = read(vfs, path);
  check(actual.length === expected.length, `${path}: size ${actual.length} != ${expected.length}`);
  const mismatch = actual.findIndex((byte, i) => byte !== expected[i]);
  check(mismatch === -1, `${path}: byte ${mismatch} is ${actual[mismatch]}, expected ${expected[mismatch]}`);
}

function bytes(length: number, fill: number, patches: [number, number[]][] = []) {
  const out = new Uint8Array(length).fill(fill);
  for (const [at, values] of patches) out.set(values, at);
  return out;
}

async function mount(name: string, options: OpfsVfsOptions) {
  const vfs = new OpfsVfs(name, { localDurabilityMode: 'relaxed', ...options });
  await vfs.ready;
  return vfs;
}

type Fault = { failWrite: number; failFlush: boolean; fired: number; dataSize(): number };

/**
 * Mount in memory mode with an injectable failure on the volume data file:
 * a quota error on its nth write (`failWrite`), or an error on its next flush.
 */
async function mountWithDataFault(name: string, options: OpfsVfsOptions = {}) {
  let dataHandle: FileSystemSyncAccessHandle | undefined;
  const fault: Fault = { failWrite: 0, failFlush: false, fired: 0, dataSize: () => dataHandle!.getSize() };
  const vfs = await mount(name, {
    bufferMode: 'memory',
    ...options,
    _wrapSyncAccessHandle: (handle, tag) => {
      if (tag !== 'data') return handle;
      dataHandle ??= handle;
      return new Proxy(handle, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (key === 'write' || key === 'flush') {
            return (...args: unknown[]) => {
              if (target === dataHandle && key === 'write' && fault.failWrite > 0 && --fault.failWrite === 0) {
                fault.fired++;
                throw new DOMException('injected quota failure', 'QuotaExceededError');
              }
              if (target === dataHandle && key === 'flush' && fault.failFlush) {
                fault.failFlush = false;
                fault.fired++;
                throw new DOMException('injected flush failure', 'InvalidStateError');
              }
              return (value as (...args: unknown[]) => unknown).apply(target, args);
            };
          }
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  });
  return { vfs, fault };
}

/** Returns the error code (or name) the failed sync reported; tests assert it after the recovery checks. */
function failingSync(vfs: OpfsVfs, fault: Fault, failure: { write: number } | 'flush') {
  if (failure === 'flush') fault.failFlush = true;
  else fault.failWrite = failure.write;
  let error: unknown;
  try {
    vfs.syncSync();
  } catch (caught) {
    error = caught;
  }
  check(fault.fired === 1 && error !== undefined, 'the injected data failure must fire and reach the caller');
  const details = error as { code?: unknown; name?: unknown };
  return String(typeof details.code === 'string' ? details.code : details.name);
}

/** A disk-mode session leaves `/sparse` as three unallocated pages. */
async function sparseFile(name: string) {
  const disk = await mount(name, { bufferMode: 'disk' });
  const fd = disk.openSync('/sparse', create);
  disk.ftruncateSync(fd, 3 * BLOCK);
  disk.closeSync(fd);
  await disk.closeVfs();
}

/** Stand-in for a record codec with data-WAL cycle stamps (a protected volume). */
function protectedPlugin() {
  const stamp = new Uint8Array([0x44, 0x57, 0x43, 0x31]);
  const codec = {
    overheadBytes: 0,
    seal: (plain: Uint8Array) => plain,
    sealInto: (plain: Uint8Array, _role: number, _identity: number, out: Uint8Array, outOffset: number) => {
      out.set(plain, outOffset);
      return plain.length;
    },
    open: (sealed: Uint8Array) => sealed,
  };
  return testPlugin(async ({ data }) => ({
    data,
    recordCodec: codec,
    createDataWalCycle: () => ({ prefix: stamp, codec }),
    openDataWalCycle: (bytes) =>
      bytes.length >= stamp.length && stamp.every((byte, i) => bytes[i] === byte)
        ? { prefixBytes: stamp.length, codec }
        : null,
    destroy() {},
  }));
}

/** Leaves the volume open: the test terminates this worker to model a killed tab. */
async function prepare(name: string, scenario: NonNullable<Request['scenario']>): Promise<Expected> {
  if (scenario === 'failed-persist') {
    const { vfs, fault } = await mountWithDataFault(name);
    put(vfs, '/f', bytes(3 * BLOCK, 7));
    const failure = failingSync(vfs, fault, { write: 1 });
    vfs.mkdirSync('/later');
    return { files: [['/f', bytes(3 * BLOCK, 7)]], dirs: ['/later'], failure };
  }
  if (scenario === 'failed-hole-fill') {
    await sparseFile(name);
    const { vfs, fault } = await mountWithDataFault(name);
    put(vfs, '/sparse', new Uint8Array([5, 5, 5]), BLOCK + 10);
    const failure = failingSync(vfs, fault, { write: 1 });
    vfs.mkdirSync('/later');
    return { files: [['/sparse', bytes(3 * BLOCK, 0, [[BLOCK + 10, [5, 5, 5]]])]], dirs: ['/later'], failure };
  }
  if (scenario === 'failed-multi-file' || scenario === 'failed-flush') {
    await sparseFile(name);
    const { vfs, fault } = await mountWithDataFault(name, { localDurabilityMode: 'strict' });
    put(vfs, '/a', bytes(2 * BLOCK, 1));
    vfs.syncSync();
    const flushedSize = fault.dataSize();
    // Persist order: /sparse fills a hole, /c takes new blocks, then (multi-file) /d's write fails.
    put(vfs, '/sparse', new Uint8Array([5, 5, 5]), BLOCK + 10);
    put(vfs, '/c', bytes(3 * BLOCK, 3));
    put(vfs, '/d', bytes(2 * BLOCK, 4));
    const failure = failingSync(vfs, fault, scenario === 'failed-flush' ? 'flush' : { write: 3 });
    check(fault.dataSize() > flushedSize, 'fixture must leave unflushed data-file growth');
    // Strict mode logs and flushes this record at once.
    vfs.mkdirSync('/later');
    return {
      files: [
        ['/a', bytes(2 * BLOCK, 1)],
        ['/sparse', bytes(3 * BLOCK, 0, [[BLOCK + 10, [5, 5, 5]]])],
        ['/c', bytes(3 * BLOCK, 3)],
        ['/d', bytes(2 * BLOCK, 4)],
      ],
      dirs: ['/later'],
      failure,
      flushedSize,
    };
  }
  if (scenario === 'prior-session') {
    const first = await mount(name, { bufferMode: 'memory' });
    put(first, '/f', bytes(100, 1));
    put(first, '/h', bytes(2 * BLOCK, 7));
    await first.closeVfs();
    // Sizes loaded at mount are the persisted sizes of this session.
    const second = await mount(name, { bufferMode: 'memory' });
    put(second, '/f', bytes(100, 2), 100);
    second.truncateSync('/h', 10);
    second.mkdirSync('/any');
    return {
      files: [
        ['/f', bytes(200, 1, [[100, Array<number>(100).fill(2)]])],
        ['/h', bytes(10, 7)],
      ],
      dirs: ['/any'],
    };
  }
  if (scenario === 'legacy-tail-forge') {
    // An earlier release could log a size past the file's blocks and then lose the WAL.
    const forged = await mount(name, { bufferMode: 'memory' });
    put(forged, '/f', bytes(BLOCK, 1));
    forged.syncSync();
    const internals = forged as unknown as { inodes: Map<string, { size: number }>; dirtyInodes: Set<string> };
    internals.inodes.get('/f')!.size = 10_000;
    internals.dirtyInodes.add('/f');
    await forged.closeVfs();
    return { files: [], dirs: [] };
  }
  if (scenario === 'legacy-tail') {
    const legacy = await mount(name, { bufferMode: 'memory' });
    const mounted = bytes(10_000, 0, [[0, Array<number>(BLOCK).fill(1)]]);
    checkFile(legacy, '/f', mounted);
    put(legacy, '/f', new Uint8Array([5]), 9000);
    legacy.mkdirSync('/any');
    mounted[9000] = 5;
    return { files: [['/f', mounted]], dirs: ['/any'] };
  }

  const vfs = await mount(name, { bufferMode: 'memory' });
  if (scenario === 'wal-only') {
    put(vfs, '/a', new Uint8Array([111, 107]));
    return { files: [['/a', new Uint8Array([111, 107])]], dirs: [] };
  }
  if (scenario === 'synced-growth') {
    put(vfs, '/f', bytes(100, 1));
    vfs.syncSync();
    put(vfs, '/f', bytes(100, 2), 100);
    // Logs /f while its growth is still pending; the sync below must record the new size.
    vfs.mkdirSync('/any');
    vfs.syncSync();
    return { files: [['/f', bytes(200, 1, [[100, Array<number>(100).fill(2)]])]], dirs: ['/any'] };
  }
  if (scenario === 'reused-block') {
    put(vfs, '/old', bytes(BLOCK, 0xbb));
    put(vfs, '/guard', bytes(BLOCK, 0xcc));
    vfs.syncSync();
    vfs.unlinkSync('/old');
    // Takes over the freed block; its bytes past offset 100 still belong to /old.
    put(vfs, '/f', bytes(100, 0x11));
    vfs.syncSync();
    put(vfs, '/f', new Uint8Array([9]), 3000);
    // Any namespace operation logs metadata for every file with unsynced changes.
    vfs.mkdirSync('/any');
    return {
      files: [
        [
          '/f',
          bytes(3001, 0, [
            [0, Array<number>(100).fill(0x11)],
            [3000, [9]],
          ]),
        ],
        ['/guard', bytes(BLOCK, 0xcc)],
      ],
      dirs: ['/any'],
    };
  }
  put(vfs, '/f', bytes(2 * BLOCK, 0xaa));
  vfs.syncSync();
  vfs.truncateSync('/f', 5000);
  vfs.syncSync();
  const kept = Array<number>(5000).fill(0xaa);
  if (scenario === 'extend') {
    vfs.truncateSync('/f', 8000);
    vfs.mkdirSync('/any');
    return { files: [['/f', bytes(8000, 0, [[0, kept]])]], dirs: ['/any'] };
  }
  put(vfs, '/f', new Uint8Array([1, 2, 3]), 8000);
  // A grown volume or a long log turns the next metadata write into a full snapshot.
  if (scenario === 'shrink-hole-snapshot') (vfs as unknown as { dirtyStructure: boolean }).dirtyStructure = true;
  vfs.mkdirSync('/any');
  return {
    files: [
      [
        '/f',
        bytes(8003, 0, [
          [0, kept],
          [8000, [1, 2, 3]],
        ]),
      ],
    ],
    dirs: ['/any'],
  };
}

async function verify(request: Request) {
  const vfs = await mount(request.name, { bufferMode: request.mode, recoveryMode: request.recoveryMode });
  try {
    if (request.recoveryMode === 'fail-stop') {
      check(vfs.getLocalPersistenceStatusSync().lastSalvage === undefined, 'a torn tail is not a salvage event');
    }
    for (const [path, data] of request.expected!.files) checkFile(vfs, path, data);
    for (const dir of request.expected!.dirs) check(vfs.statSync(dir).is_dir, `${dir}: directory survives`);
  } finally {
    await vfs.closeVfs();
  }
}

async function rawHandle(fileName: string) {
  const root = await navigator.storage.getDirectory();
  const file = await root.getFileHandle(fileName);
  return (
    file as FileSystemFileHandle & { createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle> }
  ).createSyncAccessHandle();
}

async function appendZeros(name: string, count: number, toEmptyLog = false) {
  const handle = await rawHandle(name.replace(/\.bin$/, '.data.log'));
  try {
    const size = handle.getSize();
    check(toEmptyLog ? size === 0 : size > 0, `unexpected data WAL size ${size}`);
    handle.write(new Uint8Array(count), { at: size });
    handle.flush();
  } finally {
    handle.close();
  }
}

/** Power loss: growth of the data file that was never flushed is gone. */
async function truncateData(name: string, size: number) {
  const handle = await rawHandle(name);
  try {
    check(handle.getSize() > size, `data file ${handle.getSize()} has nothing unflushed past ${size}`);
    handle.truncate(size);
    handle.flush();
  } finally {
    handle.close();
  }
}

async function zeroProtectedWal(name: string) {
  const content = new Uint8Array([111, 107]);
  const first = await mount(name, { bufferMode: 'memory', plugins: [protectedPlugin()] });
  put(first, '/a', content);
  await first.closeVfs();
  // The first append of the next cycle reached the file length, not its bytes.
  await appendZeros(name, 64, true);
  const vfs = await mount(name, { bufferMode: 'memory', recoveryMode: 'fail-stop', plugins: [protectedPlugin()] });
  try {
    const status = vfs.getLocalPersistenceStatusSync();
    check(status.lastSalvage === undefined, 'an all-zero log is not a salvage event');
    check(status.walPendingBytes === 0, 'the zero bytes are dropped');
    checkFile(vfs, '/a', content);
    put(vfs, '/b', content);
    vfs.syncSync();
  } finally {
    await vfs.closeVfs();
  }
}

/**
 * Leaves the log an earlier release wrote when it renamed `/a` to `/b` after a
 * remount: "delete /a, upsert /b", with `/a/1` still present under no parent.
 */
async function forgeDetached(name: string, mode: 'memory' | 'disk') {
  const first = await mount(name, { bufferMode: mode });
  first.mkdirSync('/a');
  put(first, '/a/1', bytes(10, 1));
  for (const n of [1, 2, 3, 4]) put(first, `/a-${n}`, bytes(10, n));
  await first.closeVfs();
  const vfs = await mount(name, { bufferMode: mode });
  const internals = vfs as unknown as {
    inodes: Map<string, unknown>;
    deletedInodes: Set<string>;
    dirtyInodes: Set<string>;
    writeMeta(): void;
  };
  internals.inodes.set('/b', internals.inodes.get('/a'));
  internals.inodes.delete('/a');
  internals.deletedInodes.add('/a');
  internals.dirtyInodes.add('/b');
  internals.writeMeta();
}

async function verifyDetached(request: Request) {
  const vfs = await mount(request.name, { bufferMode: request.mode, recoveryMode: request.recoveryMode });
  try {
    const status = vfs.getLocalPersistenceStatusSync();
    const error = status.lastError as { name?: string; category?: string; message?: string } | undefined;
    if (request.round === 0) {
      check(status.localPersistenceState === 'error', 'the repair is reported at mount');
      check(
        error?.name === 'VfsCorruptionError' && error.category === 'meta-log' && !!error.message?.includes('/a'),
        `the repair names what it recreated, got ${String(status.lastError)}`,
      );
    } else {
      check(error === undefined, `a repaired volume mounts without a report, got ${String(status.lastError)}`);
    }
    const paths = JSON.stringify(vfs.listPathsSync());
    check(paths === JSON.stringify(['/', '/a', '/a-1', '/a-2', '/a-3', '/a-4', '/a/1', '/b']), `paths ${paths}`);
    check(vfs.statSync('/a').is_dir && vfs.statSync('/b').is_dir, 'both directories exist');
    check(JSON.stringify(vfs.readdirNamesSync('/a')) === '["1"]', 'the recovered file is listed in its directory');
    checkFile(vfs, '/a/1', bytes(10, 1));
    put(vfs, `/new${request.round}`, bytes(5, 9));
    vfs.syncSync();
    vfs.unlinkSync(`/new${request.round}`);
  } finally {
    // Before the repair every close threw "Missing parent inode for path /a/1".
    await vfs.closeVfs();
  }
}

async function truncateAllocation(name: string) {
  const size = 5_000_001;
  const original = bytes(100, 3);
  const vfs = await mount(name, { bufferMode: 'memory' });
  try {
    put(vfs, '/f', original);
    vfs.syncSync();
    const realUint8Array = globalThis.Uint8Array;
    // Stands in for a buffer too large for the worker to allocate.
    globalThis.Uint8Array = new Proxy(realUint8Array, {
      construct(target, args, newTarget) {
        if (args[0] === size) throw new RangeError('Array buffer allocation failed');
        return Reflect.construct(target, args, newTarget);
      },
    });
    let failure: unknown;
    try {
      vfs.truncateSync('/f', size);
    } catch (error) {
      failure = error;
    } finally {
      globalThis.Uint8Array = realUint8Array;
    }
    check(failure instanceof RangeError, `truncate must report the failed allocation, got ${String(failure)}`);
    check(vfs.statSync('/f').size === original.length, 'a failed truncate must not change the file size');
    check(vfs.getLocalPersistenceStatusSync().walPendingBytes === 0, 'a failed truncate must not be logged');
    checkFile(vfs, '/f', original);
  } finally {
    await vfs.closeVfs();
  }
  const reopened = await mount(name, { bufferMode: 'memory' });
  try {
    checkFile(reopened, '/f', original);
  } finally {
    await reopened.closeVfs();
  }
}

async function doubleClaim(name: string) {
  const first = await mount(name, { bufferMode: 'disk' });
  put(first, '/a', bytes(BLOCK, 1));
  put(first, '/b', bytes(BLOCK, 2));
  // Forge the corruption: both files name /a's block.
  const inodes = (first as unknown as { inodes: Map<string, { blocks: number[] }> }).inodes;
  inodes.get('/b')!.blocks = inodes.get('/a')!.blocks.slice();
  await first.closeVfs();

  const vfs = await mount(name, { bufferMode: 'disk' });
  try {
    const corruption = (status = vfs.getLocalPersistenceStatusSync()) =>
      (status.lastError as { name?: string; category?: string } | undefined)?.name === 'VfsCorruptionError' &&
      (status.lastError as { category?: string }).category === 'meta-snapshot';
    check(vfs.getLocalPersistenceStatusSync().localPersistenceState === 'error', 'mount reports the corruption');
    check(
      corruption(),
      `mount reports a typed corruption error, got ${String(vfs.getLocalPersistenceStatusSync().lastError)}`,
    );
    put(vfs, '/c', bytes(10, 3));
    vfs.syncSync();
    check(vfs.getLocalPersistenceStatusSync().localPersistenceState === 'clean', 'a later sync still succeeds');
    check(corruption(), 'the corruption stays reported after later writes and syncs');
  } finally {
    await vfs.closeVfs();
  }
}

self.onmessage = async ({ data }: MessageEvent<Request>) => {
  try {
    let expected: Expected | undefined;
    if (data.action === 'prepare') expected = await prepare(data.name, data.scenario!);
    else if (data.action === 'verify') await verify(data);
    else if (data.action === 'append-zeros') await appendZeros(data.name, data.bytes!);
    else if (data.action === 'truncate-data') await truncateData(data.name, data.bytes!);
    else if (data.action === 'zero-protected-wal') await zeroProtectedWal(data.name);
    else if (data.action === 'detached-forge') await forgeDetached(data.name, data.mode!);
    else if (data.action === 'detached-verify') await verifyDetached(data);
    else if (data.action === 'truncate-alloc') await truncateAllocation(data.name);
    else await doubleClaim(data.name);
    self.postMessage({ expected });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error) });
  }
};
