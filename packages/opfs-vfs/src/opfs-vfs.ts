/**
 * OpfsVfs - Pure JS container VFS using OPFS SyncAccessHandle.
 *
 * A bounded set of OPFS files: block data plus crash-safe metadata, allocation,
 * mode-specific WAL, bootstrap, and optional encryption sidecars.
 *
 * Two buffer modes:
 * - 'disk' (default): reads/writes use mapped OPFS data blocks without keeping
 *   a full copy of file contents in RAM. Metadata still consumes memory.
 * - 'memory': keeps file contents in Uint8Array buffers and logs writes to OPFS.
 *   Memory use grows with file contents; useful for workloads that benefit from caching.
 * Local durability defaults to 'balanced', which schedules background synchronization.
 */

import {
  deserializeBinaryMeta,
  frameMetaSnapshot,
  MetaSnapshotCorruptionError,
  parseMetaSnapshot,
  replayLog,
  serializeLogAttrRecord,
  serializeLogRecord,
  serializeLogTransaction,
  serializeMeta,
} from './binary-metadata';
import {
  crc32,
  DataWalCorruptionError,
  type DataWalRecord,
  decodeDataWalRecords,
  encodeDataWalRecord,
  replayDataWalRecords,
} from './data-wal';
import { createVfsError, isVfsErrno, StoragePluginRequiredError, VfsCorruptionError } from './fs-errors';
import type {
  ChangeClient,
  ChangeFrame,
  ChangeImpact,
  CapturedContent,
  CompletedLogicalOperation,
  FileChangeChannel,
  FileChangeSource,
  LogicalChangeContribution,
  LogicalChangeSession,
  LogicalRecord,
  WireSubscribeOptions,
} from './changes';
import { baseName, normalizeFsPath, parentPath } from './fs-path';
import { isChangeReply, snapshotChangeCommand, snapshotChangeFrame, utf8Charge } from './change-protocol';
import { isMountReplacement, mountGenerations, persistenceSources, workerChangeOpeners } from './mount-context';
import { claimConfiguredPlugins, validateConfiguredPlugins, validatedPluginOptions } from './plugin-config';
import type { ConfiguredVfsPlugin, StorageSidecarSuffix } from './plugins';
import { type SyncAccessHandle, withCompleteIo } from './sync-access-handle';
import { type RecordCodec, type VolumeStorage, type VolumeStorageFactory } from './storage-contract';
import { acquireVolumeLock, findVolumeFile, isNotFound, VolumeImportingError, volumeFileNames } from './volume-files';

const attachedBuffer = (buffer: ArrayBuffer) => {
  try {
    new DataView(buffer);
    return true;
  } catch {
    return false;
  }
};

const BLOCK_SIZE = 4096;
const INITIAL_BLOCKS = 16384; // 64MB
const ZERO_BLOCK = new Uint8Array(BLOCK_SIZE);
// PERF-11/PERF-12: a single module-level encoder for the few symlink-size sites
// that just measure a target's UTF-8 byte length — avoids a per-call allocation.
const sharedTextEncoder = new TextEncoder();
/** Cap for the reusable zero buffer; longer zero runs are written in chunks. */
const MAX_ZERO_RUN_BYTES = 1 << 20;

/** UTF-8 metadata charge without allocating an encoded copy. */
function metadataCharge(path: string, budget: number): number {
  return 256 + utf8Charge(path, budget - 256);
}

const pathContains = (root: string, candidate: string) =>
  root === '/' || candidate === root || candidate.startsWith(`${root}/`);
const pathDepth = (path: string) => {
  let result = 0;
  for (let i = 0; i < path.length; i++) if (path.charCodeAt(i) === 47) result++;
  return path === '/' ? 0 : result;
};
const comparePath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const compareDeleteEntry = <T extends { record: { deletePhase: number; path: string }; depth: number }>(a: T, b: T) =>
  a.record.deletePhase - b.record.deletePhase || b.depth - a.depth || comparePath(a.record.path, b.record.path);
const compareCreateEntry = <T extends { record: { path: string }; depth: number }>(a: T, b: T) =>
  a.depth - b.depth || comparePath(a.record.path, b.record.path);
const compareUpdateEntry = <T extends { path: string }>(a: T, b: T) => comparePath(a.path, b.path);
export const MAX_WHOLE_FILE_BYTES = 16 * 1024 * 1024;

export interface WriteFileBufferOptions {
  exclusive?: boolean;
  expected?: Uint8Array;
  append?: boolean;
}
const isExpectedChangeControlError = (error: unknown) =>
  error instanceof Error && isVfsErrno((error as { code?: unknown }).code);

/**
 * Default file-size ceiling (SEC-2). The binary metadata codec stores inode
 * sizes as u32, so `serializeMeta` hard-fails on any file >4GB — and because
 * that throw happens during SNAPSHOT, a single >4GB file silently poisons every
 * subsequent snapshot (a deferred brick). Defaulting `maxFileSize` to that exact
 * format limit converts the deferred metadata-corruption brick into an
 * immediate, well-typed EFBIG error rejected at the write boundary.
 */
const MAX_FILE_SIZE_DEFAULT = 0xffffffff;

/**
 * SEC-4 default for {@link OpfsVfsOptions.maxNameLength}: the classic POSIX
 * `NAME_MAX`. A single path component longer than this is rejected with
 * ENAMETOOLONG at create time. `maxPathDepth`, `maxFiles` and `maxTotalBytes`
 * have no default (opt-in / unlimited) so normal use is never restricted.
 */
const MAX_NAME_LENGTH_DEFAULT = 255;

/**
 * PERF-8 — Linux `relatime` threshold. On a read, atime is updated only if the
 * current atime is older than mtime, older than ctime, or older than this many
 * milliseconds (24h). Otherwise the read leaves the inode untouched, so a
 * read-only workload neither dirties metadata nor schedules flush work. Matches
 * the kernel default of 24h.
 */
const RELATIME_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * PERF-9 — meta-log compaction trigger. A full snapshot is forced when the
 * incremental log would grow past `max(LOG_SNAPSHOT_THRESHOLD_BYTES,
 * 2 * lastSnapshotSize)`. This bounds replay time and the unbounded log growth
 * between snapshots that re-logged whole block tables every sync.
 */
const LOG_SNAPSHOT_THRESHOLD_BYTES = 4 * 1024 * 1024;

/**
 * §6.3 — detect a browser storage-quota exhaustion. The standard is a
 * `DOMException` with `name === 'QuotaExceededError'` (code 22). Match by name
 * (and the legacy numeric code) without relying on `instanceof DOMException`,
 * which is unavailable in some worker/test environments.
 */
function isQuotaExceededError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { name?: unknown; code?: unknown };
  return e.name === 'QuotaExceededError' || e.code === 22;
}

/**
 * Durable intent written before the very first A/B snapshot. It lives in a
 * dedicated file so a torn marker cannot be confused with user metadata.
 */
const FIRST_MOUNT_MARKER_MAGIC = 0x42564653; // 'BVFS'
const FIRST_MOUNT_MARKER_VERSION = 1;
const FIRST_MOUNT_MARKER_ACTIVE = 1;
const FIRST_MOUNT_MARKER_READY = 2;
const FIRST_MOUNT_MARKER_SIZE = 32;
const FIRST_MOUNT_MARKER_NONCE_BYTES = 12;

function hashVolumeIdentity(fileName: string): number {
  let hash = 2166136261;
  for (let i = 0; i < fileName.length; i++) {
    hash = Math.imul(hash ^ fileName.charCodeAt(i), 16777619);
  }
  return hash >>> 0;
}
const DEFAULT_FILE_MODE = 33188;
const DEFAULT_DIR_MODE = 16877;
const DEFAULT_SYMLINK_MODE = 41471;
const ACCESS_MODE_MASK = 3;
// COR-8: this VFS is single-user (the caller is always the file owner), and the
// POSIX-semantics spec defines access by ANY class bit, e.g. "no write bit set
// (0o222)". Use the full owner/group/other masks so a mode like 0o022 (write for
// group/other but not owner) still grants write — matching the spec doc — and
// pair them with the "any bit set" predicates below rather than owner-only 0o2xx.
const READ_PERMISSION = 0o444;
const WRITE_PERMISSION = 0o222;
const EXECUTE_PERMISSION = 0o111;
// COR-2: POSIX file-type bits stored in the high nibble of mode (S_IFMT 0o170000).
const S_IFREG = 0o100000;
const S_IFDIR = 0o40000;
const S_IFLNK = 0o120000;
const MAX_SYMLINK_DEPTH = 40;

export enum OpenFlags {
  O_RDONLY = 0,
  O_WRONLY = 1,
  O_RDWR = 2,
  O_CREAT = 64,
  O_EXCL = 128,
  O_TRUNC = 512,
  O_APPEND = 1024,
}

// ── Bitmap ──

// Exported for unit testing of the PERF-6 word-level allocator (alloc/allocRun).
export class Bitmap {
  private bits: Uint32Array;
  private totalBlocks: number;
  private nextFreeHint: number;

  constructor(totalBlocks: number) {
    this.totalBlocks = totalBlocks;
    this.bits = new Uint32Array(Math.ceil(totalBlocks / 32));
    this.nextFreeHint = 1;
    this.set(0, true); // reserve block 0
  }

  /**
   * PERF-6: allocate one free block via a word-level scan. Fully-allocated words
   * (=== 0xFFFFFFFF) are skipped in one step instead of bit-by-bit; within a
   * partial word the lowest free (0) bit is isolated with bit tricks + clz32.
   * Scans from the next-free hint to the end, then wraps to the start (hint
   * behavior preserved). ~32x fewer iterations on dense bitmaps.
   */
  alloc(): number {
    const idx = this.findFreeFrom(this.nextFreeHint);
    if (idx < 0) {
      // Wrap: search [0, hint) (skip block 0, always reserved).
      const wrapped = this.findFreeFrom(0);
      if (wrapped < 0 || wrapped >= this.nextFreeHint) return -1;
      this.set(wrapped, true);
      this.nextFreeHint = wrapped + 1;
      return wrapped;
    }
    this.set(idx, true);
    this.nextFreeHint = idx + 1 >= this.totalBlocks ? 1 : idx + 1;
    return idx;
  }

  /**
   * PERF-6: allocate `n` physically-contiguous blocks in one shot, returning the
   * first block number (the run is [first, first+n)), or -1 if no such run
   * exists. Used by append/grow paths so a multi-block write lands on a single
   * contiguous physical span — which lets PERF-1's coalescing issue one OPFS I/O
   * for the whole run. Scans from the hint forward, then wraps once. Falls back
   * to no allocation (caller may grow + retry) when no run fits.
   */
  allocRun(n: number): number {
    if (n <= 0) return -1;
    if (n === 1) return this.alloc();
    let first = this.findRunFrom(this.nextFreeHint, n);
    if (first < 0) first = this.findRunFrom(1, n);
    if (first < 0) return -1;
    for (let b = first; b < first + n; b++) this.set(b, true);
    this.nextFreeHint = first + n >= this.totalBlocks ? 1 : first + n;
    return first;
  }

  /** First free block index >= `from`, word-skipping full words, or -1. */
  private findFreeFrom(from: number): number {
    if (from < 1) from = 1;
    let block = from;
    while (block < this.totalBlocks) {
      const word = block >>> 5;
      const w = this.bits[word] >>> 0;
      if (w === 0xffffffff) {
        // whole word allocated — jump to the next word boundary
        block = (word + 1) << 5;
        continue;
      }
      // bits at-or-after `block & 31` that are free
      const bitPos = block & 31;
      // mask off bits below bitPos so we only consider this position onward
      const masked = (w | ((1 << bitPos) - 1)) >>> 0; // set low bits => treat as used
      const free = ~masked >>> 0;
      if (free !== 0) {
        const lowest = free & (-free >>> 0);
        const candidate = (word << 5) + (31 - Math.clz32(lowest));
        if (candidate < this.totalBlocks) return candidate;
        return -1;
      }
      block = (word + 1) << 5;
    }
    return -1;
  }

  /** First block starting a free run of length `n` at or after `from`, or -1. */
  private findRunFrom(from: number, n: number): number {
    let candidate = this.findFreeFrom(from < 1 ? 1 : from);
    while (candidate >= 0 && candidate + n <= this.totalBlocks) {
      let ok = true;
      for (let b = candidate + 1; b < candidate + n; b++) {
        if (this.get(b)) {
          ok = false;
          // resume the search after the first occupied block in the window
          candidate = this.findFreeFrom(b + 1);
          break;
        }
      }
      if (ok) return candidate;
    }
    return -1;
  }

  free(block: number) {
    this.set(block, false);
    if (block < this.nextFreeHint) this.nextFreeHint = block;
  }

  grow(newTotalBlocks: number) {
    const newBits = new Uint32Array(Math.ceil(newTotalBlocks / 32));
    newBits.set(this.bits);
    this.bits = newBits;
    this.totalBlocks = newTotalBlocks;
  }

  /**
   * INT-4: rebuild the allocation state from scratch so that the bitmap is
   * derived purely from metadata (inode block lists) rather than trusted from
   * the persisted `.bitmap` file. Clears every bit, re-reserves block 0, then
   * marks `markBlock` for each block the caller hands in. The next-free hint is
   * reset to 1 so allocation resumes from the start of the address space; the
   * word-scan in `alloc` skips the now-allocated runs cheaply.
   *
   * `markBlock` returns `true` if the block was already set (a double-claim: two
   * different inodes naming the same physical block — real corruption the caller
   * may want to surface), `false` otherwise. Blocks at or beyond `totalBlocks`
   * are out of range and are reported via `onOutOfRange` without being marked;
   * the caller decides whether to grow first or clamp.
   */
  rebuildFrom(
    blocks: Iterable<number>,
    onDoubleClaim?: (block: number) => void,
    onOutOfRange?: (block: number) => void,
  ) {
    this.bits.fill(0);
    this.set(0, true); // reserve block 0
    this.nextFreeHint = 1;
    for (const block of blocks) {
      if (block < 0 || block >= this.totalBlocks) {
        onOutOfRange?.(block);
        continue;
      }
      if (this.get(block) && block !== 0) onDoubleClaim?.(block);
      this.set(block, true);
    }
  }

  getTotalBlocks(): number {
    return this.totalBlocks;
  }

  /**
   * Highest allocated block index (word-level scan from the top). Never
   * negative: block 0 is always reserved. Used to record
   * the LOGICAL data extent — after INT-4's rebuild the bitmap covers exactly
   * the inode-referenced blocks, so this bounds every block metadata can name.
   */
  highestSet(): number {
    for (let word = this.bits.length - 1; word >= 0; word--) {
      const w = this.bits[word] >>> 0;
      if (w !== 0) return (word << 5) + (31 - Math.clz32(w));
    }
    return 0;
  }

  private get(block: number): boolean {
    return (this.bits[block >>> 5] & (1 << (block & 31))) !== 0;
  }

  private set(block: number, val: boolean) {
    const word = block >>> 5;
    const bit = block & 31;
    if (val) this.bits[word] |= 1 << bit;
    else this.bits[word] &= ~(1 << bit);
  }

  /** Raw binary access for fast persistence */
  getRawBits(): Uint32Array {
    return this.bits;
  }
  setRawBits(bits: Uint32Array) {
    this.bits = bits;
  }

  static fromBinary(bits: Uint32Array, totalBlocks: number): Bitmap {
    const bm = new Bitmap(totalBlocks);
    bm.bits = bits;
    return bm;
  }
}

// ── Inode ──

export interface Inode {
  ino: number;
  kind?: 'file' | 'dir' | 'symlink';
  isDir: boolean;
  size: number;
  blocks: number[];
  children: string[];
  symlinkTarget?: string;
  mode: number;
  nlink?: number;
  atimeMs?: number;
  mtimeMs?: number;
  ctimeMs?: number;
  timestampMs?: number;
}

export interface VfsStat {
  ino: number;
  mode: number;
  nlink: number;
  size: number;
  blksize: number;
  blocks: number;
  atimeMs?: number;
  mtimeMs?: number;
  ctimeMs?: number;
  timestampMs?: number;
  is_dir: boolean;
  is_file: boolean;
}

export interface VfsDirEntry {
  name: string;
  mode: number;
  is_dir: boolean;
  is_file: boolean;
}

type InodeId = number;
type DirEntries = Map<string, InodeId>;

function newFileInode(ino: number, mode: number = DEFAULT_FILE_MODE): Inode {
  const now = Date.now();
  return {
    ino,
    kind: 'file',
    isDir: false,
    size: 0,
    blocks: [],
    children: [],
    // COR-2: the type bits always follow the inode kind. A bare permission mode
    // (open(p, O_CREAT, 0o644)) or a foreign type (0o120644) must not make a
    // regular file stat or resolve as something else.
    mode: S_IFREG | (mode & 0o7777),
    nlink: 1,
    atimeMs: now,
    mtimeMs: now,
    ctimeMs: now,
    timestampMs: now,
  };
}

function newDirInode(ino: number, mode: number = DEFAULT_DIR_MODE): Inode {
  const now = Date.now();
  return {
    ino,
    kind: 'dir',
    isDir: true,
    size: 0,
    blocks: [],
    children: [],
    // COR-2: the type bits always follow the inode kind.
    mode: S_IFDIR | (mode & 0o7777),
    nlink: 2,
    atimeMs: now,
    mtimeMs: now,
    ctimeMs: now,
    timestampMs: now,
  };
}

function newSymlinkInode(ino: number, target: string, mode: number = DEFAULT_SYMLINK_MODE): Inode {
  const now = Date.now();
  return {
    ino,
    kind: 'symlink',
    isDir: false,
    size: sharedTextEncoder.encode(target).byteLength,
    blocks: [],
    children: [],
    symlinkTarget: target,
    // COR-2: the type bits always follow the inode kind.
    mode: S_IFLNK | (mode & 0o7777),
    nlink: 1,
    atimeMs: now,
    mtimeMs: now,
    ctimeMs: now,
    timestampMs: now,
  };
}

function isSymlinkInode(inode: Inode): boolean {
  return inode.kind === 'symlink' || ((inode.mode & 0o170000) === 0o120000 && !inode.isDir);
}

function isReadable(flags: number): boolean {
  const accessMode = flags & ACCESS_MODE_MASK;
  return accessMode === OpenFlags.O_RDONLY || accessMode === OpenFlags.O_RDWR;
}

function isWritable(flags: number): boolean {
  const accessMode = flags & ACCESS_MODE_MASK;
  return accessMode === OpenFlags.O_WRONLY || accessMode === OpenFlags.O_RDWR;
}

// ── Options ──

export interface OpfsVfsOptions {
  /** Default opens or creates. create-new rejects any existing volume component. */
  openMode?: 'open-or-create' | 'create-new' | 'open-existing';
  /**
   * Controls how file data is stored at runtime.
   * - 'disk' (default): reads/writes mapped OPFS blocks without a full RAM copy.
   *   Metadata and I/O buffers still consume memory.
   * - 'memory': caches file contents in RAM and logs writes to OPFS.
   *   Memory use grows with file contents. Both modes persist to OPFS.
   */
  bufferMode?: 'memory' | 'disk';
  /**
   * Default 'balanced' schedules synchronization about 150 ms after the first change.
   * Worker suspension or scheduling can delay it; use explicit sync at save boundaries.
   * 'relaxed' defers flushing to explicit sync or orderly close. 'strict' additionally
   * flushes memory-mode recovery records; it does not flush every disk-mode write.
   */
  localDurabilityMode?: 'relaxed' | 'balanced' | 'strict';
  /** Fresh configured plugins for this mount. Storage plugins are single-use. */
  plugins?: readonly ConfiguredVfsPlugin[];
  debugWal?: boolean;
  /**
   * PERF-8 — disable access-time (atime) updates entirely. When `true`, reads
   * never touch `atimeMs`, never mark the inode dirty, and never schedule a
   * balanced-mode flush, so a purely read-only workload stays
   * `localPersistenceState: 'clean'`. When `false`/undefined the VFS uses Linux
   * `relatime` semantics (see {@link RELATIME_THRESHOLD_MS}): atime is updated
   * on read only if it is older than mtime/ctime, or older than the relatime
   * threshold (24h). This avoids dirtying metadata and re-logging full block
   * tables (PERF-9) on every read.
   */
  noatime?: boolean;
  /**
   * §6.2 — recovery contract for corruption detected while mounting. Controls
   * the fail-stop vs. salvage choice where both are possible (currently the data
   * WAL: a checksum/structural-corrupt frame or an apply-failure poison record).
   *
   * - `'salvage'` (default, the INT-5 behavior): truncate the WAL at the last
   *   consistent boundary and continue mounting. The DB opens; everything before
   *   the corruption is intact; `localPersistenceState` passes through
   *   `'recovering'` and the event is recorded in `lastSalvage`.
   * - `'fail-stop'`: throw a typed {@link VfsCorruptionError}
   *   (`DataWalCorruptionError`) instead of salvaging, so the app can decide
   *   (back up, re-init, surface to the user) before any data is discarded.
   *   `localPersistenceState` is left `'error'` with `lastError` set.
   *
   * This does NOT relax the meta-snapshot fail-stop: a both-slots-corrupt
   * snapshot with no valid fallback always throws `MetaSnapshotCorruptionError`
   * (there is nothing to salvage there).
   */
  recoveryMode?: 'fail-stop' | 'salvage';
  /**
   * Maximum size in bytes any single file may reach (SEC-2). Enforced with an
   * EFBIG error in `writeSync`/`ftruncateSync`/`truncateSync`/`seekSync` before
   * any side effect (WAL append, block allocation, cursor mutation). Defaults to
   * {@link MAX_FILE_SIZE_DEFAULT} (0xFFFFFFFF / 4GB), the u32 limit the binary
   * metadata codec imposes — see that constant for the brick-prevention rationale.
   */
  maxFileSize?: number;
  /**
   * SEC-4 resource quotas for sandboxed / hostile workloads (e.g. the just-bash
   * sandbox). All enforced BEFORE any side effect (namespace mutation, block
   * allocation, WAL append) so a rejected op leaves no partial state.
   *
   * `maxNameLength` — longest single path component, in UTF-16 code units.
   * Exceeding it throws ENAMETOOLONG at create time. Defaults to
   * {@link MAX_NAME_LENGTH_DEFAULT} (255, POSIX `NAME_MAX`).
   */
  maxNameLength?: number;
  /**
   * SEC-4 — maximum path depth (number of `/`-separated components). Opt-in;
   * unlimited when undefined. Exceeding it throws ENOSPC at create time.
   */
  maxPathDepth?: number;
  /**
   * SEC-4 — maximum number of live namespace entries (files, directories and
   * symlinks; hard links count once per path). Opt-in; unlimited when
   * undefined. Exceeding it throws ENOSPC at create time.
   */
  maxFiles?: number;
  /**
   * SEC-4 — maximum total file bytes across the whole VFS: allocated blocks in
   * disk mode, logical bytes in memory mode. Opt-in; unlimited when undefined.
   * Quarantined disk blocks count until metadata sync releases them.
   * A write that would push the aggregate past this ceiling throws ENOSPC before
   * any data is written.
   */
  maxTotalBytes?: number;
  /**
   * **Test-only fault-injection seam.** When provided, every
   * `FileSystemSyncAccessHandle` acquired during `init()` is passed through
   * this hook and the returned handle is used in its place. `fileTag` names
   * the role of the file (`data`/`metaA`/`metaB`/
   * `metaLog`/`dataLog`/`bootstrap`) for diagnostics. Production callers MUST
   * leave this undefined; it exists solely so the crash-consistency harness
   * can wrap handles to count and kill mutation operations at OPFS boundaries.
   * See `__tests__/crash-consistency-worker.ts`.
   */
  _wrapSyncAccessHandle?: (
    handle: FileSystemSyncAccessHandle,
    fileTag: SyncAccessHandleTag,
  ) => FileSystemSyncAccessHandle;
}

/** Role of a SyncAccessHandle, surfaced to the test-only wrap hook. */
export type SyncAccessHandleTag = 'data' | 'metaA' | 'metaB' | 'metaLog' | 'dataLog' | 'bootstrap';

export type LocalPersistenceState = 'clean' | 'dirty' | 'flushing' | 'recovering' | 'error';

/**
 * Non-fatal salvage event surfaced when a data WAL was truncated during mount
 * (INT-5). The database opened successfully; everything before `truncatedAt`
 * was applied and is consistent. `reason` distinguishes a frame that failed to
 * decode/checksum (`corrupt-frame`) from a decoded record whose application
 * threw (`apply-failure`, e.g. a pre-SEC-2 poison offset), or a non-empty
 * encrypted WAL whose head is not a valid cycle stamp (`stampless-cycle`,
 * #54/M1 — the whole WAL is discarded rather than decoded with the unsalted epoch).
 */
export interface DataWalSalvageEvent {
  reason: 'corrupt-frame' | 'apply-failure' | 'stampless-cycle';
  /** Byte offset of the frame boundary at which the WAL was truncated. */
  truncatedAt: number;
  /** Bytes discarded from the WAL tail (original size minus `truncatedAt`). */
  discardedBytes: number;
  detail: string;
  at: number;
}

export interface LocalPersistenceStatus {
  dirtyPages: number;
  walPendingBytes: number;
  lastLocalFlushAt?: number;
  lastLocalCheckpointAt?: number;
  localPersistenceState: LocalPersistenceState;
  /** Set when a data WAL was salvaged on the most recent mount (INT-5). */
  lastSalvage?: DataWalSalvageEvent;
  /**
   * The error from the most recent failed flush/sync (INT-6). Populated whenever
   * `localPersistenceState` is `'error'` — including a swallowed pagehide-hook
   * flush failure — so callers can observe persistence loss after the fact.
   */
  lastError?: unknown;
}

export interface MkdirOptions {
  recursive?: boolean;
  mode?: number;
}

type SyncAccessFileHandle = FileSystemFileHandle & {
  createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>;
};

interface OpenFile {
  path: string;
  cursor: number;
  inodeId: InodeId;
  inode: Inode;
  data?: Uint8Array;
  flags: number;
  readable: boolean;
  writable: boolean;
  append: boolean;
  // COR-3: set when this descriptor's namespace entry has been removed (unlink, or
  // replaced by a rename). The fd stays fully valid (the inode survives via
  // pendingDeletedInodes / a surviving hard link), but `of.path` now names a path
  // that no longer exists, so subtree-occupancy checks (hasOpenFilesInSubtree) must
  // ignore it to avoid spurious EBUSY on rmdir/rename of the now-empty container.
  unlinked?: boolean;
}

// ── OpfsVfs ──

const importOwners = new WeakMap<OpfsVfsOptions, Uint8Array>();

/** Internal import path. The reservation token never appears in ordinary mount options. */
export function mountImportVolume(name: string, options: OpfsVfsOptions, owner: { token: Uint8Array }): OpfsVfs {
  const mountOptions = { ...options };
  importOwners.set(mountOptions, owner?.token instanceof Uint8Array ? owner.token.slice() : new Uint8Array());
  return new OpfsVfs(name, mountOptions);
}

async function checkImportReservation(
  root: FileSystemDirectoryHandle,
  name: string,
  token?: Uint8Array,
): Promise<void> {
  const markerName = name.replace(/\.bin$/, '.importing');
  let marker: FileSystemFileHandle;
  try {
    marker = await root.getFileHandle(markerName, { create: false });
  } catch (error) {
    if (!isNotFound(error)) throw error;
    if (token) throw new VolumeImportingError(name);
    return;
  }
  if (!token || token.length !== 16) throw new VolumeImportingError(name);
  try {
    await root.getFileHandle(name, { create: false });
  } catch (error) {
    if (!isNotFound(error)) throw error;
    throw new VolumeImportingError(name);
  }
  const file = await marker.getFile();
  if (file.size !== 16) throw new VolumeImportingError(name);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.every((byte, index) => byte === token[index])) {
    throw new VolumeImportingError(name);
  }
}

