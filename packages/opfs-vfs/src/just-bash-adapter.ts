import { normalizeFsPath, parentPath } from './fs-path';
import type { OpfsVfsWorker } from './index_internal';
import type { OpfsVfs } from './opfs-vfs';
import { OpenFlags, type VfsDirEntry, type MkdirOptions as VfsMkdirOptions, type VfsStat } from './opfs-vfs';

export type BufferEncoding = 'utf8' | 'utf-8' | 'ascii' | 'binary' | 'base64' | 'hex' | 'latin1';

export type FileContent = string | Uint8Array;

export interface ReadFileOptions {
  encoding?: BufferEncoding | null;
}

export interface WriteFileOptions {
  encoding?: BufferEncoding;
}

export interface DirentEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

export interface FsStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  mode: number;
  size: number;
  mtime: Date;
}

export interface MkdirOptions {
  recursive?: boolean;
}

export interface RmOptions {
  recursive?: boolean;
  force?: boolean;
}

export interface CpOptions {
  recursive?: boolean;
}

interface SyncVfsApi {
  ready?: Promise<void>;
  mkdirSync(path: string, modeOrOptions?: number | VfsMkdirOptions): void;
  openSync(path: string, flags?: number | boolean, mode?: number): number;
  writeSync(fd: number, data: Uint8Array, offset?: number): number;
  readSync(fd: number, size: number, offset?: number): { buffer: Uint8Array; read: number };
  fstatSync(fd: number): VfsStat;
  closeSync(fd: number): void;
  chmodSync(path: string, mode: number): void;
  utimesSync(path: string, atimeMs: number, mtimeMs: number): void;
  symlinkSync(target: string, path: string, mode?: number): void;
  linkSync(existingPath: string, newPath: string): void;
  readlinkSync(path: string): string;
  realpathSync(path: string): string;
  unlinkSync(path: string): void;
  rmdirSync(path: string): void;
  removeSync(path: string): void;
  renameSync(oldPath: string, newPath: string): void;
  existsSync(path: string): boolean;
  statSync(path: string): VfsStat;
  lstatSync(path: string): VfsStat;
  readdirSync(path: string): string[];
  readdirNamesSync(path: string): string[];
  readdirEntriesSync(path: string): VfsDirEntry[];
  listPathsSync(): string[];
}

