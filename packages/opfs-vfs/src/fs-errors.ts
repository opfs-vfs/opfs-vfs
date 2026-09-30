export type VfsErrno =
  | 'EACCES'
  | 'EBADF'
  | 'EBUSY'
  | 'EEXIST'
  | 'EFBIG'
  | 'EINVAL'
  | 'EISDIR'
  | 'ELOOP'
  | 'ENAMETOOLONG'
  | 'ENOENT'
  | 'ENOSPC'
  | 'ENOTDIR'
  | 'ENOTEMPTY'
  | 'ENOTSUP'
  | 'EPERM';

export class StoragePluginRequiredError extends Error {
  readonly code = 'VFS_STORAGE_PLUGIN_REQUIRED';
  readonly errno = 22;
  readonly path: string;

  constructor(path: string, sidecar: string) {
    super(`VFS_STORAGE_PLUGIN_REQUIRED: This volume requires a plugin that owns ${sidecar} (${path})`);
    this.name = 'StoragePluginRequiredError';
    this.path = path;
  }
}

const ERROR_NUMBERS: Record<VfsErrno, number> = {
  EACCES: 13,
  EBADF: 9,
  EBUSY: 16,
  EEXIST: 17,
  EFBIG: 27,
  EINVAL: 22,
  EISDIR: 21,
  ELOOP: 40,
  ENAMETOOLONG: 36,
  ENOENT: 2,
  ENOSPC: 28,
  ENOTDIR: 20,
  ENOTEMPTY: 39,
  ENOTSUP: 95,
  EPERM: 1,
};

const ERROR_MESSAGES: Record<VfsErrno, string> = {
  EACCES: 'Permission denied',
  EBADF: 'Bad file descriptor',
  EBUSY: 'Resource busy',
  EEXIST: 'File exists',
  EFBIG: 'File too large',
  EINVAL: 'Invalid argument',
  EISDIR: 'Is a directory',
  ELOOP: 'Too many levels of symbolic links',
  ENAMETOOLONG: 'File name too long',
  ENOENT: 'No such file or directory',
  ENOSPC: 'No space left on device',
  ENOTDIR: 'Not a directory',
  ENOTEMPTY: 'Directory not empty',
  ENOTSUP: 'Operation not supported',
  EPERM: 'Operation not permitted',
};

export const isVfsErrno = (value: unknown): value is VfsErrno =>
  typeof value === 'string' && Object.hasOwn(ERROR_NUMBERS, value);

export class VfsError extends Error {
  code: VfsErrno;
  errno: number;
  path?: string;

  constructor(code: VfsErrno, path?: string, detail?: string) {
    const base = detail ?? ERROR_MESSAGES[code];
    super(path ? `${code}: ${base} (${path})` : `${code}: ${base}`);
    this.name = 'VfsError';
    this.code = code;
    this.errno = ERROR_NUMBERS[code];
    this.path = path;
  }
}

export function createVfsError(code: VfsErrno, path?: string, detail?: string): VfsError {
  return new VfsError(code, path, detail);
}

/**
 * §6.2 — corruption category for the recovery contract. Each on-disk structure
 * the VFS validates maps to one category, surfaced via {@link VfsCorruptionError}
 * and the persistence status `lastError`. Apps switch on `category` to decide
 * how to react (e.g. re-init vs. surface to the user).
 */
export type VfsCorruptionCategory =
  | 'meta-snapshot' // A/B meta snapshot envelope failed CRC / parse and no valid fallback.
  | 'data-wal' // data WAL frame failed checksum / structural decode / apply.
  | 'bitmap' // bitmap frame magic/CRC mismatch (advisory cache — rebuilt from meta).
  | 'meta-log' // meta-log committed batch failed its CRC.
  | 'format-version'; // an on-disk header carried an unknown/future format version (§6.4).

/**
 * §6.2 — base class for every typed corruption the VFS detects on disk. A
 * common `category` lets callers handle all corruption uniformly while still
 * distinguishing the source. `DataWalCorruptionError` (data-wal.ts) and
 * `MetaSnapshotCorruptionError` (binary-metadata.ts) extend this so
 * `error instanceof VfsCorruptionError` matches any of them.
 */
export class VfsCorruptionError extends Error {
  readonly category: VfsCorruptionCategory;
  /** Byte offset of the corrupt frame/record where meaningful (else undefined). */
  readonly offset?: number;

  constructor(category: VfsCorruptionCategory, message: string, offset?: number) {
    super(message);
    this.name = 'VfsCorruptionError';
    this.category = category;
    this.offset = offset;
  }
}

export function isVfsCorruptionError(error: unknown): error is VfsCorruptionError {
  return error instanceof VfsCorruptionError;
}

export function isVfsError(error: unknown): error is VfsError {
  return error instanceof Error && typeof (error as { code?: unknown }).code === 'string';
}