export class OpfsVfs implements FileChangeSource {
  private dataHandle!: SyncAccessHandle;
  private logHandle!: SyncAccessHandle;
  private dataLogHandle!: SyncAccessHandle;
  /** First-mount intent; non-empty only until the empty A/B baseline is durable. */
  private bootstrapHandle!: SyncAccessHandle;
  /** Data extent from the last completed data flush. Namespace logs can flush earlier. */
  private flushedDataSize = 0;
  private flushedLogicalExtent = 0;
  /** Extent described by the newest applied metadata at mount. */
  private committedLogicalExtent = 0;
  /**
   * A/B double-buffered meta snapshot slots (INT-1). The full-snapshot rewrite
   * path writes the new snapshot into the *inactive* slot and flips, so a crash
   * mid-write can never destroy the previously-durable snapshot. Pre-opened at
   * init because acquiring SyncAccessHandles is async and the sync flush path
   * (pagehide) cannot await.
   */
  private metaHandleA!: SyncAccessHandle;
  private metaHandleB!: SyncAccessHandle;
  /** Index of the slot currently holding the authoritative snapshot (0=A, 1=B). */
  private activeMetaSlot: 0 | 1 = 0;
  /** Monotonic snapshot sequence; the higher-sequence valid slot wins on mount. */
  private metaSnapshotSequence = 0;
  private logOffset = 0;
  /** PERF-9: byte size of the last full meta snapshot; drives the log-growth snapshot trigger. */
  private lastSnapshotSize = 0;
  /**
   * PERF-10: set when an incremental meta-log batch was WRITTEN but its fsync was
   * deferred (relaxed/balanced namespace ops). syncSync/flushVfs/closeVfs flush
   * the log handle when this is set so the deferred namespace records become
   * durable at the sync barrier.
   */
  private metaLogFlushPending = false;
  private dataLogOffset = 0;
  private dataWalTruncatePending = false;
  /**
   * #54/M1 — sealer for the CURRENT data-WAL cycle on an encrypted volume: the
   * base {@link sealer} with the cycle's random salt XORed into the AAD epoch,
   * so a frame captured from a previous cycle cannot be replayed at the same
   * offset after the checkpoint `truncate(0)`. Set by {@link ensureDataWalCycle}
   * (fresh cycle) and {@link replayDataWal} (resuming a stamped WAL; a non-empty
   * encrypted WAL with no valid stamp is discarded there). `undefined` on
   * plaintext volumes.
   */
  private dataWalCycleSealer?: RecordCodec;
  private dirtyInodes = new Set<string>();
  /**
   * PERF-9: paths whose ONLY change since the last log record was a timestamp
   * touch (atime/mtime/ctime) — block table and children unchanged. Populated
   * exclusively by {@link touchInode}/{@link touchInodeAccess}/
   * {@link touchInodeMetadata}. At log-serialization time a path that is in this
   * set but NOT in {@link dirtyInodes} (the structural-change set) is written as
   * a compact attr-only record (no block table / children list), keeping the
   * meta log small for hot timestamp churn. Any structural change adds the path
   * to `dirtyInodes`, which always wins (full record).
   */
  private attrDirtyInodes = new Set<string>();
  private deletedInodes = new Set<string>();
  private inodes!: Map<string, Inode>;
  private inodeTable = new Map<InodeId, Inode>();
  private dirEntries = new Map<InodeId, DirEntries>();
  private pathIndex = new Map<string, InodeId>();
  /**
   * PERF-3/PERF-4: reverse index ino -> set of paths currently linking it. Keeps
   * inodeTable lifetime correct under incremental updates (an inode is dropped
   * only when its last path is unlinked) and lets {@link pathsForInode} answer
   * without scanning the whole pathIndex. Maintained by {@link linkInodePath} /
   * {@link unlinkInodePath} and rebuilt wholesale in rebuildIndexesFromPathMap.
   */
  private inoToPaths = new Map<InodeId, Set<string>>();
  private bitmap!: Bitmap;
  /**
   * INT-3: disk-mode freed-block quarantine. In disk mode there is no data WAL,
   * so a block freed in memory must NOT be returned to the allocator (and reused
   * by a direct OPFS write) until the metadata recording the free is durable.
   * Otherwise a crash in that window resurrects the old file from the stale
   * on-disk meta while its blocks already hold another file's bytes — silent
   * content corruption. Quarantined blocks keep their bitmap bit SET (so `alloc`
   * never hands them out) and are released to the allocator only after the
   * meta-log/snapshot write that records the free has been flushed (see
   * {@link drainPendingFree}). Empty in memory mode; see the INT-3 commit body.
   */
  private pendingFree = new Set<number>();
  /** PERF-1: reusable read-only zero buffer for coalesced zero writes (> 1 block). */
  private zeroBuffer: Uint8Array | null = null;
  /** Paths kept in sorted order — avoids O(n log n) sort on serialize */
  private sortedPaths: string[] = [];
  /** Flat in-memory file buffers — keyed by path (memory mode only) */
  private fileData = new Map<string, Uint8Array>();
  private openFiles = new Map<number, OpenFile>();
  // A random base keeps descriptors from different instances (e.g. an old and a
  // new shared-worker leader) from aliasing each other.
  private nextFd = 10 + (crypto.getRandomValues(new Uint32Array(1))[0] >>> 2);
  private totalBlocks = INITIAL_BLOCKS;
  /** Pending pages belong to the shared inode, independent of its pathnames. */
  private dirtyPages = new Map<Inode, Set<number>>();
  private pendingDeletedInodes = new Set<Inode>();
  private nextInodeNumber = 2;
  /** True when structural changes need metadata persistence */
  private dirtyStructure = false;
  /** Dirty OPFS data pages need a SyncAccessHandle.flush() */
  private dataDirty = false;
  private _ready: Promise<void>;
  private openMode: NonNullable<OpfsVfsOptions['openMode']>;
  private bufferMode: 'memory' | 'disk';
  private localDurabilityMode: 'relaxed' | 'balanced' | 'strict';
  private debugWal = false;
  /** PERF-8: when true, reads never update atime (no dirty, no flush scheduling). */
  private noatime = false;
  /** §6.2: data-WAL corruption recovery posture. Default 'salvage' (INT-5 behavior). */
  private recoveryMode: 'fail-stop' | 'salvage' = 'salvage';
  /** Optional storage transform; plaintext mounts keep raw handles. */
  private storage?: VolumeStorage;
  private sealer?: RecordCodec;
  private storageHandles: SyncAccessHandle[] = [];
  /** SEC-2 file-size ceiling; see {@link MAX_FILE_SIZE_DEFAULT}. */
  private maxFileSize: number;
  /** SEC-4 quotas. `undefined` (except name length) = unlimited / opt-in. */
  private maxNameLength: number;
  private maxPathDepth?: number;
  private maxFiles?: number;
  private maxTotalBytes?: number;
  private allocatedDataBlocks = 0;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private removeBalancedModeHooks?: () => void;
  private lastLocalFlushAt?: number;
  private lastLocalCheckpointAt?: number;
  private localPersistenceState: LocalPersistenceState = 'clean';
  private lastSalvage?: DataWalSalvageEvent;
  /** Last flush/sync error (INT-6); surfaced in {@link getLocalPersistenceStatusSync}. */
  private lastError?: unknown;
  private failureRevision = 0;
  private retainedFailure: unknown;
  private persistenceListener?: () => void;
  /** Test-only fault-injection hook (see {@link OpfsVfsOptions._wrapSyncAccessHandle}). */
  private wrapSyncAccessHandle?: OpfsVfsOptions['_wrapSyncAccessHandle'];
  /** Name-bound identity carried by the first-mount intent frame. */
  private readonly volumeIdentity: number;
  /** Independently inspected before optional commit/crypto handles are opened. */
  private firstMountAncillarySidecarsWereEmpty = false;
  /** Mount-time extension setup. */
  private storageFactory?: VolumeStorageFactory;
  private readonly storageSidecars: readonly StorageSidecarSuffix[];
  private logicalChanges?: {
    readonly contribution: LogicalChangeContribution;
    readonly create: LogicalChangeContribution['create'];
  };
  private logicalSession?: LogicalChangeSession;
  private logicalSessionClosed = false;
  private logicalChangesPoisoned = false;
  /** A completed-operation snapshot is usable only until its synchronous callback returns. */
  private logicalCaptureToken?: object;
  private readonly logicalCaptureBuffers = new WeakSet<ArrayBufferLike>();
  private readonly logicalDeliveryBuffers = new WeakSet<ArrayBufferLike>();
  private logicalSequence = 0;
  private logicalOperation?: {
    depth: number;
    failed: boolean;
    overflow: boolean;
    charged: number;
    impactCharged: number;
    impacts: { path: string; subtree: boolean }[];
    impactCharges: number[];
    impactAll: boolean;
    namespace: {
      type: 'create' | 'update' | 'delete';
      path: string;
      kind: 'file' | 'directory' | 'symlink';
      inodeId: number;
      size: number;
      deletePhase: number;
    }[];
    changedInodes: Set<number>;
    createdPaths: Set<string>;
  };
  private readonly changeGeneration: string;
  private readonly directChangeClientId = crypto.randomUUID();
  private changeChannels = new Map<
    string,
    {
      readonly client: ChangeClient;
      readonly receive: (frame: ChangeFrame) => void;
      readonly interrupted: (code: 'SUBSCRIPTION_INTERRUPTED' | 'SUBSCRIPTION_RESYNC_REQUIRED') => void;
      readonly closedCallback: () => void;
      closed: boolean;
      clientDisposed: boolean;
    }
  >();
  private readonly changeChannelCounts = new Map<string, number>();
  private readonly pendingChangeChannels = new Set<string>();
  private readonly changeSubscriptionIds = new Map<string, Set<string>>();
  private changeSubscriptionCount = 0;
  private readonly changeTerminalIds = new Set<string>();

  private get recordingLogicalChanges() {
    return !!this.logicalSession && !this.logicalChangesPoisoned && this.changeSubscriptionCount > 0;
  }

  constructor(fileName: string, options?: OpfsVfsOptions) {
    if (options && 'encryption' in options) {
      throw createVfsError('EINVAL', fileName, 'Use the premium package for encryption options');
    }
    if (options && 'storageFactory' in options) {
      throw createVfsError('EINVAL', fileName, 'Use plugins instead of storageFactory');
    }
    this.openMode = options?.openMode ?? 'open-or-create';
    const configured =
      (options && validatedPluginOptions.get(options)) ??
      validateConfiguredPlugins(options?.plugins, this.openMode, fileName);
    if (options) validatedPluginOptions.delete(options);
    claimConfiguredPlugins(configured, fileName);
    const storage = configured.find((plugin) => plugin.storage)?.storage;
    const logicalChanges = configured.find((plugin) => plugin.logicalChanges)?.logicalChanges;
    this.storageFactory = storage?.factory;
    this.storageSidecars = storage?.sidecars ?? [];
    this.logicalChanges = logicalChanges;
    this.changeGeneration = (options && mountGenerations.get(options)) ?? crypto.randomUUID();
    workerChangeOpeners.set(this, {
      open: (clientId, route, receive, interrupted, closed, channelId) =>
        this.openFileChangeChannelForClient(clientId, route, receive, interrupted, closed, channelId),
    });
    persistenceSources.set(this, {
      read: () => ({
        state: this.localPersistenceState,
        failure: this.retainedFailure,
        failureRevision: this.failureRevision,
        salvage: this.lastSalvage,
      }),
      watch: (listener) => {
        this.persistenceListener = listener;
      },
    });
    this.volumeIdentity = hashVolumeIdentity(fileName);
    this.bufferMode = options?.bufferMode ?? 'disk';
    this.localDurabilityMode = options?.localDurabilityMode ?? 'balanced';
    this.debugWal = options?.debugWal ?? false;
    this.noatime = options?.noatime ?? false;
    this.recoveryMode = options?.recoveryMode === 'fail-stop' ? 'fail-stop' : 'salvage';
    this.wrapSyncAccessHandle = options?._wrapSyncAccessHandle;
    const requestedMax = options?.maxFileSize;
    this.maxFileSize =
      requestedMax !== undefined && Number.isSafeInteger(requestedMax) && requestedMax >= 0
        ? Math.min(requestedMax, MAX_FILE_SIZE_DEFAULT)
        : MAX_FILE_SIZE_DEFAULT;
    // SEC-4 quotas. Only accept safe, non-negative integers; otherwise fall back
    // to the default / unlimited so a bogus option never weakens or bricks the FS.
    const validQuota = (v: number | undefined): number | undefined =>
      v !== undefined && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
    this.maxNameLength = validQuota(options?.maxNameLength) ?? MAX_NAME_LENGTH_DEFAULT;
    this.maxPathDepth = validQuota(options?.maxPathDepth);
    this.maxFiles = validQuota(options?.maxFiles);
    this.maxTotalBytes = validQuota(options?.maxTotalBytes);
    const importOwnerToken = options && importOwners.get(options);
    if (options) importOwners.delete(options);
    this._ready = this.init(fileName, importOwnerToken);
  }

  get ready() {
    return this._ready;
  }

  private get walPendingBytes() {
    return this.dataLogOffset;
  }

  /**
   * True when any metadata (structural, attr-only PERF-9, or deletes) needs to
   * be persisted by {@link writeMeta}. attrDirtyInodes is included so an
   * atime/chmod-only change still gets flushed — without it the sync path would
   * early-return and silently drop the compact record.
   */
  private get hasDirtyMeta(): boolean {
    return (
      this.dirtyStructure || this.dirtyInodes.size > 0 || this.attrDirtyInodes.size > 0 || this.deletedInodes.size > 0
    );
  }

  private setLocalPersistenceState(state: LocalPersistenceState, error?: unknown) {
    if (state === this.localPersistenceState && state !== 'error') return;
    const previous = this.localPersistenceState;
    this.localPersistenceState = state;
    if (state === 'error') {
      // Preserve any explicitly-passed error; otherwise keep the prior one.
      if (error !== undefined) this.lastError = error;
      const failure = error ?? this.lastError;
      if (previous !== 'error' || failure !== this.retainedFailure) {
        this.retainedFailure = failure;
        this.failureRevision++;
        this.persistenceListener?.();
      }
    } else {
      // Leaving the error state (clean/dirty/flushing/recovering) clears it.
      this.lastError = undefined;
      if (previous !== state) this.persistenceListener?.();
    }
  }

  getLocalPersistenceStatusSync(): LocalPersistenceStatus {
    let dirtyPages = 0;
    for (const pages of this.dirtyPages.values()) dirtyPages += pages.size;
    return {
      dirtyPages,
      walPendingBytes: this.walPendingBytes,
      lastLocalFlushAt: this.lastLocalFlushAt,
      lastLocalCheckpointAt: this.lastLocalCheckpointAt,
      localPersistenceState: this.localPersistenceState,
      lastSalvage: this.lastSalvage,
      lastError: this.localPersistenceState === 'error' ? this.lastError : undefined,
    };
  }

  private initializing = true;
  private closeRequested = false;
  private closing?: Promise<void>;
  private releaseVolumeLock?: () => Promise<void>;

  private async init(fileName: string, importOwnerToken?: Uint8Array) {
    const acquiredRaw: SyncAccessHandle[] = [];
    try {
      const files = volumeFileNames(fileName);
      if (!['open-or-create', 'create-new', 'open-existing'].includes(this.openMode)) {
        throw createVfsError('EINVAL', fileName, 'Unknown volume open mode');
      }
      this.releaseVolumeLock = await acquireVolumeLock(fileName);
      if (this.closeRequested) throw createVfsError('EBADF', fileName, 'Volume closed during initialization');
      const root = await navigator.storage.getDirectory();
      await checkImportReservation(root, fileName, importOwnerToken);
      if (this.openMode === 'create-new' && (await findVolumeFile(root, files))) {
        throw createVfsError('EEXIST', fileName);
      }
      for (const suffix of ['.vault', '.crypt', '.crypt.log'] as const) {
        if (!this.storageSidecars.includes(suffix)) {
          try {
            await root.getFileHandle(fileName.replace(/\.bin$/, suffix), { create: false });
            throw new StoragePluginRequiredError(fileName, suffix);
          } catch (error) {
            if (!error || typeof error !== 'object' || (error as { name?: unknown }).name !== 'NotFoundError')
              throw error;
          }
        }
      }

      // The retired pre-A/B snapshot is no longer readable, but a non-empty file
      // must not be mistaken for a fresh volume when no current snapshot exists.
      // Probe its size without creating it or acquiring a SyncAccessHandle; the
      // A/B loader below reports an explicit format-version error only when it has
      // no current snapshot to prefer.
      let retiredMetaHasBytes = false;
      try {
        const retiredMeta = await root.getFileHandle(fileName.replace(/\.bin$/, '.meta'), { create: false });
        retiredMetaHasBytes = (await retiredMeta.getFile()).size > 0;
      } catch (error) {
        if (!error || typeof error !== 'object' || (error as { name?: unknown }).name !== 'NotFoundError') throw error;
      }

      // `createSyncAccessHandle` defaults to exclusive-mode: the OPFS contract
      // grants at most one live access handle per file across the whole origin.
      // We rely on that on purpose — it is the two-tab mutual-corruption guard. If
      // a second tab races us for the same DB it loses fast here (acquisition
      // throws) rather than both tabs writing the same files and corrupting them.
      // Do NOT pass `{ mode: 'readwrite-unsafe' }`.
      //
      // Test-only: pass each acquired SyncAccessHandle through the fault-injection
      // wrap hook (no-op in production, where `wrapSyncAccessHandle` is undefined).
      //
      // INT-8: handles are acquired sequentially and each holds an exclusive lock.
      // If any acquisition mid-sequence throws (including losing the two-tab race),
      // the already-acquired handles must be released before init rethrows —
      // otherwise they stay locked, blocking BOTH this instance's retry and the
      // other tab until worker termination. We track every acquired RAW handle and
      // close them all in the catch.
      const acquire = async (handle: SyncAccessFileHandle, tag: SyncAccessHandleTag): Promise<SyncAccessHandle> => {
        const raw = (await handle.createSyncAccessHandle()) as unknown as SyncAccessHandle;
        acquiredRaw.push(raw);
        // A throwing wrap hook must release the raw handle before init unwinds.
        try {
          const handle = this.wrapSyncAccessHandle ? this.wrapSyncAccessHandle(raw, tag) : raw;
          return withCompleteIo(handle as unknown as SyncAccessHandle);
        } catch (wrapError) {
          acquiredRaw.pop();
          try {
            raw.close();
          } catch {
            // Best-effort.
          }
          throw wrapError;
        }
      };

      const dataFileHandle = await root.getFileHandle(fileName, { create: this.openMode !== 'open-existing' });
      this.dataHandle = await acquire(dataFileHandle as SyncAccessFileHandle, 'data');
      // The exclusive data handle excludes active competing mounts. A mount
      // that completed after preflight leaves sidecars/nonempty data behind.
      if (
        this.openMode === 'create-new' &&
        (this.dataHandle.getSize() > 0 || (await findVolumeFile(root, files.slice(1))))
      ) {
        throw createVfsError('EEXIST', fileName);
      }

      // INT-1: pre-open both A/B snapshot slots. Handle acquisition is async and
      // cannot happen in the synchronous flush path (pagehide), so both must be
      // ready before any flush.
      const metaAName = fileName.replace(/\.bin$/, '.meta.a');
      const metaAFileHandle = await root.getFileHandle(metaAName, { create: true });
      this.metaHandleA = await acquire(metaAFileHandle as SyncAccessFileHandle, 'metaA');

      const metaBName = fileName.replace(/\.bin$/, '.meta.b');
      const metaBFileHandle = await root.getFileHandle(metaBName, { create: true });
      this.metaHandleB = await acquire(metaBFileHandle as SyncAccessFileHandle, 'metaB');

      const logName = fileName.replace(/\.bin$/, '.meta.log');
      const logFileHandle = await root.getFileHandle(logName, { create: true });
      this.logHandle = await acquire(logFileHandle as SyncAccessFileHandle, 'metaLog');

      const dataLogName = fileName.replace(/\.bin$/, '.data.log');
      const dataLogFileHandle = await root.getFileHandle(dataLogName, { create: true });
      this.dataLogHandle = await acquire(dataLogFileHandle as SyncAccessFileHandle, 'dataLog');
      if (this.bufferMode === 'disk' && this.dataLogHandle.getSize() > 0) {
        throw createVfsError(
          'EBUSY',
          fileName,
          'Nonempty memory-mode recovery log; reopen in memory mode and close successfully before switching to disk mode',
        );
      }

      const bootstrapName = fileName.replace(/\.bin$/, '.bootstrap');
      const bootstrapFileHandle = await root.getFileHandle(bootstrapName, { create: true });
      this.bootstrapHandle = await acquire(bootstrapFileHandle as SyncAccessFileHandle, 'bootstrap');
      if (this.hasFirstMountMarker()) {
        this.firstMountAncillarySidecarsWereEmpty = true;
      }

      // #54 — set up at-rest encryption BEFORE any snapshot/log/WAL bytes are
      // interpreted. We open the `<name>.vault` (key header) and `<name>.crypt`
      // (per-block nonce/tag sidecar) handles, then derive the KEK and unwrap the
      // DEK (async — fine, init() is async; nothing here runs on a sync path).
      // After this, `this.dataHandle` is the crypto-wrapping handle and
      // `this.sealer` seals every metadata record. Plaintext volumes skip all of
      // this and leave the handles undefined.
      await this.openStorage(fileName, root, acquire);

      if (this.hasFirstMountMarker()) {
        this.firstMountAncillarySidecarsWereEmpty &&= this.storage?.isSemanticallyEmpty?.() ?? true;
      }

      // INT-8 (follow-up): the original guard only covered handle acquisition.
      // The post-acquisition init steps below (snapshot deserialize, bitmap
      // parse, log/WAL replay, disk reconcile) can ALSO throw — e.g. a corrupt
      // snapshot trips deserializeBinaryMeta, or a poison record trips replay —
      // and any throw there would leak the exclusive handles acquired above just
      // as badly as a mid-acquisition failure. Keep every step that runs after a
      // handle has been acquired inside this single try, so the catch releases
      // all of them. The whole body is synchronous from here, so no handle is
      // acquired after this point that the catch wouldn't cover.

      // INT-1: resolve the authoritative meta snapshot from the A/B slots. A
      // `null` result means a genuinely fresh filesystem (no snapshot anywhere
      // AND no pre-existing data/bitmap); anything else is surfaced as corruption.
      const firstMountInProgress = this.hasFirstMountMarker();
      const snapshot = this.loadMetaSnapshotPayload(retiredMetaHasBytes);
      const freshVolume = snapshot === null && this.logHandle.getSize() === 0;
      if (snapshot) {
        // Copy the payload into a fresh, exact-length ArrayBuffer: the A/B path
        // returns a subarray over a larger framed buffer, and deserialize expects
        // a standalone ArrayBuffer covering exactly the snapshot bytes.
        const buffer =
          snapshot.byteOffset === 0 && snapshot.byteLength === snapshot.buffer.byteLength
            ? (snapshot.buffer as ArrayBuffer)
            : snapshot.slice().buffer;
        const meta = deserializeBinaryMeta(buffer);
        this.totalBlocks = meta.totalBlocks;
        this.inodes = meta.inodes;
        this.nextInodeNumber = meta.nextInodeNumber;
        // Paths from binary format are already sorted — just extract
        this.sortedPaths = Array.from(meta.inodes.keys());

        // Allocation state is always rebuilt from metadata (INT-4). A cached
        // `.bitmap` can be shorter than a grown snapshot, and typed arrays drop
        // out-of-range bit writes, which would leave owned blocks looking free.
        this.bitmap = new Bitmap(this.totalBlocks);
      } else {
        this.bitmap = new Bitmap(INITIAL_BLOCKS);
        this.inodes = new Map<string, Inode>();
        this.inodes.set('/', newDirInode(1));
        this.nextInodeNumber = 2;
        this.sortedPaths = ['/'];

        if (freshVolume) {
          // A caller can mutate data/bitmap immediately after `ready` resolves.
          // Persist an intent marker before the first A/B write so even a torn
          // baseline is retryable, then retire it only after the empty namespace
          // and its generation transaction are both durable. An encrypted mount
          // also needs a valid empty `.crypt` baseline: raw ciphertext writes can
          // reach OPFS before the first explicit sync persists their nonce/tag
          // records, and the consistent-old empty namespace must remain mountable.
          this.beginFirstMount();
          this.storage?.beforeDataCommit?.();
          this.writeMeta(true);
          this.finishFirstMount();
        }
      }

      const retireRecoveredFirstMount = snapshot !== null && firstMountInProgress;
      // Replay any pending log records over the snapshot. Even on the fresh path
      // a non-empty log can exist (e.g. syncSync appended increments but closeVfs
      // never ran), so this is unconditional.
      //
      this.logOffset = 0;
      const logSize = this.logHandle.getSize();
      if (logSize > 0) {
        const logBuf = new Uint8Array(logSize);
        this.logHandle.read(logBuf, { at: 0 });
        const replay = replayLog(
          logBuf.buffer,
          this.inodes,
          this.sortedPaths,
          this.totalBlocks,
          this.metaSnapshotSequence,
          this.sealer,
        );
        if (replay.generationMismatch === 'newer' && this.recoveryMode === 'fail-stop') {
          throw new MetaSnapshotCorruptionError(
            `Meta log generation is newer than the readable snapshot ${this.metaSnapshotSequence}`,
          );
        }
        const validEnd = replay.validEnd;
        if (validEnd < logSize) {
          this.logHandle.truncate(validEnd);
          this.logHandle.flush();
        }
        this.logOffset = validEnd;
        if (validEnd > 0) {
          this.flushedDataSize = replay.physicalDataSize ?? this.flushedDataSize;
          this.committedLogicalExtent = replay.logicalExtent ?? this.committedLogicalExtent;
          this.flushedLogicalExtent = this.committedLogicalExtent;
        }
      }

      this.normalizeLoadedInodes();
      this.rebuildIndexesFromPathMap();
      this.storage?.validateAfterMetadata?.(
        [...new Set(this.inodes.values())].some(
          (inode) => !inode.isDir && !isSymlinkInode(inode) && inode.blocks.some((block) => block !== 0),
        ),
      );
      this.hydrateMemoryFileData();
      this.replayDataWal();

      const repaired = this.bufferMode === 'disk' && this.reconcileDiskState();

      // INT-4: derive allocation truth from the now-final metadata (post log-
      // replay, post-normalize, post-disk-reconcile) rather than a separately-
      // flushed file that can skew across a crash. Must run after reconcile,
      // which clamps block lists.
      this.rebuildBitmapFromMetadata();
      if (repaired) {
        // Persist the repair immediately so a crash before the next flush does
        // not re-detect (and re-log) the same torn state. Only now, after the
        // rebuild, does metadata record the real allocation extent.
        try {
          this.flushVfs();
        } catch (error) {
          this.logWalDebug('reconcileDiskState repair flush failed', error);
        }
      }

      if (retireRecoveredFirstMount) {
        // Retire ACTIVE only after the snapshot and any real meta-log records
        // have been recovered successfully.
        this.finishFirstMount();
      }

      if (this.closeRequested) throw createVfsError('EBADF', fileName, 'Volume closed during initialization');
      this.createLogicalChangeSession();
      if (this.localDurabilityMode === 'balanced') {
        this.installBalancedModeHooks();
      }
    } catch (error) {
      try {
        this.closeLogicalChangeSession('initialization-failed');
      } catch {
        // Preserve the initialization failure while releasing the acquired session.
      }
      // INT-8 (follow-up): release every handle acquired so far (in reverse
      // order) before rethrowing — covering BOTH a mid-acquisition failure and a
      // failure in any post-acquisition init step — so a thrown init never leaves
      // exclusive OPFS locks held (which would block this instance's retry and
      // any other tab until worker termination).
      for (let i = acquiredRaw.length - 1; i >= 0; i--) {
        try {
          acquiredRaw[i].close();
        } catch {
          // Best-effort: a handle that never fully opened may also fail to close.
        }
      }
      // The raw handles above are now terminally closed. Mark this instance the
      // same way so a caller can safely run its normal close path, and purge any
      // encryption material created before the failing init step.
      try {
        this.storage?.destroy();
      } catch {
        /* Preserve initialization error. */
      } finally {
        this.storage = undefined;
        this.sealer = undefined;
        this.dataWalCycleSealer = undefined;
        this.closed = true;
        const release = this.releaseVolumeLock;
        this.releaseVolumeLock = undefined;
        await release?.();
      }
      throw error;
    } finally {
      this.storageFactory = undefined;
      this.initializing = false;
    }
  }