interface AsyncVfsApi {
  ready?: Promise<void>;
  mkdir(path: string, modeOrOptions?: number | VfsMkdirOptions): Promise<void>;
  open(path: string, flags?: number | boolean, mode?: number): Promise<number>;
  write(fd: number, data: Uint8Array, offset?: number): Promise<number>;
  read(fd: number, size: number, offset?: number): Promise<{ buffer: Uint8Array; read: number }>;
  fstat(fd: number): Promise<VfsStat>;
  close(fd: number): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  utimes(path: string, atimeMs: number, mtimeMs: number): Promise<void>;
  symlink(target: string, path: string, mode?: number): Promise<void>;
  link(existingPath: string, newPath: string): Promise<void>;
  readlink(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<VfsStat>;
  lstat(path: string): Promise<VfsStat>;
  readdir(path: string): Promise<string[]>;
  readdirNames(path: string): Promise<string[]>;
  readdirEntries(path: string): Promise<VfsDirEntry[]>;
  listPaths(): Promise<string[]>;
}

type VfsApi = Partial<SyncVfsApi & AsyncVfsApi>;

type AdapterOperation =
  | 'open'
  | 'write'
  | 'append'
  | 'stat'
  | 'lstat'
  | 'mkdir'
  | 'scandir'
  | 'rm'
  | 'cp'
  | 'mv'
  | 'chmod'
  | 'symlink'
  | 'link'
  | 'readlink'
  | 'realpath'
  | 'utimes';

type ErrorWithCode = Error & { code?: string; errno?: number; path?: string };
type ValidatedPath = { path: string; vfsPath: string };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// SAB-5: upper bound on a single read request issued by readAll. Keeps the
// per-call buffer bounded on every transport (the SAB proxy additionally
// chunks to its own payload cap). 1MiB comfortably fits the default ~4MB SAB.
const READ_ALL_CHUNK_BYTES = 1024 * 1024;

function getEncoding(options?: ReadFileOptions | WriteFileOptions | string | null): BufferEncoding | undefined {
  if (options === null || options === undefined) {
    return undefined;
  }
  if (typeof options === 'string') {
    return options as BufferEncoding;
  }
  return options.encoding ?? undefined;
}

function toBuffer(content: FileContent, encoding?: BufferEncoding): Uint8Array {
  if (content instanceof Uint8Array) {
    // The adapter exposes Node-style writeFile/appendFile ownership: callers may reuse their
    // input after the promise settles. OpfsVfsWorker intentionally transfers (and detaches) a
    // full-owner buffer, so give that lower-level transport an adapter-owned copy. Use `from`
    // rather than `slice`: Buffer is a Uint8Array subtype whose slice() aliases its backing store.
    return Uint8Array.from(content);
  }

  if (encoding === 'base64') {
    return Uint8Array.from(atob(content), (char) => char.charCodeAt(0));
  }
  if (encoding === 'hex') {
    const bytes = new Uint8Array(content.length / 2);
    for (let index = 0; index < content.length; index += 2) {
      bytes[index / 2] = Number.parseInt(content.slice(index, index + 2), 16);
    }
    return bytes;
  }
  if (encoding === 'binary' || encoding === 'latin1' || encoding === 'ascii') {
    const result = new Uint8Array(content.length);
    for (let index = 0; index < content.length; index++) {
      result[index] = content.charCodeAt(index);
    }
    return result;
  }
  return textEncoder.encode(content);
}

function fromBuffer(buffer: Uint8Array, encoding?: BufferEncoding | null): string {
  if (encoding === 'base64') {
    let binary = '';
    const chunkSize = 65536;
    for (let index = 0; index < buffer.length; index += chunkSize) {
      binary += String.fromCharCode(...buffer.subarray(index, index + chunkSize));
    }
    return btoa(binary);
  }
  if (encoding === 'hex') {
    return Array.from(buffer)
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('');
  }
  if (encoding === 'ascii') {
    let result = '';
    const chunkSize = 65536;
    for (let index = 0; index < buffer.length; index += chunkSize) {
      const chunk = buffer.subarray(index, index + chunkSize);
      for (const value of chunk) {
        result += String.fromCharCode(value & 0x7f);
      }
    }
    return result;
  }
  if (encoding === 'binary' || encoding === 'latin1') {
    let result = '';
    const chunkSize = 65536;
    for (let index = 0; index < buffer.length; index += chunkSize) {
      result += String.fromCharCode(...buffer.subarray(index, index + chunkSize));
    }
    return result;
  }
  return textDecoder.decode(buffer);
}

function joinPath(parent: string, child: string): string {
  return parent === '/' ? `/${child}` : `${parent}/${child}`;
}

function toVfsPath(path: string): string {
  const normalized = normalizeFsPath(path);
  return normalized.requiresDirectory && normalized.path !== '/' ? `${normalized.path}/` : normalized.path;
}

function isSymbolicLinkMode(mode: number): boolean {
  return (mode & 0o170000) === 0o120000;
}

function isSameOrDescendantPath(parent: string, child: string): boolean {
  if (parent === child) {
    return true;
  }
  if (parent === '/') {
    return child.startsWith('/');
  }
  return child.startsWith(`${parent}/`);
}

function extractCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function throwError(message: string, code?: string, cause?: unknown): never {
  const error = new Error(message) as ErrorWithCode & { cause?: unknown };
  if (code) {
    error.code = code;
  }
  if (cause && typeof cause === 'object' && cause !== null && 'errno' in cause && typeof cause.errno === 'number') {
    error.errno = cause.errno;
  }
  if (cause && typeof cause === 'object' && cause !== null && 'path' in cause && typeof cause.path === 'string') {
    error.path = cause.path;
  }
  error.cause = cause;
  throw error;
}

function messageForOperation(code: string, operation: AdapterOperation, path: string): string | undefined {
  switch (operation) {
    case 'open':
      if (code === 'ENOENT') return `ENOENT: no such file or directory, open '${path}'`;
      if (code === 'EISDIR') return `EISDIR: illegal operation on a directory, read '${path}'`;
      if (code === 'ELOOP') return `ELOOP: too many levels of symbolic links, open '${path}'`;
      return undefined;
    case 'write':
      if (code === 'ENOENT') return `ENOENT: no such file or directory, write '${path}'`;
      return undefined;
    case 'append':
      if (code === 'ENOENT') return `ENOENT: no such file or directory, append '${path}'`;
      return undefined;
    case 'stat':
      if (code === 'ENOENT') return `ENOENT: no such file or directory, stat '${path}'`;
      return undefined;
    case 'lstat':
      if (code === 'ENOENT') return `ENOENT: no such file or directory, lstat '${path}'`;
      return undefined;
    case 'mkdir':
      if (code === 'EEXIST') return `EEXIST: file already exists, mkdir '${path}'`;
      if (code === 'ENOENT') return `ENOENT: no such file or directory, mkdir '${path}'`;
      return undefined;
    case 'scandir':
      if (code === 'ENOENT') return `ENOENT: no such file or directory, scandir '${path}'`;
      if (code === 'ENOTDIR') return `ENOTDIR: not a directory, scandir '${path}'`;
      return undefined;
    case 'rm':
      if (code === 'ENOENT') return `ENOENT: no such file or directory, rm '${path}'`;
      if (code === 'ENOTEMPTY') return `ENOTEMPTY: directory not empty, rm '${path}'`;
      return undefined;
    case 'cp':
      if (code === 'ENOENT') return `ENOENT: no such file or directory, cp '${path}'`;
      if (code === 'EISDIR') return `EISDIR: is a directory, cp '${path}'`;
      return undefined;
    case 'mv':
      if (code === 'ENOENT') return `ENOENT: no such file or directory, mv '${path}'`;
      return undefined;
    case 'chmod':
      if (code === 'ENOENT') return `ENOENT: no such file or directory, chmod '${path}'`;
      return undefined;
    case 'symlink':
      if (code === 'EEXIST') return `EEXIST: file already exists, symlink '${path}'`;
      return undefined;
    case 'link':
      if (code === 'ENOENT') return `ENOENT: no such file or directory, link '${path}'`;
      if (code === 'EEXIST') return `EEXIST: file already exists, link '${path}'`;
      if (code === 'EPERM') return `EPERM: operation not permitted, link '${path}'`;
      return undefined;
    case 'readlink':
      if (code === 'ENOENT') return `ENOENT: no such file or directory, readlink '${path}'`;
      if (code === 'EINVAL') return `EINVAL: invalid argument, readlink '${path}'`;
      return undefined;
    case 'realpath':
      if (code === 'ENOENT') return `ENOENT: no such file or directory, realpath '${path}'`;
      if (code === 'ELOOP') return `ELOOP: too many levels of symbolic links, realpath '${path}'`;
      return undefined;
    case 'utimes':
      if (code === 'ENOENT') return `ENOENT: no such file or directory, utimes '${path}'`;
      return undefined;
  }
}

function mapStat(stat: VfsStat): FsStat {
  const mtimeMs = stat.mtimeMs ?? stat.timestampMs ?? 0;
  return {
    isFile: stat.is_file,
    isDirectory: stat.is_dir,
    isSymbolicLink: isSymbolicLinkMode(stat.mode),
    mode: stat.mode,
    size: stat.size,
    mtime: new Date(mtimeMs),
  };
}

export class OpfsVfsJustBashAdapter {
  private readonly vfs: VfsApi;
  private readonly readyPromise: Promise<void>;

