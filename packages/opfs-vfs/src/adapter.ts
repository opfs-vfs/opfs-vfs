import type { PGlite, postgresMod } from '@electric-sql/pglite';
import { BaseFilesystem, ERRNO_CODES, type FsStats } from '@electric-sql/pglite/basefs';
import { normalizeFsPath } from './fs-path';
import { type LocalPersistenceStatus, OpenFlags, type VfsStat } from './opfs-vfs';

const PGLITE_DATA_DIR = '/pglite/data';
const ENOSYS_ERRNO = 52;
// PERF-11/PERF-12: hoisted encoder for writeFile's string path.
const sharedTextEncoder = new TextEncoder();
// Emscripten/WASI numbering (see PGlite's errno table), for codes its ERRNO_CODES lacks.
const EMFS_ERRNO_CODES: Record<string, number> = {
  EACCES: 2,
  EBUSY: 10,
  EFBIG: 22,
  EIO: 29,
  ELOOP: 32,
  ENAMETOOLONG: 37,
  ENOSPC: 51,
  ENOSYS: ENOSYS_ERRNO,
  EPERM: 63,
};
/** Errors this adapter already mapped; only their numeric code is an Emscripten errno. */
const wrappedErrors = new WeakSet<object>();

type PostgresMod = postgresMod.PostgresMod;
type BridgeGetattrResult = Omit<FsStats, 'atime' | 'mtime' | 'ctime'> & {
  atime: Date;
  mtime: Date;
  ctime: Date;
};

interface BridgeNode {
  parent: BridgeNode;
  name: string;
  mount: { opts: { root: string } };
  rdev: number;
  mode: number;
  node_ops?: BridgeFilesystem['node_ops'];
  stream_ops?: BridgeFilesystem['stream_ops'];
}

interface BridgeStream {
  node: BridgeNode;
  flags: number;
  position: number;
  nfd?: number;
  shared: { refcount: number };
}

interface BridgeFs {
  ErrnoError: new (errno: number) => Error;
  isDir(mode: number): boolean;
  isFile(mode: number): boolean;
  isLink(mode: number): boolean;
  mkdir(path: string, mode?: number): BridgeNode;
  mount(filesystem: BridgeFilesystem, opts: unknown, root: string): BridgeNode;
  lookupPath(path: string, options: { follow: boolean }): { node: BridgeNode };
  createNode(parent: BridgeNode | null, name: string, mode: number, dev?: number): BridgeNode;
}

interface BridgeModule extends PostgresMod {
  FS: BridgeFs;
  HEAP8: Uint8Array;
  mmapAlloc(length: number): number;
}

interface BridgeFilesystem {
  mount(): BridgeNode;
  syncfs(_mount: unknown, _populate: unknown, _callback: unknown): void;
  createNode(parent: BridgeNode | null, name: string, mode: number, dev?: number): BridgeNode;
  getMode(path: string): number;
  node_ops: {
    getattr(node: BridgeNode): BridgeGetattrResult;
    setattr(node: BridgeNode, attrs: { mode?: number; size?: number; timestamp?: number }): void;
    lookup(parent: BridgeNode, name: string): BridgeNode;
    mknod(parent: BridgeNode, name: string, mode: number, dev: number): BridgeNode;
    rename(node: BridgeNode, newParent: BridgeNode, newName: string): void;
    unlink(parent: BridgeNode, name: string): void;
    rmdir(parent: BridgeNode, name: string): void;
    readdir(node: BridgeNode): string[];
    symlink(parent: BridgeNode, name: string, target: string): void;
    readlink(node: BridgeNode): string;
  };
  stream_ops: {
    open(stream: BridgeStream): void;
    close(stream: BridgeStream): void;
    dup(stream: BridgeStream): void;
    read(stream: BridgeStream, buffer: Uint8Array, offset: number, length: number, position: number): number;
    write(stream: BridgeStream, buffer: Uint8Array, offset: number, length: number, position: number): number;
    llseek(stream: BridgeStream, offset: number, whence: number): number;
    mmap(
      stream: BridgeStream,
      length: number,
      position: number,
      prot: number,
      flags: number,
    ): { ptr: number; allocated: boolean };
    msync(stream: BridgeStream, buffer: Uint8Array, offset: number, length: number, mmapFlags: number): number;
  };
}

