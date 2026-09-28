import { createVfsError } from './fs-errors';
import { normalizeFsPath } from './fs-path';
import { OpenFlags, type OpfsVfs, type VfsStat } from './opfs-vfs';

export interface WasmerSyncMetadata {
  kind: 'file' | 'directory';
  size: number;
  accessed?: number;
  modified?: number;
  created?: number;
}

export interface WasmerSyncOpenOptions {
  read: boolean;
  write: boolean;
  append: boolean;
  truncate: boolean;
  create: boolean;
  createNew: boolean;
}

/** Structural contract for the experimental Wasmer SDK synchronous mount. */
export interface WasmerSyncFileSystem {
  metadata(path: string): WasmerSyncMetadata;
  readDir(path: string): (WasmerSyncMetadata & { name: string })[];
  createDir(path: string): void;
  removeDir(path: string): void;
  removeFile(path: string): void;
  unlink(fd: number): void;
  rename(from: string, to: string): void;
  open(path: string, options: WasmerSyncOpenOptions): number;
  read(fd: number, length: number): Uint8Array;
  write(fd: number, bytes: Uint8Array): number;
  seek(fd: number, offset: number, whence: 0 | 1 | 2): number;
  fstat(fd: number): WasmerSyncMetadata;
  setLen(fd: number, length: number): void;
  flush(fd: number): void;
  close(fd: number): void;
}

function unsupported(): never {
  throw Object.assign(
    new Error('ENOTSUP: linked files, special files and external namespace changes are unsupported'),
    {
      code: 'ENOTSUP',
    },
  );
}

function metadata(stat: VfsStat): WasmerSyncMetadata {
  if ((!stat.is_file && !stat.is_dir) || (stat.is_file && stat.nlink > 1)) unsupported();
  return {
    kind: stat.is_dir ? 'directory' : 'file',
    size: stat.size,
    accessed: stat.atimeMs,
    modified: stat.mtimeMs,
    created: stat.ctimeMs,
  };
}

/**
 * Call after `vfs.ready` in its owner worker. Absolute paths start at the mount root.
 * Close the sandbox before closing the VFS. This provider does not own the volume.
 * Namespace changes must pass through this provider while guest handles are open.
 */
export function createWasmerFileSystem(vfs: OpfsVfs): WasmerSyncFileSystem {
  const descriptors = new Map<number, { path: string; ino: number; writable: boolean }>();

  function checkedPath(raw: string): string {
    if (
      typeof raw !== 'string' ||
      !raw.startsWith('/') ||
      raw.includes('\0') ||
      raw.split('/').some((part) => part === '.' || part === '..')
    ) {
      throw createVfsError('EINVAL', raw, 'Expected an absolute mount path without dot components');
    }
    const { path, requiresDirectory } = normalizeFsPath(raw);
    const parts = path.split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const prefix = `/${parts.slice(0, i + 1).join('/')}`;
      let stat: VfsStat;
      try {
        stat = vfs.lstatSync(prefix);
      } catch (error) {
        if (i === parts.length - 1 && (error as { code?: string }).code === 'ENOENT') break;
        throw error;
      }
      metadata(stat);
      if ((i < parts.length - 1 || requiresDirectory) && !stat.is_dir) throw createVfsError('ENOTDIR', prefix);
    }
    return requiresDirectory && path !== '/' ? `${path}/` : path;
  }

  function descriptor(fd: number) {
    const entry = descriptors.get(fd);
    if (!entry) throw createVfsError('EBADF');
    const stat = vfs.fstatSync(fd);
    if (stat.ino !== entry.ino) throw createVfsError('EBADF');
    metadata(stat);
    return { ...entry, stat };
  }

  return {
    metadata: (path) => metadata(vfs.lstatSync(checkedPath(path))),
    readDir(path) {
      const checked = checkedPath(path);
      return vfs.readdirNamesSync(checked).map((name) => ({
        name,
        ...metadata(vfs.lstatSync(checkedPath(`${checked.replace(/\/$/, '')}/${name}`))),
      }));
    },
    createDir: (path) => vfs.mkdirSync(checkedPath(path)),
    removeDir: (path) => vfs.rmdirSync(checkedPath(path)),
    removeFile: (path) => vfs.unlinkSync(checkedPath(path)),
    unlink(fd) {
      const entry = descriptor(fd);
      if (entry.stat.nlink === 0) return;
      let current: VfsStat;
      try {
        current = vfs.lstatSync(checkedPath(entry.path));
      } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') unsupported();
        throw error;
      }
      if (current.ino !== entry.ino) unsupported();
      vfs.unlinkSync(entry.path);
    },
    rename(from, to) {
      const source = checkedPath(from);
      const destination = checkedPath(to);
      vfs.renameSync(source, destination);
      const oldPath = normalizeFsPath(source).path;
      const newPath = normalizeFsPath(destination).path;
      for (const entry of descriptors.values()) {
        if (entry.path === oldPath || entry.path.startsWith(`${oldPath}/`)) {
          entry.path = `${newPath}${entry.path.slice(oldPath.length)}`;
        }
      }
    },
    open(path, options) {
      if (
        !options ||
        [options.read, options.write, options.append, options.truncate, options.create, options.createNew].some(
          (value) => typeof value !== 'boolean',
        )
      )
        throw createVfsError('EINVAL');
      const writable = options.write || options.append;
      if ((!options.read && !writable) || ((options.truncate || options.create || options.createNew) && !writable)) {
        throw createVfsError('EINVAL');
      }
      let flags = writable ? (options.read ? OpenFlags.O_RDWR : OpenFlags.O_WRONLY) : OpenFlags.O_RDONLY;
      if (options.create || options.createNew) flags |= OpenFlags.O_CREAT;
      if (options.createNew) flags |= OpenFlags.O_EXCL;
      if (options.truncate) flags |= OpenFlags.O_TRUNC;
      if (options.append) flags |= OpenFlags.O_APPEND;
      const checked = checkedPath(path);
      const fd = vfs.openSync(checked, flags);
      descriptors.set(fd, { path: normalizeFsPath(checked).path, ino: vfs.fstatSync(fd).ino, writable });
      return fd;
    },
    read(fd, length) {
      descriptor(fd);
      return vfs.readSync(fd, length).buffer;
    },
    write(fd, bytes) {
      descriptor(fd);
      return vfs.writeSync(fd, bytes);
    },
    seek(fd, offset, whence) {
      descriptor(fd);
      return vfs.seekSync(fd, offset, whence);
    },
    fstat: (fd) => metadata(descriptor(fd).stat),
    setLen(fd, length) {
      if (!descriptor(fd).writable) throw createVfsError('EBADF');
      vfs.ftruncateSync(fd, length);
    },
    flush(fd) {
      descriptor(fd);
      vfs.fsyncSync(fd);
    },
    close(fd) {
      // Closing must remain possible even if another caller added a hard link.
      const entry = descriptors.get(fd);
      if (!entry || vfs.fstatSync(fd).ino !== entry.ino) throw createVfsError('EBADF');
      vfs.closeSync(fd);
      descriptors.delete(fd);
    },
  };
}