  constructor(vfs: OpfsVfs | OpfsVfsWorker) {
    this.vfs = vfs as VfsApi;
    this.readyPromise = this.vfs.ready ?? Promise.resolve();
  }

  private validatePath(path: string, operation: AdapterOperation): ValidatedPath {
    if (path.includes('\0')) {
      throwError(`ENOENT: path contains null byte, ${operation} '${path}'`, 'ENOENT');
    }
    const normalized = normalizeFsPath(path);
    return {
      path: normalized.path,
      vfsPath: toVfsPath(path),
    };
  }

  private async call<T>(
    asyncName: keyof AsyncVfsApi,
    syncName: keyof SyncVfsApi,
    operation: AdapterOperation,
    path: string,
    ...args: unknown[]
  ): Promise<T> {
    await this.readyPromise;

    try {
      const asyncMethod = this.vfs[asyncName];
      if (typeof asyncMethod === 'function') {
        return await (asyncMethod as (...callArgs: unknown[]) => Promise<T>).apply(this.vfs, args);
      }
      const syncMethod = this.vfs[syncName];
      if (typeof syncMethod === 'function') {
        return (syncMethod as (...callArgs: unknown[]) => T).apply(this.vfs, args);
      }
      throwError(`ENOSYS: operation not supported, ${operation} '${path}'`, 'ENOSYS');
    } catch (error) {
      const code = extractCode(error);
      if (!code) {
        throw error;
      }
      const message = messageForOperation(code, operation, path);
      if (message) {
        throwError(message, code, error);
      }
      if (error instanceof Error) {
        throw error;
      }
      throwError(String(error), code, error);
    }
  }