export interface VfsSyncApi {
  mkdirSync(path: string, mode?: number): void;
  openSync(path: string, flags?: number, mode?: number): number;
  writeSync(fd: number, data: Uint8Array, offset?: number): number;
  readSync(fd: number, size: number, offset?: number): { buffer: Uint8Array; read: number };
  readInto?(fd: number, target: Uint8Array, offset?: number): number;
  seekSync(fd: number, offset: number, whence: number): number;
  closeSync(fd: number): void;
  fstatSync?(fd: number): VfsStat;
  fsyncSync?(fd: number): void;
  ftruncateSync?(fd: number, size: number): void;
  chmodSync?(path: string, mode: number): void;
  utimesSync?(path: string, atimeMs: number, mtimeMs: number): void;
  symlinkSync?(target: string, path: string, mode?: number): void;
  readlinkSync?(path: string): string;
  realpathSync?(path: string): string;
  lstatSync?(path: string): VfsStat;
  unlinkSync?(path: string): void;
  rmdirSync?(path: string): void;
  removeSync?(path: string): void;
  renameSync(oldPath: string, newPath: string): void;
  truncateSync(path: string, size: number): void;
  existsSync(path: string): boolean;
  statSync(path: string): VfsStat;
  readdirSync(path: string): string[];
  syncSync(): void;
  flushVfs?(): void | Promise<void>;
  closeVfs?(): void | Promise<void>;
  getLocalPersistenceStatusSync?(): LocalPersistenceStatus;
}

export class OpfsVfsPGliteAdapter extends BaseFilesystem {
  private vfs: VfsSyncApi;
  private relaxed: boolean;
  private fdPaths = new Map<number, string>();
  private log: ((...args: unknown[]) => void) | null = null;
  private pgOpenCount = 0;

  constructor(vfs: VfsSyncApi, options: { relaxedDurability?: boolean; debug?: boolean } = {}) {
    super(undefined, { debug: options.debug });
    this.vfs = vfs;
    this.relaxed = options.relaxedDurability ?? true;
    if (options.debug) {
      this.log = (...args: unknown[]) => {
        try {
          self.postMessage({ type: 'LOG', msg: args.map(String).join(' ') });
        } catch {}
      };
    }
  }

  private normalizePath(path: string): string {
    return normalizeFsPath(path).path;
  }

  private toErrnoCode(error: unknown, fallbackCode: number): number {
    if (typeof error !== 'object' || error === null) return fallbackCode;
    const { code, errno, name } = error as { code?: unknown; errno?: unknown; name?: unknown };
    // Numbers are only trusted where they are known to be Emscripten errnos: a
    // DOMException's legacy code or a VfsError's Linux errno would map to the
    // wrong error (Linux EFBIG 27 is EINTR here, so Postgres retries forever).
    if (wrappedErrors.has(error) && typeof code === 'number') return code;
    if (name === 'ErrnoError' && typeof errno === 'number') return errno;
    if (typeof code === 'string') {
      const errnoCode = (ERRNO_CODES as Record<string, number | undefined>)[code] ?? EMFS_ERRNO_CODES[code];
      if (errnoCode !== undefined) return errnoCode;
    }
    if (name === 'QuotaExceededError') return EMFS_ERRNO_CODES.ENOSPC!;
    if (error instanceof DOMException) return EMFS_ERRNO_CODES.EIO!;
    return fallbackCode;
  }

  private wrapFsError(error: unknown, fallbackCode: number): Error & { code: number } {
    const message = error instanceof Error ? error.message : String(error);
    const err = new Error(message) as Error & { code: number };
    err.code = this.toErrnoCode(error, fallbackCode);
    wrappedErrors.add(err);
    return err;
  }

