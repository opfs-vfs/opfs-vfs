import { createVfsError } from './fs-errors';

const SUFFIXES = [
  '.bin',
  '.meta.a',
  '.meta.b',
  '.bitmap',
  '.meta.log',
  '.data.log',
  '.bootstrap',
  '.vault',
  '.crypt',
  '.crypt.log',
  '.meta',
  '.importing',
] as const;

export class VolumeImportingError extends Error {
  readonly code = 'VOLUME_IMPORTING';
  constructor(name: string) {
    super(`Volume ${name} has an incomplete import`);
    this.name = 'VolumeImportingError';
  }
}

/** Data first; the retired .meta remains owned for inspection and cleanup. */
export function volumeFileNames(name: string): string[] {
  if (typeof name !== 'string' || !name.endsWith('.bin') || name.length <= 4 || /[/\\]/.test(name)) {
    throw createVfsError('EINVAL', name, 'Volume name must be a basename ending in .bin');
  }
  return SUFFIXES.map((suffix) => name.slice(0, -4) + suffix);
}

export function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'NotFoundError';
}

/** Presence is independent of length, magic, and whether a mount can recover it. */
export async function findVolumeFile(root: FileSystemDirectoryHandle, names: string[]): Promise<string | undefined> {
  for (const name of names) {
    try {
      await root.getFileHandle(name, { create: false });
      return name;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}

// Synchronous close signals release before the browser acknowledges it. Only
// wait for releases in this realm; an active owner still rejects immediately.
const pendingReleases = new Map<string, Promise<void>>();

/** Hold ownership across all component files, including browsers that unlink open files. */
export async function acquireVolumeLock(name: string): Promise<() => Promise<void>> {
  await pendingReleases.get(name);
  return new Promise((resolve, reject) => {
    const request = navigator.locks.request(`opfs-vfs-volume-${name}`, { ifAvailable: true }, async (lock) => {
      if (!lock) throw createVfsError('EBUSY', name, 'Volume is in use');
      await new Promise<void>((release) => {
        let released = false;
        resolve(() => {
          if (!released) {
            released = true;
            pendingReleases.set(name, request);
            const clear = () => {
              if (pendingReleases.get(name) === request) pendingReleases.delete(name);
            };
            void request.then(clear, clear);
            release();
          }
          return request;
        });
      });
    });
    request.catch(reject);
  });
}

/** Async callers must acknowledge ownership release even after a synchronous flush error. */
export async function closeVolume(vfs: { closeVfs(): void | Promise<void> }): Promise<void> {
  try {
    await vfs.closeVfs();
  } catch (error) {
    try {
      await vfs.closeVfs();
    } catch {
      /* Keep the first close error. */
    }
    throw error;
  }
}

/** Explicitly remove a closed volume and all reserved component files. */
export async function deleteVolume(name: string): Promise<void> {
  volumeFileNames(name);
  const release = await acquireVolumeLock(name);
  try {
    await removeVolumeFiles(await navigator.storage.getDirectory(), name);
  } finally {
    await release();
  }
}

/** Caller holds the volume lock; the import reservation is always removed last. */
export async function removeVolumeFiles(root: FileSystemDirectoryHandle, name: string): Promise<void> {
  const files = volumeFileNames(name);
  // Metadata first: an interrupted delete then fails mounts loudly ("data but no
  // snapshot") instead of mounting old metadata over a recreated, empty .bin.
  const metadataFirst = [...files.slice(1, 3), files[4], files[0], ...files.slice(3, 4), ...files.slice(5)];
  for (const file of metadataFirst) {
    try {
      await root.removeEntry(file);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}