  private async ensureParentDirectory(path: string) {
    const parent = parentPath(path);
    if (parent === '/') {
      return;
    }
    await this.mkdir(parent, { recursive: true });
  }

  private async getVfsStat(path: string, followFinalSymlink: boolean) {
    return followFinalSymlink
      ? await this.call<VfsStat>('stat', 'statSync', 'stat', path, path)
      : await this.call<VfsStat>('lstat', 'lstatSync', 'lstat', path, path);
  }

  private async readDirectoryNames(path: string) {
    return await this.call<string[]>('readdirNames', 'readdirNamesSync', 'scandir', path, path);
  }

  private async readAll(fd: number, path: string, size: number) {
    const chunks: Uint8Array[] = [];
    let totalRead = 0;

    while (totalRead < size) {
      // SAB-5: request in bounded chunks regardless of transport. The sync (SAB)
      // path is also chunked at the proxy layer, but capping the request here
      // keeps per-call allocation bounded on the async path too and avoids
      // asking for a multi-hundred-MB buffer in a single call.
      const want = Math.min(size - totalRead, READ_ALL_CHUNK_BYTES);
      const { buffer, read } = await this.call<{ buffer: Uint8Array; read: number }>(
        'read',
        'readSync',
        'open',
        path,
        fd,
        want,
        totalRead,
      );
      if (read <= 0) {
        break;
      }
      chunks.push(buffer.subarray(0, read));
      totalRead += read;
    }

    const result = new Uint8Array(totalRead);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }

  private async writeAll(fd: number, path: string, data: Uint8Array) {
    let written = 0;
    while (written < data.length) {
      const count = await this.call<number>('write', 'writeSync', 'write', path, fd, data.subarray(written));
      if (count <= 0) {
        throwError(`EIO: short write, write '${path}'`);
      }
      written += count;
    }
  }

  private async closeQuietly(fd: number) {
    try {
      await this.call<void>('close', 'closeSync', 'open', `<fd:${fd}>`, fd);
    } catch {}
  }

  async readFile(path: string, options?: ReadFileOptions | BufferEncoding): Promise<string> {
    const buffer = await this.readFileBuffer(path);
    return fromBuffer(buffer, getEncoding(options));
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const validated = this.validatePath(path, 'open');
    const fd = await this.call<number>(
      'open',
      'openSync',
      'open',
      validated.vfsPath,
      validated.vfsPath,
      OpenFlags.O_RDONLY,
    );

    try {
      const stat = await this.call<VfsStat>('fstat', 'fstatSync', 'stat', validated.vfsPath, fd);
      return await this.readAll(fd, validated.vfsPath, stat.size);
    } finally {
      await this.closeQuietly(fd);
    }
  }