  async init(pg: PGlite, emscriptenOptions: Partial<PostgresMod>): Promise<{ emscriptenOpts: Partial<PostgresMod> }> {
    this.pg = pg;
    this.pgOpenCount++;
    const origPreRun = emscriptenOptions.preRun || [];
    return {
      emscriptenOpts: {
        ...emscriptenOptions,
        preRun: [
          (mod: PostgresMod) => {
            const bridgeModule = mod as BridgeModule;
            // Patch FS.mkdir to tolerate existing directories (EEXIST).
            const origMkdir = bridgeModule.FS.mkdir.bind(bridgeModule.FS);
            bridgeModule.FS.mkdir = (path: string, mode?: number) => {
              try {
                return origMkdir(path, mode);
              } catch (error) {
                const errno =
                  typeof error === 'object' && error !== null && 'errno' in error && typeof error.errno === 'number'
                    ? error.errno
                    : undefined;
                if (errno === ERRNO_CODES.EEXIST) {
                  return bridgeModule.FS.lookupPath(path, { follow: true }).node;
                }
                throw error;
              }
            };
          },
          ...origPreRun,
          (mod: PostgresMod) => {
            const bridgeModule = mod as BridgeModule;
            const fsBridge = this.createPGliteFilesystemBridge(bridgeModule);
            bridgeModule.FS.mkdir(PGLITE_DATA_DIR);
            bridgeModule.FS.mount(fsBridge, {}, PGLITE_DATA_DIR);
          },
        ],
      },
    };
  }

