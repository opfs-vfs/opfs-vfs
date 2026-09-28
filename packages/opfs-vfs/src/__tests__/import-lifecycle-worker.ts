import { testPlugin } from './test-plugin';
import { OpfsVfs } from '../opfs-vfs';
import { acquireVolumeLock, closeVolume, deleteVolume, mountImportVolume, removeVolumeFiles } from '../storage';

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function files(root: FileSystemDirectoryHandle, name: string): Promise<string> {
  const entries: [string, number[]][] = [];
  for await (const [fileName, handle] of root.entries()) {
    if (!fileName.startsWith(name.slice(0, -4) + '.')) continue;
    const bytes = new Uint8Array(await (await (handle as FileSystemFileHandle).getFile()).arrayBuffer());
    entries.push([fileName, [...bytes]]);
  }
  return JSON.stringify(entries.sort(([a], [b]) => a.localeCompare(b)));
}

async function write(root: FileSystemDirectoryHandle, name: string, bytes: Uint8Array) {
  const handle = await root.getFileHandle(name, { create: true });
  const writer = await handle.createWritable();
  await writer.write(bytes.slice());
  await writer.close();
}

async function rejects(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    check((error as { code?: string }).code === 'VOLUME_IMPORTING', `unexpected refusal: ${String(error)}`);
    return;
  }
  throw new Error('expected VOLUME_IMPORTING');
}

async function run(name: string) {
  const root = await navigator.storage.getDirectory();
  const marker = name.replace(/\.bin$/, '.importing');
  const token = crypto.getRandomValues(new Uint8Array(16));
  let reservationHandle: FileSystemSyncAccessHandle | undefined;
  let storageOpened = false;
  const storageFactory = async () => {
    storageOpened = true;
    throw new Error('storage must not open');
  };
  try {
    await write(root, marker, new Uint8Array());
    let before = await files(root, name);
    for (const openMode of ['open-or-create', 'open-existing', 'create-new'] as const) {
      await rejects(new OpfsVfs(name, { openMode, plugins: [testPlugin(storageFactory)] }).ready);
      check((await files(root, name)) === before, `${openMode} changed empty reservation`);
    }
    await write(root, marker, new Uint8Array([1, 2, 3]));
    before = await files(root, name);
    await rejects(new OpfsVfs(name, { plugins: [testPlugin(storageFactory)] }).ready);
    check((await files(root, name)) === before, 'damaged reservation changed files');

    await write(root, marker, token);
    before = await files(root, name);
    await rejects(mountImportVolume(name, { openMode: 'open-existing' }, { token }).ready);
    check((await files(root, name)) === before, 'marker-only owner attempt changed files');

    await write(root, name, new Uint8Array());
    reservationHandle = await (await root.getFileHandle(marker)).createSyncAccessHandle();
    before = await files(root, name);
    for (const openMode of ['open-or-create', 'open-existing', 'create-new'] as const) {
      await rejects(new OpfsVfs(name, { openMode, plugins: [testPlugin(storageFactory)] }).ready);
      check((await files(root, name)) === before, `${openMode} changed reserved files`);
    }
    check(!storageOpened, 'storage factory opened before import guard');
    await rejects(mountImportVolume(name, { openMode: 'open-existing' }, { token: new Uint8Array(16) }).ready);
    await rejects(mountImportVolume(name, { openMode: 'open-existing' }, { token: token.slice(0, 15) }).ready);
    await rejects(
      mountImportVolume(name, { openMode: 'open-existing' }, { token: undefined as unknown as Uint8Array }).ready,
    );
    check((await files(root, name)) === before, 'wrong token changed reserved files');

    const owner = mountImportVolume(name, { openMode: 'open-existing' }, { token });
    await owner.ready;
    await closeVolume(owner);
    check((await files(root, name)).includes(marker), 'owner mount removed reservation');

    reservationHandle.close();
    reservationHandle = undefined;
    await root.removeEntry(marker);
    before = await files(root, name);
    await rejects(mountImportVolume(name, { openMode: 'open-existing' }, { token }).ready);
    check((await files(root, name)) === before, 'stale token changed completed volume');

    await write(root, marker, crypto.getRandomValues(new Uint8Array(16)));
    before = await files(root, name);
    await rejects(mountImportVolume(name, { openMode: 'open-existing' }, { token }).ready);
    check((await files(root, name)) === before, 'old token changed replacement reservation');

    const release = await acquireVolumeLock(name);
    try {
      await removeVolumeFiles(root, name);
    } finally {
      await release();
    }
    check((await files(root, name)) === '[]', 'unlocked helper left components');
  } finally {
    reservationHandle?.close();
    await deleteVolume(name);
  }
}

self.onmessage = async ({ data }) => {
  try {
    await run(data.name);
    self.postMessage({ ok: true });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? `${error.message}\n${error.stack}` : String(error) });
  }
};