  async writeFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void> {
    const validated = this.validatePath(path, 'write');
    await this.ensureParentDirectory(validated.path);
    const fd = await this.call<number>(
      'open',
      'openSync',
      'open',
      validated.vfsPath,
      validated.vfsPath,
      OpenFlags.O_WRONLY | OpenFlags.O_CREAT | OpenFlags.O_TRUNC,
    );

    try {
      await this.writeAll(fd, validated.vfsPath, toBuffer(content, getEncoding(options)));
    } finally {
      await this.closeQuietly(fd);
    }
  }

  async appendFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void> {
    const validated = this.validatePath(path, 'append');
    await this.ensureParentDirectory(validated.path);
    const fd = await this.call<number>(
      'open',
      'openSync',
      'open',
      validated.vfsPath,
      validated.vfsPath,
      OpenFlags.O_WRONLY | OpenFlags.O_CREAT | OpenFlags.O_APPEND,
    );

    try {
      await this.writeAll(fd, validated.vfsPath, toBuffer(content, getEncoding(options)));
    } finally {
      await this.closeQuietly(fd);
    }
  }

  async exists(path: string): Promise<boolean> {
    if (path.includes('\0')) {
      return false;
    }
    const normalized = toVfsPath(path);
    try {
      return await this.call<boolean>('exists', 'existsSync', 'stat', normalized, normalized);
    } catch {
      return false;
    }
  }

  async stat(path: string): Promise<FsStat> {
    const validated = this.validatePath(path, 'stat');
    return mapStat(await this.getVfsStat(validated.vfsPath, true));
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const validated = this.validatePath(path, 'mkdir');
    await this.call<void>(
      'mkdir',
      'mkdirSync',
      'mkdir',
      validated.vfsPath,
      validated.vfsPath,
      options?.recursive ? { recursive: true } : undefined,
    );
  }

  async readdir(path: string): Promise<string[]> {
    return await this.readDirectoryNames(this.validatePath(path, 'scandir').vfsPath);
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    const validated = this.validatePath(path, 'scandir');
    const entries = await this.call<VfsDirEntry[]>(
      'readdirEntries',
      'readdirEntriesSync',
      'scandir',
      validated.vfsPath,
      validated.vfsPath,
    );

    return entries.map((entry) => ({
      name: entry.name,
      isFile: entry.is_file,
      isDirectory: entry.is_dir,
      isSymbolicLink: isSymbolicLinkMode(entry.mode),
    }));
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    const validated = this.validatePath(path, 'rm');

    if (options?.recursive) {
      try {
        await this.call<void>('remove', 'removeSync', 'rm', validated.vfsPath, validated.vfsPath);
        return;
      } catch (error) {
        if (options.force && extractCode(error) === 'ENOENT') {
          return;
        }
        throw error;
      }
    }

    // COR-8: non-recursive `rm` must NOT remove directories. POSIX `rm` and
    // Node `fs.rm` without `{recursive:true}` reject a directory (EISDIR) rather
    // than silently rmdir-ing an empty one. Only `unlink` here; the recursive
    // branch above is the sole path that removes directories.
    try {
      await this.call<void>('unlink', 'unlinkSync', 'rm', validated.vfsPath, validated.vfsPath);
      return;
    } catch (error) {
      const code = extractCode(error);
      if (options?.force && code === 'ENOENT') {
        return;
      }
      throw error;
    }
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    const source = this.validatePath(src, 'cp');
    const target = this.validatePath(dest, 'cp');
    const stat = await this.lstat(source.vfsPath);

    if (stat.isFile) {
      await this.ensureParentDirectory(target.path);
      await this.writeFile(target.vfsPath, await this.readFileBuffer(source.vfsPath));
      await this.chmod(target.vfsPath, stat.mode);
      await this.utimes(target.vfsPath, stat.mtime, stat.mtime);
      return;
    }

    if (stat.isSymbolicLink) {
      await this.ensureParentDirectory(target.path);
      await this.symlink(await this.readlink(source.vfsPath), target.vfsPath);
      return;
    }

    if (!options?.recursive) {
      throwError(`EISDIR: is a directory, cp '${source.path}'`, 'EISDIR');
    }

    if (isSameOrDescendantPath(source.path, target.path) || (await this.copiesIntoItself(source.path, target.path))) {
      throwError(`EINVAL: cannot copy directory into itself, cp '${target.path}'`, 'EINVAL');
    }

    // List before creating the target, so a destination inside the source can
    // never be copied into itself again.
    const entries = await this.readDirectoryNames(source.path);
    await this.mkdir(target.vfsPath, { recursive: true });
    for (const entry of entries) {
      await this.cp(joinPath(source.path, entry), joinPath(target.path, entry), options);
    }
    // COR-1: apply chmod AFTER children are copied. Copying an r-x (no write bit)
    // source directory used to chmod the target read-only first, then fail with
    // EACCES while writing the children into it. Defer the mode change (and the
    // timestamps) until the subtree is fully populated.
    await this.chmod(target.vfsPath, stat.mode);
    await this.utimes(target.vfsPath, stat.mtime, stat.mtime);
  }