  private createPGliteFilesystemBridge(mod: BridgeModule): BridgeFilesystem {
    const fs = mod.FS;
    const debugLog = this.debug ? console.log : null;
    // Bridge methods have their own `this`; keep the adapter instance available.
    // oxlint-disable-next-line typescript/no-this-alias
    const adapter = this;

    const tryFsOperation = <T>(operation: () => T): T => {
      try {
        return operation();
      } catch (error) {
        throw new fs.ErrnoError(adapter.toErrnoCode(error, ERRNO_CODES.EINVAL));
      }
    };

    const realPath = (node: BridgeNode): string => {
      const parts: string[] = [];
      let current = node;
      while (current.parent !== current) {
        parts.push(current.name);
        current = current.parent;
      }
      parts.push(current.mount.opts.root);
      parts.reverse();
      return parts.join('/');
    };

    const bridge: BridgeFilesystem = {
      mount() {
        return bridge.createNode(null, '/', 16895, 0);
      },
      syncfs(_mount: unknown, _populate: unknown, _callback: unknown) {},
      createNode(parent: BridgeNode | null, name: string, mode: number, dev?: number) {
        if (!fs.isDir(mode) && !fs.isFile(mode) && !fs.isLink(mode)) {
          throw new fs.ErrnoError(ERRNO_CODES.EINVAL);
        }
        const node = fs.createNode(parent, name, mode, dev);
        node.node_ops = bridge.node_ops;
        node.stream_ops = bridge.stream_ops;
        return node;
      },
      getMode(path: string) {
        debugLog?.('getMode', path);
        return tryFsOperation(() => adapter.lstat(path).mode);
      },
      node_ops: {
        getattr(node: BridgeNode) {
          const path = realPath(node);
          debugLog?.('getattr', path);
          return tryFsOperation(() => {
            const stats = adapter.lstat(path);
            return {
              ...stats,
              dev: 0,
              ino: stats.ino,
              nlink: stats.nlink,
              rdev: node.rdev,
              atime: new Date(stats.atime),
              mtime: new Date(stats.mtime),
              ctime: new Date(stats.ctime),
            };
          });
        },
        setattr(node: BridgeNode, attrs: { mode?: number; size?: number; timestamp?: number }) {
          const path = realPath(node);
          debugLog?.('setattr', path, JSON.stringify(attrs));
          tryFsOperation(() => {
            if (attrs.mode !== undefined) adapter.chmod(path, attrs.mode);
            if (attrs.size !== undefined) adapter.truncate(path, attrs.size);
            if (attrs.timestamp !== undefined) {
              adapter.utimes(path, attrs.timestamp, attrs.timestamp);
            }
          });
        },
        lookup(parent: BridgeNode, name: string) {
          const parentPath = realPath(parent);
          debugLog?.('lookup', parentPath, name);
          const path = `${parentPath}/${name}`;
          const mode = bridge.getMode(path);
          return bridge.createNode(parent, name, mode);
        },
        mknod(parent: BridgeNode, name: string, mode: number, dev: number) {
          const parentPath = realPath(parent);
          debugLog?.('mknod', parentPath, name, mode, dev);
          const node = bridge.createNode(parent, name, mode, dev);
          const path = realPath(node);
          return tryFsOperation(() => {
            if (fs.isDir(node.mode)) {
              adapter.mkdir(path, { mode });
            } else {
              adapter.writeFile(path, '', { mode });
            }
            return node;
          });
        },
        rename(node: BridgeNode, newParent: BridgeNode, newName: string) {
          const oldPath = realPath(node);
          const newPath = `${realPath(newParent)}/${newName}`;
          debugLog?.('rename', oldPath, newPath);
          tryFsOperation(() => {
            adapter.rename(oldPath, newPath);
          });
          node.name = newName;
        },
        unlink(parent: BridgeNode, name: string) {
          const path = `${realPath(parent)}/${name}`;
          debugLog?.('unlink', realPath(parent), name);
          tryFsOperation(() => {
            adapter.unlink(path);
          });
        },
        rmdir(parent: BridgeNode, name: string) {
          const path = `${realPath(parent)}/${name}`;
          debugLog?.('rmdir', realPath(parent), name);
          return tryFsOperation(() => {
            adapter.rmdir(path);
          });
        },
        readdir(node: BridgeNode) {
          const path = realPath(node);
          debugLog?.('readdir', path);
          return tryFsOperation(() => adapter.readdir(path));
        },
        symlink(parent: BridgeNode, name: string, target: string) {
          const path = `${realPath(parent)}/${name}`;
          debugLog?.('symlink', realPath(parent), name, target);
          return tryFsOperation(() => {
            adapter.symlink(target, path);
          });
        },
        readlink(node: BridgeNode) {
          const path = realPath(node);
          debugLog?.('readlink', path);
          return tryFsOperation(() => adapter.readlink(path));
        },
      },
      stream_ops: {
        open(stream: BridgeStream) {
          const path = realPath(stream.node);
          debugLog?.('open stream', path, stream.flags);
          return tryFsOperation(() => {
            if (fs.isFile(stream.node.mode)) {
              stream.shared.refcount = 1;
              stream.nfd = adapter.open(path, stream.flags);
            }
          });
        },
        close(stream: BridgeStream) {
          if (debugLog) debugLog('close stream', realPath(stream.node));
          return tryFsOperation(() => {
            if (fs.isFile(stream.node.mode) && stream.nfd !== undefined && --stream.shared.refcount === 0) {
              adapter.close(stream.nfd);
            }
          });
        },
        dup(stream: BridgeStream) {
          debugLog?.('dup stream', realPath(stream.node));
          stream.shared.refcount++;
        },
        read(stream: BridgeStream, buffer: Uint8Array, offset: number, length: number, position: number) {
          if (debugLog) debugLog('read stream', realPath(stream.node), offset, length, position);
          return tryFsOperation(() => adapter.read(stream.nfd!, buffer, offset, length, position));
        },
        write(stream: BridgeStream, buffer: Uint8Array, offset: number, length: number, position: number) {
          if (debugLog) debugLog('write stream', realPath(stream.node), offset, length, position);
          return tryFsOperation(() => adapter.write(stream.nfd!, buffer, offset, length, position));
        },
        llseek(stream: BridgeStream, offset: number, whence: number) {
          if (debugLog) debugLog('llseek stream', realPath(stream.node), offset, whence);
          let nextOffset = offset;
          if (whence === 1) {
            nextOffset += stream.position;
          } else if (whence === 2 && fs.isFile(stream.node.mode)) {
            tryFsOperation(() => {
              nextOffset += adapter.fstat(stream.nfd!).size;
            });
          }
          if (nextOffset < 0) {
            throw new fs.ErrnoError(ERRNO_CODES.EINVAL);
          }
          return nextOffset;
        },
        mmap(stream: BridgeStream, length: number, position: number, prot: number, flags: number) {
          const path = realPath(stream.node);
          debugLog?.('mmap stream', path, length, position, prot, flags);
          if (!fs.isFile(stream.node.mode)) {
            throw new fs.ErrnoError(ERRNO_CODES.ENODEV);
          }
          const ptr = mod.mmapAlloc(length);
          bridge.stream_ops.read(stream, mod.HEAP8, ptr, length, position);
          return { ptr, allocated: true };
        },
        msync(stream: BridgeStream, buffer: Uint8Array, offset: number, length: number, mmapFlags: number) {
          const path = realPath(stream.node);
          debugLog?.('msync stream', path, offset, length, mmapFlags);
          // COR-8 verified: the `0` buffer offset is correct. `buffer` is the
          // mmap'd region and `offset` is the FILE position, so we write `length`
          // bytes from the start of the region to file position `offset`. This
          // matches PGlite's own EMFS.msync contract verbatim
          // (pglite/src/fs/base.ts: `write(stream, buffer, 0, length, offset)`).
          bridge.stream_ops.write(stream, buffer, 0, length, offset);
          return 0;
        },
      },
    };

    return bridge;
  }