  private async openStorage(
    fileName: string,
    root: FileSystemDirectoryHandle,
    acquire: (handle: SyncAccessFileHandle, tag: SyncAccessHandleTag) => Promise<SyncAccessHandle>,
  ) {
    const factory = this.storageFactory;
    this.storageFactory = undefined;
    if (!factory) return;
    const openers: Promise<SyncAccessHandle>[] = [];
    let setupFinished = false;
    let storage: VolumeStorage;
    try {
      storage = await factory({
        fileName,
        root,
        data: this.dataHandle,
        dataSize: this.dataHandle.getSize(),
        metaSnapshotSizes: [this.metaHandleA.getSize(), this.metaHandleB.getSize()],
        openSidecar: (suffix, create = true) => {
          if (setupFinished) return Promise.reject(new TypeError('Storage setup has finished'));
          if (!this.storageSidecars.includes(suffix as StorageSidecarSuffix)) {
            return Promise.reject(new TypeError(`Unsupported storage sidecar suffix: ${suffix}`));
          }
          const opening = (async () =>
            this.trackStorageHandle(
              await acquire(
                (await root.getFileHandle(fileName.replace(/\.bin$/, suffix), { create })) as SyncAccessFileHandle,
                'data',
              ),
            ))();
          openers.push(opening);
          void opening.catch(() => {});
          return opening;
        },
      });
      this.storage = storage;
    } finally {
      setupFinished = true;
      await Promise.allSettled(openers);
    }
    if (storage.recordCodec && (!storage.createDataWalCycle || !storage.openDataWalCycle)) {
      throw createVfsError('EINVAL', fileName, 'Record codecs require both WAL cycle hooks');
    }
    // Keep `storage` intact for its lifecycle hooks, but route its data I/O
    // through the same progress checks as acquired OPFS handles.
    this.dataHandle = withCompleteIo(storage.data);
    this.sealer = storage.recordCodec;
  }

  private trackStorageHandle(handle: SyncAccessHandle) {
    this.storageHandles.push(handle);
    return handle;
  }