  /** Lexical checks miss symlinked parents: compare the real locations. */
  private async copiesIntoItself(source: string, target: string): Promise<boolean> {
    const slash = target.lastIndexOf('/');
    let parent: string;
    try {
      parent = await this.realpath(slash <= 0 ? '/' : target.slice(0, slash));
    } catch {
      return false; // The parent does not exist yet, so it cannot be inside the source.
    }
    const realTarget = parent === '/' ? target.slice(slash) : `${parent}${target.slice(slash)}`;
    return isSameOrDescendantPath(await this.realpath(source), realTarget);
  }

  async mv(src: string, dest: string): Promise<void> {
    const source = this.validatePath(src, 'mv');
    const target = this.validatePath(dest, 'mv');
    await this.ensureParentDirectory(target.path);

    try {
      await this.call<void>('rename', 'renameSync', 'mv', source.vfsPath, source.vfsPath, target.vfsPath);
    } catch (error) {
      if (extractCode(error) === 'EXDEV') {
        await this.cp(source.vfsPath, target.vfsPath, { recursive: true });
        await this.rm(source.vfsPath, { recursive: true });
        return;
      }
      throw error;
    }
  }

  resolvePath(base: string, path: string): string {
    if (path.startsWith('/')) {
      return normalizeFsPath(path).path;
    }
    const normalizedBase = normalizeFsPath(base).path;
    const combined = normalizedBase === '/' ? `/${path}` : `${normalizedBase}/${path}`;
    return normalizeFsPath(combined).path;
  }

  async getAllPaths(): Promise<string[]> {
    return await this.call<string[]>('listPaths', 'listPathsSync', 'scandir', '/', '/');
  }

  async chmod(path: string, mode: number): Promise<void> {
    const validated = this.validatePath(path, 'chmod');
    await this.call<void>('chmod', 'chmodSync', 'chmod', validated.vfsPath, validated.vfsPath, mode);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    const validated = this.validatePath(linkPath, 'symlink');
    await this.ensureParentDirectory(validated.path);
    await this.call<void>('symlink', 'symlinkSync', 'symlink', validated.vfsPath, target, validated.vfsPath);
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    const source = this.validatePath(existingPath, 'link');
    const target = this.validatePath(newPath, 'link');
    await this.ensureParentDirectory(target.path);
    await this.call<void>('link', 'linkSync', 'link', source.vfsPath, source.vfsPath, target.vfsPath);
  }

  async readlink(path: string): Promise<string> {
    const validated = this.validatePath(path, 'readlink');
    return await this.call<string>('readlink', 'readlinkSync', 'readlink', validated.vfsPath, validated.vfsPath);
  }

  async lstat(path: string): Promise<FsStat> {
    const validated = this.validatePath(path, 'lstat');
    return mapStat(await this.getVfsStat(validated.vfsPath, false));
  }

  async realpath(path: string): Promise<string> {
    const validated = this.validatePath(path, 'realpath');
    return await this.call<string>('realpath', 'realpathSync', 'realpath', validated.vfsPath, validated.vfsPath);
  }

  async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    const validated = this.validatePath(path, 'utimes');
    await this.call<void>(
      'utimes',
      'utimesSync',
      'utimes',
      validated.vfsPath,
      validated.vfsPath,
      atime.getTime(),
      mtime.getTime(),
    );
  }
}