  async closeFs(): Promise<void> {
    this.pgOpenCount = Math.max(0, this.pgOpenCount - 1);
    if (this.pgOpenCount > 0) {
      await Promise.resolve(this.vfs.flushVfs?.());
      return;
    }
    if (this.vfs.closeVfs) {
      await Promise.resolve(this.vfs.closeVfs());
      return;
    }
    await Promise.resolve(this.vfs.flushVfs?.());
  }

  async syncToFs(relaxedDurability?: boolean): Promise<void> {
    // In relaxed mode, skip sync entirely — data lives in memory until close.
    // In strict mode, persist dirty files to OPFS and flush.
    // Note: syncToFs is called from within Emscripten C callbacks, so we must
    // avoid heavy I/O here. syncSync only persists files modified since last sync.
    if (relaxedDurability || this.relaxed) return;
    this.vfs.syncSync();
  }

  close(fd: number): void {
    // COR-7: do not swallow close errors (previously `catch {}` hid EBADF). The
    // bridge already refcount-guards close, so a throw here is a genuine bad-fd
    // condition the caller should see. Always drop the path mapping, even on error,
    // so a re-close cannot resurrect a stale fd->path entry.
    try {
      this.vfs.closeSync(fd);
    } catch (error) {
      this.fdPaths.delete(fd);
      throw this.wrapFsError(error, ERRNO_CODES.EBADF);
    }
    this.fdPaths.delete(fd);
  }

  private makeFsStats(
    stat: Partial<VfsStat> & { size: number; mode: number; is_file: boolean; is_dir: boolean; timestampMs?: number },
  ): FsStats {
    const atime = stat.atimeMs ?? stat.mtimeMs ?? stat.ctimeMs ?? stat.timestampMs ?? Date.now();
    const mtime = stat.mtimeMs ?? atime;
    const ctime = stat.ctimeMs ?? mtime;
    return {
      dev: 0,
      ino: stat.ino ?? 0,
      mode: stat.mode,
      nlink: stat.nlink ?? 1,
      uid: 0,
      gid: 0,
      rdev: 0,
      size: stat.size,
      blksize: stat.blksize ?? 4096,
      blocks: stat.blocks ?? Math.ceil(stat.size / 4096),
      atime,
      mtime,
      ctime,
    };
  }