  private writeAll(handle: SyncAccessHandle, bytes: Uint8Array, at: number, label: string) {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = handle.write(bytes.subarray(offset), { at: at + offset });
      if (!Number.isSafeInteger(written) || written <= 0 || written > bytes.byteLength - offset) {
        throw new DOMException(
          `${label} short write made no valid progress (${written}/${bytes.byteLength - offset} bytes)`,
          'InvalidStateError',
        );
      }
      offset += written;
    }
  }

  private firstMountMarker(state: number): Uint8Array {
    const bytes = new Uint8Array(FIRST_MOUNT_MARKER_SIZE);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, FIRST_MOUNT_MARKER_MAGIC, true);
    view.setUint32(4, FIRST_MOUNT_MARKER_VERSION, true);
    view.setUint32(8, state, true);
    view.setUint32(12, this.volumeIdentity, true);
    bytes.set(crypto.getRandomValues(new Uint8Array(FIRST_MOUNT_MARKER_NONCE_BYTES)), 16);
    view.setUint32(28, crc32(bytes.subarray(0, 28)), true);
    return bytes;
  }

  private firstMountMarkerState(): number | null {
    if (this.bootstrapHandle.getSize() !== FIRST_MOUNT_MARKER_SIZE) return null;
    const bytes = new Uint8Array(FIRST_MOUNT_MARKER_SIZE);
    if (this.bootstrapHandle.read(bytes, { at: 0 }) !== bytes.byteLength) return null;
    const view = new DataView(bytes.buffer);
    if (
      view.getUint32(0, true) !== FIRST_MOUNT_MARKER_MAGIC ||
      view.getUint32(4, true) !== FIRST_MOUNT_MARKER_VERSION ||
      view.getUint32(12, true) !== this.volumeIdentity ||
      view.getUint32(28, true) !== crc32(bytes.subarray(0, 28))
    ) {
      return null;
    }
    const state = view.getUint32(8, true);
    return state === FIRST_MOUNT_MARKER_ACTIVE || state === FIRST_MOUNT_MARKER_READY ? state : null;
  }

  private hasFirstMountMarker(): boolean {
    return this.firstMountMarkerState() === FIRST_MOUNT_MARKER_ACTIVE;
  }

  private beginFirstMount() {
    const marker = this.firstMountMarker(FIRST_MOUNT_MARKER_ACTIVE);
    this.bootstrapHandle.truncate(0);
    this.writeAll(this.bootstrapHandle, marker, 0, 'first-mount intent');
    this.bootstrapHandle.flush();
  }

  private finishFirstMount() {
    const marker = this.firstMountMarker(FIRST_MOUNT_MARKER_READY);
    this.bootstrapHandle.truncate(0);
    this.writeAll(this.bootstrapHandle, marker, 0, 'first-mount retirement');
    this.bootstrapHandle.flush();
  }

  /**
   * Resolve the authoritative meta snapshot payload at mount time (INT-1).
   *
   * Selection order:
   *  1. The A/B slot with the higher valid (magic + CRC) sequence number wins;
   *     this is what survives a crash mid-rewrite, since the rewrite always
   *     targets the *inactive* slot and the old slot stays intact.
   *  2. If either slot carries bytes but neither validates, that is corruption —
   *     surface a typed {@link MetaSnapshotCorruptionError} before log recovery.
   *  3. With both A/B slots empty, a non-empty retired `.meta` artifact is an
   *     unsupported on-disk format and fails with category `format-version`.
   *  4. A non-empty `.meta.log` with no snapshot is a legitimate pre-first-
   *     snapshot crash state — return null and let the caller replay the log.
   *  5. If nothing exists anywhere but `.bin`/`.bitmap` carry bytes, the
   *     snapshot was lost (the old in-place `truncate(0)` crash window) —
   *     typed corruption error, never a silent fresh mount.
   *  6. Otherwise (truly nothing on disk) return null → fresh filesystem.
   *
   * Side effects: sets `activeMetaSlot` and `metaSnapshotSequence` so the next
   * rewrite continues the sequence and writes to the correct inactive slot.
   */
  private loadMetaSnapshotPayload(retiredMetaHasBytes: boolean): Uint8Array | null {
    const readSlot = (handle: SyncAccessHandle) => {
      const size = handle.getSize();
      if (size <= 0) return { size: 0, parsed: null };
      const buf = new Uint8Array(size);
      handle.read(buf, { at: 0 });
      return { size, parsed: parseMetaSnapshot(buf, this.sealer) };
    };

    const slotA = readSlot(this.metaHandleA);
    const slotB = readSlot(this.metaHandleB);

    let chosen: {
      payload: Uint8Array;
      sequence: number;
      slot: 0 | 1;
      physicalDataSize: number;
      logicalExtent: number;
    } | null = null;
    if (slotA.parsed && (!slotB.parsed || slotA.parsed.sequence >= slotB.parsed.sequence)) {
      chosen = { ...slotA.parsed, slot: 0 };
    } else if (slotB.parsed) {
      chosen = { ...slotB.parsed, slot: 1 };
    }

    if (chosen) {
      this.activeMetaSlot = chosen.slot;
      this.metaSnapshotSequence = chosen.sequence;
      this.flushedDataSize = chosen.physicalDataSize;
      this.flushedLogicalExtent = chosen.logicalExtent;
      this.committedLogicalExtent = chosen.logicalExtent;
      return chosen.payload;
    }

    // Non-empty slot(s) that failed magic/CRC validation: corruption, full
    // stop. Do NOT fall through to log replay, which could silently reconstruct
    // an incomplete namespace over a lost snapshot.
    if (slotA.size > 0 || slotB.size > 0) {
      // The first snapshot has no older A/B slot to protect it. A durable
      // bootstrap marker proves `ready` never resolved, so no caller could have
      // created a valuable namespace. Retry that one narrow state; every other
      // unreadable snapshot remains fail-stop.
      const interruptedFirstMount =
        this.hasFirstMountMarker() &&
        this.logHandle.getSize() === 0 &&
        this.dataLogHandle.getSize() === 0 &&
        this.dataHandle.getSize() === 0 &&
        this.firstMountAncillarySidecarsWereEmpty;
      if (interruptedFirstMount) {
        this.metaHandleA.truncate(0);
        this.metaHandleA.flush();
        this.metaHandleB.truncate(0);
        this.metaHandleB.flush();
        this.activeMetaSlot = 0;
        this.metaSnapshotSequence = 0;
        return null;
      }
      throw new MetaSnapshotCorruptionError(
        `Meta snapshot present but unreadable (slotA=${slotA.size}B, slotB=${slotB.size}B); ` +
          'no valid checksum and no usable fallback.',
      );
    }

    if (retiredMetaHasBytes) {
      throw new VfsCorruptionError(
        'format-version',
        'Unsupported retired metadata snapshot (.meta); reset this development volume to use .meta.a/.meta.b',
      );
    }

    // No snapshot in any form. The namespace may still be fully recoverable
    // from the incremental meta log (a DB that only ever appended log records
    // before its first full snapshot is a legitimate, recoverable state — the
    // caller replays the log over a fresh base).
    if (this.logHandle.getSize() > 0) {
      this.activeMetaSlot = 1;
      this.metaSnapshotSequence = 0;
      return null;
    }

    // No recovery source at all, yet data/bitmap carry bytes: this is the
    // INT-1 corruption window (the old in-place truncate(0) crash).
    const hasData = this.dataHandle.getSize() > 0;
    if (hasData) {
      throw new MetaSnapshotCorruptionError(
        'Meta snapshot and log are both empty but data/bitmap files are non-empty; refusing to ' +
          'mount as a fresh filesystem (would discard the existing namespace).',
      );
    }
    return null;
  }

  /**
   * Crash-consistency self-heal for disk mode.
   *
   * The data, bitmap and meta files are independent OPFS handles flushed
   * separately. A tab killed mid-flush (especially likely with the `balanced`
   * debounce) can persist meta — which records `inode.size`/`inode.blocks` —
   * referencing data blocks whose write never reached disk. Reloading that meta
   * verbatim makes every read of the missing block fail with
   * `read only 0 of N bytes`, and the bad meta replays forever.
   *
   * We repair on load by clamping each inode to what is *physically present*:
   * Drop blocks whose byte extent exceeds the physical data size and shrink
   * each inode to the first missing page. Encrypted storage also checks the
   * logical extent recorded in the newest applied metadata.
   *
   * Dropped tails degrade to short/empty files rather than hard read errors;
   * upstream sync (e.g. Electric) re-materializes the missing rows.
   */
  private reconcileDiskState(): boolean {
    const physicalDataSize = this.dataHandle.getSize();
    const physicalBlocks = Math.floor(physicalDataSize / BLOCK_SIZE);

    const logicalLimit = this.committedLogicalExtent;
    const blockMissing = (block: number): boolean =>
      block === 0
        ? false
        : this.storage?.hasPhysicalBlock
          ? !this.storage.hasPhysicalBlock(block, physicalDataSize, logicalLimit)
          : block >= physicalBlocks;

    let repairedInodes = 0;
    let droppedBlocks = 0;
    for (const [path, inode] of this.inodes) {
      if (inode.isDir || isSymlinkInode(inode)) continue;

      // Logical page N lives in inode.blocks[N], so a file can only be read up
      // to the first page whose block is missing from disk. Block numbers are
      // NOT monotonic with offset — Bitmap.alloc reuses freed low blocks, so a
      // table like [5, 6, 2] is valid. Scan every page and cut at the FIRST
      // out-of-range block, not just trailing ones, or a dangling middle block
      // would survive and still short-read.
      let firstMissingPage = inode.blocks.length;
      for (let page = 0; page < inode.blocks.length; page++) {
        if (blockMissing(inode.blocks[page])) {
          firstMissingPage = page;
          break;
        }
      }

      // Free every block from the first missing page onward (in-range or not):
      // pages after a physically missing page are unreachable after repair.
      let droppedHere = 0;
      while (inode.blocks.length > firstMissingPage) {
        const block = inode.blocks.pop()!;
        if (block !== 0) {
          this.bitmap.free(block);
          droppedBlocks++;
        }
        droppedHere++;
      }

      const maxSizeFromBlocks = inode.blocks.length * BLOCK_SIZE;
      const nextSize = Math.min(inode.size, maxSizeFromBlocks);
      if (nextSize !== inode.size || droppedHere > 0) {
        inode.size = nextSize;
        repairedInodes++;
        this.dirtyInodes.add(path);
      }
    }

    if (repairedInodes > 0 || droppedBlocks > 0) {
      this.dirtyStructure = true;
      this.logWalDebug('reconcileDiskState repaired torn state', {
        repairedInodes,
        droppedBlocks,
        physicalDataSize,
      });
      return true;
    }
    return false;
  }

  /**
   * INT-4: rebuild the in-memory allocation bitmap from the loaded (log-replayed,
   * normalized and — in disk mode — reconciled) metadata, demoting the persisted
   * `.bitmap` file to a non-authoritative warm-start/debugging artifact.
   *
   * Rationale: the bitmap is fully derivable from inode block lists. The data
   * file and `.bitmap` are flushed through independent OPFS handles, so a crash
   * between their flushes can persist one without the other. Trusting the file
   * verbatim is unsound in both skew directions:
   *  - bitmap frees not reflected in meta → allocator hands a still-referenced
   *    block to a new file → silent corruption (disk) / double-free (memory);
   *  - meta deletions not reflected in the bitmap → permanently leaked blocks.
   * Deriving from metadata closes both windows in a single pass.
   *
   * ORDERING: this MUST run after meta-log replay, `normalizeLoadedInodes`, and
   * (disk mode) `reconcileDiskState`. Reconcile clamps block lists to what is
   * physically present and `bitmap.free()`s the clamped-away blocks against the
   * loaded bitmap; rebuilding afterwards from the *clamped* lists makes those
   * frees moot (we discard the loaded contents wholesale) and is the only order
   * in which clamped-away blocks reliably end up free. Reconcile reads the
   * physical data size — never the loaded bitmap's allocation state — to make
   * its decisions, so running rebuild after it does not invalidate any input it
   * depended on; its bitmap mutations were always purely outputs.
   *
   * Anomaly handling: if two distinct inodes claim the same physical block, that
   * is real on-disk corruption. We RECORD it (debug log + persistence state) and
   * keep the mount alive rather than throwing: the data may be partially
   * salvageable, and a hard failure would brick an otherwise-recoverable DB
   * (same salvage-over-fail-stop posture as reconcileDiskState). The block is
   * marked allocated once, so the allocator will not hand it out again — the
   * worst residual effect is one of the two files reading the other's bytes,
   * which the rebuild cannot disambiguate but does not worsen.
   *
   * Hard links are deduped by inode identity (block lists are shared by
   * reference across paths pointing at one inode), so each block is marked once.
   * Symlinks and directories carry no data blocks. Empty block lists (e.g.
   * memory-mode files whose data was never persisted) are normal and contribute
   * nothing.
   */
  private rebuildBitmapFromMetadata() {
    // Dedupe hard links by inode identity: multiple paths share one Inode object
    // (and its `blocks` array) by reference, so a Set of seen Inodes collapses
    // them to a single contribution.
    const seen = new Set<Inode>();
    const claimed: number[] = [];
    let maxBlock = -1;
    for (const inode of this.inodes.values()) {
      if (inode.isDir || isSymlinkInode(inode)) continue;
      if (seen.has(inode)) continue;
      seen.add(inode);
      for (const block of inode.blocks) {
        if (block === 0) continue;
        claimed.push(block);
        if (block > maxBlock) maxBlock = block;
      }
    }

    // Grow to cover any block beyond the current capacity before marking, so a
    // stale-but-larger block list is preserved rather than silently dropped.
    // Keep growth geometric (mirrors growStorage) so the address space stays a
    // power-of-two multiple of INITIAL_BLOCKS.
    if (maxBlock >= this.totalBlocks) {
      let newTotal = this.totalBlocks;
      while (maxBlock >= newTotal) newTotal *= 2;
      this.bitmap.grow(newTotal);
      this.totalBlocks = newTotal;
      this.dirtyStructure = true;
    }

    let doubleClaims = 0;
    this.bitmap.rebuildFrom(claimed, () => {
      doubleClaims++;
    });
    this.allocatedDataBlocks = claimed.length;

    // The bitmap is now authoritative; the persisted file is advisory. Mark it
    // dirty so the next sync overwrites the (possibly skewed) on-disk copy with
    // the rebuilt truth, keeping the artifact useful for debugging/warm starts.

    if (doubleClaims > 0) {
      this.setLocalPersistenceState('error');
      this.logWalDebug('rebuildBitmapFromMetadata detected double-claimed blocks', {
        doubleClaims,
        totalBlocks: this.totalBlocks,
      });
    }
  }

  private hydrateMemoryFileData() {
    if (this.bufferMode !== 'memory') return;
    this.fileData.clear();
    const hydrated = new Map<Inode, Uint8Array>();
    for (const [path, inode] of this.inodes) {
      if (inode.isDir || isSymlinkInode(inode) || inode.size <= 0) continue;
      const existing = hydrated.get(inode);
      if (existing) {
        this.fileData.set(path, existing);
        continue;
      }
      const data = new Uint8Array(inode.size);
      // PERF-1: coalesce contiguous blocks and read straight into `data` — no
      // per-block 4KB chunk allocation, one OPFS read per physical run. Cap the
      // span at the bytes the block table actually backs: a file may have fewer
      // blocks than `ceil(size/BLOCK)` (e.g. a trailing sparse/unpersisted tail),
      // in which case the uncovered tail stays zero — matching the old loop,
      // which stopped when it ran out of blocks.
      const backedBytes = Math.min(inode.size, inode.blocks.length * BLOCK_SIZE);
      this.forEachBlockRun(inode, 0, backedBytes, (at, dataOffset, runLength) => {
        // WAL records may cover only a changed byte, not every byte in this
        // span. Authentication failure cannot safely be replaced with zeros.
        if (at !== 0) this.readDataExactly(data.subarray(dataOffset, dataOffset + runLength), at);
      });
      this.fileData.set(path, data);
      hydrated.set(inode, data);
    }
  }

  private logWalDebug(...args: unknown[]) {
    if (!this.debugWal) return;
    console.debug('[opfs-vfs:data-wal]', ...args);
  }

  private replayDataWal() {
    const size = this.dataLogHandle.getSize();

    // Disk mounts reject nonempty memory recovery logs before recovery begins.
    // They cannot prove those records are stale and must never discard them.
    if (this.bufferMode !== 'memory') {
      this.dataLogOffset = 0;
      return;
    }

    if (size <= 0) {
      this.dataLogOffset = 0;
      this.setLocalPersistenceState('clean');
      return;
    }

    this.setLocalPersistenceState('recovering');
    const bytes = new Uint8Array(size);
    this.dataLogHandle.read(bytes, { at: 0 });
    // #54/M1: an encrypted WAL begins with a cycle stamp; its salt reconstructs
    // the cycle-bound sealer the frames were sealed with. On an encrypted volume
    // a non-empty WAL whose head is NOT a valid stamp is discarded outright — it
    // is never decoded with the unsalted base epoch, which would open a window
    // for an attacker to replay frames captured from an earlier cycle at the same
    // offsets. Discarding keeps the volume mounting; the next append starts a
    // fresh stamped cycle (dataLogOffset 0 → ensureDataWalCycle). Plaintext
    // volumes carry no stamp and no sealer, so they never probe.
    const cycle = this.storage?.openDataWalCycle?.(bytes);
    if (this.storage?.recordCodec && !cycle) {
      this.recoverDataWal('stampless-cycle', 0, size, 'protected data WAL has no valid cycle stamp');
      if (this.walPendingBytes > 0 || this.dirtyPages.size > 0) this.setLocalPersistenceState('dirty');
      else this.setLocalPersistenceState('clean');
      return;
    }
    const walSealer = cycle?.codec ?? this.sealer;
    this.dataWalCycleSealer = walSealer;
    // decodeDataWalRecords no longer throws on corruption (INT-5): a corrupt
    // frame stops decoding and is reported via corruptionOffset so we can
    // truncate at the last checksum-valid boundary instead of bricking init.
    const { records, frameEnds, parsedBytes, hadPartialTail, corruptionOffset } = decodeDataWalRecords(
      bytes,
      walSealer,
      cycle?.prefixBytes ?? 0,
    );
    if (hadPartialTail && corruptionOffset === undefined) {
      // Never append behind a torn frame: its leftover payload would parse as
      // frames after the next crash.
      this.logWalDebug('truncating partial trailing data WAL record', { parsedBytes, size });
      this.dataLogHandle.truncate(parsedBytes);
      this.dataLogHandle.flush();
    }

    // `parsedBytes` is the byte boundary after the last successfully decoded
    // frame and is the valid extent regardless of how decoding terminated.
    this.dataLogOffset = parsedBytes;

    // Records stay in the WAL until the next checkpoint and this session appends
    // after them. Their inode numbers must not be reissued, or a later replay
    // would apply a deleted file's records to the file that reused its number.
    for (const record of records) {
      this.nextInodeNumber = Math.max(this.nextInodeNumber, record.inodeId + 1);
    }

    const replay = replayDataWalRecords(
      {
        applyWrite: (inodeId, offset, data) => this.applyReplayWrite(inodeId, offset, data),
        applyTruncate: (inodeId, size) => this.applyReplayTruncate(inodeId, size),
        // The meta log is replayed first and owns the namespace. Replaying a
        // delete here could remove a path that was re-linked afterwards.
        applyDelete: () => {},
      },
      records,
    );

    if (replay.failedIndex !== undefined) {
      // Apply-side poison (e.g. pre-SEC-2 huge-offset write): everything before
      // the failed record applied cleanly; stop there and truncate at its frame
      // boundary so the poison record can never replay again. `frameEnds[i]` is
      // the byte offset just past record i's frame (PERF: derived during decode
      // — re-encoding the preceding records to recover lengths would re-SEAL
      // every frame on an encrypted volume just to throw the bytes away).
      const boundary = replay.failedIndex === 0 ? 0 : frameEnds[replay.failedIndex - 1]!;
      const failed = records[replay.failedIndex];
      this.recoverDataWal(
        'apply-failure',
        boundary,
        size,
        `apply of ${failed.op} record #${replay.failedIndex} failed`,
      );
    } else if (corruptionOffset !== undefined) {
      // Mid-WAL corruption: frames before the corrupt one are checksum-valid and
      // ordered and have been applied; the corrupt frame and everything after it
      // (ordering integrity lost) are discarded.
      this.recoverDataWal('corrupt-frame', parsedBytes, size, `corrupt frame at byte ${corruptionOffset}`);
    }

    if (this.walPendingBytes > 0 || this.dirtyPages.size > 0) this.setLocalPersistenceState('dirty');
    else this.setLocalPersistenceState('clean');
    this.logWalDebug('replayed data WAL', {
      records: records.length,
      replayedRecords: replay.replayedRecords,
      parsedBytes,
      hadPartialTail,
      failedIndex: replay.failedIndex,
      corruptionOffset,
      pendingBytes: this.walPendingBytes,
    });
  }

  /**
   * Durably truncate the data WAL to `boundary` after a mount-time salvage
   * (INT-5). Everything up to `boundary` was applied and is consistent; the
   * tail is discarded. Resets WAL bookkeeping so the next append/checkpoint
   * proceeds from a clean tail, and records a non-fatal event for the app.
   */
  /**
   * §6.2 — apply the recovery contract for a detected data-WAL corruption. In
   * `'salvage'` mode (default) truncate at `boundary` and continue (INT-5). In
   * `'fail-stop'` mode set `localPersistenceState: 'error'` + `lastError` and
   * throw a typed {@link DataWalCorruptionError} so the app decides before any
   * tail is discarded.
   */
  private recoverDataWal(
    reason: DataWalSalvageEvent['reason'],
    boundary: number,
    originalSize: number,
    detail: string,
  ) {
    if (this.recoveryMode === 'fail-stop') {
      const error = new DataWalCorruptionError(`data WAL corruption (${reason}): ${detail}`, boundary);
      this.setLocalPersistenceState('error', error);
      throw error;
    }
    this.salvageDataWal(reason, boundary, originalSize, detail);
  }

  private salvageDataWal(
    reason: DataWalSalvageEvent['reason'],
    boundary: number,
    originalSize: number,
    detail: string,
  ) {
    this.dataLogHandle.truncate(boundary);
    this.dataLogHandle.flush();
    this.dataLogOffset = boundary;
    this.lastSalvage = {
      reason,
      truncatedAt: boundary,
      discardedBytes: Math.max(0, originalSize - boundary),
      detail,
      at: Date.now(),
    };
    this.persistenceListener?.();
    this.logWalDebug('salvaged data WAL', this.lastSalvage);
  }

  private markDirtyRange(inode: Inode, offset: number, byteLength: number) {
    if (byteLength <= 0) return;
    const firstPage = (offset / BLOCK_SIZE) >>> 0;
    const lastPage = ((offset + byteLength - 1) / BLOCK_SIZE) >>> 0;
    let pages = this.dirtyPages.get(inode);
    if (!pages) {
      pages = new Set<number>();
      this.dirtyPages.set(inode, pages);
    }
    for (let p = firstPage; p <= lastPage; p++) pages.add(p);
  }

  /**
   * A size change dirties only the pages between the old and new end of file.
   * The entry is kept even when empty so persistToOpfs releases shrunk blocks.
   */
  private markResized(inode: Inode, oldSize: number, newSize: number) {
    let pages = this.dirtyPages.get(inode);
    if (!pages) {
      pages = new Set<number>();
      this.dirtyPages.set(inode, pages);
    }
    for (let p = Math.floor(oldSize / BLOCK_SIZE); p < Math.ceil(newSize / BLOCK_SIZE); p++) pages.add(p);
  }

  private applyReplayWrite(inodeId: number, offset: number, data: Uint8Array) {
    this.ensureDerivedIndexes();
    const inode = this.inodeTable.get(inodeId);
    if (!inode || inode.isDir || isSymlinkInode(inode)) return;
    const livePath = this.pathForInode(inode);
    if (!livePath) return;
    const end = offset + data.length;
    // Defense in depth (INT-5): reject offsets/sizes that violate the SEC-2
    // ceiling before allocating `new Uint8Array(end)`. SEC-2 blocks such records
    // at append time, but a pre-SEC-2 poison record on disk must surface as an
    // apply failure (caught by the replay harness → WAL truncated) rather than
    // an unhandled RangeError that bricks init.
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(end) || end > this.maxFileSize) {
      throw new RangeError(`Data WAL replay write out of bounds: offset=${offset} end=${end} max=${this.maxFileSize}`);
    }
    const existing = this.lookupFileDataForInode(livePath, inode) ?? new Uint8Array(0);
    let next = existing;
    if (end > existing.length) {
      next = new Uint8Array(end);
      next.set(existing);
    }
    next.set(data, offset);
    this.syncFileDataForInode(inode, next);
    this.updateOpenFileBuffers(inode, next);
    const dirtyFrom = Math.min(offset, inode.size);
    inode.size = Math.max(inode.size, end);
    this.markDirtyRange(inode, dirtyFrom, end - dirtyFrom);
    this.markAllPathsForInode(inode);
  }

  private applyReplayTruncate(inodeId: number, size: number) {
    this.ensureDerivedIndexes();
    const inode = this.inodeTable.get(inodeId);
    if (!inode || inode.isDir || isSymlinkInode(inode)) return;
    const livePath = this.pathForInode(inode);
    if (!livePath) return;
    // Defense in depth (INT-5): see applyReplayWrite — a pre-SEC-2 huge-size
    // truncate must fail the apply (→ salvage), not throw RangeError to init.
    if (!Number.isSafeInteger(size) || size < 0 || size > this.maxFileSize) {
      throw new RangeError(`Data WAL replay truncate out of bounds: size=${size} max=${this.maxFileSize}`);
    }
    const existing = this.lookupFileDataForInode(livePath, inode) ?? new Uint8Array(0);
    let next: Uint8Array;
    if (size <= existing.length) {
      next = existing.slice(0, size);
    } else {
      next = new Uint8Array(size);
      next.set(existing);
    }
    this.syncFileDataForInode(inode, next);
    this.updateOpenFileBuffers(inode, next);
    this.markResized(inode, inode.size, size);
    inode.size = size;
    this.markAllPathsForInode(inode);
  }

  symlinkSync(target: string, rawPath: string, mode: number = DEFAULT_SYMLINK_MODE) {
    if (!this.recordingLogicalChanges) return this.symlinkSyncImpl(target, rawPath, mode);
    return this.withLogicalOperation(() => this.symlinkSyncImpl(target, rawPath, mode));
  }

  private symlinkSyncImpl(target: string, rawPath: string, mode: number): void {
    // SEC-5: validate the link target at creation time rather than deferring to
    // resolution. POSIX symlink() rejects an empty target with ENOENT, and a NUL
    // byte makes the stored target unrepresentable as a C path — reject EINVAL.
    if (target.length === 0) throw createVfsError('ENOENT', rawPath, 'Empty symlink target');
    if (target.includes('\0')) throw createVfsError('EINVAL', rawPath, 'Symlink target contains NUL byte');
    if (sharedTextEncoder.encode(target).byteLength >= 4096) throw createVfsError('ENAMETOOLONG', rawPath);
    const normalized = normalizeFsPath(rawPath);
    const path = this.resolveInodePath(normalized.path, false);
    if (this.hasPathEntry(path)) throw createVfsError('EEXIST', path);
    const parent = this.resolveInodePath(parentPath(path), true);
    const name = baseName(path);
    const parentInode = this.getInodeByPath(parent);
    if (!parentInode) throw createVfsError('ENOENT', parent);
    if (!parentInode.isDir) throw createVfsError('ENOTDIR', parent);
    this.assertSearchablePath(parent, true);
    this.assertDirectoryWritable(parent, parentInode);
    // SEC-4: enforce name/depth/count quotas before any namespace mutation.
    this.assertNameWithinQuota(path);
    this.assertFileCountWithinQuota(path);
    this.impact(path, false);
    const inode = newSymlinkInode(this.nextInodeNumber++, target, mode);
    this.addDirEntry(parentInode, name, inode);
    this.linkInodePath(path, inode);
    sortedInsert(this.sortedPaths, path);
    this.commitNamespaceChange();
    this.touchInode(path);
    this.touchInode(parent);
    this.dirtyInodes.add(path);
    this.dirtyInodes.add(parent);
    this.flushMemoryNamespaceLog();
    this.recordLogicalCreate(path, inode);
  }

  readlinkSync(rawPath: string): string {
    const normalized = normalizeFsPath(rawPath);
    const path = this.resolveInodePath(normalized.path, false);
    const inode = this.getInodeByPath(path);
    if (!inode) throw createVfsError('ENOENT', path);
    if (!isSymlinkInode(inode)) throw createVfsError('EINVAL', path, 'Path is not a symbolic link');
    this.assertSearchablePath(path, false);
    this.touchInodeAccess(path, inode);
    return inode.symlinkTarget ?? '';
  }

  realpathSync(rawPath: string): string {
    const normalized = normalizeFsPath(rawPath);
    const path = this.resolveInodePath(normalized.path, true);
    const inode = this.getInodeByPath(path);
    if (!inode) throw createVfsError('ENOENT', path);
    this.assertSearchablePath(path, inode.isDir);
    return path;
  }

  private resolveSymlinkTarget(path: string, target: string): string {
    if (target.startsWith('/')) {
      return normalizeFsPath(target).path;
    }
    const base = parentPath(path);
    const joined = base === '/' ? `/${target}` : `${base}/${target}`;
    return normalizeFsPath(joined).path;
  }

  private resolveInodePath(path: string, followFinalSymlink: boolean): string {
    // Every path operation resolves here. After close nothing would persist.
    if (this.closed) throw createVfsError('EBADF', path, 'Volume is closed');
    let currentPath = path;
    let depth = 0;

    while (true) {
      const parts = currentPath.split('/').filter(Boolean);
      if (parts.length === 0) return '/';

      let substituted = false;
      let currentDirPath = '/';
      const rootInode = this.getInodeByPath('/');
      if (rootInode?.isDir) {
        this.assertDirectoryExecutable('/', rootInode);
      }

      for (let i = 0; i < parts.length; i++) {
        const parentInode = this.getInodeByPath(currentDirPath);
        const { path: candidatePath, inode } = parentInode?.isDir
          ? this.lookupChild(currentDirPath, parentInode, parts[i])
          : { path: currentDirPath, inode: undefined };
        const isFinal = i === parts.length - 1;
        if (!inode) {
          currentDirPath =
            candidatePath === currentDirPath
              ? currentDirPath === '/'
                ? `/${parts[i]}`
                : `${currentDirPath}/${parts[i]}`
              : candidatePath;
          continue;
        }
        if (isSymlinkInode(inode) && (followFinalSymlink || !isFinal)) {
          if (++depth > MAX_SYMLINK_DEPTH) {
            throw createVfsError('ELOOP', candidatePath);
          }
          const targetPath = this.resolveSymlinkTarget(candidatePath, inode.symlinkTarget ?? '');
          const remaining = parts.slice(i + 1).join('/');
          currentPath = remaining ? `${targetPath === '/' ? '' : targetPath}/${remaining}` : targetPath;
          substituted = true;
          break;
        }

        if (!isFinal) {
          if (!inode.isDir) {
            throw createVfsError('ENOTDIR', candidatePath);
          }
          this.assertDirectoryExecutable(candidatePath, inode);
          currentDirPath = candidatePath;
        }
      }

      if (!substituted) return currentPath;
    }
  }

  mkdirSync(rawPath: string, modeOrOptions: number | MkdirOptions = DEFAULT_DIR_MODE) {
    if (!this.recordingLogicalChanges) return this.mkdirSyncImpl(rawPath, modeOrOptions);
    return this.withLogicalOperation(() => this.mkdirSyncImpl(rawPath, modeOrOptions));
  }

  private mkdirSyncImpl(rawPath: string, modeOrOptions: number | MkdirOptions): void {
    const options = this.normalizeMkdirOptions(modeOrOptions);
    if (options.recursive) {
      const normalized = normalizeFsPath(rawPath);
      if (normalized.path === '/') return;
      const parts = normalized.path.split('/').filter(Boolean);
      for (let i = 0; i < parts.length; i++) {
        const candidateRaw = `/${parts.slice(0, i + 1).join('/')}`;
        const candidatePath = this.resolveInodePath(candidateRaw, false);
        const existing = this.getInodeByPath(candidatePath);
        if (existing) {
          if (isSymlinkInode(existing)) {
            const resolvedPath = this.resolveInodePath(candidateRaw, true);
            const resolvedInode = this.getInodeByPath(resolvedPath);
            if (!resolvedInode) {
              throw createVfsError(i === parts.length - 1 ? 'EEXIST' : 'ENOENT', candidatePath);
            }
            if (!resolvedInode.isDir) {
              throw createVfsError(i === parts.length - 1 ? 'EEXIST' : 'ENOTDIR', candidatePath);
            }
            if (i < parts.length - 1) {
              this.assertSearchablePath(resolvedPath, true);
            }
            continue;
          }
          if (!existing.isDir) {
            throw createVfsError(i === parts.length - 1 ? 'EEXIST' : 'ENOTDIR', candidatePath);
          }
          if (i < parts.length - 1) {
            this.assertSearchablePath(candidatePath, true);
          }
          continue;
        }
        this.mkdirSingleSync(candidatePath, options.mode);
      }
      return;
    }
    this.mkdirSingleSync(rawPath, options.mode);
  }

  private mkdirSingleSync(rawPath: string, mode: number = DEFAULT_DIR_MODE) {
    const normalized = normalizeFsPath(rawPath);
    const path = this.resolveInodePath(normalized.path, false);
    if (this.hasPathEntry(path)) throw createVfsError('EEXIST', path);
    const parent = parentPath(path);
    const name = baseName(path);
    const parentInode = this.getInodeByPath(parent);
    if (!parentInode) throw createVfsError('ENOENT', parent);
    if (!parentInode.isDir) throw createVfsError('ENOTDIR', parent);
    this.assertSearchablePath(parent, true);
    this.assertDirectoryWritable(parent, parentInode);
    // SEC-4: enforce name/depth/count quotas before any namespace mutation.
    this.assertNameWithinQuota(path);
    this.assertFileCountWithinQuota(path);
    this.impact(path, false);
    const inode = newDirInode(this.nextInodeNumber++, mode);
    this.addDirEntry(parentInode, name, inode);
    parentInode.nlink = (parentInode.nlink ?? 2) + 1;
    this.linkInodePath(path, inode);
    sortedInsert(this.sortedPaths, path);
    this.commitNamespaceChange();
    this.touchInode(path);
    this.touchInode(parent);
    this.dirtyInodes.add(path);
    this.dirtyInodes.add(parent);
    this.flushMemoryNamespaceLog();
    this.recordLogicalCreate(path, inode);
  }

  openSync(rawPath: string, flags: number = OpenFlags.O_RDONLY, mode: number = DEFAULT_FILE_MODE): number {
    if ((flags & (OpenFlags.O_CREAT | OpenFlags.O_TRUNC)) === 0) return this.openSyncImpl(rawPath, flags, mode);
    if (!this.recordingLogicalChanges) return this.openSyncImpl(rawPath, flags, mode);
    return this.withLogicalOperation(() => this.openSyncImpl(rawPath, flags, mode));
  }

  private openSyncImpl(rawPath: string, flags: number, mode: number): number {
    const normalized = normalizeFsPath(rawPath);
    if ((flags & OpenFlags.O_TRUNC) !== 0 && !isWritable(flags)) {
      throw createVfsError('EINVAL', normalized.path, 'O_TRUNC requires a writable descriptor');
    }
    const exclusive = (flags & OpenFlags.O_CREAT) !== 0 && (flags & OpenFlags.O_EXCL) !== 0;
    // POSIX: O_CREAT|O_EXCL fails on any existing entry, including a dangling symlink.
    if (exclusive && this.getInodeByPath(this.resolveInodePath(normalized.path, false))) {
      throw createVfsError('EEXIST', normalized.path);
    }
    const path = this.resolveInodePath(normalized.path, true);
    let existing = this.getInodeByPath(path);

    if (normalized.requiresDirectory && !existing?.isDir) {
      throw createVfsError('ENOTDIR', path);
    }

    if (existing) {
      this.assertSearchablePath(path, normalized.requiresDirectory || existing.isDir);
      if (existing.isDir) throw createVfsError('EISDIR', path);
      if (isReadable(flags)) this.assertFilePermission(path, existing, READ_PERMISSION);
      if (isWritable(flags)) this.assertFilePermission(path, existing, WRITE_PERMISSION);
      if (exclusive) throw createVfsError('EEXIST', path);
    } else {
      if ((flags & OpenFlags.O_CREAT) === 0) throw createVfsError('ENOENT', path);
      const parent = parentPath(path);
      const name = baseName(path);
      const parentInode = this.getInodeByPath(parent);
      if (!parentInode) throw createVfsError('ENOENT', parent);
      if (!parentInode.isDir) throw createVfsError('ENOTDIR', parent);
      this.assertSearchablePath(parent, true);
      this.assertDirectoryWritable(parent, parentInode);
      // SEC-4: enforce name/depth/count quotas before any namespace mutation.
      this.assertNameWithinQuota(path);
      this.assertFileCountWithinQuota(path);
      this.impact(path, false);
      const inode = newFileInode(this.nextInodeNumber++, mode);
      this.addDirEntry(parentInode, name, inode);
      this.linkInodePath(path, inode);
      sortedInsert(this.sortedPaths, path);
      if (this.bufferMode === 'memory') {
        this.fileData.set(path, new Uint8Array(0));
      }
      this.commitNamespaceChange();
      this.dirtyInodes.add(path);
      this.dirtyInodes.add(parent);
      this.touchInode(path);
      this.touchInode(parent);
      this.flushMemoryNamespaceLog();
      existing = this.getInodeByPath(path)!;
      this.recordLogicalCreate(path, existing);
    }

    if ((flags & OpenFlags.O_TRUNC) !== 0) {
      this.truncateSync(path, 0);
      existing = this.getInodeByPath(path)!;
    }

    const fd = this.nextFd++;
    this.openFiles.set(fd, {
      path,
      // COR-5: POSIX/Node start the read offset at 0 even for O_APPEND ('a+'); only
      // writes seek to EOF, which writeSync already enforces per-write via `append`.
      // Starting the cursor at EOF made 'a+' reads return nothing.
      cursor: 0,
      inodeId: existing.ino,
      inode: existing,
      data:
        this.bufferMode === 'memory' ? (this.lookupFileDataForInode(path, existing) ?? new Uint8Array(0)) : undefined,
      flags,
      readable: isReadable(flags),
      writable: isWritable(flags),
      append: (flags & OpenFlags.O_APPEND) !== 0,
    });
    return fd;
  }

  /** Write data — memory mode: flat memcpy; disk mode: direct OPFS block write */
  /**
   * SEC-2: reject any non-negative numeric arg that is not a safe integer >= 0
   * (catches NaN, Infinity, fractions, and negatives — `NaN < 0` is false, so a
   * plain `< 0` guard lets NaN through). Defense in depth: same-worker callers
   * bypass the worker.ts message boundary, so the public sync API validates too.
   */
  private assertValidOffset(value: number, path: string | undefined, label: string): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw createVfsError('EINVAL', path, `Invalid ${label}`);
    }
  }

  /**
   * SEC-2: enforce the configured file-size ceiling (default = u32 / 4GB, the
   * binary-metadata format limit) BEFORE any side effect. Converts the deferred
   * snapshot-poisoning brick (serializeMeta throws on >4GB files) into an
   * immediate EFBIG at the write boundary.
   */
  private assertWithinMaxFileSize(end: number, path: string | undefined): void {
    if (end > this.maxFileSize) {
      throw createVfsError('EFBIG', path, `File size ${end} exceeds maximum ${this.maxFileSize}`);
    }
  }

  /**
   * SEC-4: validate a new namespace entry's name/depth against the configured
   * quotas BEFORE any inode allocation or namespace mutation. `path` is the
   * fully-resolved absolute path of the entry being created.
   */
  private assertNameWithinQuota(path: string): void {
    const name = baseName(path);
    if (name.length > this.maxNameLength) {
      throw createVfsError('ENAMETOOLONG', path, `Name exceeds maximum length ${this.maxNameLength}`);
    }
    if (this.maxPathDepth !== undefined) {
      // Depth = number of '/'-separated components (root '/' is depth 0).
      const depth = path === '/' ? 0 : path.split('/').filter(Boolean).length;
      if (depth > this.maxPathDepth) {
        throw createVfsError('ENOSPC', path, `Path depth ${depth} exceeds maximum ${this.maxPathDepth}`);
      }
    }
  }

  /**
   * SEC-4: reject a new namespace entry once the live entry count would exceed
   * `maxFiles`. Counts every path entry (hard links count once per path), which
   * matches what grows the metadata structures a hostile sandbox could abuse.
   */
  private assertFileCountWithinQuota(path: string): void {
    if (this.maxFiles === undefined) return;
    if (this.inodes.size >= this.maxFiles) {
      throw createVfsError('ENOSPC', path, `File count ${this.inodes.size} would exceed maximum ${this.maxFiles}`);
    }
  }

  /**
   * Sum live memory-mode file bytes, deduplicated by inode so hard links count
   * once. Disk mode uses the allocated-block counter instead.
   */
  private computeLiveDataBytes(): number {
    let total = 0;
    const seen = new Set<number>();
    for (const inode of this.inodes.values()) {
      if (inode.isDir || isSymlinkInode(inode)) continue;
      if (seen.has(inode.ino)) continue;
      seen.add(inode.ino);
      total += inode.size;
    }
    // Unlinked-but-open inodes (COR-3) are gone from the path map but their
    // bytes still occupy memory/blocks until the last close — without counting
    // them, open()+unlink()+write() would grow past maxTotalBytes unmetered.
    for (const inode of this.pendingDeletedInodes) {
      if (inode.isDir || isSymlinkInode(inode)) continue;
      if (seen.has(inode.ino)) continue;
      seen.add(inode.ino);
      total += inode.size;
    }
    return total;
  }

  /**
   * SEC-4: memory mode keeps dense buffers, so logical growth counts toward
   * `maxTotalBytes`. Disk mode checks newly allocated blocks at write time.
   */
  private assertTotalBytesWithinQuota(inode: Inode | undefined, newEnd: number, path: string | undefined): void {
    if (this.maxTotalBytes === undefined || this.bufferMode === 'disk') return;
    const delta = newEnd - (inode?.size ?? 0);
    if (delta <= 0) return;
    const projected = this.computeLiveDataBytes() + delta;
    if (projected > this.maxTotalBytes) {
      throw createVfsError('ENOSPC', path, `Total bytes ${projected} would exceed maximum ${this.maxTotalBytes}`);
    }
  }

  private assertDiskBlocksWithinQuota(count: number, path: string | undefined): void {
    if (count === 0 || this.maxTotalBytes === undefined) return;
    const projected = (this.allocatedDataBlocks + count) * BLOCK_SIZE;
    if (projected > this.maxTotalBytes) {
      throw createVfsError('ENOSPC', path, `Total bytes ${projected} would exceed maximum ${this.maxTotalBytes}`);
    }
  }

  private assertWholeFileQuota(inode: Inode | undefined, finalSize: number, writeAt: number, path: string): void {
    if (this.maxTotalBytes === undefined) return;
    if (this.bufferMode === 'memory') {
      this.assertTotalBytesWithinQuota(inode, finalSize, path);
      return;
    }
    this.assertDiskBlocksWithinQuota(this.diskWriteHoleCount(inode, finalSize, writeAt), path);
  }

  private diskWriteHoleCount(inode: Inode | undefined, end: number, writeAt: number): number {
    if (end <= writeAt) return 0;
    let holes = 0;
    for (let page = Math.floor(writeAt / BLOCK_SIZE); page < Math.ceil(end / BLOCK_SIZE); page++) {
      if (!inode?.blocks[page]) holes++;
    }
    return holes;
  }

  writeSync(fd: number, data: Uint8Array, offset?: number): number {
    if (!this.recordingLogicalChanges) return this.writeSyncImpl(fd, data, offset);
    return this.withLogicalOperation(() => this.writeSyncImpl(fd, data, offset));
  }

  private writeSyncImpl(fd: number, data: Uint8Array, offset?: number): number {
    // COR-8: validate the descriptor BEFORE the zero-length early-return. POSIX
    // write(2) reports EBADF on a bad fd regardless of count; returning 0 for a
    // zero-length write on a bogus fd hid the error.
    const of = this.openFiles.get(fd);
    if (!of) throw createVfsError('EBADF');
    if (!of.writable) throw createVfsError('EBADF', of.path, 'Descriptor is not open for writing');
    // Offsets below are element counts; a wider view would spill into other blocks.
    if (!(data instanceof Uint8Array)) throw createVfsError('EINVAL', of.path, 'Write data must be a Uint8Array');
    if (data.length === 0) return 0;
    if (offset !== undefined) this.assertValidOffset(offset, of.path, 'file offset');
    // COR-6: an explicit offset (pwrite) must NOT move the file's persistent cursor.
    // Remember the implicit cursor so we can restore it after an explicit-offset
    // write. O_APPEND always targets EOF and advances the cursor there (its own
    // semantics), so it is exempt from the pwrite rule.
    const usesImplicitCursor = offset === undefined || of.append;
    const savedCursor = of.cursor;
    const writeAt = of.append ? of.inode.size : (offset ?? of.cursor);
    const end = writeAt + data.length;
    const inode = of.inode;
    // SEC-2: reject before any side effect (block allocation / WAL append).
    this.assertWithinMaxFileSize(end, of.path);
    // SEC-4: reject if the grown aggregate would exceed maxTotalBytes (opt-in).
    this.assertTotalBytesWithinQuota(inode, end, of.path);

    if (this.bufferMode === 'disk') {
      const oldSize = inode.size;
      const oldBlockCount = inode.blocks.length;
      const allocatedPages: number[] = [];
      this.assertDiskBlocksWithinQuota(this.diskWriteHoleCount(inode, end, writeAt), of.path);
      this.impactInode(inode);
      try {
        this.withQuotaMapped(() => {
          this.ensureDiskBlocks(of.path, inode, end, writeAt, allocatedPages);
          if (writeAt > oldSize) this.zeroDiskRange(inode, oldSize, writeAt);
          // Write directly to OPFS, coalescing contiguous runs (PERF-1).
          this.forEachBlockRun(inode, writeAt, data.length, (at, dataOffset, runLength) => {
            this.dataHandle.write(data.subarray(dataOffset, dataOffset + runLength), { at });
          });
        }, of.path);
      } catch (error) {
        this.rollbackNewBlocks(inode, oldBlockCount, allocatedPages);
        this.setLocalPersistenceState('error', error);
        throw error;
      }
      this.markDataDirty();

      if (end > inode.size) {
        inode.size = end;
      }
      this.touchInode(of.path, Date.now(), inode);
      // COR-6: pwrite leaves the cursor untouched; implicit/append writes advance it.
      of.cursor = usesImplicitCursor ? end : savedCursor;
      this.recordLogicalUpdate(inode);
      return data.length;
    }

    // Memory mode: flat memcpy into per-file buffer.
    let buf = of.data ?? this.lookupFileDataForInode(of.path, inode) ?? new Uint8Array(0);

    // PERF-4 fast path must not trust of.path for an unlinked fd (COR-3): the
    // path may have been deleted or reassigned to a NEW inode, and setting
    // fileData[path] here would clobber that successor file's buffer. With no
    // hint the slow path resolves zero live paths and leaves fileData alone —
    // the fd keeps reading/writing through of.data, as before PERF-4.
    const pathHint = of.unlinked ? undefined : of.path;

    // Grow buffer geometrically to avoid O(n²) reallocation. Allocate before
    // logging: a failed allocation must not leave a record the caller saw fail.
    const grown = end > buf.length ? new Uint8Array(Math.max(end, buf.length * 2, 4096)) : undefined;
    this.impactInode(inode);

    // PERF-2: pass `data` directly — encodeDataWalRecord copies it into the
    // single frame buffer synchronously before returning, so no defensive
    // slice() is needed (the caller's buffer is not retained).
    this.appendDataWal({
      version: 1,
      op: 'write',
      inodeId: of.inode.ino,
      path: of.path,
      offset: writeAt,
      data,
    });
    if (grown) {
      grown.set(buf);
      buf = grown;
      this.syncFileDataForInode(inode, buf, pathHint);
      this.updateOpenFileBuffers(inode, buf);
    }

    buf.set(data, writeAt);
    of.data = buf;
    this.syncFileDataForInode(inode, buf, pathHint);

    // A write past EOF also dirties the zero gap: its blocks may be reused
    // ones that still hold a deleted file's bytes on disk.
    const dirtyFrom = Math.min(writeAt, inode.size);
    if (end > inode.size) {
      inode.size = end;
    }
    this.touchInode(of.path, Date.now(), inode);
    // COR-6: pwrite leaves the cursor untouched; implicit/append writes advance it.
    of.cursor = usesImplicitCursor ? end : savedCursor;
    this.markDirtyRange(inode, dirtyFrom, end - dirtyFrom);
    this.recordLogicalUpdate(inode);
    return data.length;
  }

  /** Bounded one-turn write used by the worker and direct callers. */
  writeFileBufferSync(path: string, data: Uint8Array, options: WriteFileBufferOptions = {}): void {
    if (!this.recordingLogicalChanges) return this.writeFileBufferSyncImpl(path, data, options);
    return this.withLogicalOperation(() => this.writeFileBufferSyncImpl(path, data, options));
  }

  private writeFileBufferSyncImpl(path: string, data: Uint8Array, options: WriteFileBufferOptions = {}): void {
    if (typeof path !== 'string') throw createVfsError('EINVAL');
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw createVfsError('EINVAL', path);
    for (const key of Object.keys(options)) {
      if (key !== 'exclusive' && key !== 'expected' && key !== 'append') throw createVfsError('EINVAL', path);
    }
    if (!(data instanceof Uint8Array)) throw createVfsError('EINVAL', path);
    if (data.byteLength > MAX_WHOLE_FILE_BYTES) throw createVfsError('EFBIG', path);
    if (options.expected !== undefined && !(options.expected instanceof Uint8Array))
      throw createVfsError('EINVAL', path);
    if (options.expected && options.expected.byteLength > MAX_WHOLE_FILE_BYTES) throw createVfsError('EFBIG', path);
    if (typeof options.exclusive !== 'undefined' && typeof options.exclusive !== 'boolean')
      throw createVfsError('EINVAL', path);
    if (typeof options.append !== 'undefined' && typeof options.append !== 'boolean')
      throw createVfsError('EINVAL', path);
    if (options.exclusive && options.expected !== undefined) throw createVfsError('EINVAL', path);
    const normalized = normalizeFsPath(path);
    const resolved = this.resolveInodePath(normalized.path, true);
    const before = this.getInodeByPath(resolved);
    if (before && options.exclusive) throw createVfsError('EEXIST', resolved);
    const finalSize = (options.append ? (before?.size ?? 0) : 0) + data.byteLength;
    if (finalSize > MAX_WHOLE_FILE_BYTES) throw createVfsError('EFBIG', resolved);
    this.assertWithinMaxFileSize(finalSize, resolved);
    this.assertWholeFileQuota(before, finalSize, options.append ? (before?.size ?? 0) : 0, resolved);
    const flags =
      (options.expected === undefined ? OpenFlags.O_WRONLY | OpenFlags.O_CREAT : OpenFlags.O_RDWR) |
      (options.exclusive ? OpenFlags.O_EXCL : 0) |
      (options.append ? OpenFlags.O_APPEND : 0);
    const fd = this.openSync(path, flags);
    try {
      const size = this.fstatSync(fd).size;
      if (options.expected !== undefined) {
        if (size !== options.expected.byteLength)
          throw createVfsError('EBUSY', resolved, 'File changed since it was read');
        const actual = this.readSync(fd, size, 0);
        if (actual.read !== size || options.expected.some((byte, index) => byte !== actual.buffer[index]))
          throw createVfsError('EBUSY', resolved, 'File changed since it was read');
      }
      const written = this.writeSync(fd, data, 0);
      if (written !== data.byteLength) throw new Error('Incomplete file write; the file may be partially written');
      if (!options.append) this.ftruncateSync(fd, data.byteLength);
    } finally {
      this.closeSync(fd);
    }
  }

  readSync(fd: number, size: number, offset?: number): { buffer: Uint8Array; read: number } {
    const of = this.openFiles.get(fd);
    if (!of) throw createVfsError('EBADF');
    if (!of.readable) throw createVfsError('EBADF', of.path, 'Descriptor is not open for reading');
    // SEC-2: validate size and offset before mutating the cursor; otherwise a
    // NaN size permanently poisons of.cursor.
    this.assertValidOffset(size, of.path, 'read size');
    if (offset !== undefined) this.assertValidOffset(offset, of.path, 'file offset');
    // COR-6: pread (explicit offset) must not move the file's persistent cursor.
    const readAt = offset !== undefined ? offset : of.cursor;
    const advanceCursor = offset === undefined;

    const inode = of.inode;
    const fileSize = inode.size;
    const available = readAt >= fileSize ? 0 : fileSize - readAt;
    const toRead = Math.min(size, available);
    if (toRead === 0) return { buffer: new Uint8Array(0), read: 0 };

    if (this.bufferMode === 'disk') {
      const result = new Uint8Array(toRead);
      this.readBlocks(inode, readAt, result);
      if (advanceCursor) of.cursor = readAt + toRead;
      this.touchInodeAccess(of.path, inode);
      return { buffer: result, read: toRead };
    }

    const buf = of.data ?? this.fileData.get(of.path) ?? new Uint8Array(0);
    const result = buf.slice(readAt, readAt + toRead);
    if (advanceCursor) of.cursor = readAt + toRead;
    this.touchInodeAccess(of.path, inode);
    return { buffer: result, read: toRead };
  }

  /** Read directly into caller's buffer (e.g. Emscripten heap) */
  readInto(fd: number, target: Uint8Array, offset?: number): number {
    const of = this.openFiles.get(fd);
    if (!of) throw createVfsError('EBADF');
    if (!of.readable) throw createVfsError('EBADF', of.path, 'Descriptor is not open for reading');
    if (!(target instanceof Uint8Array)) throw createVfsError('EINVAL', of.path, 'Read target must be a Uint8Array');
    // SEC-2: validate the offset before mutating the cursor.
    if (offset !== undefined) this.assertValidOffset(offset, of.path, 'file offset');
    // COR-6: pread (explicit offset) must not move the file's persistent cursor.
    const readAt = offset !== undefined ? offset : of.cursor;
    const advanceCursor = offset === undefined;

    const inode = of.inode;
    const fileSize = inode.size;
    const available = readAt >= fileSize ? 0 : fileSize - readAt;
    const toRead = Math.min(target.length, available);
    if (toRead === 0) return 0;

    if (this.bufferMode === 'disk') {
      this.readBlocks(inode, readAt, target.subarray(0, toRead));
      if (advanceCursor) of.cursor = readAt + toRead;
      this.touchInodeAccess(of.path, inode);
      return toRead;
    }

    const buf = of.data ?? this.fileData.get(of.path) ?? new Uint8Array(0);
    target.set(buf.subarray(readAt, readAt + toRead));
    if (advanceCursor) of.cursor = readAt + toRead;
    this.touchInodeAccess(of.path, inode);
    return toRead;
  }

  /**
   * PERF-1: walk the byte range [fileOffset, fileOffset+length) over an inode's
   * block table and coalesce physically-contiguous blocks into runs, invoking
   * `cb(physicalAt, dataOffset, runLength)` once per run. `dataOffset` is the
   * offset into the logical data buffer at which the run begins (starts at 0).
   * A run extends while the next page's physical block is `prev + 1`. Correct
   * for arbitrary (fragmented) block layouts: a non-contiguous boundary simply
   * ends the current run. Partial head/tail bytes within a block are handled by
   * the per-byte cursor/offsetInBlock math, exactly as the old per-block loop.
   */
  private forEachBlockRun(
    inode: Inode,
    fileOffset: number,
    length: number,
    cb: (physicalAt: number, dataOffset: number, runLength: number) => void,
  ) {
    let done = 0;
    let cursor = fileOffset;
    while (done < length) {
      const pageIdx = (cursor / BLOCK_SIZE) >>> 0;
      const offsetInBlock = cursor % BLOCK_SIZE;
      const firstBlock = inode.blocks[pageIdx];
      if (firstBlock === undefined) throw createVfsError('EINVAL', undefined, 'Corrupted inode block table');
      // Bytes available in this first (possibly partial-head) block.
      let runLength = Math.min(BLOCK_SIZE - offsetInBlock, length - done);
      // Extend the run across subsequent pages while they are physically
      // contiguous AND fully consumed (full BLOCK_SIZE each). The run always
      // starts at `offsetInBlock` of `firstBlock`; intermediate/tail blocks are
      // consumed from their start, so a single contiguous physical span covers
      // [firstBlock*BS + offsetInBlock, ...].
      let nextPage = pageIdx + 1;
      let prevBlock = firstBlock;
      while (done + runLength < length) {
        const nextBlock = inode.blocks[nextPage];
        if (nextBlock === undefined) throw createVfsError('EINVAL', undefined, 'Corrupted inode block table');
        if (firstBlock === 0 ? nextBlock !== 0 : nextBlock !== prevBlock + 1) break;
        const add = Math.min(BLOCK_SIZE, length - done - runLength);
        runLength += add;
        prevBlock = nextBlock;
        nextPage++;
      }
      cb(firstBlock === 0 ? 0 : firstBlock * BLOCK_SIZE + offsetInBlock, done, runLength);
      done += runLength;
      cursor += runLength;
    }
  }

  /** Read from OPFS blocks into a target buffer (disk mode), coalescing runs. */
  private readBlocks(inode: Inode, fileOffset: number, target: Uint8Array) {
    this.forEachBlockRun(inode, fileOffset, target.length, (at, dataOffset, runLength) => {
      if (at === 0) target.fill(0, dataOffset, dataOffset + runLength);
      else this.readDataExactly(target.subarray(dataOffset, dataOffset + runLength), at);
    });
  }

  /** Data block reads must be fully backed; sparse runs are handled by callers. */
  private readDataExactly(bytes: Uint8Array, at: number) {
    const read = this.dataHandle.read(bytes, { at });
    if (read !== bytes.byteLength)
      throw new DOMException(`OPFS data read ended early (${read}/${bytes.byteLength} bytes)`, 'InvalidStateError');
  }

  seekSync(fd: number, offset: number, whence: number): number {
    const of = this.openFiles.get(fd);
    if (!of) throw createVfsError('EBADF');
    // SEC-2: offset may be negative for relative seeks (whence 1/2), but must be
    // a finite safe integer — a NaN offset would slip past the `< 0` guard below
    // and permanently poison of.cursor.
    if (!Number.isSafeInteger(offset)) throw createVfsError('EINVAL', of.path, 'Invalid seek offset');
    const inode = of.inode;
    let nextCursor: number;
    switch (whence) {
      case 0:
        nextCursor = offset;
        break;
      case 1:
        nextCursor = of.cursor + offset;
        break;
      case 2:
        nextCursor = inode.size + offset;
        break;
      default:
        throw createVfsError('EINVAL', of.path, 'Invalid whence');
    }
    if (!Number.isSafeInteger(nextCursor) || nextCursor < 0)
      throw createVfsError('EINVAL', of.path, 'Invalid seek offset');
    // SEC-2: don't let the cursor be parked beyond the file-size ceiling.
    this.assertWithinMaxFileSize(nextCursor, of.path);
    of.cursor = nextCursor;
    return of.cursor;
  }

  closeSync(fd: number) {
    const of = this.openFiles.get(fd);
    if (!of) throw createVfsError('EBADF');
    this.openFiles.delete(fd);
    if (this.pendingDeletedInodes.has(of.inode) && !this.hasOpenHandleForInode(of.inode)) {
      this.pendingDeletedInodes.delete(of.inode);
      this.invalidateFlush();
      for (const block of of.inode.blocks) {
        if (block !== 0) this.releaseBlock(block);
      }
      of.inode.blocks = [];
      of.inode.size = 0;
    }
  }

  private toStat(inode: Inode): VfsStat {
    return {
      ino: inode.ino,
      mode: inode.mode,
      nlink: inode.nlink ?? 1,
      size: inode.size,
      blksize: BLOCK_SIZE,
      blocks:
        this.bufferMode === 'disk'
          ? inode.blocks.reduce((count, block) => count + (block === 0 ? 0 : BLOCK_SIZE / 512), 0)
          : Math.ceil(inode.size / 512),
      atimeMs: inode.atimeMs,
      mtimeMs: inode.mtimeMs,
      ctimeMs: inode.ctimeMs,
      timestampMs: inode.mtimeMs ?? inode.timestampMs,
      is_dir: inode.isDir,
      is_file: !inode.isDir && !isSymlinkInode(inode),
    };
  }

  fstatSync(fd: number): VfsStat {
    const of = this.openFiles.get(fd);
    if (!of) throw createVfsError('EBADF');
    return this.toStat(of.inode);
  }

  fsyncSync(fd: number) {
    if (!this.openFiles.has(fd)) throw createVfsError('EBADF');
    this.syncSync();
  }

  chmodSync(rawPath: string, mode: number) {
    if (!this.recordingLogicalChanges) return this.chmodSyncImpl(rawPath, mode);
    return this.withLogicalOperation(() => this.chmodSyncImpl(rawPath, mode));
  }

  private chmodSyncImpl(rawPath: string, mode: number): void {
    const normalized = normalizeFsPath(rawPath);
    const path = this.resolveInodePath(normalized.path, true);
    const { requiresDirectory } = normalized;
    const inode = this.getInodeByPath(path);
    if (!inode) throw createVfsError('ENOENT', path);
    if (requiresDirectory && !inode.isDir) throw createVfsError('ENOTDIR', path);
    this.assertSearchablePath(path, requiresDirectory || inode.isDir);
    // COR-1: POSIX chmod is gated by ownership, not the file's own write bit. This
    // VFS is single-user (every caller "owns" every inode), so requiring the write
    // bit made read-only files irreversible (no way to chmod 0o644 back onto a 0o444
    // file). Drop the writability assertion.
    // COR-2: chmod must touch only the permission/setuid bits (low 12). Storing the
    // raw mode verbatim wiped the file-type bits (S_IFREG/S_IFDIR/S_IFLNK), so a
    // chmod'd file/dir/symlink would later stat as the wrong type. Preserve the
    // existing type bits and replace only the 0o7777 portion.
    const nextMode = (inode.mode & 0o170000) | (mode & 0o7777);
    if (inode.mode === nextMode) return;
    this.impactInode(inode);
    this.invalidateFlush();
    inode.mode = nextMode;
    this.touchInodeMetadata(path);
    this.recordLogicalUpdate(inode);
  }

  utimesSync(rawPath: string, atimeMs: number, mtimeMs: number) {
    if (!this.recordingLogicalChanges) return this.utimesSyncImpl(rawPath, atimeMs, mtimeMs);
    return this.withLogicalOperation(() => this.utimesSyncImpl(rawPath, atimeMs, mtimeMs));
  }

  private utimesSyncImpl(rawPath: string, atimeMs: number, mtimeMs: number): void {
    if (!Number.isFinite(atimeMs) || !Number.isFinite(mtimeMs)) throw createVfsError('EINVAL', rawPath, 'Invalid time');
    const normalized = normalizeFsPath(rawPath);
    const path = this.resolveInodePath(normalized.path, true);
    const { requiresDirectory } = normalized;
    const inode = this.getInodeByPath(path);
    if (!inode) throw createVfsError('ENOENT', path);
    if (requiresDirectory && !inode.isDir) throw createVfsError('ENOTDIR', path);
    this.assertSearchablePath(path, requiresDirectory || inode.isDir);
    // COR-1: like chmod, POSIX utimes is an ownership operation, not gated by the
    // file's own write bit. Requiring it broke `cp` of a read-only file (the
    // utimes step threw EACCES). Drop the writability assertion.
    if (inode.atimeMs === atimeMs && inode.mtimeMs === mtimeMs) return;
    this.impactInode(inode);
    this.invalidateFlush();
    inode.atimeMs = atimeMs;
    inode.mtimeMs = mtimeMs;
    inode.ctimeMs = Date.now();
    inode.timestampMs = inode.mtimeMs;
    this.dirtyInodes.add(path);
    this.recordLogicalUpdate(inode);
  }

  linkSync(rawExistingPath: string, rawNewPath: string) {
    if (!this.recordingLogicalChanges) return this.linkSyncImpl(rawExistingPath, rawNewPath);
    return this.withLogicalOperation(() => this.linkSyncImpl(rawExistingPath, rawNewPath));
  }

  private linkSyncImpl(rawExistingPath: string, rawNewPath: string): void {
    const existingNormalized = normalizeFsPath(rawExistingPath);
    const newNormalized = normalizeFsPath(rawNewPath);
    const existingPath = this.resolveInodePath(existingNormalized.path, false);
    const inode = this.getInodeByPath(existingPath);
    if (!inode) throw createVfsError('ENOENT', existingPath);
    if (existingNormalized.requiresDirectory && !inode.isDir) throw createVfsError('ENOTDIR', existingPath);
    if (inode.isDir) throw createVfsError('EPERM', existingPath, 'Hard links to directories are not supported');

    const newPath = this.resolveInodePath(newNormalized.path, false);
    if (this.hasPathEntry(newPath)) throw createVfsError('EEXIST', newPath);
    if (newNormalized.requiresDirectory && !inode.isDir) throw createVfsError('ENOTDIR', newPath);

    const parent = parentPath(newPath);
    const name = baseName(newPath);
    const parentInode = this.getInodeByPath(parent);
    if (!parentInode) throw createVfsError('ENOENT', parent);
    if (!parentInode.isDir) throw createVfsError('ENOTDIR', parent);

    this.assertSearchablePath(existingPath, existingNormalized.requiresDirectory || inode.isDir);
    this.assertSearchablePath(parent, true);
    this.assertDirectoryWritable(parent, parentInode);
    // SEC-4: a hard link adds a namespace entry — enforce name/depth/count quotas
    // before mutating. (Bytes are shared with the existing inode, so no maxTotalBytes.)
    this.assertNameWithinQuota(newPath);
    this.assertFileCountWithinQuota(newPath);
    this.impact(newPath, false);

    this.invalidateFlush();
    inode.nlink = (inode.nlink ?? 1) + 1;
    this.addDirEntry(parentInode, name, inode);
    this.linkInodePath(newPath, inode);
    sortedInsert(this.sortedPaths, newPath);
    if (this.bufferMode === 'memory') {
      const data = this.lookupFileDataForInode(existingPath, inode);
      if (data) this.fileData.set(newPath, data);
    }
    this.commitNamespaceChange();
    this.markAllPathsForInode(inode);

    const now = Date.now();
    inode.ctimeMs = now;
    inode.timestampMs = inode.mtimeMs ?? inode.timestampMs;
    this.touchInode(parent, now);
    this.dirtyInodes.add(existingPath);
    this.dirtyInodes.add(newPath);
    this.flushMemoryNamespaceLog();
    this.recordLogicalCreate(newPath, inode);
  }

  unlinkSync(rawPath: string) {
    if (!this.recordingLogicalChanges) return this.unlinkSyncImpl(rawPath);
    return this.withLogicalOperation(() => this.unlinkSyncImpl(rawPath));
  }

  private unlinkSyncImpl(rawPath: string): void {
    const normalized = normalizeFsPath(rawPath);
    const path = this.resolveInodePath(normalized.path, false);
    const { requiresDirectory } = normalized;
    const inode = this.getInodeByPath(path);
    if (!inode) throw createVfsError('ENOENT', path);
    if (requiresDirectory && !inode.isDir) throw createVfsError('ENOTDIR', path);
    if (inode.isDir) throw createVfsError('EISDIR', path);
    const parent = parentPath(path);
    const parentInode = this.getInodeByPath(parent);
    this.assertSearchablePath(parent, true);
    if (parentInode) this.assertDirectoryWritable(parent, parentInode);
    this.impact(path, false);
    if (parentInode) this.removeDirEntry(parentInode, baseName(path));
    // COR-3: mark any descriptors opened on this exact path as unlinked BEFORE the
    // namespace check below, so a still-open fd on the file being removed no longer
    // makes the (now-empty) parent look busy. The fd itself stays valid: the inode
    // is retained via pendingDeletedInodes (when this was its last link) and its
    // blocks are freed at last close.
    this.markOpenFilesUnlinked(path);
    this.recordLogicalDelete(path, inode);
    this.removeNamespaceEntry(path, inode);
    this.commitNamespaceChange();
    this.markAllPathsForInode(inode);
    this.touchInode(parent);
    this.dirtyInodes.add(parent);
    this.flushMemoryNamespaceLog();
  }

  rmdirSync(rawPath: string) {
    if (!this.recordingLogicalChanges) return this.rmdirSyncImpl(rawPath);
    return this.withLogicalOperation(() => this.rmdirSyncImpl(rawPath));
  }

  private rmdirSyncImpl(rawPath: string): void {
    const normalized = normalizeFsPath(rawPath);
    const path = this.resolveInodePath(normalized.path, false);
    const { requiresDirectory } = normalized;
    if (path === '/') throw createVfsError('EPERM', path);
    const inode = this.getInodeByPath(path);
    if (!inode) throw createVfsError('ENOENT', path);
    if (requiresDirectory && !inode.isDir) throw createVfsError('ENOTDIR', path);
    if (!inode.isDir) throw createVfsError('ENOTDIR', path);
    this.assertSearchablePath(path, true);
    if (this.listDirNames(inode).length > 0) throw createVfsError('ENOTEMPTY', path);
    if (this.hasOpenFilesInSubtree(path)) throw createVfsError('EBUSY', path);
    const parent = parentPath(path);
    const parentInode = this.getInodeByPath(parent);
    if (parentInode) this.assertDirectoryWritable(parent, parentInode);
    this.impact(path, true);
    if (parentInode) {
      this.removeDirEntry(parentInode, baseName(path));
      parentInode.nlink = Math.max(2, (parentInode.nlink ?? 2) - 1);
    }
    this.deleteSubtree(path);
    this.commitNamespaceChange();
    this.touchInode(parent);
    this.dirtyInodes.add(parent);
    this.flushMemoryNamespaceLog();
  }

  removeSync(path: string) {
    if (!this.recordingLogicalChanges) return this.removeSyncImpl(path);
    return this.withLogicalOperation(() => this.removeSyncImpl(path));
  }

  private removeSyncImpl(path: string): void {
    const normalized = normalizeFsPath(path);
    const normalizedPath = this.resolveInodePath(normalized.path, false);
    const inode = this.getInodeByPath(normalizedPath);
    if (!inode) throw createVfsError('ENOENT', normalizedPath);
    if (normalized.requiresDirectory && !inode.isDir) throw createVfsError('ENOTDIR', normalizedPath);
    if (inode.isDir) {
      if (normalizedPath === '/') throw createVfsError('EPERM', normalizedPath);
      if (this.hasOpenFilesInSubtree(normalizedPath)) throw createVfsError('EBUSY', normalizedPath);
      this.assertSearchablePath(normalizedPath, true);
      const parent = parentPath(normalizedPath);
      const parentInode = this.getInodeByPath(parent);
      if (parentInode) this.assertDirectoryWritable(parent, parentInode);
      this.impact(normalizedPath, true);
      if (parentInode) {
        this.removeDirEntry(parentInode, baseName(normalizedPath));
        parentInode.nlink = Math.max(2, (parentInode.nlink ?? 2) - 1);
      }
      this.deleteSubtree(normalizedPath);
      this.commitNamespaceChange();
      this.touchInode(parent);
      this.dirtyInodes.add(parent);
      this.flushMemoryNamespaceLog();
      return;
    }
    this.unlinkSync(normalizedPath);
  }

  renameSync(rawOldPath: string, rawNewPath: string) {
    if (!this.recordingLogicalChanges) return this.renameSyncImpl(rawOldPath, rawNewPath);
    return this.withLogicalOperation(() => this.renameSyncImpl(rawOldPath, rawNewPath));
  }

  private renameSyncImpl(rawOldPath: string, rawNewPath: string): void {
    const oldNormalized = normalizeFsPath(rawOldPath);
    const newNormalized = normalizeFsPath(rawNewPath);
    const oldPath = this.resolveInodePath(oldNormalized.path, false);
    const newPath = this.resolveInodePath(newNormalized.path, false);
    const inode = this.getInodeByPath(oldPath);
    if (!inode) throw createVfsError('ENOENT', oldPath);
    if (oldNormalized.requiresDirectory && !inode.isDir) throw createVfsError('ENOTDIR', oldPath);
    if (newNormalized.requiresDirectory && !inode.isDir) throw createVfsError('ENOTDIR', newPath);
    // POSIX: renaming one hard link over another of the same inode does nothing.
    if (this.getInodeByPath(newPath) === inode) return;
    if (oldPath === '/') throw createVfsError('EPERM', oldPath);
    this.assertSearchablePath(oldPath, oldNormalized.requiresDirectory || inode.isDir);
    if (inode.isDir && newPath.startsWith(`${oldPath}/`)) {
      throw createVfsError('EINVAL', newPath, 'Cannot move directory into its own subtree');
    }
    const oldParent = parentPath(oldPath);
    const oldName = baseName(oldPath);
    const oldParentInode = this.getInodeByPath(oldParent);
    const newParent = parentPath(newPath);
    const newName = baseName(newPath);
    const newParentInode = this.getInodeByPath(newParent);
    if (!newParentInode) throw createVfsError('ENOENT', newParent);
    if (!newParentInode.isDir) throw createVfsError('ENOTDIR', newParent);
    if (oldParentInode) {
      this.assertSearchablePath(oldParent, true);
      this.assertDirectoryWritable(oldParent, oldParentInode);
    }
    this.assertSearchablePath(newParent, true);
    this.assertDirectoryWritable(newParent, newParentInode);
    // SEC-4: rename mints a new namespace entry — without this, a short name
    // created within quota could be renamed past maxNameLength/maxPathDepth.
    this.assertNameWithinQuota(newPath);
    if (this.maxPathDepth !== undefined && inode.isDir) {
      const depth = (value: string) => value.split('/').filter(Boolean).length;
      const deepest = this.collectSubtreePaths(oldPath).reduce((max, entry) => Math.max(max, depth(entry)), 0);
      const moved = deepest - depth(oldPath) + depth(newPath);
      if (moved > this.maxPathDepth) {
        throw createVfsError('ENOSPC', newPath, `Path depth ${moved} exceeds maximum ${this.maxPathDepth}`);
      }
    }
    const replacedInode = this.getInodeByPath(newPath);
    if (replacedInode) {
      this.assertSearchablePath(newPath, replacedInode.isDir || newNormalized.requiresDirectory);
      if (inode.isDir !== replacedInode.isDir) {
        throw createVfsError(replacedInode.isDir ? 'EISDIR' : 'ENOTDIR', newPath);
      }
      if (replacedInode.isDir) {
        // A directory target must be empty to be replaced. A non-empty directory
        // (whether by entries or by open descriptors in its subtree) is a genuine
        // conflict — keep the EBUSY/ENOTEMPTY behavior for directories.
        if (this.listDirNames(replacedInode).length > 0) {
          throw createVfsError('ENOTEMPTY', newPath);
        }
        if (this.hasOpenFilesInSubtree(newPath)) {
          throw createVfsError('EBUSY', newPath);
        }
      }
    }
    this.impact(oldPath, true);
    this.impact(newPath, true);
    this.markLinkedInodeDirty(inode);
    if (replacedInode) {
      // COR-3: POSIX rename atomically replaces an existing FILE target even if a
      // descriptor is open on it; the open fd stays valid on the now-detached
      // (replaced) inode and deleteSubtree defers its free to the last close.
      if (!replacedInode.isDir) this.markOpenFilesUnlinked(newPath);
      this.deleteSubtree(newPath, 0);
    }

    if (oldParent === newParent) {
      if (oldParentInode) {
        this.removeDirEntry(oldParentInode, oldName);
        this.addDirEntry(oldParentInode, newName, inode);
        // COR-4: when the target was a (now-deleted) subdirectory, deleteSubtree
        // removed it but never adjusted the parent's link count. The replaced
        // subdir's ".." entry contributed +1 to this parent's nlink; the moved dir
        // was already a child of the same parent, so it adds nothing new. Net -1.
        // Mirrors the cross-parent branch, which avoids the +1 when replacing a dir.
        if (inode.isDir && replacedInode?.isDir) {
          oldParentInode.nlink = Math.max(2, (oldParentInode.nlink ?? 2) - 1);
        }
        this.touchInode(oldParent);
      }
    } else {
      if (oldParentInode) {
        this.removeDirEntry(oldParentInode, oldName);
        if (inode.isDir) {
          oldParentInode.nlink = Math.max(2, (oldParentInode.nlink ?? 2) - 1);
        }
      }
      this.removeDirEntry(newParentInode, newName);
      this.addDirEntry(newParentInode, newName, inode);
      if (inode.isDir && !replacedInode?.isDir) {
        newParentInode.nlink = (newParentInode.nlink ?? 2) + 1;
      }
      this.touchInode(oldParent);
      this.touchInode(newParent);
    }

    const subtreePaths = this.collectSubtreePaths(oldPath);
    const oldToNew = new Map<string, string>();
    for (const currentPath of subtreePaths) {
      oldToNew.set(currentPath, currentPath === oldPath ? newPath : `${newPath}${currentPath.slice(oldPath.length)}`);
    }
    const subtreeEntries = subtreePaths.map((currentPath) => ({
      oldPath: currentPath,
      inode: this.getInodeByPath(currentPath)!,
    }));

    for (const { oldPath: currentPath } of subtreeEntries) {
      this.recordLogicalDelete(currentPath, this.getInodeByPath(currentPath)!);
      this.unlinkInodePath(currentPath);
      if (this.bufferMode === 'memory') {
        const data = this.fileData.get(currentPath);
        this.fileData.delete(currentPath);
        const nextPath = oldToNew.get(currentPath)!;
        if (data) this.fileData.set(nextPath, data);
      }
      this.deletedInodes.add(currentPath);
      this.dirtyInodes.delete(currentPath);
    }

    for (const { oldPath: currentPath, inode: currentInode } of subtreeEntries) {
      const nextPath = oldToNew.get(currentPath)!;
      this.linkInodePath(nextPath, currentInode);
      this.dirtyInodes.add(nextPath);
      this.recordLogicalCreate(nextPath, currentInode);
    }
    this.moveSortedSubtree(oldPath, newPath);

    this.commitNamespaceChange();

    const renamedInode = this.getInodeByPath(newPath);
    if (renamedInode) this.touchInodeMetadata(newPath);

    for (const openFile of this.openFiles.values()) {
      const nextPath = oldToNew.get(openFile.path);
      if (nextPath) {
        openFile.path = nextPath;
      }
    }

    this.dirtyInodes.add(oldParent);
    if (newParent !== oldParent) this.dirtyInodes.add(newParent);
    this.flushMemoryNamespaceLog();
  }

  ftruncateSync(fd: number, size: number) {
    if (!this.recordingLogicalChanges) return this.ftruncateSyncImpl(fd, size);
    return this.withLogicalOperation(() => this.ftruncateSyncImpl(fd, size));
  }

  private ftruncateSyncImpl(fd: number, size: number): void {
    const of = this.openFiles.get(fd);
    if (!of) throw createVfsError('EBADF');
    if (!of.writable) throw createVfsError('EBADF', of.path, 'Descriptor is not open for writing');
    this.truncateInode(of.path, of.inode, size);
  }

  private truncateInode(path: string, inode: Inode, size: number) {
    // SEC-2: reject NaN/Infinity/float/negative sizes and enforce the file-size
    // ceiling BEFORE any side effect (WAL append, block allocation). A NaN size
    // slips past a plain `< 0` check and drives ensureDiskBlocks to allocate
    // ~10^11 blocks (or appends a poison WAL record in memory mode).
    this.assertValidOffset(size, path, 'truncate size');
    this.assertWithinMaxFileSize(size, path);
    // SEC-4: a grow-via-truncate counts toward maxTotalBytes (opt-in).
    this.assertTotalBytesWithinQuota(inode, size, path);
    if (inode.isDir) throw createVfsError('EISDIR', path);
    const changed = inode.size !== size;
    if (changed) this.impactInode(inode);
    this.invalidateFlush();
    const oldSize = inode.size;
    if (this.bufferMode === 'memory') {
      this.appendDataWal({ version: 1, op: 'truncate', inodeId: inode.ino, path, size });
    }
    if (this.bufferMode === 'disk') {
      if (size > oldSize) {
        const oldTailEnd = Math.min(size, Math.ceil(oldSize / BLOCK_SIZE) * BLOCK_SIZE);
        if (oldTailEnd > oldSize) this.withQuotaMapped(() => this.zeroDiskRange(inode, oldSize, oldTailEnd), path);
        const blocksNeeded = Math.ceil(size / BLOCK_SIZE);
        while (inode.blocks.length < blocksNeeded) inode.blocks.push(0);
      }
      const blocksNeeded = size === 0 ? 0 : Math.ceil(size / BLOCK_SIZE);
      while (inode.blocks.length > blocksNeeded) {
        const block = inode.blocks.pop()!;
        if (block !== 0) this.releaseBlock(block);
      }
    }
    inode.size = size;
    // PERF-9: truncate can change the block table (shrink frees blocks); force a
    // full record so replay does not keep a stale, longer block list.
    this.markAllPathsForInode(inode);
    this.touchInode(path, Date.now(), inode);
    if (changed) this.recordLogicalUpdate(inode);

    if (this.bufferMode === 'memory') {
      const livePath = this.pathForInode(inode);
      const existingBuffer = this.lookupFileDataForInode(livePath, inode);
      const openBuffer = Array.from(this.openFiles.values()).find((openFile) => openFile.inode === inode)?.data;
      const buf = existingBuffer ?? openBuffer ?? new Uint8Array(0);
      let nextBuf: Uint8Array;
      if (size <= buf.length) {
        nextBuf = buf.slice(0, size);
      } else {
        nextBuf = new Uint8Array(size);
        nextBuf.set(buf);
      }
      this.syncFileDataForInode(inode, nextBuf);
      this.updateOpenFileBuffers(inode, nextBuf);
      this.markResized(inode, oldSize, size);
    }
  }

  truncateSync(rawPath: string, size: number) {
    if (!this.recordingLogicalChanges) return this.truncateSyncImpl(rawPath, size);
    return this.withLogicalOperation(() => this.truncateSyncImpl(rawPath, size));
  }

  private truncateSyncImpl(rawPath: string, size: number): void {
    const normalized = normalizeFsPath(rawPath);
    const path = this.resolveInodePath(normalized.path, true);
    const { requiresDirectory } = normalized;
    const inode = this.getInodeByPath(path);
    if (!inode) throw createVfsError('ENOENT', path);
    if (requiresDirectory && !inode.isDir) throw createVfsError('ENOTDIR', path);
    this.assertSearchablePath(path, requiresDirectory || inode.isDir);
    this.assertInodeWritable(path, inode);
    this.truncateInode(path, inode, size);
  }

  existsSync(rawPath: string): boolean {
    const normalized = normalizeFsPath(rawPath);
    let path: string;
    try {
      path = this.resolveInodePath(normalized.path, true);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === 'ENOTDIR' || code === 'ELOOP' || code === 'EACCES') return false;
      throw error;
    }
    const { requiresDirectory } = normalized;
    const inode = this.getInodeByPath(path);
    if (!inode) return false;
    return !requiresDirectory || inode.isDir;
  }

  statSync(rawPath: string): VfsStat {
    const normalized = normalizeFsPath(rawPath);
    const path = this.resolveInodePath(normalized.path, true);
    const { requiresDirectory } = normalized;
    const inode = this.getInodeByPath(path);
    if (!inode) throw createVfsError('ENOENT', path);
    if (requiresDirectory && !inode.isDir) throw createVfsError('ENOTDIR', path);
    this.assertSearchablePath(path, requiresDirectory || inode.isDir);
    return this.toStat(inode);
  }

  lstatSync(rawPath: string): VfsStat {
    const normalized = normalizeFsPath(rawPath);
    const path = this.resolveInodePath(normalized.path, false);
    const inode = this.getInodeByPath(path);
    if (!inode) throw createVfsError('ENOENT', path);
    if (normalized.requiresDirectory && !inode.isDir) throw createVfsError('ENOTDIR', path);
    this.assertSearchablePath(path, normalized.requiresDirectory || inode.isDir);
    return this.toStat(inode);
  }

  readdirSync(rawPath: string): string[] {
    const path = this.resolveInodePath(normalizeFsPath(rawPath).path, true);
    const inode = this.getInodeByPath(path);
    if (!inode) throw createVfsError('ENOENT', path);
    if (!inode.isDir) throw createVfsError('ENOTDIR', path);
    this.assertSearchablePath(path, true);
    this.assertDirectoryReadable(path, inode);
    this.touchInodeAccess(path, inode);
    return ['.', '..', ...this.listDirNames(inode)];
  }

  readdirNamesSync(rawPath: string): string[] {
    const path = this.resolveInodePath(normalizeFsPath(rawPath).path, true);
    const inode = this.getInodeByPath(path);
    if (!inode) throw createVfsError('ENOENT', path);
    if (!inode.isDir) throw createVfsError('ENOTDIR', path);
    this.assertSearchablePath(path, true);
    this.assertDirectoryReadable(path, inode);
    this.touchInodeAccess(path, inode);
    return this.listDirNames(inode).slice().sort();
  }

  readdirEntriesSync(rawPath: string): VfsDirEntry[] {
    const path = this.resolveInodePath(normalizeFsPath(rawPath).path, true);
    const inode = this.getInodeByPath(path);
    if (!inode) throw createVfsError('ENOENT', path);
    if (!inode.isDir) throw createVfsError('ENOTDIR', path);
    this.assertSearchablePath(path, true);
    this.assertDirectoryReadable(path, inode);
    this.touchInodeAccess(path, inode);

    return this.listDirNames(inode)
      .slice()
      .sort()
      .map((name) => {
        const childInode = this.lookupChild(path, inode, name).inode;
        if (!childInode) throw createVfsError('ENOENT', path);
        return {
          name,
          mode: childInode.mode,
          is_dir: childInode.isDir,
          is_file: !childInode.isDir && !isSymlinkInode(childInode),
        };
      });
  }

  listPathsSync(): string[] {
    if (this.closed) throw createVfsError('EBADF', undefined, 'Volume is closed');
    this.ensureDerivedIndexes();
    return [...this.sortedPaths];
  }

  syncSync() {
    if (this.closed) return;
    this.setLocalPersistenceState('flushing');
    try {
      if (this.bufferMode === 'disk') {
        const hasDirtyMeta = this.hasDirtyMeta;
        if (!this.dataDirty && !hasDirtyMeta) {
          this.setLocalPersistenceState('clean');
          return;
        }
        // Ordering barrier: flush data blocks durable before persisting the
        // meta that references them.
        // Allocation state is never persisted: it is rebuilt from metadata.
        // #54/H2: commit the .crypt sidecar (journaled, crash-atomic) BEFORE
        // flushing the data blocks. OPFS gives no cross-file ordering, but this
        // makes the GUARANTEED window (between the two flushes) the salvageable
        // skew: if the sidecar lands and the data doesn't, each re-sealed block
        // still holds its PRIOR ciphertext, which decrypts via the record's
        // prev {nonce, tag} pair (H3 salvage) — a consistent-old read, matching
        // the old meta that never got written. The reverse skew (data writes
        // becoming durable before an unflushed sidecar, e.g. spontaneous
        // writeback) cannot always be recovered. Both modes surface unreadable
        // encrypted data as CryptoIntegrityError instead of substituting zeros.
        this.storage?.beforeDataCommit?.();
        this.flushData();
        if (hasDirtyMeta) {
          this.writeMeta();
        }
        this.lastLocalFlushAt = Date.now();
        this.setLocalPersistenceState('clean');
        return;
      }
      if (
        this.dirtyPages.size === 0 &&
        !this.dataDirty &&
        !this.hasDirtyMeta &&
        !this.metaLogFlushPending &&
        !this.walPendingBytes
      ) {
        this.setLocalPersistenceState('clean');
        return;
      }
      this.flushRecoveryLogs();
      this.persistToOpfs();
      const hasDirtyMeta = this.hasDirtyMeta;
      // #54/H2: sidecar (journaled) before the data flush — the guaranteed skew
      // direction then reads old content via prev-pair salvage (see the disk
      // branch above for the full rationale).
      this.storage?.beforeDataCommit?.();
      this.flushData();
      if (hasDirtyMeta) {
        this.writeMeta();
      }
      // PERF-10: flush any namespace records that an earlier relaxed/balanced op
      // wrote-but-deferred (and that left no remaining dirty meta for writeMeta
      // to flush). Makes the deferred records durable at the sync barrier.
      this.flushPendingMetaLog();
      this.lastLocalFlushAt = Date.now();
      this.checkpointDataWal();
      this.setLocalPersistenceState('clean');
    } catch (error) {
      this.setLocalPersistenceState('error', error);
      throw error;
    }
  }

  private flushed = false;
  private closed = false;

  /**
   * A completed flush only covers mutations up to that point. If filesystem
   * operations continue afterward, the final close must flush again.
   */
  private invalidateFlush() {
    this.flushed = false;
    this.markLocalDirty();
  }

  private markDataDirty() {
    this.dataDirty = true;
    this.markLocalDirty();
  }

  private markLocalDirty() {
    this.setLocalPersistenceState('dirty');
    if (this.localDurabilityMode === 'balanced') this.scheduleBalancedFlush();
  }

  private ensureDataWalCycle() {
    if (this.dataLogOffset !== 0) return;
    const cycle = this.storage?.createDataWalCycle?.();
    if (!cycle) return;
    this.withQuotaMapped(() => this.dataLogHandle.write(cycle.prefix, { at: 0 }));
    this.dataLogOffset = cycle.prefix.byteLength;
    this.dataWalCycleSealer = cycle.codec;
  }

  /** Data WAL append boundary (cycle prefix, frame write and strict flush); failures are recorded. */
  private appendDataWal(record: DataWalRecord) {
    try {
      this.appendDataWalRecord(record);
    } catch (error) {
      this.setLocalPersistenceState('error', error);
      throw error;
    }
  }

  private appendDataWalRecord(record: DataWalRecord) {
    if (this.bufferMode !== 'memory') return;
    if (this.dataWalTruncatePending) this.checkpointDataWal();
    this.ensureDataWalCycle();
    // #54: identity = the byte offset where this frame is written, which is what
    // the decode side derives as the AEAD identity on replay. Must match exactly.
    // M1: the sealer is the current CYCLE's (salted epoch) on encrypted volumes.
    const encoded = encodeDataWalRecord(record, this.dataWalCycleSealer ?? this.sealer, this.dataLogOffset);
    // §6.3: map a quota failure here to ENOSPC. The write is attempted BEFORE the
    // in-memory buffer grow (writeSync) so a failed append leaves no in-memory
    // state ahead of the WAL — dataLogOffset is only advanced on success.
    const recordPath = 'path' in record ? record.path : undefined;
    this.withQuotaMapped(() => this.dataLogHandle.write(encoded, { at: this.dataLogOffset }), recordPath);
    this.dataLogOffset += encoded.byteLength;
    // PERF-2(b): flush policy by durability mode. The per-record fsync was the
    // dominant memory-mode write cost and is only load-bearing for `strict`.
    //  - strict:   fsync every record (unchanged) — every write is crash-durable.
    //  - balanced: defer to the debounced sync (scheduled below via
    //              markLocalDirty); a crash loses writes since the last sync
    //              (≤ debounce window).
    //  - relaxed:  defer to the next explicit sync/checkpoint only.
    // In all modes the bytes are already WRITTEN to the WAL handle; only the
    // durability barrier (flush) moves. The checkpoint at sync truncates the WAL
    // once the data is persisted, so deferred records are never replayed stale.
    if (this.localDurabilityMode === 'strict') {
      this.dataLogHandle.flush();
    }
    // balanced: ensure the debounced sync is scheduled so the deferred flush
    // actually lands within the debounce window. relaxed waits for an explicit
    // sync/checkpoint. strict already flushed above. markLocalDirty schedules
    // the balanced timer (idempotent) and sets 'dirty'.
    this.markLocalDirty();
    this.logWalDebug('append', record.op, { bytes: encoded.byteLength, pendingBytes: this.walPendingBytes });
  }

  /** Data WAL checkpoint boundary, also reached from a later write's retry; failures are recorded. */
  private checkpointDataWal() {
    try {
      this.checkpointDataWalRecords();
    } catch (error) {
      this.setLocalPersistenceState('error', error);
      throw error;
    }
  }

  private checkpointDataWalRecords() {
    if (this.bufferMode !== 'memory') return;
    if (!this.dataWalTruncatePending && this.walPendingBytes === 0 && this.dataLogHandle.getSize() === 0) return;
    // A failed truncate/flush must be retried before any new cycle or frame is
    // written, whether the old tail or the truncated file survives a crash.
    this.dataWalTruncatePending = true;
    this.dataLogHandle.truncate(0);
    this.dataLogHandle.flush();
    this.dataWalTruncatePending = false;
    this.dataLogOffset = 0;
    this.dataWalCycleSealer = undefined;
    this.lastLocalCheckpointAt = Date.now();
    this.logWalDebug('checkpoint');
  }

  private installBalancedModeHooks() {
    const scope = globalThis as unknown as {
      addEventListener?: (event: string, callback: () => void) => void;
      removeEventListener?: (event: string, callback: () => void) => void;
    };
    const flush = () => {
      try {
        this.flushVfs();
      } catch (error) {
        // INT-6: a pagehide/beforeunload flush cannot propagate (the hook can't
        // throw usefully), but the failure must still be observable — record it
        // so getLocalPersistenceStatusSync() reflects the unpersisted state
        // rather than silently swallowing it.
        this.setLocalPersistenceState('error', error);
        this.logWalDebug('balanced flush hook failed', error);
      }
    };
    scope.addEventListener?.('pagehide', flush);
    scope.addEventListener?.('beforeunload', flush);
    this.removeBalancedModeHooks = () => {
      scope.removeEventListener?.('pagehide', flush);
      scope.removeEventListener?.('beforeunload', flush);
    };
  }

  private scheduleBalancedFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      if (this.closed) return;
      try {
        this.syncSync();
      } catch (error) {
        this.setLocalPersistenceState('error', error);
        this.logWalDebug('balanced scheduled sync failed', error);
      }
    }, 150);
  }

  private flushData(force = false) {
    if (!force && !this.dataDirty) return;
    this.dataHandle?.flush();
    this.dataDirty = false;
    this.flushedDataSize = this.dataHandle.getSize();
    this.flushedLogicalExtent = (this.bitmap.highestSet() + 1) * BLOCK_SIZE;
  }

  /** Persist all dirty data and metadata to OPFS without closing handles. */
  flushVfs() {
    if (this.closed || this.flushed) return;
    this.setLocalPersistenceState('flushing');
    try {
      if (this.bufferMode === 'memory') {
        this.flushRecoveryLogs();
        this.persistToOpfs();
      }
      // Ordering barrier: data blocks must be durable before meta records the
      // sizes/block tables that reference them.
      // #54/H2: sidecar (journaled) before the data flush — the guaranteed skew
      // direction then reads old content via prev-pair salvage (see syncSync).
      this.storage?.beforeDataCommit?.();
      this.flushData(true);
      this.writeMeta(true); // force = full snapshot + clear log (bumps generation)
      if (this.bufferMode === 'memory') this.checkpointDataWal();
      this.lastLocalFlushAt = Date.now();
      // INT-6: mark `flushed` only AFTER the work succeeds. Setting it up front
      // let a throwing flush leave `flushed === true`, so closeVfs would skip
      // the retry and close handles with data still unpersisted.
      this.flushed = true;
      this.setLocalPersistenceState('clean');
    } catch (error) {
      this.setLocalPersistenceState('error', error);
      throw error;
    }
  }

  /** Flush and close all OPFS handles. */
  closeVfs(): Promise<void> | undefined {
    if (this.initializing) {
      this.closeRequested = true;
      this.closing ??= this._ready.then(
        () => undefined,
        () => undefined,
      );
      return this.closing;
    }
    if (this.closed) return this.closing;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    const errors: unknown[] = [];
    try {
      if (!this.flushed) this.flushVfs();
    } catch (error) {
      errors.push(error);
    } finally {
      try {
        this.closeLogicalChangeSession(isMountReplacement(this) ? 'replacement' : 'close');
      } catch (error) {
        errors.push(error);
      }
      // One broken close must not prevent later handles or the DEK from cleanup.
      for (const handle of [
        this.dataLogHandle,
        this.logHandle,
        this.metaHandleA,
        this.metaHandleB,
        this.bootstrapHandle,
        this.dataHandle,
        ...this.storageHandles,
      ]) {
        try {
          handle?.close();
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        this.storage?.destroy();
      } catch (error) {
        errors.push(error);
      }
      try {
        this.removeBalancedModeHooks?.();
      } catch (error) {
        errors.push(error);
      }
      this.removeBalancedModeHooks = undefined;
      this.openFiles.clear();
      this.storage = undefined;
      this.storageHandles = [];
      this.sealer = undefined;
      this.dataWalCycleSealer = undefined;
      this.closed = true;
      const release = this.releaseVolumeLock;
      this.releaseVolumeLock = undefined;
      this.closing = release?.();
    }
    if (errors.length > 0) {
      const error =
        errors.length === 1 ? errors[0] : new AggregateError(errors, 'VFS close failed', { cause: errors[0] });
      this.setLocalPersistenceState('error', error);
      throw error;
    }
    return this.closing;
  }

  async openFileChangeChannel(
    receive: (frame: ChangeFrame) => void,
    interrupted: (code: 'SUBSCRIPTION_INTERRUPTED' | 'SUBSCRIPTION_RESYNC_REQUIRED') => void,
    closed: () => void,
  ): Promise<FileChangeChannel> {
    return this.openFileChangeChannelForClient(this.directChangeClientId, 'local', receive, interrupted, closed);
  }

  /** Internal worker transport entry point. The worker stamps a verified normal-client identity. */
  private async openFileChangeChannelForClient(
    clientId: string,
    route: ChangeClient['route'],
    receive: (frame: ChangeFrame) => void,
    interrupted: (code: 'SUBSCRIPTION_INTERRUPTED' | 'SUBSCRIPTION_RESYNC_REQUIRED') => void,
    closed: () => void,
    requestedChannelId?: string,
  ): Promise<FileChangeChannel> {
    if (typeof receive !== 'function' || typeof interrupted !== 'function' || typeof closed !== 'function') {
      throw createVfsError('EINVAL', undefined, 'Invalid file change channel callbacks');
    }
    const channelId = requestedChannelId ?? crypto.randomUUID();
    if (
      typeof channelId !== 'string' ||
      !channelId ||
      channelId.length > 128 ||
      this.changeChannels.has(channelId) ||
      this.pendingChangeChannels.has(channelId)
    )
      throw createVfsError('EINVAL', undefined, 'Invalid file change channel');
    if (
      typeof clientId !== 'string' ||
      !clientId ||
      clientId.length > 128 ||
      (route !== 'local' && route !== 'follower-relay')
    )
      throw createVfsError('EINVAL', undefined, 'Invalid file change client');
    if (
      this.changeChannels.size + this.pendingChangeChannels.size >= 128 ||
      (this.changeChannelCounts.get(clientId) ?? 0) >= 32
    )
      throw createVfsError('EBUSY', undefined, 'Too many file change channels');
    this.pendingChangeChannels.add(channelId);
    this.changeChannelCounts.set(clientId, (this.changeChannelCounts.get(clientId) ?? 0) + 1);
    try {
      await this.ready;
      if (this.closed) throw createVfsError('EBADF', undefined, 'Volume is closed');
      if (!this.logicalSession || this.logicalChangesPoisoned)
        throw createVfsError('ENOTSUP', undefined, 'Logical changes unavailable');
      const client = Object.freeze({ clientId, channelId, route });
      const channel = { client, receive, interrupted, closedCallback: closed, closed: false, clientDisposed: false };
      this.pendingChangeChannels.delete(channelId);
      this.changeChannels.set(channelId, channel);
      return {
        generation: this.changeGeneration,
        request: async (command) => {
          if (channel.closed) throw createVfsError('EBADF', undefined, 'File change channel is closed');
          // Admit commands between filesystem operations, never inside a synchronous mutator (e.g. from a getter).
          await Promise.resolve();
          if (channel.closed) throw createVfsError('EBADF', undefined, 'File change channel is closed');
          const snapshot = snapshotChangeCommand(command, 16 * 1024 * 1024).command;
          const subscriptionKey = JSON.stringify([client.clientId, client.channelId, snapshot.subscriptionId]);
          let admitted = false;
          if (snapshot.type === 'register') {
            const ids = this.changeSubscriptionIds.get(client.clientId) ?? new Set<string>();
            if (ids.has(subscriptionKey))
              throw createVfsError('EINVAL', undefined, 'Duplicate file change subscription');
            if (ids.size >= 32 || this.changeSubscriptionCount >= 128)
              throw createVfsError('ENOSPC', undefined, 'Too many file change subscriptions');
            ids.add(subscriptionKey);
            this.changeSubscriptionIds.set(client.clientId, ids);
            this.changeSubscriptionCount++;
            admitted = true;
          }
          const session = this.logicalSession;
          if (!session || this.logicalChangesPoisoned)
            throw createVfsError('ENOTSUP', undefined, 'Logical changes unavailable');
          try {
            const reply = session.control(client, snapshot);
            if (isChangeReply(snapshot, reply)) {
              if (snapshot.type === 'terminal-ack' && this.changeTerminalIds.delete(subscriptionKey))
                this.releaseChangeSubscription(client, subscriptionKey);
              return snapshot.type === 'register'
                ? { type: 'registered' as const, subscriptionId: snapshot.subscriptionId }
                : { type: 'ok' as const };
            }
            if (reply && typeof (reply as { then?: unknown }).then === 'function') {
              Promise.resolve(reply).catch(() => {});
            }
            this.poisonLogicalChanges();
            throw createVfsError('EINVAL', undefined, 'Invalid file change reply');
          } catch (error) {
            if (admitted) this.releaseChangeSubscription(client, subscriptionKey);
            if (snapshot.type !== 'register' || !isExpectedChangeControlError(error)) this.poisonLogicalChanges();
            throw error;
          }
        },
        close: () => this.closeChangeChannel(channelId, channel),
      };
    } catch (error) {
      if (this.pendingChangeChannels.delete(channelId)) {
        const count = this.changeChannelCounts.get(clientId) ?? 1;
        if (count <= 1) this.changeChannelCounts.delete(clientId);
        else this.changeChannelCounts.set(clientId, count - 1);
      }
      throw error;
    }
  }

  private createLogicalChangeSession() {
    const contribution = this.logicalChanges;
    if (!contribution) return;
    const host = {
      generation: this.changeGeneration,
      validateTarget: (target: Pick<WireSubscribeOptions, 'path' | 'scope' | 'recursive'>) => {
        if (this.closed || this.logicalSessionClosed) throw createVfsError('EBADF', undefined, 'Volume is closed');
        this.validateChangeTarget(target);
      },
      send: (client: ChangeClient, frame: ChangeFrame) => this.sendChangeFrame(client, frame),
    };
    const session = contribution.create.call(contribution.contribution, host);
    if (
      !session ||
      typeof session !== 'object' ||
      typeof session.control !== 'function' ||
      typeof session.completed !== 'function' ||
      typeof session.invalidated !== 'function' ||
      typeof session.clientClosed !== 'function' ||
      typeof session.close !== 'function'
    ) {
      if (session && typeof session === 'object' && typeof (session as { close?: unknown }).close === 'function') {
        try {
          (session as { close(reason: 'initialization-failed'): void }).close('initialization-failed');
        } catch {
          // Preserve the malformed-session error.
        }
      }
      if (session && typeof (session as { then?: unknown }).then === 'function')
        Promise.resolve(session).catch(() => {});
      throw createVfsError('EINVAL', undefined, 'Invalid logical change session');
    }
    this.logicalSession = session;
  }

  private closeLogicalChangeSession(reason: 'close' | 'initialization-failed' | 'replacement') {
    if (!this.logicalSession && !this.logicalChanges) return;
    if (this.logicalSessionClosed) return;
    this.logicalSessionClosed = true;
    const session = this.logicalSession;
    this.logicalSession = undefined;
    const channels = [...this.changeChannels.values()];
    for (const channel of channels) channel.closed = true;
    this.changeChannels.clear();
    this.changeChannelCounts.clear();
    this.pendingChangeChannels.clear();
    this.changeSubscriptionIds.clear();
    this.changeSubscriptionCount = 0;
    this.changeTerminalIds.clear();
    try {
      session?.close(reason);
    } finally {
      if (reason === 'close' || reason === 'replacement') {
        for (const channel of channels) {
          queueMicrotask(() => {
            if (channel.clientDisposed) return;
            try {
              if (reason === 'close') channel.closedCallback();
              else channel.interrupted('SUBSCRIPTION_INTERRUPTED');
            } catch {
              // Client callbacks are never allowed to escape a deferred task.
            }
          });
        }
      }
    }
  }

  private poisonLogicalChanges(
    code: 'SUBSCRIPTION_INTERRUPTED' | 'SUBSCRIPTION_RESYNC_REQUIRED' = 'SUBSCRIPTION_RESYNC_REQUIRED',
  ) {
    if (this.logicalChangesPoisoned) return;
    this.logicalChangesPoisoned = true;
    const session = this.logicalSession;
    this.logicalSession = undefined;
    this.logicalSessionClosed = true;
    try {
      session?.close('close');
    } catch {
      // A broken contribution cannot escape the filesystem operation it broke.
    }
    const channels = [...this.changeChannels.values()];
    for (const channel of channels) channel.closed = true;
    this.changeChannels.clear();
    this.changeChannelCounts.clear();
    this.pendingChangeChannels.clear();
    this.changeSubscriptionIds.clear();
    this.changeSubscriptionCount = 0;
    this.changeTerminalIds.clear();
    for (const channel of channels) {
      queueMicrotask(() => {
        if (!channel.clientDisposed) {
          try {
            channel.interrupted(code);
          } catch {
            // Client callbacks are never allowed to escape a deferred task.
          }
        }
      });
    }
  }

  /** Call before an irreversible namespace or inode mutation. */
  private impact(path: string, subtree: boolean): void {
    if (!this.recordingLogicalChanges) return;
    const operation = this.logicalOperation;
    if (!operation) return;
    if (operation.impactAll) return;
    const impacts = operation.impacts;
    for (let i = 0; i < impacts.length; i++) {
      const region = impacts[i];
      if (region.subtree && pathContains(region.path, path)) return;
      if (!subtree && region.path === path) return;
    }
    let charged = operation.impactCharged;
    if (subtree) {
      for (let i = impacts.length - 1; i >= 0; i--) {
        if (pathContains(path, impacts[i].path)) {
          charged -= operation.impactCharges[i];
          impacts.splice(i, 1);
          operation.impactCharges.splice(i, 1);
        }
      }
    }
    const charge = metadataCharge(path, 64 * 1024 - charged);
    if (impacts.length >= 128 || !Number.isFinite(charge)) {
      operation.impactAll = true;
      impacts.length = 0;
      operation.impactCharges.length = 0;
      return;
    }
    impacts.push({ path, subtree });
    operation.impactCharges.push(charge);
    operation.impactCharged = charged + charge;
  }

  /** Call before mutating an inode when all of its live aliases may be affected. */
  private impactInode(inode: Inode): void {
    if (!this.recordingLogicalChanges) return;
    const operation = this.logicalOperation;
    if (!operation || operation.impactAll) return;
    const paths = this.inoToPaths.get(inode.ino);
    if (!paths) return;
    // Count and charge before retaining any alias region.
    let additions = 0;
    let bytes = operation.impactCharged;
    for (const path of paths) {
      let covered = false;
      for (let i = 0; i < operation.impacts.length; i++) {
        const region = operation.impacts[i];
        if (region.subtree && (region.path === '/' || path === region.path || path.startsWith(`${region.path}/`))) {
          covered = true;
          break;
        }
        if (region.path === path) {
          covered = true;
          break;
        }
      }
      if (covered) continue;
      additions++;
      const charge = metadataCharge(path, 64 * 1024 - bytes);
      if (operation.impacts.length + additions > 128 || !Number.isFinite(charge)) {
        operation.impactAll = true;
        operation.impacts.length = 0;
        operation.impactCharges.length = 0;
        return;
      }
      bytes += charge;
    }
    for (const path of paths) this.impact(path, false);
  }

  /** Stage one exact namespace transition after it has succeeded. */
  private recordLogicalNamespace(type: 'create' | 'delete', path: string, inode: Inode, deletePhase = 1): void {
    if (!this.recordingLogicalChanges) return;
    const operation = this.logicalOperation;
    if (!operation) return;
    if (operation.overflow) return;
    const charge = metadataCharge(path, 4 * 1024 * 1024 - operation.charged);
    if (
      operation.namespace.length + operation.changedInodes.size >= 4096 ||
      !Number.isFinite(charge) ||
      operation.charged + charge > 4 * 1024 * 1024
    ) {
      operation.overflow = true;
      operation.namespace.length = 0;
      operation.changedInodes.clear();
      operation.createdPaths.clear();
      return;
    }
    operation.charged += charge;
    operation.namespace.push({
      type,
      path,
      kind: inode.isDir ? 'directory' : isSymlinkInode(inode) ? 'symlink' : 'file',
      inodeId: inode.ino,
      size: inode.size,
      deletePhase,
    });
    if (type === 'create') operation.createdPaths.add(path);
  }

  /** Stage a changed inode; its aliases are read only during successful finalization. */
  private recordLogicalUpdate(inode: Inode): void {
    if (!this.recordingLogicalChanges) return;
    const operation = this.logicalOperation;
    if (!operation) return;
    if (operation.overflow || operation.changedInodes.has(inode.ino)) return;
    if (
      operation.namespace.length + operation.changedInodes.size >= 4096 ||
      operation.charged + 256 > 4 * 1024 * 1024
    ) {
      operation.overflow = true;
      operation.namespace.length = 0;
      operation.changedInodes.clear();
      operation.createdPaths.clear();
      return;
    }
    operation.changedInodes.add(inode.ino);
    operation.charged += 256;
  }

  private recordLogicalCreate(path: string, inode: Inode): void {
    this.recordLogicalNamespace('create', path, inode);
  }

  private recordLogicalDelete(path: string, inode: Inode, deletePhase = 1): void {
    this.recordLogicalNamespace('delete', path, inode, deletePhase);
  }

  private withLogicalOperation<T>(action: () => T): T {
    if (!this.logicalOperation) this.logicalCaptureToken = undefined;
    if (!this.recordingLogicalChanges) return action();
    const outer = !this.logicalOperation;
    const operation =
      this.logicalOperation ??
      (this.logicalOperation = {
        depth: 0,
        failed: false,
        overflow: false,
        charged: 0,
        impactCharged: 0,
        impacts: [],
        impactCharges: [],
        impactAll: false,
        namespace: [],
        changedInodes: new Set(),
        createdPaths: new Set(),
      });
    operation.depth++;
    try {
      return action();
    } catch (error) {
      operation.failed = true;
      throw error;
    } finally {
      operation.depth--;
      if (outer && operation.depth === 0) {
        this.logicalOperation = undefined;
        if (operation.failed) {
          if (operation.impactAll || operation.impacts.length > 0) {
            this.callLogicalInvalidated(
              operation.impactAll ? { kind: 'all' } : { kind: 'paths', paths: operation.impacts },
              'partial-mutation',
            );
          }
        } else if (operation.overflow) {
          this.callLogicalInvalidated(
            operation.impactAll ? { kind: 'all' } : { kind: 'paths', paths: operation.impacts },
            'record-limit',
          );
        } else {
          this.completeLogicalOperation(operation);
        }
      }
    }
  }

  private completeLogicalOperation(operation: NonNullable<typeof this.logicalOperation>): void {
    const session = this.logicalSession;
    if (!session) return;
    let count = operation.namespace.length;
    let charge = operation.charged - operation.changedInodes.size * 256;
    for (const inodeId of operation.changedInodes) {
      const paths = this.inoToPaths.get(inodeId);
      if (!paths) continue;
      for (const path of paths) {
        if (operation.createdPaths.has(path)) continue;
        const pathCharge = metadataCharge(path, 4 * 1024 * 1024 - charge);
        if (!Number.isFinite(pathCharge)) {
          this.callLogicalInvalidated(
            operation.impactAll ? { kind: 'all' } : { kind: 'paths', paths: operation.impacts },
            'record-limit',
          );
          return;
        }
        count++;
        charge += pathCharge;
        if (count > 4096 || charge > 4 * 1024 * 1024) {
          this.callLogicalInvalidated(
            operation.impactAll ? { kind: 'all' } : { kind: 'paths', paths: operation.impacts },
            'record-limit',
          );
          return;
        }
      }
    }
    if (count === 0) return;
    if (this.logicalSequence > Number.MAX_SAFE_INTEGER - count) {
      this.poisonLogicalChanges('SUBSCRIPTION_INTERRUPTED');
      return;
    }
    const cursor = () => Object.freeze({ generation: this.changeGeneration, sequence: ++this.logicalSequence });
    const kindOf = (inode: Inode): LogicalRecord['kind'] =>
      inode.isDir ? 'directory' : isSymlinkInode(inode) ? 'symlink' : 'file';
    const records: LogicalRecord[] = [];
    const single = count === 1 ? operation.namespace[0] : undefined;
    if (single) {
      const inode = single.type === 'create' ? this.inodeTable.get(single.inodeId) : undefined;
      records.push({
        type: single.type,
        path: single.path,
        kind: inode ? kindOf(inode) : single.kind,
        inodeId: single.inodeId,
        size: inode?.size ?? single.size,
        cursor: cursor(),
      });
    } else if (count === 1) {
      // The single record is an update of one live name.
      for (const inodeId of operation.changedInodes) {
        const inode = this.inodeTable.get(inodeId);
        const paths = this.inoToPaths.get(inodeId);
        if (!inode || !paths) continue;
        for (const path of paths) {
          if (operation.createdPaths.has(path)) continue;
          records.push({ type: 'update', path, kind: kindOf(inode), inodeId, size: inode.size, cursor: cursor() });
          break;
        }
        if (records.length) break;
      }
    } else {
      const deletes: { record: (typeof operation.namespace)[number]; depth: number }[] = [];
      const creates: { record: (typeof operation.namespace)[number]; depth: number }[] = [];
      for (const record of operation.namespace) {
        const entry = { record, depth: pathDepth(record.path) };
        if (record.type === 'delete') deletes.push(entry);
        else creates.push(entry);
      }
      deletes.sort(compareDeleteEntry);
      creates.sort(compareCreateEntry);
      const updates: { path: string; inode: Inode; inodeId: number }[] = [];
      for (const inodeId of operation.changedInodes) {
        const inode = this.inodeTable.get(inodeId);
        const paths = this.inoToPaths.get(inodeId);
        if (!inode || !paths) continue;
        for (const path of paths) {
          if (!operation.createdPaths.has(path)) updates.push({ path, inode, inodeId });
        }
      }
      updates.sort(compareUpdateEntry);
      for (const { record } of deletes) {
        records.push({
          type: record.type,
          path: record.path,
          kind: record.kind,
          inodeId: record.inodeId,
          size: record.size,
          cursor: cursor(),
        });
      }
      for (const { record } of creates) {
        const inode = this.inodeTable.get(record.inodeId);
        records.push({
          type: record.type,
          path: record.path,
          kind: inode ? kindOf(inode) : record.kind,
          inodeId: record.inodeId,
          size: inode?.size ?? record.size,
          cursor: cursor(),
        });
      }
      for (const { path, inode, inodeId } of updates) {
        records.push({ type: 'update', path, kind: kindOf(inode), inodeId, size: inode.size, cursor: cursor() });
      }
    }
    for (const record of records) Object.freeze(record);
    Object.freeze(records);
    let recordTokens: WeakSet<LogicalRecord> | undefined;
    let captures: Map<Inode, Uint8Array> | undefined;
    const token = {};
    try {
      this.logicalCaptureToken = token;
      session.completed({
        records,
        capture: (record, maxBytes) => {
          try {
            const content = this.captureLogicalContent(
              record,
              maxBytes,
              token,
              (recordTokens ??= new WeakSet(records)),
              (captures ??= new Map()),
            );
            if (content.status === 'included' && content.bytes.buffer instanceof ArrayBuffer)
              this.logicalCaptureBuffers.add(content.bytes.buffer);
            return content;
          } catch {
            return { status: 'omitted', reason: 'unavailable' };
          }
        },
      } satisfies CompletedLogicalOperation);
    } catch {
      this.poisonLogicalChanges();
    } finally {
      this.logicalCaptureToken = undefined;
    }
  }

  private captureLogicalContent(
    record: LogicalRecord,
    maxBytes: number,
    token: object,
    recordTokens: WeakSet<LogicalRecord>,
    captures: Map<Inode, Uint8Array>,
  ): CapturedContent {
    const unavailable = { status: 'omitted' as const, reason: 'unavailable' as const };
    if (
      this.logicalCaptureToken !== token ||
      !recordTokens.has(record) ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes <= 0 ||
      maxBytes > MAX_WHOLE_FILE_BYTES
    )
      return unavailable;
    if (record.type === 'delete') return { status: 'omitted', reason: 'deleted' };
    if (record.kind !== 'file') return { status: 'omitted', reason: 'not-file' };
    if (record.size > maxBytes) return { status: 'omitted', reason: 'too-large' };

    try {
      const inode = this.getInodeByPath(record.path);
      if (
        !inode ||
        inode !== this.inodeTable.get(record.inodeId) ||
        inode.isDir ||
        isSymlinkInode(inode) ||
        inode.size !== record.size
      )
        return unavailable;
      this.assertSearchablePath(record.path, false);
      this.assertFilePermission(record.path, inode, READ_PERMISSION);
      if (this.logicalCaptureToken !== token) return unavailable;
      if (captures.has(inode)) {
        const bytes = captures.get(inode);
        return this.logicalCaptureToken === token && bytes ? { status: 'included', bytes } : unavailable;
      }

      let bytes: Uint8Array;
      if (this.bufferMode === 'memory') {
        const data = this.lookupFileDataForInode(record.path, inode);
        if (record.size > 0 && (!data || data.byteLength < record.size)) return unavailable;
        bytes = data ? data.slice(0, record.size) : new Uint8Array();
      } else {
        bytes = new Uint8Array(record.size);
        this.readBlocks(inode, 0, bytes);
      }
      if (this.logicalCaptureToken !== token) return unavailable;
      captures.set(inode, bytes);
      return { status: 'included', bytes };
    } catch {
      return unavailable;
    }
  }

  private callLogicalInvalidated(impact: ChangeImpact, reason: 'partial-mutation' | 'record-limit') {
    try {
      this.logicalSession?.invalidated(impact, reason);
    } catch {
      this.poisonLogicalChanges();
    }
  }

  private closeChangeChannel(
    channelId: string,
    channel: { readonly client: ChangeClient; closed: boolean; clientDisposed: boolean },
  ) {
    channel.clientDisposed = true;
    if (channel.closed) return;
    channel.closed = true;
    this.changeChannels.delete(channelId);
    const count = this.changeChannelCounts.get(channel.client.clientId) ?? 1;
    if (count <= 1) this.changeChannelCounts.delete(channel.client.clientId);
    else this.changeChannelCounts.set(channel.client.clientId, count - 1);
    this.releaseChangeSubscriptionsForChannel(channel.client);
    const session = this.logicalSession;
    if (!session || this.logicalChangesPoisoned) return;
    try {
      session.clientClosed(channel.client);
    } catch {
      this.poisonLogicalChanges();
    }
  }

  private sendChangeFrame(client: ChangeClient, frame: ChangeFrame) {
    const channel = this.changeChannels.get(client.channelId);
    if (!channel || channel.closed || channel.client.clientId !== client.clientId || this.logicalChangesPoisoned)
      return;
    const snapshot = snapshotChangeFrame(frame, this.changeGeneration);
    const included =
      snapshot?.type === 'event' && snapshot.change.content.status === 'included'
        ? snapshot.change.content.bytes
        : undefined;
    if (
      !snapshot ||
      (included &&
        (!(included.buffer instanceof ArrayBuffer) ||
          included.byteOffset !== 0 ||
          included.byteLength !== included.buffer.byteLength ||
          !attachedBuffer(included.buffer) ||
          this.logicalCaptureBuffers.has(included.buffer) ||
          this.logicalDeliveryBuffers.has(included.buffer)))
    ) {
      this.poisonLogicalChanges();
      return;
    }
    if (included) this.logicalDeliveryBuffers.add(included.buffer);
    if (snapshot.type === 'terminal' || snapshot.type === 'closed') {
      const key = JSON.stringify([client.clientId, client.channelId, snapshot.subscriptionId]);
      if (this.changeSubscriptionIds.get(client.clientId)?.has(key)) this.changeTerminalIds.add(key);
    }
    queueMicrotask(() => {
      if (!channel.closed && !this.logicalChangesPoisoned) {
        try {
          channel.receive(snapshot);
        } catch {
          // Delivery is deferred and application callbacks never escape core.
        }
      }
    });
  }

  private releaseChangeSubscription(client: ChangeClient, key: string) {
    const ids = this.changeSubscriptionIds.get(client.clientId);
    if (!ids?.delete(key)) return;
    this.changeSubscriptionCount--;
    if (ids.size === 0) this.changeSubscriptionIds.delete(client.clientId);
  }

  private releaseChangeSubscriptionsForChannel(client: ChangeClient) {
    for (const ids of [this.changeSubscriptionIds.get(client.clientId)]) {
      if (!ids) continue;
      for (const key of [...ids]) {
        if (key.startsWith(`${JSON.stringify([client.clientId, client.channelId]).slice(0, -1)},`)) {
          this.changeTerminalIds.delete(key);
          this.releaseChangeSubscription(client, key);
        }
      }
    }
  }

  private validateChangeTarget(target: Pick<WireSubscribeOptions, 'path' | 'scope' | 'recursive'>) {
    if (
      !target ||
      typeof target.path !== 'string' ||
      (target.scope !== 'file' && target.scope !== 'directory') ||
      typeof target.recursive !== 'boolean' ||
      (target.scope === 'file' && target.recursive)
    ) {
      throw createVfsError('EINVAL', undefined, 'Invalid subscription target');
    }
    const normalized = normalizeFsPath(target.path);
    if (normalized.requiresDirectory && target.scope !== 'directory')
      throw createVfsError('EINVAL', normalized.path, 'Trailing slash requires directory scope');
    let path = '/';
    let inode = this.getInodeByPath('/');
    if (inode?.isDir) this.assertDirectoryExecutable('/', inode);
    const parts = normalized.path.split('/').filter(Boolean);
    for (let index = 0; index < parts.length - 1; index++) {
      if (!inode?.isDir) throw createVfsError('ENOTDIR', path);
      const next = this.lookupChild(path, inode, parts[index]);
      path = next.path;
      inode = next.inode;
      if (!inode) return;
      if (isSymlinkInode(inode)) throw createVfsError('EINVAL', path, 'Subscription target traverses symlink');
      if (!inode.isDir) throw createVfsError('ENOTDIR', path);
      this.assertDirectoryExecutable(path, inode);
    }
    if (parts.length === 0) {
      if (target.scope === 'file') throw createVfsError('EINVAL', normalized.path, 'Root requires directory scope');
      return;
    }
    if (!inode?.isDir) throw createVfsError('ENOTDIR', path);
    const final = this.lookupChild(path, inode, parts[parts.length - 1]).inode;
    if (!final) return;
    if (target.scope === 'file' && final.isDir)
      throw createVfsError('EINVAL', normalized.path, 'Directory conflicts with file scope');
    if (target.scope === 'directory' && !final.isDir)
      throw createVfsError('EINVAL', normalized.path, 'Non-directory conflicts with directory scope');
    if (final.isDir) this.assertDirectoryExecutable(normalized.path, final);
  }

  private growStorage() {
    const newTotal = this.totalBlocks * 2;
    this.bitmap.grow(newTotal);
    this.totalBlocks = newTotal;
    this.dirtyStructure = true;
  }

  /**
   * §6.3 — run an OPFS write/truncate that may throw `QuotaExceededError` and map
   * that single failure mode to a first-class ENOSPC. Browser storage quota is
   * the realistic "disk full" for OPFS; without this it surfaces as an opaque
   * DOMException. On quota exhaustion we set `localPersistenceState: 'error'` +
   * `lastError` (the in-memory state may now be ahead of disk — the caller's
   * rollback, where feasible, keeps the allocator/bitmap consistent) and rethrow
   * as a VfsError(ENOSPC). Any other error propagates unchanged.
   */
  private withQuotaMapped<T>(op: () => T, path?: string): T {
    try {
      return op();
    } catch (error) {
      if (isQuotaExceededError(error)) {
        const enospc = createVfsError('ENOSPC', path, 'Browser storage quota exceeded');
        this.setLocalPersistenceState('error', enospc);
        throw enospc;
      }
      throw error;
    }
  }

  /**
   * §6.3 — current browser storage estimate (`navigator.storage.estimate()`),
   * or `undefined` in environments without the Storage Manager API. Async (the
   * underlying API is async); the sync persistence status cannot include it.
   */
  async getStorageEstimate(): Promise<StorageEstimate | undefined> {
    try {
      if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return undefined;
      return await navigator.storage.estimate();
    } catch {
      return undefined;
    }
  }

  /**
   * INT-3: free a block. In disk mode the block is quarantined (its bitmap bit
   * stays set so `alloc` cannot reuse it) until the metadata recording the free
   * is durably flushed. In memory mode there is a CRC32 data WAL and whole-file
   * rewrites in {@link persistToOpfs}, so a reused block is always overwritten
   * from the authoritative in-memory buffer and recoverable via WAL replay —
   * immediate release is safe there and preserves the original behavior.
   */
  private releaseBlock(block: number) {
    if (block === 0) return;
    if (this.bufferMode === 'disk') {
      // Keep the bit allocated; only quarantine. Released in drainPendingFree.
      this.pendingFree.add(block);
    } else {
      this.bitmap.free(block);
    }
  }

  /**
   * INT-3: release quarantined blocks back to the allocator. MUST be called only
   * after the meta write that records the corresponding frees has been flushed
   * to OPFS (i.e. at the tail of {@link writeMeta}). At that point the durable
   * meta no longer references these blocks, so they are genuinely free. This is
   * fully synchronous (SyncAccessHandle), so it also works on the sync pagehide
   * flush path which cannot await.
   */
  private drainPendingFree() {
    if (this.pendingFree.size === 0) return;
    for (const block of this.pendingFree) {
      this.bitmap.free(block);
      this.allocatedDataBlocks--;
    }
    this.pendingFree.clear();
  }

  /**
   * INT-3: allocate one block, draining quarantine before growing the data file.
   * When the allocator is exhausted but blocks are quarantined, force an ordered
   * meta flush so the pending frees become durable and the blocks can be reused —
   * bounding allocation-pressure cost to one sync interval rather than growing
   * the file unboundedly. Falls back to {@link growStorage} only if nothing is
   * quarantined. Synchronous throughout (no awaits), so usable on every path.
   */
  private allocDiskBlock(): number {
    let block = this.bitmap.alloc();
    if (block >= 0) return block;
    if (this.pendingFree.size > 0) {
      // Drain quarantine by persisting the frees durably, then retry. Same order
      // as syncSync: other files' fresh blocks must be durable before the
      // snapshot references them.
      this.storage?.beforeDataCommit?.();
      this.flushData();
      this.writeMeta(true);
      block = this.bitmap.alloc();
      if (block >= 0) return block;
    }
    this.growStorage();
    block = this.bitmap.alloc();
    if (block < 0) throw createVfsError('ENOSPC');
    return block;
  }

  /** Map only pages touched by the write; leave the rest of the file as holes. */
  private ensureDiskBlocks(path: string, inode: Inode, end: number, writeAt: number, allocatedPages: number[]) {
    const needed = Math.ceil(end / BLOCK_SIZE);
    const firstPage = Math.floor(writeAt / BLOCK_SIZE);
    this.assertDiskBlocksWithinQuota(this.diskWriteHoleCount(inode, end, writeAt), path);
    const holes: number[] = [];
    for (let page = firstPage; page < needed; page++) if (!inode.blocks[page]) holes.push(page);

    const allocated: number[] = [];
    try {
      for (let i = 0; i < holes.length;) {
        let run = 1;
        while (i + run < holes.length && holes[i + run] === holes[i] + run) run++;
        const first = this.bitmap.allocRun(run);
        if (first >= 0) {
          for (let j = 0; j < run; j++) allocated.push(first + j);
        } else {
          for (let j = 0; j < run; j++) allocated.push(this.allocDiskBlock());
        }
        i += run;
      }
      for (let i = 0; i < holes.length; i++) {
        const start = holes[i] * BLOCK_SIZE;
        const head = Math.min(BLOCK_SIZE, Math.max(0, writeAt - start));
        const tail = Math.min(BLOCK_SIZE, Math.max(0, start + BLOCK_SIZE - end));
        if (head > 0) this.dataHandle.write(this.zeroSource(head), { at: allocated[i] * BLOCK_SIZE });
        if (tail > 0) {
          this.dataHandle.write(this.zeroSource(tail), { at: (allocated[i] + 1) * BLOCK_SIZE - tail });
        }
      }
    } catch (error) {
      for (const block of allocated) this.bitmap.free(block);
      throw error;
    }
    while (inode.blocks.length < needed) inode.blocks.push(0);
    for (let i = 0; i < holes.length; i++) {
      inode.blocks[holes[i]] = allocated[i];
      allocatedPages.push(holes[i]);
    }
    this.allocatedDataBlocks += allocated.length;
    if (allocated.length > 0) {
      this.markDataDirty();
      this.markAllPathsForInode(inode);
    }
  }

  private rollbackNewBlocks(inode: Inode, originalCount: number, allocatedPages: number[]) {
    for (const page of allocatedPages) {
      this.bitmap.free(inode.blocks[page]);
      inode.blocks[page] = 0;
    }
    this.allocatedDataBlocks -= allocatedPages.length;
    inode.blocks.length = originalCount;
  }

  private zeroDiskRange(inode: Inode, start: number, end: number) {
    if (end <= start) return;
    this.forEachBlockRun(inode, start, end - start, (at, _dataOffset, runLength) => {
      if (at === 0) return;
      // A run can span the whole zeroed range (a large truncate-extend over a
      // contiguous allocation); chunk it so zeroSource's retained backing
      // buffer stays bounded at MAX_ZERO_RUN_BYTES.
      for (let off = 0; off < runLength; off += MAX_ZERO_RUN_BYTES) {
        const len = Math.min(MAX_ZERO_RUN_BYTES, runLength - off);
        this.dataHandle.write(this.zeroSource(len), { at: at + off });
      }
      this.markDataDirty();
    });
  }

  /**
   * PERF-1: a reusable zero buffer for coalesced zero writes, capped at
   * MAX_ZERO_RUN_BYTES (callers chunk longer ranges). It is only ever read
   * from, never written, so sharing one backing buffer across calls is safe.
   */
  private zeroSource(length: number): Uint8Array {
    if (length <= BLOCK_SIZE) return ZERO_BLOCK.subarray(0, length);
    if (!this.zeroBuffer) this.zeroBuffer = new Uint8Array(MAX_ZERO_RUN_BYTES);
    return this.zeroBuffer.subarray(0, length);
  }

  /**
   * Re-sort a renamed subtree with range splices instead of one O(n) splice per
   * entry. Descendants keep their relative order under the new prefix.
   */
  private moveSortedSubtree(oldPath: string, newPath: string) {
    const paths = this.sortedPaths;
    sortedRemove(paths, oldPath);
    const oldPrefix = `${oldPath}/`;
    const from = lowerBound(paths, oldPrefix);
    let to = from;
    while (to < paths.length && paths[to]!.startsWith(oldPrefix)) to++;
    const moved = paths.splice(from, to - from).map((path) => newPath + path.slice(oldPath.length));
    sortedInsert(paths, newPath);
    const at = lowerBound(paths, `${newPath}/`);
    this.sortedPaths = paths.slice(0, at).concat(moved, paths.slice(at));
  }

  private collectSubtreePaths(path: string): string[] {
    // Descendants share the `${path}/` prefix, so they form one contiguous run
    // of the sorted path list: binary-search it instead of scanning every path.
    const prefix = path === '/' ? '/' : `${path}/`;
    const paths = this.inodes.has(path) && path !== '/' ? [path] : [];
    for (let i = lowerBound(this.sortedPaths, prefix); i < this.sortedPaths.length; i++) {
      const candidate = this.sortedPaths[i]!;
      if (!candidate.startsWith(prefix)) break;
      paths.push(candidate);
    }
    return paths;
  }

  /**
   * COR-3: flag every open descriptor whose path is exactly `path` as unlinked so
   * subtree-occupancy checks ignore it.
   * Matches by exact path (not subtree): only the removed namespace entry is gone;
   * a hard link to the same inode under another path keeps that other fd live.
   */
  private markOpenFilesUnlinked(path: string) {
    for (const of of this.openFiles.values()) {
      if (of.path === path) of.unlinked = true;
    }
  }

  private hasOpenFilesInSubtree(path: string): boolean {
    const prefix = path === '/' ? '/' : `${path}/`;
    for (const of of this.openFiles.values()) {
      // COR-3: a descriptor whose namespace entry was unlinked/replaced still
      // carries its old `of.path`, but that path no longer occupies the subtree —
      // matching it produced spurious EBUSY on rmdir/rename of the empty container.
      if (of.unlinked) continue;
      if (of.path === path || of.path.startsWith(prefix)) return true;
    }
    return false;
  }

  private deleteSubtree(path: string, deletePhase = 1) {
    const subtreePaths = this.collectSubtreePaths(path).sort((a, b) => b.length - a.length);
    const linkedInodes = new Set<Inode>();
    for (const currentPath of subtreePaths) {
      const currentInode = this.inodes.get(currentPath);
      if (!currentInode) continue;
      this.recordLogicalDelete(currentPath, currentInode, deletePhase);
      const hadLinks = (currentInode.nlink ?? 1) > 1;
      if (hadLinks) linkedInodes.add(currentInode);
      currentInode.nlink = currentInode.isDir ? 0 : Math.max(0, (currentInode.nlink ?? 1) - 1);
      currentInode.ctimeMs = Date.now();
      currentInode.timestampMs = currentInode.mtimeMs ?? currentInode.timestampMs;
      if (currentInode.nlink === 0) this.releaseUnlinkedInode(currentInode);
      this.dropInodeEntries(currentInode);
      this.unlinkInodePath(currentPath);
      sortedRemove(this.sortedPaths, currentPath);
      if (this.bufferMode === 'memory') this.fileData.delete(currentPath);
      this.deletedInodes.add(currentPath);
      this.dirtyInodes.delete(currentPath);
    }
    this.commitNamespaceChange();
    for (const inode of linkedInodes) {
      this.markAllPathsForInode(inode);
    }
    // Callers log the whole operation as one transaction; rename must never
    // durably drop its target without also recording the move.
  }

  private removeNamespaceEntry(path: string, inode: Inode) {
    this.invalidateFlush();
    this.unlinkInodePath(path);
    sortedRemove(this.sortedPaths, path);
    if (this.bufferMode === 'memory') this.fileData.delete(path);
    this.deletedInodes.add(path);
    this.dirtyInodes.delete(path);
    inode.nlink = Math.max(0, (inode.nlink ?? 1) - 1);
    inode.ctimeMs = Date.now();
    inode.timestampMs = inode.mtimeMs ?? inode.timestampMs;
    if (inode.nlink === 0) this.releaseUnlinkedInode(inode);
    this.dropInodeEntries(inode);
    this.commitNamespaceChange();
  }

  /** The last link is gone: free now, or at the last close of any descriptor, whatever path it used. */
  private releaseUnlinkedInode(inode: Inode) {
    if (this.hasOpenHandleForInode(inode)) {
      this.pendingDeletedInodes.add(inode);
      return;
    }
    for (const block of inode.blocks) {
      if (block !== 0) this.releaseBlock(block);
    }
    inode.blocks = [];
    inode.size = 0;
  }

  private normalizeLoadedInodes() {
    const now = Date.now();
    let maxIno = 1;
    let nextGeneratedIno = 2;
    const usedInos = new Set<number>();
    // Hard links share ONE Inode object across multiple paths, so iterating the
    // path->inode map yields the same object repeatedly. Dedupe by object
    // IDENTITY: an ino is "used" per distinct inode, and a repeated (hard-linked)
    // object must keep the ino it was already assigned. Treating each path
    // occurrence as a fresh ino would (a) flag a hard link's 2nd+ path as a
    // duplicate and renumber the shared object out from under its other paths,
    // and (b) let two genuinely distinct objects collide on one ino — which the
    // ino-keyed derived index (inodeTable/pathIndex) then aliases, so two paths
    // resolve to one inode and read each other's blocks (cross-bleed). Both are
    // reachable after a partial meta-log replay of rename+hardlink churn.
    const seen = new Set<Inode>();
    for (const inode of this.inodes.values()) {
      if (seen.has(inode)) continue;
      seen.add(inode);
      if (inode.kind === undefined) {
        inode.kind = inode.isDir ? 'dir' : isSymlinkInode(inode) ? 'symlink' : 'file';
      }
      if (inode.kind === 'symlink') {
        inode.isDir = false;
        inode.mode = (inode.mode & 0o777) | 0o120000 || DEFAULT_SYMLINK_MODE;
        inode.size = sharedTextEncoder.encode(inode.symlinkTarget ?? '').byteLength;
      } else if (inode.kind === 'dir') {
        inode.isDir = true;
      } else {
        inode.isDir = false;
      }
      // Follow-up to COR-2: inodes persisted by a pre-COR-2 build store BARE
      // permission modes with no S_IFMT type bits. Without a type bit,
      // chmodSync's `(mode & 0o170000) | ...` preservation would carry ZERO type
      // bits forever, so stat()/FS.isFile would forever misclassify the node.
      // Backfill the correct type bit from the resolved kind (symlinks are
      // already handled above). Files/dirs that already carry a type bit are
      // left untouched.
      if (inode.kind !== 'symlink' && (inode.mode & 0o170000) === 0) {
        inode.mode |= inode.isDir ? S_IFDIR : S_IFREG;
      }
      const fallbackTime = inode.mtimeMs ?? inode.timestampMs ?? now;
      if (inode.atimeMs === undefined) inode.atimeMs = fallbackTime;
      if (inode.mtimeMs === undefined) inode.mtimeMs = fallbackTime;
      if (inode.ctimeMs === undefined) inode.ctimeMs = fallbackTime;
      inode.timestampMs = inode.mtimeMs;
      if (!Number.isInteger(inode.nlink) || inode.nlink === undefined || inode.nlink < 0) {
        inode.nlink = inode.isDir ? 2 : 1;
      }
      if (!Number.isInteger(inode.ino) || inode.ino <= 0 || usedInos.has(inode.ino)) {
        while (usedInos.has(nextGeneratedIno)) nextGeneratedIno++;
        inode.ino = nextGeneratedIno++;
      }
      usedInos.add(inode.ino);
      maxIno = Math.max(maxIno, inode.ino);
    }
    const pathRefCounts = new Map<number, number>();
    for (const [path, inode] of this.inodes) {
      if (path === '/') continue;
      pathRefCounts.set(inode.ino, (pathRefCounts.get(inode.ino) ?? 0) + 1);
    }
    for (const inode of this.inodes.values()) {
      if (inode.isDir) {
        inode.nlink = 2;
      } else {
        inode.nlink = Math.max(1, pathRefCounts.get(inode.ino) ?? inode.nlink ?? 1);
      }
    }
    for (const [path, inode] of this.inodes) {
      if (path === '/' || !inode.isDir) continue;
      const parent = this.inodes.get(parentPath(path));
      if (parent?.isDir) {
        parent.nlink = (parent.nlink ?? 2) + 1;
      }
    }
    const root = this.inodes.get('/');
    if (root) {
      root.kind = 'dir';
      root.ino = 1;
      root.nlink = Math.max(2, root.nlink ?? 2);
    }
    // Never lower the persisted counter: a reissued number would let surviving
    // data-WAL records of a deleted inode replay into its successor.
    this.nextInodeNumber = Math.max(this.nextInodeNumber, maxIno + 1, nextGeneratedIno);
  }

  /**
   * Transitional derived indexes for the inode-table refactor.
   * The path-keyed map remains the source of truth until namespace operations
   * fully switch over to inode ids + directory entries.
   */
  private rebuildIndexesFromPathMap() {
    this.initializeDerivedIndexes();
    this.inodeTable.clear();
    this.dirEntries.clear();
    this.pathIndex.clear();
    this.inoToPaths.clear();

    for (const [path, inode] of this.inodes) {
      this.pathIndex.set(path, inode.ino);
      let paths = this.inoToPaths.get(inode.ino);
      if (!paths) {
        paths = new Set();
        this.inoToPaths.set(inode.ino, paths);
      }
      paths.add(path);
      if (!this.inodeTable.has(inode.ino)) {
        this.inodeTable.set(inode.ino, inode);
      }
      if (inode.isDir && !this.dirEntries.has(inode.ino)) {
        this.dirEntries.set(inode.ino, new Map());
      }
    }

    for (const [path, inode] of this.inodes) {
      if (path === '/') continue;
      const parentPathValue = parentPath(path);
      const parentInode = this.inodes.get(parentPathValue);
      if (!parentInode?.isDir) continue;
      let entries = this.dirEntries.get(parentInode.ino);
      if (!entries) {
        entries = new Map();
        this.dirEntries.set(parentInode.ino, entries);
      }
      entries.set(baseName(path), inode.ino);
    }
  }

  /**
   * PERF-3: incrementally link a path to its inode in the derived indexes.
   * Mirrors what rebuildIndexesFromPathMap would compute for this one path:
   * pathIndex[path]=ino, inoToPaths[ino] += path, and inodeTable[ino] set if
   * not already present (the inode object is shared across hard links, so any
   * path's inode is the same object). dirEntries are maintained separately by
   * addDirEntry/removeDirEntry, which every namespace caller already invokes.
   */
  private linkInodePath(path: string, inode: Inode) {
    this.inodes.set(path, inode);
    this.pathIndex.set(path, inode.ino);
    let paths = this.inoToPaths.get(inode.ino);
    if (!paths) {
      paths = new Set();
      this.inoToPaths.set(inode.ino, paths);
    }
    paths.add(path);
    if (!this.inodeTable.has(inode.ino)) this.inodeTable.set(inode.ino, inode);
    if (inode.isDir && !this.dirEntries.has(inode.ino)) this.dirEntries.set(inode.ino, new Map());
  }

  /**
   * PERF-3: incrementally unlink a path from the derived indexes. The inode is
   * removed from inodeTable when its LAST path is gone, so hard links stay
   * resolvable. dirEntries are NOT dropped here: that map is keyed by the
   * directory's ino (which is monotonic and never reused) and is owned by
   * addDirEntry/removeDirEntry. Dropping it on a transient zero-path window —
   * e.g. the unlink-all/relink-all pass in renameSync — would destroy a moved
   * directory's children. {@link dropInodeEntries} clears it on genuine deletion.
   */
  private unlinkInodePath(path: string) {
    const ino = this.pathIndex.get(path);
    this.inodes.delete(path);
    this.pathIndex.delete(path);
    if (ino === undefined) return;
    const paths = this.inoToPaths.get(ino);
    if (paths) {
      paths.delete(path);
      if (paths.size === 0) {
        this.inoToPaths.delete(ino);
        this.inodeTable.delete(ino);
      }
    }
  }

  /**
   * PERF-3: drop a directory inode's own entries map once it is genuinely
   * deleted (its last link removed). Safe to call for non-dirs (no-op). Keeps
   * the dirEntries map from leaking stale entries after deleteSubtree / unlink,
   * matching what the full rebuild would produce.
   */
  private dropInodeEntries(inode: Inode) {
    if ((inode.nlink ?? 1) === 0) this.dirEntries.delete(inode.ino);
  }

  /**
   * PERF-3: namespace ops now maintain the derived indexes incrementally via
   * linkInodePath / unlinkInodePath (and addDirEntry / removeDirEntry), so this
   * is a no-op. The full O(N) rebuild is reserved for mount/replay
   * (rebuildIndexesFromPathMap), where the whole inode map changes at once.
   */
  private commitNamespaceChange() {}

  private hasPathEntry(path: string): boolean {
    this.ensureDerivedIndexes();
    return this.pathIndex.has(path) || this.inodes.has(path);
  }

  private getInodeByPath(path: string): Inode | undefined {
    this.ensureDerivedIndexes();
    const inodeId = this.pathIndex.get(path);
    if (inodeId !== undefined) {
      return this.inodeTable.get(inodeId);
    }
    return this.inodes.get(path);
  }

  private getDirEntries(inode: Inode): DirEntries {
    this.ensureDerivedIndexes();
    const entries = this.dirEntries.get(inode.ino);
    if (entries) return entries;
    const nextEntries = new Map<string, InodeId>();
    this.dirEntries.set(inode.ino, nextEntries);
    return nextEntries;
  }

  private listDirNames(inode: Inode): string[] {
    return [...this.getDirEntries(inode).keys()];
  }

  private addDirEntry(parentInode: Inode, name: string, childInode: Inode) {
    this.getDirEntries(parentInode).set(name, childInode.ino);
  }

  private removeDirEntry(parentInode: Inode, name: string) {
    this.getDirEntries(parentInode).delete(name);
  }

  private lookupChild(parentPath: string, parentInode: Inode, name: string): { path: string; inode?: Inode } {
    this.ensureDerivedIndexes();
    const candidatePath = parentPath === '/' ? `/${name}` : `${parentPath}/${name}`;
    const childInodeId = this.getDirEntries(parentInode).get(name);
    if (childInodeId !== undefined) {
      return { path: candidatePath, inode: this.inodeTable.get(childInodeId) };
    }
    return { path: candidatePath, inode: this.inodes.get(candidatePath) };
  }

  private initializeDerivedIndexes() {
    if (!(this.inodeTable instanceof Map)) this.inodeTable = new Map();
    if (!(this.dirEntries instanceof Map)) this.dirEntries = new Map();
    if (!(this.pathIndex instanceof Map)) this.pathIndex = new Map();
    if (!(this.inoToPaths instanceof Map)) this.inoToPaths = new Map();
  }

  private ensureDerivedIndexes() {
    this.initializeDerivedIndexes();
    if (!(this.inodes instanceof Map)) return;
    if (this.pathIndex.size === 0 && this.inodes.size > 0) {
      this.normalizeLoadedInodes();
      this.rebuildIndexesFromPathMap();
    }
  }

  private touchInode(path: string, timestampMs: number = Date.now(), inode = this.lookupInodeByPathHint(path)) {
    if (!inode) return;
    this.invalidateFlush();
    // PERF-9: a timestamp touch is attr-only. markLinkedInodeDirty / the trailing
    // mark route to attrDirtyInodes; if a structural change already dirtied this
    // path in the same flush window, markInodeAttrDirty is a no-op and the full
    // record wins.
    this.markLinkedInodeDirty(inode, true);
    inode.mtimeMs = timestampMs;
    inode.ctimeMs = timestampMs;
    if (inode.atimeMs === undefined) inode.atimeMs = timestampMs;
    inode.timestampMs = inode.mtimeMs;
    if (this.getInodeByPath(path) === inode) this.markInodeAttrDirty(path);
    else this.markAllPathsForInode(inode, true);
  }

  /**
   * PERF-8 — record an access (read). Uses `relatime` semantics so a read-only
   * workload does not dirty metadata or schedule flush work:
   *  - `noatime` option set → never update atime; return immediately.
   *  - otherwise update atime ONLY if the current atime is older than mtime or
   *    ctime, or older than {@link RELATIME_THRESHOLD_MS}. Only then do we mark
   *    the inode dirty / invalidate the flush.
   * When relatime does not fire the inode is left completely untouched, so the
   * persistence state stays `clean`.
   */
  private touchInodeAccess(path: string, inode: Inode, timestampMs: number = Date.now()) {
    if (this.noatime) return;
    const atime = inode.atimeMs;
    if (atime !== undefined) {
      const mtime = inode.mtimeMs ?? 0;
      const ctime = inode.ctimeMs ?? 0;
      const relatimeFires = atime < mtime || atime < ctime || timestampMs - atime >= RELATIME_THRESHOLD_MS;
      if (!relatimeFires) return;
    }
    // relatime fired (or atime was never set) — persist the new access time.
    this.invalidateFlush();
    this.markLinkedInodeDirty(inode, true);
    inode.atimeMs = timestampMs;
    inode.timestampMs = inode.mtimeMs ?? inode.timestampMs;
    if (this.getInodeByPath(path) === inode) {
      this.markInodeAttrDirty(path); // PERF-9: atime change is attr-only.
    }
  }

  private touchInodeMetadata(path: string, timestampMs: number = Date.now()) {
    const inode = this.lookupInodeByPathHint(path);
    if (!inode) return;
    this.invalidateFlush();
    // PERF-9: ctime/mode change (e.g. chmod) is attr-only — mode is carried in
    // the compact record's flags, block table and children are untouched.
    this.markLinkedInodeDirty(inode, true);
    inode.ctimeMs = timestampMs;
    if (inode.mtimeMs === undefined) inode.mtimeMs = timestampMs;
    if (inode.atimeMs === undefined) inode.atimeMs = inode.mtimeMs;
    inode.timestampMs = inode.mtimeMs;
    this.markInodeAttrDirty(path);
  }

  private updateOpenFileBuffers(inode: Inode, data: Uint8Array) {
    for (const openFile of this.openFiles.values()) {
      if (openFile.inode === inode) openFile.data = data;
    }
  }

  private pathForInode(target: Inode): string | undefined {
    return this.pathsForInode(target)[0];
  }

  private pathsForInode(target: Inode): string[] {
    this.ensureDerivedIndexes();
    // PERF-4: answer from the ino -> paths reverse index (O(#links)). An inode
    // missing from it has no path (e.g. unlinked but open), so there is nothing
    // to find by scanning every path.
    const direct = this.inoToPaths.get(target.ino);
    return direct && this.inodeTable.get(target.ino) === target ? [...direct] : [];
  }

  private lookupFileDataForInode(pathHint: string | undefined, inode: Inode): Uint8Array | undefined {
    if (pathHint) {
      const direct = this.fileData.get(pathHint);
      if (direct) return direct;
    }
    for (const path of this.pathsForInode(inode)) {
      const data = this.fileData.get(path);
      if (data) return data;
    }
    return undefined;
  }

  private syncFileDataForInode(inode: Inode, data: Uint8Array, pathHint?: string) {
    // PERF-4: the overwhelming case is a non-hard-linked file (nlink <= 1) with
    // exactly one path. Set it directly from the caller's known path — no
    // reverse-index lookup, no iteration. Only hard-linked inodes need every
    // alias updated so all paths observe the same buffer.
    if ((inode.nlink ?? 1) <= 1 && pathHint !== undefined) {
      this.fileData.set(pathHint, data);
      return;
    }
    for (const path of this.pathsForInode(inode)) {
      this.fileData.set(path, data);
    }
  }

  private lookupInodeByPathHint(path: string): Inode | undefined {
    return (
      this.getInodeByPath(path) ?? Array.from(this.openFiles.values()).find((openFile) => openFile.path === path)?.inode
    );
  }

  private assertSearchablePath(path: string, includeLeafDirectory: boolean) {
    const root = this.getInodeByPath('/');
    if (root) this.assertDirectoryExecutable('/', root);
    if (path === '/') return;

    const parts = path.split('/').filter(Boolean);
    const limit = includeLeafDirectory ? parts.length : Math.max(parts.length - 1, 0);
    let currentPath = '/';
    let currentInode = root;
    for (let i = 0; i < limit; i++) {
      if (!currentInode?.isDir) throw createVfsError('ENOTDIR', currentPath);
      const next = this.lookupChild(currentPath, currentInode, parts[i]);
      currentPath = next.path;
      const inode = next.inode;
      if (!inode) throw createVfsError('ENOENT', currentPath);
      if (!inode.isDir) throw createVfsError('ENOTDIR', currentPath);
      this.assertDirectoryExecutable(currentPath, inode);
      currentInode = inode;
    }
  }

  private assertInodeWritable(path: string, inode: Inode) {
    if (inode.isDir) {
      this.assertDirectoryWritable(path, inode);
      return;
    }
    this.assertFilePermission(path, inode, WRITE_PERMISSION);
  }

  private assertDirectoryReadable(path: string, inode: Inode) {
    if ((inode.mode & READ_PERMISSION) === 0) throw createVfsError('EACCES', path);
  }

  private assertDirectoryWritable(path: string, inode: Inode) {
    if ((inode.mode & WRITE_PERMISSION) === 0 || (inode.mode & EXECUTE_PERMISSION) === 0) {
      throw createVfsError('EACCES', path);
    }
  }

  private assertDirectoryExecutable(path: string, inode: Inode) {
    if ((inode.mode & EXECUTE_PERMISSION) === 0) throw createVfsError('EACCES', path);
  }

  private assertFilePermission(path: string, inode: Inode, mask: number) {
    // COR-8: grant access when ANY bit of the permission class is set (the masks
    // are full 0o444/0o222/0o111 classes). Single-user VFS: caller == owner.
    if ((inode.mode & mask) === 0) throw createVfsError('EACCES', path);
  }

  private hasOpenHandleForInode(inode: Inode): boolean {
    for (const openFile of this.openFiles.values()) {
      if (openFile.inode === inode) return true;
    }
    return false;
  }

  private normalizeMkdirOptions(modeOrOptions?: number | MkdirOptions): { mode: number; recursive: boolean } {
    if (typeof modeOrOptions === 'number') {
      return { mode: modeOrOptions, recursive: false };
    }
    return {
      mode: modeOrOptions?.mode ?? DEFAULT_DIR_MODE,
      recursive: modeOrOptions?.recursive ?? false,
    };
  }

  private markAllPathsForInode(inode: Inode, attrOnly = false) {
    for (const path of this.pathsForInode(inode)) {
      if (attrOnly) this.markInodeAttrDirty(path);
      else this.dirtyInodes.add(path);
    }
  }

  private markLinkedInodeDirty(inode: Inode, attrOnly = false) {
    if ((inode.nlink ?? 1) > 1) {
      this.markAllPathsForInode(inode, attrOnly);
    }
  }

  /**
   * PERF-9: flag a path as attr-only dirty (timestamp touch). Only takes effect
   * if the path is not already structurally dirty — a structural change always
   * wins and forces a full record.
   */
  private markInodeAttrDirty(path: string) {
    if (!this.dirtyInodes.has(path)) this.attrDirtyInodes.add(path);
  }

  /**
   * PERF-10: persist the memory-mode namespace log after a create/unlink/mkdir/
   * rename. Previously this called writeMeta() (write + fsync) synchronously
   * after EVERY namespace op — the dominant memory-mode namespace cost.
   *
   * Flush policy by durability mode:
   *  - strict:   per-op writeMeta() + fsync (unchanged) — namespace ops are
   *              crash-durable the instant they return.
   *  - balanced: defer to the debounced sync. The namespace mutation is already
   *              recorded in dirtyInodes/deletedInodes (and the data WAL still
   *              protects file contents); markLocalDirty scheduled the flush, so
   *              the op is durable within the debounce window.
   *  - relaxed:  defer to the next explicit sync/checkpoint.
   *
   * The deferred branches MUST still leave the in-memory dirty sets populated so
   * syncSync/flushVfs/closeVfs flush them before snapshotting — they do, because
   * the caller added the paths before invoking this. The durability-window
   * implications are documented in the README durability table.
   */
  private flushMemoryNamespaceLog() {
    if (this.bufferMode !== 'memory') return;
    // PERF-10: always WRITE the namespace record(s) to the log handle per op (so
    // a crash-close that does not power-cycle still recovers them, exactly like
    // the data WAL's per-op write), but only fsync per op in strict mode. In
    // relaxed/balanced the durability barrier (flush) moves to the debounced /
    // explicit sync — the namespace op is then bounded by that window. Writing
    // (not flushing) per op is REQUIRED: the data WAL is keyed by inode id, so a
    // created inode must be in the namespace log for a later WAL write record to
    // replay against it.
    this.writeMeta(false, this.localDurabilityMode !== 'strict');
  }

  /**
   * Memory mode reuses freed blocks immediately and rewrites pages in place, so
   * both recovery logs must be durable before persistToOpfs touches the data
   * file. Otherwise a power loss after the data flush can resurrect a deleted
   * or truncated file whose blocks already hold another file's bytes.
   */
  private flushRecoveryLogs() {
    if (this.walPendingBytes > 0 && this.localDurabilityMode !== 'strict') this.dataLogHandle.flush();
    this.flushPendingMetaLog();
  }

  /** PERF-10: fsync the meta log if an earlier deferred (relaxed/balanced) write left it pending. */
  private flushPendingMetaLog() {
    if (!this.metaLogFlushPending) return;
    this.logHandle.flush();
    this.metaLogFlushPending = false;
  }

  /** Persist dirty in-memory file data to OPFS */
  private persistToOpfs() {
    if (this.dirtyPages.size === 0) return;
    for (const [inode, pages] of this.dirtyPages) {
      const path = this.pathForInode(inode);
      if (!path || inode.isDir || isSymlinkInode(inode)) continue;
      const data = this.lookupFileDataForInode(path, inode);
      if (!data) continue;

      // Ensure enough blocks are allocated
      const blocksNeeded = inode.size === 0 ? 0 : Math.ceil(inode.size / BLOCK_SIZE);
      const oldBlockCount = inode.blocks.length;
      // PERF-6: prefer one contiguous run for the whole grow so persistToOpfs's
      // dirty-page writes (PERF-1) coalesce into a single OPFS write. Fall back
      // to scattered per-block allocation (+ grow) when no run fits.
      const need = blocksNeeded - inode.blocks.length;
      if (need > 1) {
        const first = this.bitmap.allocRun(need);
        if (first >= 0) {
          for (let i = 0; i < need; i++) inode.blocks.push(first + i);
        }
      }
      while (inode.blocks.length < blocksNeeded) {
        let block = this.bitmap.alloc();
        if (block < 0) {
          this.growStorage();
          block = this.bitmap.alloc();
          if (block < 0) throw createVfsError('ENOSPC');
        }
        inode.blocks.push(block);
      }
      while (inode.blocks.length > blocksNeeded) {
        const block = inode.blocks.pop()!;
        if (block !== 0) this.releaseBlock(block);
      }
      // A file opened in memory mode can carry holes from an earlier disk mount.
      // Keep untouched zero pages sparse; materialize only pages with data.
      for (const p of pages) {
        if (p >= Math.min(oldBlockCount, blocksNeeded)) continue;
        if (
          inode.blocks[p] !== 0 ||
          !data.subarray(p * BLOCK_SIZE, Math.min((p + 1) * BLOCK_SIZE, inode.size)).some((byte) => byte !== 0)
        )
          continue;
        let block = this.bitmap.alloc();
        if (block < 0) {
          this.growStorage();
          block = this.bitmap.alloc();
          if (block < 0) throw createVfsError('ENOSPC');
        }
        inode.blocks[p] = block;
        pages.add(p);
        this.dirtyInodes.add(path);
      }
      if (inode.blocks.length !== oldBlockCount) {
        this.dirtyInodes.add(path);
      }
      // Every newly mapped block is written in full; a reused block must never
      // keep a previous owner's bytes behind this file's size.
      for (let p = oldBlockCount; p < blocksNeeded; p++) pages.add(p);

      // PERF-1: write dirty pages coalesced into runs that are contiguous both
      // logically (sequential page indices) and physically (sequential blocks).
      // Sort the dirty page set first so adjacent pages can be merged. Pages at
      // or past the current block count are stale (file shrank) and skipped.
      const sortedPages = Array.from(pages)
        .filter((p) => p < inode.blocks.length && inode.blocks[p] !== 0)
        .sort((a, b) => a - b);
      for (let i = 0; i < sortedPages.length;) {
        const startPage = sortedPages[i];
        const startBlock = inode.blocks[startPage];
        // Extend the run while the next dirty page is the immediate logical
        // successor AND its block is the immediate physical successor. The run
        // may only grow across pages we know are full BLOCK_SIZE; the final
        // page of the file may be partial (EOF), so we stop extending there.
        let j = i;
        let lastPage = startPage;
        while (
          j + 1 < sortedPages.length &&
          sortedPages[j + 1] === lastPage + 1 &&
          inode.blocks[sortedPages[j + 1]] === inode.blocks[lastPage] + 1 &&
          // every page strictly before the file's last page is full
          (lastPage + 1) * BLOCK_SIZE <= inode.size
        ) {
          j++;
          lastPage = sortedPages[j];
        }
        const pos = startPage * BLOCK_SIZE;
        const endByte = Math.min((lastPage + 1) * BLOCK_SIZE, inode.size);
        const chunkSize = endByte - pos;
        if (chunkSize > 0) {
          this.dataHandle.write(data.subarray(pos, pos + chunkSize), { at: startBlock * BLOCK_SIZE });
          const tailBytes = endByte % BLOCK_SIZE;
          // Disk recovery requires complete physical blocks. Encrypted handles
          // already materialize them; do not reseal their tail a second time.
          if (tailBytes > 0 && this.dataHandle.getSize() < (startBlock + lastPage - startPage + 1) * BLOCK_SIZE) {
            this.dataHandle.write(this.zeroSource(BLOCK_SIZE - tailBytes), {
              at: startBlock * BLOCK_SIZE + chunkSize,
            });
          }
          this.markDataDirty();
        }
        i = j + 1;
      }
    }
    this.dirtyPages.clear();
  }

  /**
   * Write metadata (inodes + structure) to meta file.
   *
   * `deferIncrementalFlush` (PERF-10): when true and this is an incremental
   * append (not a full snapshot), the namespace records are WRITTEN to the log
   * handle but NOT fsynced — the durability barrier is left to the next sync.
   * A full snapshot always flushes (the A/B swap ordering depends on it).
   */
  /** Metadata persistence boundary: every failure, including compaction, is recorded before it propagates. */
  private writeMeta(force = false, deferIncrementalFlush = false) {
    try {
      this.writeMetaRecords(force, deferIncrementalFlush);
    } catch (error) {
      this.setLocalPersistenceState('error', error);
      throw error;
    }
  }

  private writeMetaRecords(force: boolean, deferIncrementalFlush: boolean) {
    const hasDirtyInodes = this.dirtyInodes.size > 0 || this.attrDirtyInodes.size > 0 || this.deletedInodes.size > 0;
    if (!force && !this.dirtyStructure && !hasDirtyInodes) return;

    // PERF-9: compact the log into a fresh snapshot once it would exceed the
    // threshold (max of the fixed floor and 2x the last snapshot). Bounds replay
    // time and stops the log growing without bound between snapshots.
    const snapshotThreshold = Math.max(LOG_SNAPSHOT_THRESHOLD_BYTES, (this.lastSnapshotSize || 0) * 2);
    const logSizeTrigger = this.logOffset >= snapshotThreshold;
    const fullSnapshot = force || this.dirtyStructure || logSizeTrigger;

    if (fullSnapshot) {
      // Full snapshot rewrite (compaction). INT-1: write the new snapshot into
      // the *inactive* A/B slot and only flip + truncate the log AFTER it is
      // durable. A crash anywhere before the flush completes leaves the old
      // (still-active) slot untouched, so the previous consistent snapshot is
      // always recoverable — no in-place truncate(0) data-loss window.
      const payload = new Uint8Array(
        serializeMeta(this.inodes, this.totalBlocks, BLOCK_SIZE, this.sortedPaths, this.nextInodeNumber),
      );
      this.lastSnapshotSize = payload.byteLength; // PERF-9 snapshot-trigger baseline.
      const nextSequence = (this.metaSnapshotSequence + 1) >>> 0;
      const framed = frameMetaSnapshot(
        payload,
        nextSequence,
        this.sealer,
        this.flushedDataSize,
        this.flushedLogicalExtent,
      );
      const targetSlot: 0 | 1 = this.activeMetaSlot === 0 ? 1 : 0;
      const targetHandle = targetSlot === 0 ? this.metaHandleA : this.metaHandleB;

      // §6.3: a quota failure writing the snapshot leaves the ACTIVE slot intact
      // (the swap below has not happened yet), so the previous consistent
      // snapshot survives; map to ENOSPC. The in-memory state is unchanged here.
      this.withQuotaMapped(() => {
        targetHandle.truncate(0);
        this.writeAll(targetHandle, framed, 0, 'metadata snapshot');
        targetHandle.flush(); // snapshot is now durable in the inactive slot
      });

      // Atomic logical swap: the higher sequence now wins on mount.
      this.activeMetaSlot = targetSlot;
      this.metaSnapshotSequence = nextSequence;

      // The new snapshot subsumes the old log. A crash before truncation is
      // harmless because every old transaction names the prior generation.
      this.dirtyStructure = true;
      const batch = serializeLogTransaction(
        [],
        1,
        this.sealer,
        nextSequence,
        this.flushedDataSize,
        this.flushedLogicalExtent,
      );
      this.withQuotaMapped(() => {
        this.logHandle.truncate(0);
        // Retain the committed generation even if this snapshot later becomes unreadable.
        this.writeAll(this.logHandle, batch, 0, 'metadata log');
        this.logHandle.flush();
      });
      this.logOffset = batch.byteLength;
      this.committedLogicalExtent = this.flushedLogicalExtent;
      this.metaLogFlushPending = false; // full snapshot subsumes any deferred log flush
    } else {
      // Incremental: append one committed metadata batch
      const records: Uint8Array[] = [];
      for (const path of this.deletedInodes) {
        records.push(serializeLogRecord(path, null));
      }
      // Structural changes → full records (block table + children).
      for (const path of this.dirtyInodes) {
        const inode = this.inodes.get(path);
        if (inode) {
          records.push(serializeLogRecord(path, inode));
        }
      }
      // PERF-9: attr-only changes → compact records (no block table / children).
      // markInodeAttrDirty already excludes anything in dirtyInodes, but a path
      // can become structurally dirty AFTER it was flagged attr-only in the same
      // window, so re-check here to avoid emitting a stale compact alongside the
      // authoritative full record.
      for (const path of this.attrDirtyInodes) {
        if (this.dirtyInodes.has(path) || this.deletedInodes.has(path)) continue;
        const inode = this.inodes.get(path);
        if (inode) {
          records.push(serializeLogAttrRecord(path, inode));
        }
      }
      if (records.length > 0) {
        const txId = this.logOffset + 1;
        const batch = serializeLogTransaction(
          records,
          txId,
          this.sealer,
          this.metaSnapshotSequence,
          this.flushedDataSize,
          this.flushedLogicalExtent,
        );
        // §6.3: map a quota failure on the log append to ENOSPC; logOffset is
        // only advanced on success so the next write retries the same offset.
        this.withQuotaMapped(() => this.logHandle.write(batch, { at: this.logOffset }));
        this.logOffset += batch.byteLength;
        this.committedLogicalExtent = this.flushedLogicalExtent;
        // PERF-10: in relaxed/balanced the per-op flush is deferred to the next
        // sync (markLocalDirty already scheduled the balanced flush). The bytes
        // are written so a non-power-loss crash-close still recovers them; the
        // pending flag makes the next sync/flush/close fsync the log.
        if (deferIncrementalFlush) {
          this.metaLogFlushPending = true;
        } else {
          this.logHandle.flush();
          this.metaLogFlushPending = false;
        }
      }
    }

    this.dirtyStructure = false;
    this.dirtyInodes.clear();
    this.attrDirtyInodes.clear();
    this.deletedInodes.clear();

    // INT-3: the meta recording every quarantined free is now durable (every
    // branch above ends in a logHandle/targetHandle flush), so it is finally
    // safe to return quarantined blocks to the allocator. Runs after the flush,
    // never before — flush ordering is the whole point of the quarantine.
    this.drainPendingFree();
  }
}

// ── Sorted array helpers ──

/** First index whose value is not below `value` in a sorted string array. */
function lowerBound(arr: string[], value: string) {
  let lo = 0,
    hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function sortedInsert(arr: string[], value: string) {
  arr.splice(lowerBound(arr, value), 0, value);
}

function sortedRemove(arr: string[], value: string) {
  const at = lowerBound(arr, value);
  if (at < arr.length && arr[at] === value) arr.splice(at, 1);
}
