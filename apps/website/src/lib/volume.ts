import { deleteVolume } from '@opfs-vfs/opfs-vfs';
import { OpfsVfsWorker } from '@opfs-vfs/opfs-vfs/worker';
import { OpfsVfsJustBashAdapter } from '@opfs-vfs/opfs-vfs/just-bash';
import { Bash } from 'just-bash/browser';

const encoder = new TextEncoder();
const registryKey = (namespace: string) => `opfs-vfs:website:${namespace}:volumes`;
const physicalVolumeName = (namespace: string, name: string) =>
  `website-${namespace}-${encodeURIComponent(name.toLowerCase())}.bin`;

function assertFilesystemSupport() {
  if (!navigator.storage?.getDirectory)
    throw new Error('This browser does not support the Origin Private File System.');
  if (!navigator.locks) throw new Error('This browser does not support Web Locks, which this multi-tab demo requires.');
  if (typeof Worker === 'undefined' || typeof BroadcastChannel === 'undefined')
    throw new Error('This browser cannot run the filesystem worker.');
  if (!crossOriginIsolated || typeof SharedArrayBuffer === 'undefined')
    throw new Error('This demo needs cross-origin isolation and SharedArrayBuffer.');
}

async function registryLock<T>(namespace: string, run: () => T | Promise<T>) {
  return navigator.locks.request(`opfs-vfs:website:${namespace}:registry`, run);
}

export async function listVolumes(namespace: string) {
  return registryLock(namespace, () => JSON.parse(localStorage.getItem(registryKey(namespace)) || '[]') as string[]);
}

export async function registerVolume(namespace: string, name: string) {
  await registryLock(namespace, () => {
    const names = JSON.parse(localStorage.getItem(registryKey(namespace)) || '[]') as string[];
    if (!names.includes(name)) localStorage.setItem(registryKey(namespace), JSON.stringify([...names, name].sort()));
  });
}

async function unregisterVolume(namespace: string, name: string) {
  await registryLock(namespace, () => {
    const names = JSON.parse(localStorage.getItem(registryKey(namespace)) || '[]') as string[];
    localStorage.setItem(registryKey(namespace), JSON.stringify(names.filter((item) => item !== name)));
  });
}

function errorCode(error: unknown) {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
}

export type FilesystemSession = Awaited<ReturnType<typeof openVolume>>;

export async function openVolume(
  namespace: string,
  name: string,
  create = false,
  registerOnOpen = true,
  reuseOnExist = false,
) {
  assertFilesystemSupport();
  if (!/^[a-z0-9][a-z0-9 _-]{0,39}$/i.test(name))
    throw new Error('Use 1-40 letters, numbers, spaces, hyphens, or underscores');
  const volumeFile = physicalVolumeName(namespace, name);
  let vfs = new OpfsVfsWorker(volumeFile, create ? { openMode: 'create-new' } : undefined);
  try {
    try {
      await vfs.ready;
    } catch (error) {
      vfs.dispose();
      if (!create || !reuseOnExist || errorCode(error) !== 'EEXIST') throw error;
      vfs = new OpfsVfsWorker(volumeFile);
      await vfs.ready;
    }
    const fs = new OpfsVfsJustBashAdapter(vfs);
    const lockName = `opfs-vfs:website:${volumeFile}:use`;
    const leaseName = `opfs-vfs:website:${volumeFile}:lease`;
    await navigator.locks.request(lockName, async () => {
      if (!(await fs.exists('/workspace'))) await fs.mkdir('/workspace', { recursive: true });
    });
    const bash = new Bash({ cwd: '/workspace', env: { HOME: '/workspace', USER: 'visitor' }, fs: fs as never });
    if (registerOnOpen) await registerVolume(namespace, name);
    const changes = new BroadcastChannel(`opfs-vfs:website:${volumeFile}:changes`);
    let closed = false;
    let releaseLease!: () => void;
    let markLeaseReady!: () => void;
    const leaseReady = new Promise<void>((resolve) => {
      markLeaseReady = resolve;
    });
    const lease = navigator.locks.request(leaseName, { mode: 'shared' }, async () => {
      markLeaseReady();
      await new Promise<void>((resolve) => {
        releaseLease = resolve;
      });
    });
    await leaseReady;
    const use = <T>(operation: () => Promise<T>) =>
      navigator.locks.request(lockName, async () => {
        if (closed) throw new Error('This volume session is closed.');
        return operation();
      });
    const closeUnlocked = async () => {
      if (closed) return;
      closed = true;
      changes.close();
      releaseLease();
      await lease;
      await vfs.closeVfs();
    };
    return {
      bash,
      changes,
      fs,
      name,
      volumeFile,
      read<T>(operation: (filesystem: OpfsVfsJustBashAdapter) => Promise<T>) {
        return use(() => operation(fs));
      },
      run<T>(operation: (filesystem: OpfsVfsJustBashAdapter) => Promise<T>) {
        return use(async () => {
          const result = await operation(fs);
          await vfs.flushVfs();
          changes.postMessage('change');
          return result;
        });
      },
      exec(command: string) {
        return use(async () => {
          const result = await bash.exec(command);
          await vfs.flushVfs();
          changes.postMessage('change');
          return result;
        });
      },
      flush() {
        return use(() => vfs.flushVfs());
      },
      close() {
        return navigator.locks.request(lockName, closeUnlocked);
      },
      remove(options: { unregister?: boolean } = {}) {
        return navigator.locks.request(lockName, async () => {
          const heldLeases =
            (await navigator.locks.query()).held?.filter((lock) => lock.name === leaseName).length ?? 0;
          if (heldLeases > 1)
            throw Object.assign(new Error('This volume is open in another tab. Close it there before resetting.'), {
              code: 'EBUSY',
            });
          closed = true;
          changes.close();
          const exclusive = navigator.locks.request(leaseName, async () => {
            await vfs.closeVfs();
            await deleteVolume(volumeFile);
            if (options.unregister !== false) await unregisterVolume(namespace, name);
          });
          releaseLease();
          await lease;
          await exclusive;
        });
      },
    };
  } catch (error) {
    vfs.dispose();
    throw error;
  }
}

export async function seedVolume(session: FilesystemSession) {
  await session.run(async (fs) => {
    await fs.writeFile(
      '/workspace/README.md',
      '# Persistent workspace\n\nFiles here survive reloads in this browser.\n',
    );
    await fs.mkdir('/workspace/data', { recursive: true });
    await fs.writeFile('/workspace/data/example.json', JSON.stringify({ storage: 'OPFS', durable: true }, null, 2));
    await fs.writeFile('/workspace/notes.txt', encoder.encode('Try: echo "hello" > hello.txt\n'));
  });
}