  private makeBufferView(buffer: Uint8Array | ArrayBuffer, offset: number, length: number): Uint8Array {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > buffer.byteLength ||
      !Number.isSafeInteger(length) ||
      length < 0
    ) {
      throw this.wrapFsError(
        new Error(`Invalid buffer window (offset=${offset}, length=${length})`),
        ERRNO_CODES.EINVAL,
      );
    }
    const ab = buffer instanceof ArrayBuffer ? buffer : buffer.buffer;
    const byteOffset = (buffer instanceof ArrayBuffer ? 0 : buffer.byteOffset) + offset;
    return new Uint8Array(ab, byteOffset, Math.min(length, buffer.byteLength - offset));
  }

  private toVfsOpenFlags(flags?: string | number): number {
    if (typeof flags === 'number') {
      const accessMode = flags & 0x3;
      return accessMode | (flags & (OpenFlags.O_CREAT | OpenFlags.O_EXCL | OpenFlags.O_TRUNC | OpenFlags.O_APPEND));
    }

    switch (flags ?? 'r') {
      case 'r':
        return OpenFlags.O_RDONLY;
      case 'r+':
        return OpenFlags.O_RDWR;
      case 'w':
        return OpenFlags.O_WRONLY | OpenFlags.O_CREAT | OpenFlags.O_TRUNC;
      case 'w+':
        return OpenFlags.O_RDWR | OpenFlags.O_CREAT | OpenFlags.O_TRUNC;
      case 'wx':
      case 'xw':
        return OpenFlags.O_WRONLY | OpenFlags.O_CREAT | OpenFlags.O_TRUNC | OpenFlags.O_EXCL;
      case 'wx+':
      case 'xw+':
        return OpenFlags.O_RDWR | OpenFlags.O_CREAT | OpenFlags.O_TRUNC | OpenFlags.O_EXCL;
      case 'a':
        return OpenFlags.O_WRONLY | OpenFlags.O_CREAT | OpenFlags.O_APPEND;
      case 'a+':
        return OpenFlags.O_RDWR | OpenFlags.O_CREAT | OpenFlags.O_APPEND;
      case 'ax':
      case 'xa':
        return OpenFlags.O_WRONLY | OpenFlags.O_CREAT | OpenFlags.O_APPEND | OpenFlags.O_EXCL;
      case 'ax+':
      case 'xa+':
        return OpenFlags.O_RDWR | OpenFlags.O_CREAT | OpenFlags.O_APPEND | OpenFlags.O_EXCL;
      default: {
        const err = new Error(`Invalid open flag: ${flags}`) as Error & { code: number };
        err.code = ERRNO_CODES.EINVAL;
        throw err;
      }
    }
  }

  fstat(fd: number): FsStats {
    // COR-7: propagate the real error instead of fabricating {size:0, mode:33188}.
    // The fabricated stat masked EBADF/ENOENT and silently reported every failing
    // fd as a 0-byte regular file. Prefer fstatSync (fd-keyed); fall back to a
    // path-based stat ONLY when the fd has no fstat support, then surface whatever
    // the underlying FS reports.
    if (this.vfs.fstatSync) {
      try {
        return this.makeFsStats(this.vfs.fstatSync(fd));
      } catch (error) {
        // The path fallback below cannot help an fd-level error (EBADF), so rethrow.
        throw this.wrapFsError(error, ERRNO_CODES.EBADF);
      }
    }
    const path = this.fdPaths.get(fd);
    if (path) {
      try {
        return this.makeFsStats(this.vfs.statSync(path));
      } catch (error) {
        throw this.wrapFsError(error, ERRNO_CODES.ENOENT);
      }
    }
    // No fstat support and no known path for this fd: this is a bad descriptor.
    throw this.wrapFsError(new Error('EBADF'), ERRNO_CODES.EBADF);
  }

  lstat(path: string): FsStats {
    const p = this.normalizePath(path);
    try {
      const meta = this.vfs.lstatSync ? this.vfs.lstatSync(p) : this.vfs.statSync(p);
      return this.makeFsStats(meta);
    } catch (error) {
      this.log?.('lstat ERROR', p, error instanceof Error ? error.message : String(error));
      throw this.wrapFsError(error, ERRNO_CODES.ENOENT);
    }
  }

  symlink(target: string, path: string): void {
    const p = this.normalizePath(path);
    if (!this.vfs.symlinkSync) {
      throw this.wrapFsError(new Error('ENOSYS'), ENOSYS_ERRNO);
    }
    this.vfs.symlinkSync(target, p);
  }

  readlink(path: string): string {
    const p = this.normalizePath(path);
    if (!this.vfs.readlinkSync) {
      throw this.wrapFsError(new Error('ENOSYS'), ENOSYS_ERRNO);
    }
    return this.vfs.readlinkSync(p);
  }

  realpath(path: string): string {
    const p = this.normalizePath(path);
    if (this.vfs.realpathSync) {
      return this.vfs.realpathSync(p);
    }
    return p;
  }

  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): void {
    const p = this.normalizePath(path);
    if (options?.recursive) {
      const parts = p.split('/').filter(Boolean);
      let current = '';
      for (const part of parts) {
        current = `${current}/${part}`;
        try {
          this.vfs.mkdirSync(current, options.mode);
        } catch (error) {
          if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) {
            throw error;
          }
        }
      }
      return;
    }

    try {
      this.vfs.mkdirSync(p, options?.mode);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') return;
      throw error;
    }
  }

  open(path: string, flags?: string | number): number {
    const p = this.normalizePath(path);
    const mappedFlags = this.toVfsOpenFlags(flags);
    const fd = this.vfs.openSync(p, mappedFlags);
    this.fdPaths.set(fd, p);
    return fd;
  }

  readdir(path: string): string[] {
    // COR-7: propagate the real error instead of returning []. Swallowing it made
    // a missing directory (ENOENT) or a non-directory (ENOTDIR) look like an empty
    // directory, hiding genuine path errors from PGlite/Emscripten.
    const p = this.normalizePath(path);
    try {
      return this.vfs.readdirSync(p);
    } catch (error) {
      throw this.wrapFsError(error, ERRNO_CODES.ENOENT);
    }
  }

  read(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number {
    const target = this.makeBufferView(buffer, offset, length);
    if (target.byteLength === 0) return 0;

    let bytesRead: number;
    let source: Uint8Array | undefined;
    if (this.vfs.readInto) {
      bytesRead = this.vfs.readInto(fd, target, position);
    } else {
      const result = this.vfs.readSync(fd, target.byteLength, position);
      bytesRead = result.read;
      source = result.buffer;
    }
    if (
      !Number.isSafeInteger(bytesRead) ||
      bytesRead < 0 ||
      bytesRead > target.byteLength ||
      (source && bytesRead > source.byteLength)
    ) {
      throw this.wrapFsError(new Error('Invalid read count'), ERRNO_CODES.EINVAL);
    }
    if (source) target.set(source.subarray(0, bytesRead));
    return bytesRead;
  }

  readFile(path: string): Uint8Array {
    const p = this.normalizePath(path);
    const fd = this.vfs.openSync(p, OpenFlags.O_RDONLY);
    let completed = false;
    try {
      const stat = this.vfs.statSync(p);
      const buf = new Uint8Array(stat.size);
      if (stat.size > 0) this.read(fd, buf, 0, stat.size, 0);
      completed = true;
      return buf;
    } finally {
      if (completed) this.vfs.closeSync(fd);
      else {
        // Preserve the operation error if descriptor cleanup also fails.
        try {
          this.vfs.closeSync(fd);
        } catch {}
      }
    }
  }

  rename(oldPath: string, newPath: string): void {
    const oldP = this.normalizePath(oldPath);
    const newP = this.normalizePath(newPath);
    try {
      this.vfs.renameSync(oldP, newP);
      const oldPrefix = `${oldP}/`;
      for (const [fd, path] of this.fdPaths) {
        if (path === oldP) {
          this.fdPaths.set(fd, newP);
        } else if (path.startsWith(oldPrefix)) {
          this.fdPaths.set(fd, `${newP}${path.slice(oldP.length)}`);
        }
      }
    } catch (e: unknown) {
      throw this.wrapFsError(e, ERRNO_CODES.EINVAL);
    }
  }

  rmdir(path: string): void {
    const p = this.normalizePath(path);
    if (this.vfs.rmdirSync) {
      this.vfs.rmdirSync(p);
      return;
    }
    this.vfs.removeSync?.(p);
  }
  truncate(path: string, len: number): void {
    this.vfs.truncateSync(this.normalizePath(path), len);
  }
  unlink(path: string): void {
    const p = this.normalizePath(path);
    if (this.vfs.unlinkSync) {
      this.vfs.unlinkSync(p);
      return;
    }
    this.vfs.removeSync?.(p);
  }
  chmod(path: string, mode: number): void {
    this.vfs.chmodSync?.(this.normalizePath(path), mode);
  }
  utime(path: string, atime: Date | number, mtime: Date | number): void {
    const atimeMs = atime instanceof Date ? atime.getTime() : atime;
    const mtimeMs = mtime instanceof Date ? mtime.getTime() : mtime;
    this.vfs.utimesSync?.(this.normalizePath(path), atimeMs, mtimeMs);
  }
  utimes(path: string, atime: number, mtime: number): void {
    this.utime(path, atime, mtime);
  }

  writeFile(path: string, data: string | Uint8Array, options?: { mode?: number }): void {
    const p = this.normalizePath(path);
    const uint8 =
      typeof data === 'string'
        ? sharedTextEncoder.encode(data)
        : data instanceof Uint8Array
          ? data
          : new Uint8Array(data);
    const fd = this.vfs.openSync(p, OpenFlags.O_CREAT | OpenFlags.O_WRONLY | OpenFlags.O_TRUNC, options?.mode);
    let completed = false;
    try {
      if (uint8.length > 0) this.vfs.writeSync(fd, uint8, 0);
      completed = true;
    } finally {
      if (completed) this.vfs.closeSync(fd);
      else {
        // Preserve the operation error if descriptor cleanup also fails.
        try {
          this.vfs.closeSync(fd);
        } catch {}
      }
    }
    if (options?.mode !== undefined) {
      this.vfs.chmodSync?.(p, options.mode);
    }
  }

  write(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number {
    const view = this.makeBufferView(buffer, offset, length);
    return this.vfs.writeSync(fd, view, position);
  }
}
