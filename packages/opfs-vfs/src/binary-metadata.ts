import { RecordRole, type RecordCodec } from './storage-contract';
import { crc32 } from './data-wal';
import { VfsCorruptionError } from './fs-errors';
import { baseName, parentPath } from './fs-path';
import type { Inode } from './opfs-vfs';

// Binary format constants
const BINARY_MAGIC = 0x42564653; // 'BVFS' in little-endian

/**
 * The metadata format version this build writes and accepts. Exposed so callers
 * (e.g. {@link peekVolume}) can compare an on-disk volume's version against the
 * current one to decide whether it needs a reset/migration. A volume whose stored
 * version differs is rejected at mount with `VfsCorruptionError('format-version')`.
 */
export const CURRENT_BINARY_VERSION = 10;

// Log record types
const LOG_UPSERT = 1;
const LOG_DELETE = 2;
const LOG_TX_BEGIN = 3;
const LOG_TX_COMMIT = 4;
/**
 * PERF-9: compact attr-only upsert. Carries flags(mode/kind), size, ino, nlink
 * and the three timestamps — but NO block table and NO children list. Emitted
 * when an inode's blocks/children did not change since the last log record
 * (e.g. a timestamp touch, chmod, or an in-place overwrite that only changed
 * size). On replay it MERGES onto the existing inode, preserving its current
 * blocks/children (see {@link applyMutation} `upsert-attr`). Legacy logs never
 * contain this type; a legacy reader that encounters it (impossible without a
 * format bump, but defensively) treats it as an unknown record and resyncs to
 * the next transaction marker. Payload layout (all u32 LE):
 *   flags | size | ino | nlink | atime | mtime | ctime   (28 bytes)
 */
const LOG_UPSERT_ATTR = 5;

/** Module-level encoder shared by the compact-record serializer (PERF-9/PERF-12). */
const sharedLogEncoder = new TextEncoder();
// Version 10 adds per-inode block extents to the generation/commit-facts format.
const BINARY_VERSION = 10;
const HEADER_SIZE = 40; // bytes
const INODE_RECORD_SIZE = 48; // bytes
const INODE_RECORD_U32S = 12; // 48 / 4
const DIR_ENTRY_RECORD_SIZE = 16; // bytes
const DIR_ENTRY_RECORD_U32S = 4; // 16 / 4
const HEADER_U32S = 10; // 40 / 4
const MAX_U32 = 0xffffffff;
// High bit of block count selects runCount followed by (start, length) pairs.
const EXTENT_FLAG = 0x80000000;
const DEFAULT_FILE_MODE = 33188;
const DEFAULT_DIR_MODE = 16877;
const DEFAULT_SYMLINK_MODE = 41471;

function packFlags(inode: Inode): number {
  const kind = inode.kind === 'symlink' ? 2 : inode.isDir ? 1 : 0;
  return (inode.mode << 2) | kind;
}

function unpackKind(flags: number): 'file' | 'dir' | 'symlink' {
  const kind = flags & 0b11;
  return kind === 1 ? 'dir' : kind === 2 ? 'symlink' : 'file';
}

function unpackMode(flags: number, kind: 'file' | 'dir' | 'symlink'): number {
  const mode = flags >>> 2;
  if (mode !== 0) return mode;
  if (kind === 'dir') return DEFAULT_DIR_MODE;
  if (kind === 'symlink') return DEFAULT_SYMLINK_MODE;
  return DEFAULT_FILE_MODE;
}

function kindMatchesMode(kind: 'file' | 'dir' | 'symlink', mode: number): boolean {
  const fileType = mode & 0o170000;
  if (kind === 'dir') return fileType === 0o040000;
  if (kind === 'symlink') return fileType === 0o120000;
  return fileType === 0o100000;
}

function decodeLogFlags(flags: number): {
  kind: 'file' | 'dir' | 'symlink';
  mode: number;
} {
  const kind = unpackKind(flags);
  const mode = unpackMode(flags, kind);
  if (kindMatchesMode(kind, mode)) {
    return { kind, mode };
  }
  throw new Error(`Unsupported metadata log flags: 0x${flags.toString(16)}`);
}

function packTimestampSeconds(timestampMs?: number): number {
  return timestampMs === undefined ? 0 : Math.floor(timestampMs / 1000);
}

function unpackTimestampMs(timestampSeconds: number): number | undefined {
  return timestampSeconds === 0 ? undefined : timestampSeconds * 1000;
}

function getPackedTimes(inode: Inode): { atime: number; mtime: number; ctime: number } {
  const mtimeMs = inode.mtimeMs ?? inode.timestampMs;
  const atimeMs = inode.atimeMs ?? mtimeMs ?? inode.ctimeMs;
  const ctimeMs = inode.ctimeMs ?? mtimeMs ?? atimeMs;
  return {
    atime: packTimestampSeconds(atimeMs),
    mtime: packTimestampSeconds(mtimeMs),
    ctime: packTimestampSeconds(ctimeMs),
  };
}

function blockEncoding(blocks: number[]): { count: number; words: number } {
  let runs = 0;
  for (let i = 0; i < blocks.length; i++) {
    if (i === 0 || (blocks[i - 1] === 0 ? blocks[i] !== 0 : blocks[i] !== blocks[i - 1] + 1)) runs++;
  }
  const extents = 1 + runs * 2 < blocks.length;
  return { count: blocks.length | (extents ? EXTENT_FLAG : 0), words: extents ? 1 + runs * 2 : blocks.length };
}

function writeBlocks(view: DataView, offset: number, blocks: number[], encodedCount: number): number {
  if (!(encodedCount & EXTENT_FLAG)) {
    for (const block of blocks) {
      view.setUint32(offset, block, true);
      offset += 4;
    }
    return offset;
  }

  const runCountOffset = offset;
  offset += 4;
  let runs = 0;
  for (let i = 0; i < blocks.length;) {
    const start = blocks[i];
    let length = 1;
    while (
      i + length < blocks.length &&
      (start === 0 ? blocks[i + length] === 0 : blocks[i + length] === blocks[i + length - 1] + 1)
    ) {
      length++;
    }
    view.setUint32(offset, start, true);
    view.setUint32(offset + 4, length, true);
    offset += 8;
    runs++;
    i += length;
  }
  view.setUint32(runCountOffset, runs, true);
  return offset;
}

function readBlocks(view: DataView, offset: number, encodedCount: number, end: number, totalBlocks: number): number[] {
  const blockCount = encodedCount & ~EXTENT_FLAG;
  if (blockCount > (MAX_U32 + 1) / 4096) throw new Error('Corrupted binary metadata: block count exceeds file limit');
  const extents = !!(encodedCount & EXTENT_FLAG);
  if (extents && offset + 4 > end) throw new Error('Corrupted binary metadata: truncated extent list');
  const runs = extents ? view.getUint32(offset, true) : 0;
  if (extents) offset += 4;
  const words = extents ? runs * 2 : blockCount;
  if (offset + words * 4 > end || (extents && (runs === 0 || runs > blockCount))) {
    throw new Error('Corrupted binary metadata: truncated or invalid block list');
  }

  const blocks: number[] = [];
  const validBlock = (block: number) => block < totalBlocks;
  for (let i = 0; i < (extents ? runs : blockCount); i++) {
    const start = view.getUint32(offset, true);
    offset += 4;
    const length = extents ? view.getUint32(offset, true) : 1;
    if (extents) offset += 4;
    if (
      length === 0 ||
      length > blockCount - blocks.length ||
      start + length > MAX_U32 + 1 ||
      !validBlock(start) ||
      !validBlock(start === 0 ? 0 : start + length - 1)
    ) {
      throw new Error(`Corrupted binary metadata: block ${start} outside the volume or invalid extent`);
    }
    for (let b = 0; b < length; b++) blocks.push(start === 0 ? 0 : start + b);
  }
  if (blocks.length !== blockCount)
    throw new Error('Corrupted binary metadata: extent lengths do not match block count');
  return blocks;
}

export interface DeserializedMeta {
  totalBlocks: number;
  blockSize: number;
  nextInodeNumber: number;
  inodes: Map<string, Inode>;
}

function resolveSerializationPaths(inodes: Map<string, Inode>, presortedPaths?: string[]): string[] {
  if (!presortedPaths) {
    return Array.from(inodes.keys()).sort();
  }

  const seen = new Set<string>();
  const paths: string[] = [];
  let needsResort = false;

  for (const path of presortedPaths) {
    if (!inodes.has(path) || seen.has(path)) {
      needsResort = true;
      continue;
    }
    seen.add(path);
    paths.push(path);
  }

  if (paths.length !== inodes.size) {
    needsResort = true;
    for (const path of inodes.keys()) {
      if (!seen.has(path)) {
        seen.add(path);
        paths.push(path);
      }
    }
  }

  if (needsResort) {
    paths.sort();
  }

  return paths;
}

/**
 * Serialize inode map into binary format.
 * Snapshot format stores unique inode records plus explicit directory entries.
 */
export function serializeMeta(
  inodes: Map<string, Inode>,
  totalBlocks: number,
  blockSize: number,
  presortedPaths?: string[],
  nextInodeNumber?: number,
): ArrayBuffer {
  const paths = resolveSerializationPaths(inodes, presortedPaths);
  const inodeById = new Map<number, Inode>();
  for (const path of paths) {
    const inode = inodes.get(path)!;
    if (!inodeById.has(inode.ino)) inodeById.set(inode.ino, inode);
  }
  const uniqueInodes = Array.from(inodeById.entries()).sort((a, b) => a[0] - b[0]);
  const inodeCount = uniqueInodes.length;
  const dirEntryPaths = paths.filter((path) => path !== '/');
  const dirEntryCount = dirEntryPaths.length;

  const encoder = new TextEncoder();
  let stringTableSize = 0;
  let blockListU32s = 0;
  const blockEncodings = uniqueInodes.map(([, inode]) => blockEncoding(inode.blocks));
  const symlinkTargetByteLengths: number[] = new Array(inodeCount).fill(0);
  const dirEntryNameByteLengths: number[] = new Array(dirEntryCount);
  for (let i = 0; i < inodeCount; i++) {
    const [, inode] = uniqueInodes[i];
    if (inode.size > MAX_U32) {
      throw new Error(
        `Inode ${inode.ino} size ${inode.size} exceeds u32 max (4GB). Binary metadata does not support files >4GB.`,
      );
    }
    if (inode.kind === 'symlink' && inode.symlinkTarget) {
      const targetByteLen = encoder.encode(inode.symlinkTarget).byteLength;
      symlinkTargetByteLengths[i] = targetByteLen;
      stringTableSize += targetByteLen;
    }
    blockListU32s += blockEncodings[i].words;
  }
  for (let i = 0; i < dirEntryCount; i++) {
    const byteLen = encoder.encode(baseName(dirEntryPaths[i])).byteLength;
    dirEntryNameByteLengths[i] = byteLen;
    stringTableSize += byteLen;
  }

  const blockListOffset = HEADER_SIZE + inodeCount * INODE_RECORD_SIZE;
  const dirEntryOffset = blockListOffset + blockListU32s * 4;
  const stringTableOffset = dirEntryOffset + dirEntryCount * DIR_ENTRY_RECORD_SIZE;
  const totalSize = stringTableOffset + stringTableSize;

  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const u32 = new Uint32Array(buffer, 0, (dirEntryOffset >>> 2) + dirEntryCount * DIR_ENTRY_RECORD_U32S);
  const bytes = new Uint8Array(buffer);
  let derivedNextInodeNumber = 2;
  for (const inode of inodeById.values()) {
    const storedIno = Number.isInteger(inode.ino) && inode.ino > 0 ? inode.ino : 0;
    derivedNextInodeNumber = Math.max(derivedNextInodeNumber, storedIno + 1);
  }

  u32[0] = BINARY_MAGIC;
  u32[1] = BINARY_VERSION;
  u32[2] = blockSize;
  u32[3] = totalBlocks;
  u32[4] = inodeCount;
  u32[5] = dirEntryCount;
  u32[6] = nextInodeNumber ?? derivedNextInodeNumber;
  u32[7] = inodes.get('/')?.ino ?? 1;
  u32[8] = dirEntryOffset;
  u32[9] = stringTableOffset;

  let curBlockU32 = 0;
  let curStringOff = 0;
  for (let i = 0; i < inodeCount; i++) {
    const [inodeId, inode] = uniqueInodes[i];
    const rec = HEADER_U32S + i * INODE_RECORD_U32S;
    const times = getPackedTimes(inode);
    const isSymlink = inode.kind === 'symlink';

    u32[rec + 0] = inodeId;
    u32[rec + 1] = packFlags(inode);
    u32[rec + 2] = inode.size;
    u32[rec + 3] = blockEncodings[i].count;
    u32[rec + 4] = inode.blocks.length > 0 ? blockListOffset + curBlockU32 * 4 : 0;
    u32[rec + 5] = inode.nlink ?? 1;
    u32[rec + 6] = times.atime;
    u32[rec + 7] = times.mtime;
    u32[rec + 8] = times.ctime;
    u32[rec + 9] = isSymlink && symlinkTargetByteLengths[i] > 0 ? stringTableOffset + curStringOff : 0;
    u32[rec + 10] = isSymlink ? symlinkTargetByteLengths[i] : 0;
    u32[rec + 11] = 0;

    if (inode.blocks.length > 0) {
      writeBlocks(view, blockListOffset + curBlockU32 * 4, inode.blocks, blockEncodings[i].count);
    }
    curBlockU32 += blockEncodings[i].words;

    if (isSymlink && symlinkTargetByteLengths[i] > 0) {
      encoder.encodeInto(inode.symlinkTarget!, bytes.subarray(stringTableOffset + curStringOff));
      curStringOff += symlinkTargetByteLengths[i];
    }
  }

  const dirEntryBase = dirEntryOffset >>> 2;
  for (let i = 0; i < dirEntryCount; i++) {
    const path = dirEntryPaths[i];
    const inode = inodes.get(path)!;
    const parent = inodes.get(parentPath(path));
    if (!parent) throw new Error(`Missing parent inode for path ${path}`);
    const rec = dirEntryBase + i * DIR_ENTRY_RECORD_U32S;
    const name = baseName(path);
    const nameByteLen = dirEntryNameByteLengths[i];
    u32[rec + 0] = parent.ino;
    u32[rec + 1] = inode.ino;
    u32[rec + 2] = stringTableOffset + curStringOff;
    u32[rec + 3] = nameByteLen;
    encoder.encodeInto(name, bytes.subarray(stringTableOffset + curStringOff));
    curStringOff += nameByteLen;
  }

  return buffer;
}

/**
 * Deserialize binary metadata from ArrayBuffer.
 * Reconstructs the legacy path-keyed inode map from unique inode records + dir entries.
 */
export function deserializeBinaryMeta(buffer: ArrayBuffer): DeserializedMeta {
  const bytes = new Uint8Array(buffer);
  const decoder = new TextDecoder();

  if (buffer.byteLength < HEADER_SIZE) {
    throw new Error(`Corrupted binary metadata: buffer too small (${buffer.byteLength} < ${HEADER_SIZE})`);
  }

  const hdr = new DataView(buffer, 0, HEADER_SIZE);
  const magic = hdr.getUint32(0, true);
  if (magic !== BINARY_MAGIC) {
    throw new Error(`Invalid binary metadata magic: 0x${magic.toString(16)}`);
  }
  const version = hdr.getUint32(4, true);
  if (version !== BINARY_VERSION) {
    // §6.4: refuse an unknown/future on-disk format with a typed, categorized
    // error rather than misparsing it. A future version (> BINARY_VERSION) means
    // a newer build wrote this DB; a lower one is a pre-migration legacy format.
    throw new VfsCorruptionError(
      'format-version',
      `Unsupported binary metadata version: ${version} (this build expects ${BINARY_VERSION})`,
    );
  }

  const blockSize = hdr.getUint32(8, true);
  const totalBlocks = hdr.getUint32(12, true);
  const inodeCount = hdr.getUint32(16, true);
  const dirEntryCount = hdr.getUint32(20, true);
  const storedNextInodeNumber = hdr.getUint32(24, true);
  const rootInodeId = hdr.getUint32(28, true);
  const dirEntryOffset = hdr.getUint32(32, true);
  const stringTableOffset = hdr.getUint32(36, true);
  const inodeTableOffset = HEADER_SIZE;
  const blockListOffset = inodeTableOffset + inodeCount * INODE_RECORD_SIZE;

  // Bound what the rest of the load (and the allocator) will trust.
  if (blockSize !== 4096 || totalBlocks === 0 || totalBlocks > 0x80000000) {
    throw new Error(`Corrupted binary metadata: invalid geometry (blockSize ${blockSize}, totalBlocks ${totalBlocks})`);
  }

  if (dirEntryOffset < blockListOffset || dirEntryOffset > buffer.byteLength) {
    throw new Error(`Corrupted binary metadata: invalid dir entry offset ${dirEntryOffset}`);
  }
  if (stringTableOffset < dirEntryOffset || stringTableOffset > buffer.byteLength) {
    throw new Error(`Corrupted binary metadata: invalid string table offset ${stringTableOffset}`);
  }
  if (dirEntryOffset + dirEntryCount * DIR_ENTRY_RECORD_SIZE > stringTableOffset) {
    throw new Error(`Corrupted binary metadata: directory entries overlap string table`);
  }

  const inodeTable = new Map<number, Inode>();
  let maxInodeNumber = 1;
  for (let i = 0; i < inodeCount; i++) {
    const recOffset = inodeTableOffset + i * INODE_RECORD_SIZE;
    const view = new DataView(buffer, recOffset, INODE_RECORD_SIZE);
    const inodeId = view.getUint32(0, true);
    const flags = view.getUint32(4, true);
    const kind = unpackKind(flags);
    const size = view.getUint32(8, true);
    const encodedBlockCount = view.getUint32(12, true);
    const blockListAbsOffset = view.getUint32(16, true);
    const nlink = view.getUint32(20, true);
    const atimeMs = unpackTimestampMs(view.getUint32(24, true));
    const mtimeMs = unpackTimestampMs(view.getUint32(28, true));
    const ctimeMs = unpackTimestampMs(view.getUint32(32, true));
    const symlinkTargetOffset = view.getUint32(36, true);
    const symlinkTargetLength = view.getUint32(40, true);

    let blocks: number[] = [];
    if (encodedBlockCount > 0) {
      if (blockListAbsOffset < blockListOffset || blockListAbsOffset > dirEntryOffset) {
        throw new Error(`Corrupted binary metadata: block list at inode ${inodeId} overflows buffer`);
      }
      blocks = readBlocks(new DataView(buffer), blockListAbsOffset, encodedBlockCount, dirEntryOffset, totalBlocks);
    }

    let symlinkTarget: string | undefined;
    if (kind === 'symlink' && symlinkTargetLength > 0) {
      const targetEnd = symlinkTargetOffset + symlinkTargetLength;
      if (symlinkTargetOffset < stringTableOffset || targetEnd > buffer.byteLength) {
        throw new Error(`Corrupted binary metadata: symlink target at inode ${inodeId} overflows buffer`);
      }
      symlinkTarget = decoder.decode(bytes.subarray(symlinkTargetOffset, targetEnd));
    }

    inodeTable.set(inodeId, {
      ino: inodeId,
      kind,
      isDir: kind === 'dir',
      size: kind === 'symlink' ? symlinkTargetLength : size,
      blocks,
      children: [],
      symlinkTarget,
      mode: unpackMode(flags, kind),
      nlink: nlink || 1,
      atimeMs,
      mtimeMs,
      ctimeMs,
      timestampMs: mtimeMs,
    });
    maxInodeNumber = Math.max(maxInodeNumber, inodeId);
  }

  const dirEntriesByParent = new Map<number, Array<{ name: string; childId: number }>>();
  for (let i = 0; i < dirEntryCount; i++) {
    const recOffset = dirEntryOffset + i * DIR_ENTRY_RECORD_SIZE;
    const view = new DataView(buffer, recOffset, DIR_ENTRY_RECORD_SIZE);
    const parentId = view.getUint32(0, true);
    const childId = view.getUint32(4, true);
    const nameOffset = view.getUint32(8, true);
    const nameLength = view.getUint32(12, true);
    const nameEnd = nameOffset + nameLength;
    if (nameOffset < stringTableOffset || nameEnd > buffer.byteLength) {
      throw new Error(`Corrupted binary metadata: directory entry ${i} overflows string table`);
    }
    const parent = inodeTable.get(parentId);
    const child = inodeTable.get(childId);
    if (!parent?.isDir || !child) {
      throw new Error(`Corrupted binary metadata: invalid directory entry ${i}`);
    }
    const name = decoder.decode(bytes.subarray(nameOffset, nameEnd));
    let entries = dirEntriesByParent.get(parentId);
    if (!entries) {
      entries = [];
      dirEntriesByParent.set(parentId, entries);
    }
    entries.push({ name, childId });
  }

  // Iterative preorder walk (the path order doubles as the sorted path list). A
  // directory may be reached only once: that rejects cycles and the DAGs whose
  // expansion is exponential, and deep trees cannot overflow the call stack.
  const inodes = new Map<string, Inode>();
  const seenDirs = new Set<number>();
  const stack: Array<[string, number]> = [['/', rootInodeId || 1]];
  while (stack.length > 0) {
    const [path, inodeId] = stack.pop()!;
    const inode = inodeTable.get(inodeId);
    if (!inode) throw new Error(`Corrupted binary metadata: missing inode ${inodeId}`);
    if (inode.isDir) {
      if (seenDirs.has(inodeId)) throw new Error(`Corrupted binary metadata: directory inode ${inodeId} linked twice`);
      seenDirs.add(inodeId);
    }
    if (inodes.has(path)) throw new Error(`Corrupted binary metadata: duplicate path ${path}`);
    inodes.set(path, inode);
    const children = dirEntriesByParent.get(inodeId) ?? [];
    for (let i = children.length - 1; i >= 0; i--) {
      const { name, childId } = children[i]!;
      if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
        throw new Error(`Corrupted binary metadata: invalid entry name under inode ${inodeId}`);
      }
      stack.push([path === '/' ? `/${name}` : `${path}/${name}`, childId]);
    }
  }

  return {
    totalBlocks,
    blockSize,
    nextInodeNumber: storedNextInodeNumber > 1 ? storedNextInodeNumber : maxInodeNumber + 1,
    inodes,
  };
}

/**
 * Serialize a single inode change into a log record.
 * Format: recordType(u32) + pathLength(u32) + payloadSize(u32) + path(UTF-8) + payload
 * Payload for upsert: flags(u32) + size(u32) + encodedBlockCount(u32) + block list + auxCount(u32) +
 * auxPayload + ino(u32) + nlink(u32) + atime(u32) + mtime(u32) + ctime(u32)
 */
export function serializeLogRecord(path: string, inode: Inode | null): Uint8Array {
  const encoder = new TextEncoder();
  const pathBytes = encoder.encode(path);

  if (inode === null) {
    // Delete record: no payload
    const buf = new ArrayBuffer(12 + pathBytes.byteLength);
    const view = new DataView(buf);
    view.setUint32(0, LOG_DELETE, true);
    view.setUint32(4, pathBytes.byteLength, true);
    view.setUint32(8, 0, true); // payloadSize
    new Uint8Array(buf).set(pathBytes, 12);
    return new Uint8Array(buf);
  }

  // Directory records carry no child names: the namespace is rebuilt from paths
  // on mount, and re-logging every sibling made each create O(directory size).
  const isSymlink = inode.kind === 'symlink';
  let auxPayloadSize = 0;
  let auxCount = 0;
  let symlinkTargetBytes: Uint8Array | undefined;
  if (isSymlink) {
    symlinkTargetBytes = encoder.encode(inode.symlinkTarget ?? '');
    auxCount = symlinkTargetBytes.byteLength;
    auxPayloadSize = symlinkTargetBytes.byteLength;
  }

  const encoding = blockEncoding(inode.blocks);
  const payloadSize = 12 + encoding.words * 4 + 4 + auxPayloadSize + 20;
  const times = getPackedTimes(inode);
  // 12 = flags(4) + size(4) + encodedBlockCount(4), then block list, auxCount(4), auxPayload, ino/nlink/atime/mtime/ctime

  const totalSize = 12 + pathBytes.byteLength + payloadSize;
  const buf = new ArrayBuffer(totalSize);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  // Header
  view.setUint32(0, LOG_UPSERT, true);
  view.setUint32(4, pathBytes.byteLength, true);
  view.setUint32(8, payloadSize, true);

  // Path
  bytes.set(pathBytes, 12);

  // Payload
  let off = 12 + pathBytes.byteLength;
  view.setUint32(off, packFlags(inode), true);
  off += 4;
  view.setUint32(off, inode.size, true);
  off += 4;
  view.setUint32(off, encoding.count, true);
  off += 4;
  off = writeBlocks(view, off, inode.blocks, encoding.count);
  view.setUint32(off, auxCount, true);
  off += 4;
  if (isSymlink) {
    bytes.set(symlinkTargetBytes ?? new Uint8Array(0), off);
    off += symlinkTargetBytes?.byteLength ?? 0;
  }
  view.setUint32(off, Number.isInteger(inode.ino) && inode.ino > 0 ? inode.ino : 0, true);
  off += 4;
  view.setUint32(off, inode.nlink ?? 1, true);
  off += 4;
  view.setUint32(off, times.atime, true);
  off += 4;
  view.setUint32(off, times.mtime, true);
  off += 4;
  view.setUint32(off, times.ctime, true);

  return new Uint8Array(buf);
}

/**
 * PERF-9: serialize a compact attr-only upsert record. Same 12-byte framing
 * header (recordType | pathLength | payloadSize) as {@link serializeLogRecord}
 * so the transaction-aware reader can walk it, but the payload omits the block
 * table and children. Used only for inodes whose blocks/children are unchanged.
 */
export function serializeLogAttrRecord(path: string, inode: Inode): Uint8Array {
  const pathBytes = sharedLogEncoder.encode(path);
  const payloadSize = 28; // flags + size + ino + nlink + atime + mtime + ctime
  const buf = new ArrayBuffer(12 + pathBytes.byteLength + payloadSize);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  view.setUint32(0, LOG_UPSERT_ATTR, true);
  view.setUint32(4, pathBytes.byteLength, true);
  view.setUint32(8, payloadSize, true);
  bytes.set(pathBytes, 12);
  let off = 12 + pathBytes.byteLength;
  const times = getPackedTimes(inode);
  view.setUint32(off, packFlags(inode), true);
  off += 4;
  view.setUint32(off, inode.size, true);
  off += 4;
  view.setUint32(off, Number.isInteger(inode.ino) && inode.ino > 0 ? inode.ino : 0, true);
  off += 4;
  view.setUint32(off, inode.nlink ?? 1, true);
  off += 4;
  view.setUint32(off, times.atime, true);
  off += 4;
  view.setUint32(off, times.mtime, true);
  off += 4;
  view.setUint32(off, times.ctime, true);
  return bytes;
}

function serializeLogMarker(recordType: number, txId: number): Uint8Array {
  const buf = new ArrayBuffer(16);
  const view = new DataView(buf);
  view.setUint32(0, recordType, true);
  view.setUint32(4, 0, true); // pathLength
  view.setUint32(8, 4, true); // payloadSize
  view.setUint32(12, txId, true);
  return new Uint8Array(buf);
}

/** CRC32 over the complete BEGIN and transaction body. */
function serializeLogCommitMarkerWithCrc(txId: number, crc: number): Uint8Array {
  const buf = new ArrayBuffer(20);
  const view = new DataView(buf);
  view.setUint32(0, LOG_TX_COMMIT, true);
  view.setUint32(4, 0, true); // pathLength
  view.setUint32(8, 8, true); // payloadSize: txId(4) + crc(4)
  view.setUint32(12, txId, true);
  view.setUint32(16, crc >>> 0, true);
  return new Uint8Array(buf);
}

export function serializeLogTransaction(
  records: Uint8Array[],
  txId: number,
  sealer?: RecordCodec,
  generation = 0,
  physicalDataSize = 0,
  logicalExtent = 0,
): Uint8Array {
  const begin = serializeLogMarker(LOG_TX_BEGIN, txId);

  // Issue #54: the TX_BEGIN/TX_COMMIT markers stay plaintext (a reader scans them
  // without the key); only the records body between them is sealed. Concatenate
  // the records, seal that body (role METALOG, identity = txId), then frame it as
  // BEGIN ‖ sealedBody ‖ COMMIT. The commit CRC is still computed over the
  // on-disk prefix (BEGIN ‖ sealedBody) so replay's INT-9 batch CRC check runs on
  // the bytes actually written. With no `sealer`, `body` is the plaintext
  // concatenation, including the generation and durable extent.
  const recordsBytes = 20 + records.reduce((sum, record) => sum + record.byteLength, 0);
  const plaintextBody = new Uint8Array(recordsBytes);
  const header = new DataView(plaintextBody.buffer);
  header.setUint32(0, generation >>> 0, true);
  header.setFloat64(4, physicalDataSize, true);
  header.setFloat64(12, logicalExtent, true);
  let bodyOffset = 20;
  for (const record of records) {
    plaintextBody.set(record, bodyOffset);
    bodyOffset += record.byteLength;
  }
  const body = sealer ? sealer.seal(plaintextBody, RecordRole.metaLog, txId >>> 0) : plaintextBody;

  // The CRC covers BEGIN + (sealed-or-plaintext) body. Build that prefix first,
  // checksum it, then append the CRC-bearing COMMIT marker.
  const prefixSize = begin.byteLength + body.byteLength;
  const prefix = new Uint8Array(prefixSize);
  prefix.set(begin, 0);
  prefix.set(body, begin.byteLength);

  const commit = serializeLogCommitMarkerWithCrc(txId, crc32(prefix));
  const out = new Uint8Array(prefixSize + commit.byteLength);
  out.set(prefix, 0);
  out.set(commit, prefixSize);
  return out;
}

type ParsedMutation =
  | { kind: 'delete'; path: string }
  | { kind: 'upsert'; path: string; inode: Inode }
  // PERF-9: attr-only upsert — merge these fields onto the existing inode,
  // preserving its current blocks/children.
  | {
      kind: 'upsert-attr';
      path: string;
      nodeKind: 'file' | 'dir' | 'symlink';
      mode: number;
      size: number;
      ino: number;
      nlink: number;
      atimeMs?: number;
      mtimeMs?: number;
      ctimeMs?: number;
    };

function cloneInode(source: Inode): Inode {
  return {
    ...source,
    blocks: [...source.blocks],
    children: [...source.children],
  };
}

function overwriteInode(target: Inode, source: Inode) {
  target.ino = source.ino;
  target.kind = source.kind;
  target.isDir = source.isDir;
  target.size = source.size;
  target.blocks = [...source.blocks];
  target.children = [...source.children];
  target.symlinkTarget = source.symlinkTarget;
  target.mode = source.mode;
  target.nlink = source.nlink;
  target.atimeMs = source.atimeMs;
  target.mtimeMs = source.mtimeMs;
  target.ctimeMs = source.ctimeMs;
  target.timestampMs = source.timestampMs;
}

function refreshCanonicalInode(inodeById: Map<number, Inode>, inodes: Map<string, Inode>, inodeId: number) {
  if (inodeId <= 0) return;
  for (const inode of inodes.values()) {
    if (inode.ino === inodeId) {
      inodeById.set(inodeId, inode);
      return;
    }
  }
  inodeById.delete(inodeId);
}

function applyMutation(
  mutation: ParsedMutation,
  inodes: Map<string, Inode>,
  sortedPaths: string[],
  inodeById: Map<number, Inode>,
) {
  if (mutation.kind === 'delete') {
    const removed = inodes.get(mutation.path);
    inodes.delete(mutation.path);
    let lo = 0;
    let hi = sortedPaths.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sortedPaths[mid] < mutation.path) lo = mid + 1;
      else hi = mid;
    }
    if (lo < sortedPaths.length && sortedPaths[lo] === mutation.path) {
      sortedPaths.splice(lo, 1);
    }
    if (removed) refreshCanonicalInode(inodeById, inodes, removed.ino);
    return;
  }

  if (mutation.kind === 'upsert-attr') {
    // PERF-9: merge attrs onto the existing inode, KEEPING its blocks/children.
    const existing = inodes.get(mutation.path) ?? (mutation.ino > 0 ? inodeById.get(mutation.ino) : undefined);
    if (existing) {
      existing.kind = mutation.nodeKind;
      existing.isDir = mutation.nodeKind === 'dir';
      existing.mode = mutation.mode;
      existing.size = mutation.nodeKind === 'symlink' ? existing.size : mutation.size;
      if (mutation.ino > 0) existing.ino = mutation.ino;
      existing.nlink = mutation.nlink;
      existing.atimeMs = mutation.atimeMs;
      existing.mtimeMs = mutation.mtimeMs;
      existing.ctimeMs = mutation.ctimeMs;
      existing.timestampMs = mutation.mtimeMs;
      inodes.set(mutation.path, existing);
      if (mutation.ino > 0) inodeById.set(mutation.ino, existing);
      return;
    }
    // No existing inode for an attr-only record (e.g. a log whose full record was
    // discarded by a torn-tail truncation). Synthesize a minimal inode with empty
    // blocks/children — the same state a full record would have produced if it
    // had described an empty file. Falls through to the upsert insertion path.
    const synthesized: Inode = {
      ino: mutation.ino,
      kind: mutation.nodeKind,
      isDir: mutation.nodeKind === 'dir',
      size: mutation.size,
      blocks: [],
      children: [],
      symlinkTarget: undefined,
      mode: mutation.mode,
      nlink: mutation.nlink,
      atimeMs: mutation.atimeMs,
      mtimeMs: mutation.mtimeMs,
      ctimeMs: mutation.ctimeMs,
      timestampMs: mutation.mtimeMs,
    };
    mutation = { kind: 'upsert', path: mutation.path, inode: synthesized };
  }

  const previous = inodes.get(mutation.path);
  const isNew = previous === undefined;
  const inodeId = mutation.inode.ino;
  let nextInode: Inode;

  if (inodeId > 0) {
    const canonical = inodeById.get(inodeId) ?? (previous?.ino === inodeId ? previous : undefined);
    if (canonical) {
      overwriteInode(canonical, mutation.inode);
      nextInode = canonical;
    } else {
      nextInode = cloneInode(mutation.inode);
    }
    inodeById.set(inodeId, nextInode);
  } else if (previous) {
    overwriteInode(previous, mutation.inode);
    nextInode = previous;
  } else {
    nextInode = cloneInode(mutation.inode);
  }

  inodes.set(mutation.path, nextInode);
  if (previous && previous !== nextInode) {
    refreshCanonicalInode(inodeById, inodes, previous.ino);
  }
  if (!isNew) return;

  let lo = 0;
  let hi = sortedPaths.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedPaths[mid] < mutation.path) lo = mid + 1;
    else hi = mid;
  }
  sortedPaths.splice(lo, 0, mutation.path);
}

function parseMutationRecord(
  view: DataView,
  bytes: Uint8Array,
  decoder: TextDecoder,
  offset: number,
  totalBlocks: number,
): { mutation: ParsedMutation; nextOffset: number } | null {
  if (offset + 12 > view.byteLength) return null;

  try {
    const recordType = view.getUint32(offset, true);
    const pathLength = view.getUint32(offset + 4, true);
    const payloadSize = view.getUint32(offset + 8, true);
    if (recordType !== LOG_UPSERT && recordType !== LOG_DELETE && recordType !== LOG_UPSERT_ATTR) return null;
    if (offset + 12 + pathLength + payloadSize > view.byteLength) return null;

    const path = decoder.decode(bytes.subarray(offset + 12, offset + 12 + pathLength));
    const nextOffset = offset + 12 + pathLength + payloadSize;

    if (recordType === LOG_DELETE) {
      if (payloadSize !== 0) return null;
      return { mutation: { kind: 'delete', path }, nextOffset };
    }

    if (recordType === LOG_UPSERT_ATTR) {
      // PERF-9 compact record: flags|size|ino|nlink|atime|mtime|ctime (28 bytes).
      if (payloadSize !== 28) return null;
      let aOff = offset + 12 + pathLength;
      const flags = view.getUint32(aOff, true);
      const { kind, mode } = decodeLogFlags(flags);
      aOff += 4;
      const size = view.getUint32(aOff, true);
      aOff += 4;
      const ino = view.getUint32(aOff, true);
      aOff += 4;
      const nlink = view.getUint32(aOff, true) || 1;
      aOff += 4;
      const atimeMs = unpackTimestampMs(view.getUint32(aOff, true));
      aOff += 4;
      const mtimeMs = unpackTimestampMs(view.getUint32(aOff, true));
      aOff += 4;
      const ctimeMs = unpackTimestampMs(view.getUint32(aOff, true));
      return {
        mutation: {
          kind: 'upsert-attr',
          path,
          nodeKind: kind,
          mode,
          size,
          ino,
          nlink,
          atimeMs: atimeMs ?? mtimeMs,
          mtimeMs,
          ctimeMs: ctimeMs ?? mtimeMs,
        },
        nextOffset,
      };
    }

    if (payloadSize < 36) return null;
    const recordEnd = nextOffset;
    let pOff = offset + 12 + pathLength;
    const flags = view.getUint32(pOff, true);
    const { kind, mode } = decodeLogFlags(flags);
    pOff += 4;
    const size = view.getUint32(pOff, true);
    pOff += 4;
    const encodedBlockCount = view.getUint32(pOff, true);
    pOff += 4;

    // Reserve auxCount and the five required inode fields after the block list.
    const blocks = readBlocks(view, pOff, encodedBlockCount, recordEnd - 24, totalBlocks);
    pOff +=
      encodedBlockCount & EXTENT_FLAG ? 4 + view.getUint32(pOff, true) * 8 : (encodedBlockCount & ~EXTENT_FLAG) * 4;

    const auxCount = view.getUint32(pOff, true);
    pOff += 4;
    if (kind !== 'symlink' && auxCount !== 0) return null;
    if (pOff + auxCount + 20 !== recordEnd) return null;
    let symlinkTarget: string | undefined;
    if (kind === 'symlink') {
      symlinkTarget = decoder.decode(bytes.subarray(pOff, pOff + auxCount));
      pOff += auxCount;
    }

    const ino = view.getUint32(pOff, true);
    pOff += 4;
    const nlink = view.getUint32(pOff, true) || 1;
    pOff += 4;
    let atimeMs = unpackTimestampMs(view.getUint32(pOff, true));
    pOff += 4;
    const mtimeMs = unpackTimestampMs(view.getUint32(pOff, true));
    pOff += 4;
    let ctimeMs = unpackTimestampMs(view.getUint32(pOff, true));
    if (atimeMs === undefined) atimeMs = mtimeMs;
    if (ctimeMs === undefined) ctimeMs = mtimeMs;
    return {
      mutation: {
        kind: 'upsert',
        path,
        inode: {
          ino,
          kind,
          isDir: kind === 'dir',
          size: kind === 'symlink' ? auxCount : size,
          blocks,
          children: [],
          symlinkTarget,
          mode,
          nlink,
          atimeMs,
          mtimeMs,
          ctimeMs,
          timestampMs: mtimeMs,
        },
      },
      nextOffset,
    };
  } catch {
    // Any malformed record (bounds, flags, kind) ends replay at its batch; a
    // committed batch that throws here must never brick the mount.
    return null;
  }
}

function findNextTransactionMarker(view: DataView, startOffset: number): number {
  for (let offset = startOffset; offset + 16 <= view.byteLength; offset++) {
    const recordType = view.getUint32(offset, true);
    if (recordType !== LOG_TX_BEGIN && recordType !== LOG_TX_COMMIT) continue;
    const pathLength = view.getUint32(offset + 4, true);
    const payloadSize = view.getUint32(offset + 8, true);
    if (pathLength === 0 && (recordType === LOG_TX_BEGIN ? payloadSize === 4 : payloadSize === 8)) return offset;
  }
  return -1;
}

/**
 * A committed log prefix and the extent carried by its newest transaction.
 */
export interface LogReplayResult {
  count: number;
  validEnd: number;
  physicalDataSize?: number;
  logicalExtent?: number;
  generationMismatch?: 'stale' | 'newer';
}

export function replayLog(
  logBuffer: ArrayBuffer,
  inodes: Map<string, Inode>,
  sortedPaths: string[],
  totalBlocks: number,
  expectedGeneration = 0,
  sealer?: RecordCodec,
): LogReplayResult {
  if (sealer) return replaySealedLog(logBuffer, inodes, sortedPaths, totalBlocks, expectedGeneration, sealer);
  const view = new DataView(logBuffer);
  const bytes = new Uint8Array(logBuffer);
  const decoder = new TextDecoder();
  const inodeById = new Map<number, Inode>();
  for (const inode of inodes.values()) {
    if (inode.ino > 0 && !inodeById.has(inode.ino)) {
      inodeById.set(inode.ino, inode);
    }
  }
  let offset = 0;
  let validEnd = 0;
  let physicalDataSize: number | undefined;
  let logicalExtent: number | undefined;
  let count = 0;

  // Only complete BEGIN‥records‥COMMIT(crc) transactions apply, in order. The
  // first byte that is not one ends replay: skipping a damaged batch and
  // applying a later one could resurrect paths or double-claim blocks.
  while (offset + 16 <= logBuffer.byteLength) {
    if (
      view.getUint32(offset, true) !== LOG_TX_BEGIN ||
      view.getUint32(offset + 4, true) !== 0 ||
      view.getUint32(offset + 8, true) !== 4
    ) {
      break;
    }
    const txId = view.getUint32(offset + 12, true);
    if (offset + 36 > logBuffer.byteLength) break;
    const generation = view.getUint32(offset + 16, true);
    const txPhysicalDataSize = view.getFloat64(offset + 20, true);
    const txLogicalExtent = view.getFloat64(offset + 28, true);
    if (
      !Number.isSafeInteger(txPhysicalDataSize) ||
      !Number.isSafeInteger(txLogicalExtent) ||
      txPhysicalDataSize < 0 ||
      txLogicalExtent < 0
    )
      break;
    const mutations: ParsedMutation[] = [];
    let cursor = offset + 36;
    let commitEnd = -1;
    while (cursor + 12 <= logBuffer.byteLength) {
      const recordType = view.getUint32(cursor, true);
      if (recordType === LOG_TX_COMMIT) {
        if (
          cursor + 20 <= logBuffer.byteLength &&
          view.getUint32(cursor + 4, true) === 0 &&
          view.getUint32(cursor + 8, true) === 8 &&
          view.getUint32(cursor + 12, true) === txId &&
          crc32(bytes.subarray(offset, cursor)) === view.getUint32(cursor + 16, true)
        ) {
          commitEnd = cursor + 20;
        }
        break;
      }
      if (recordType === LOG_TX_BEGIN) break;
      if (generation !== expectedGeneration) {
        // A different generation may describe a larger volume. Check framing
        // and the commit CRC before reporting it, without decoding its blocks.
        if (recordType !== LOG_UPSERT && recordType !== LOG_DELETE && recordType !== LOG_UPSERT_ATTR) break;
        const nextOffset = cursor + 12 + view.getUint32(cursor + 4, true) + view.getUint32(cursor + 8, true);
        if (nextOffset > logBuffer.byteLength) break;
        cursor = nextOffset;
        continue;
      }
      const parsed = parseMutationRecord(view, bytes, decoder, cursor, totalBlocks);
      if (!parsed) break;
      mutations.push(parsed.mutation);
      cursor = parsed.nextOffset;
    }
    if (commitEnd < 0) break;
    if (generation !== expectedGeneration) {
      return {
        count,
        validEnd,
        physicalDataSize,
        logicalExtent,
        generationMismatch: generation < expectedGeneration ? 'stale' : 'newer',
      };
    }
    for (const mutation of mutations) {
      applyMutation(mutation, inodes, sortedPaths, inodeById);
    }
    count += mutations.length;
    physicalDataSize = txPhysicalDataSize;
    logicalExtent = txLogicalExtent;
    offset = commitEnd;
    validEnd = commitEnd;
  }

  return { count, validEnd, physicalDataSize, logicalExtent };
}

/**
 * Issue #54 sealed-log replay. Mirrors {@link replayLog}'s plaintext discipline
 * for the encrypted layout written by {@link serializeLogTransaction} with a
 * sealer:  `BEGIN(16) ‖ sealedBody ‖ COMMIT(20, CRC over BEGIN‖sealedBody)`.
 *
 * Per transaction: scan to a valid TX_BEGIN, find the matching CRC-bearing
 * TX_COMMIT (same txId), validate the commit CRC over the on-disk prefix
 * (torn-tail / tamper of the bytes on disk), AEAD-open the body (role METALOG,
 * identity = txId), then parse + apply the decrypted mutation records. A CRC
 * mismatch or `open` failure discards this batch AND everything after it —
 * matching the plaintext path's mid-stream-corruption truncation semantics.
 * Only fully-committed, authenticated transactions are applied (an unsealed
 * record body can never be parsed, so partial/uncommitted batches are dropped).
 */
function replaySealedLog(
  logBuffer: ArrayBuffer,
  inodes: Map<string, Inode>,
  sortedPaths: string[],
  totalBlocks: number,
  expectedGeneration: number,
  sealer: RecordCodec,
): LogReplayResult {
  const view = new DataView(logBuffer);
  const bytes = new Uint8Array(logBuffer);
  const decoder = new TextDecoder();
  const inodeById = new Map<number, Inode>();
  for (const inode of inodes.values()) {
    if (inode.ino > 0 && !inodeById.has(inode.ino)) {
      inodeById.set(inode.ino, inode);
    }
  }

  let offset = 0;
  let validEnd = 0;
  let physicalDataSize: number | undefined;
  let logicalExtent: number | undefined;
  let count = 0;

  while (offset + 16 <= logBuffer.byteLength) {
    // Stop at the first byte that is not a well-formed BEGIN written at this
    // offset: the txId is the AEAD identity, so an authenticated batch spliced
    // in from another offset is rejected. Never skip ahead to a later batch.
    const txId = view.getUint32(offset + 12, true);
    if (
      view.getUint32(offset, true) !== LOG_TX_BEGIN ||
      view.getUint32(offset + 4, true) !== 0 ||
      view.getUint32(offset + 8, true) !== 4 ||
      txId !== (offset + 1) >>> 0
    ) {
      break;
    }
    const bodyStart = offset + 16;

    // Find the matching commit: the next CRC-bearing TX_COMMIT (20-byte,
    // payloadSize 8) with this txId. The sealed body is opaque, so we cannot
    // walk records — we scan markers and require the matching commit.
    let commitOffset = -1;
    let scan = bodyStart;
    while (scan + 16 <= logBuffer.byteLength) {
      const marker = findNextTransactionMarker(view, scan);
      if (marker < 0) break;
      const mType = view.getUint32(marker, true);
      const mPayload = view.getUint32(marker + 8, true);
      const mTxId = view.getUint32(marker + 12, true);
      if (mType === LOG_TX_COMMIT && mPayload === 8 && mTxId === txId && marker + 20 <= logBuffer.byteLength) {
        commitOffset = marker;
        break;
      }
      // A nested BEGIN before our COMMIT means our batch was never committed
      // (crash mid-append): stop — uncommitted batches are not replayed.
      if (mType === LOG_TX_BEGIN && marker !== offset) break;
      scan = marker + 1;
    }
    if (commitOffset < 0) break; // no committed batch (torn tail) — done.

    // Validate the commit CRC over the on-disk prefix (BEGIN ‖ sealedBody).
    const expectedCrc = view.getUint32(commitOffset + 16, true);
    const prefix = bytes.subarray(offset, commitOffset);
    if (crc32(prefix) !== expectedCrc) break; // corruption — discard rest.

    // AEAD-open the sealed body, then parse + apply its mutation records.
    const sealedBody = bytes.subarray(bodyStart, commitOffset);
    let plainBody: Uint8Array;
    try {
      plainBody = sealer.open(sealedBody, RecordRole.metaLog, txId >>> 0);
    } catch {
      break; // tamper / wrong key — discard this batch and everything after.
    }

    const bodyView = new DataView(plainBody.buffer, plainBody.byteOffset, plainBody.byteLength);
    if (plainBody.byteLength < 20) break;
    const generation = bodyView.getUint32(0, true);
    if (generation !== expectedGeneration) {
      return {
        count,
        validEnd,
        physicalDataSize,
        logicalExtent,
        generationMismatch: generation < expectedGeneration ? 'stale' : 'newer',
      };
    }
    const txPhysicalDataSize = bodyView.getFloat64(4, true);
    const txLogicalExtent = bodyView.getFloat64(12, true);
    if (
      !Number.isSafeInteger(txPhysicalDataSize) ||
      !Number.isSafeInteger(txLogicalExtent) ||
      txPhysicalDataSize < 0 ||
      txLogicalExtent < 0
    )
      break;
    let bodyOffset = 20;
    const mutations: ParsedMutation[] = [];
    let bodyOk = true;
    while (bodyOffset + 12 <= plainBody.byteLength) {
      const parsed = parseMutationRecord(bodyView, plainBody, decoder, bodyOffset, totalBlocks);
      if (!parsed) {
        bodyOk = false;
        break;
      }
      mutations.push(parsed.mutation);
      bodyOffset = parsed.nextOffset;
    }
    // A decrypted body that does not parse cleanly to its end is corrupt — its
    // AEAD tag passed, so this is a framing bug, not tamper; fail-stop the rest.
    if (!bodyOk || bodyOffset !== plainBody.byteLength) break;

    for (const mutation of mutations) {
      applyMutation(mutation, inodes, sortedPaths, inodeById);
    }
    count += mutations.length;
    physicalDataSize = txPhysicalDataSize;
    logicalExtent = txLogicalExtent;
    offset = commitOffset + 20;
    validEnd = offset;
  }

  return { count, validEnd, physicalDataSize, logicalExtent };
}

// ── Meta snapshot envelope (INT-1: atomic A/B double-buffered snapshot) ──

/**
 * Raised when a meta snapshot file exists with bytes but cannot be parsed as a
 * valid, checksum-matching snapshot envelope (or is an unparseable legacy
 * snapshot) and no valid fallback snapshot is available. Mirrors the typed
 * fail-stop style of {@link DataWalCorruptionError} in data-wal.ts so callers
 * can distinguish genuine corruption from a fresh, never-written filesystem.
 */
export class MetaSnapshotCorruptionError extends VfsCorruptionError {
  constructor(message?: string) {
    super('meta-snapshot', message ?? 'Meta snapshot is corrupt');
    this.name = 'MetaSnapshotCorruptionError';
  }
}

/** A/B snapshot envelope: magic, sequence, CRC, body length. The body begins with the durable extents. */
const SNAPSHOT_MAGIC = 0x534e4150; // 'SNAP' little-endian
const SNAPSHOT_HEADER_SIZE = 16;

const SNAPSHOT_CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function snapshotCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = SNAPSHOT_CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Wrap a serialized meta payload in a checksummed, sequenced snapshot envelope.
 *
 * Issue #54: when `sealer` is provided the payload is AEAD-sealed (role
 * {@link AAD_ROLE_SNAPSHOT}, identity = the snapshot `sequence`) BEFORE the CRC
 * and `payloadLen` are computed — so the header's crc32/len describe the on-disk
 * (sealed) bytes and the slot-selection / fallback logic in
 * {@link parseMetaSnapshot} keeps working on the bytes actually written. The
 * sealed body also records the durable physical size and logical extent.
 */
export function frameMetaSnapshot(
  payload: Uint8Array,
  sequence: number,
  sealer?: RecordCodec,
  physicalDataSize = 0,
  logicalExtent = 0,
): Uint8Array {
  const plain = new Uint8Array(16 + payload.length);
  const extents = new DataView(plain.buffer);
  extents.setFloat64(0, physicalDataSize, true);
  extents.setFloat64(8, logicalExtent, true);
  plain.set(payload, 16);
  const body = sealer ? sealer.seal(plain, RecordRole.snapshot, sequence >>> 0) : plain;
  const framed = new Uint8Array(SNAPSHOT_HEADER_SIZE + body.length);
  const view = new DataView(framed.buffer);
  view.setUint32(0, SNAPSHOT_MAGIC, true);
  view.setUint32(4, sequence >>> 0, true);
  view.setUint32(12, body.length, true);
  framed.set(body, SNAPSHOT_HEADER_SIZE);
  view.setUint32(8, snapshotCrc32(framed.subarray(16)), true);
  return framed;
}

export interface ParsedMetaSnapshot {
  sequence: number;
  physicalDataSize: number;
  logicalExtent: number;
  /** The inner serialized-meta payload, ready for {@link deserializeBinaryMeta}. */
  payload: Uint8Array;
}

/**
 * Parse a framed snapshot slot. Returns null when the slot is empty, too small,
 * lacks the magic, or fails its CRC — i.e. it is unusable but not fatal on its
 * own (the other slot or a fallback may still be valid).
 *
 * Issue #54: the CRC is validated over the on-disk bytes FIRST (torn-tail), then
 * — when `sealer` is provided — the payload is AEAD-opened (role
 * {@link AAD_ROLE_SNAPSHOT}, identity = `sequence`) to recover the plaintext meta
 * payload. An `open` failure (tamper / wrong key) returns null, matching the
 * "unusable but not fatal" contract so the other A/B slot can still be tried.
 */
export function parseMetaSnapshot(bytes: Uint8Array, sealer?: RecordCodec): ParsedMetaSnapshot | null {
  if (bytes.length < SNAPSHOT_HEADER_SIZE) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== SNAPSHOT_MAGIC) return null;
  const sequence = view.getUint32(4, true);
  const expectedCrc = view.getUint32(8, true);
  const payloadLen = view.getUint32(12, true);
  if (SNAPSHOT_HEADER_SIZE + payloadLen > bytes.length) return null;
  const onDisk = bytes.subarray(SNAPSHOT_HEADER_SIZE, SNAPSHOT_HEADER_SIZE + payloadLen);
  if (snapshotCrc32(onDisk) !== expectedCrc) return null;
  let plain: Uint8Array;
  try {
    plain = sealer ? sealer.open(onDisk, RecordRole.snapshot, sequence) : onDisk;
  } catch {
    return null;
  }
  if (plain.length < 16) return null;
  const extents = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
  const physicalDataSize = extents.getFloat64(0, true);
  const logicalExtent = extents.getFloat64(8, true);
  if (
    !Number.isSafeInteger(physicalDataSize) ||
    !Number.isSafeInteger(logicalExtent) ||
    physicalDataSize < 0 ||
    logicalExtent < 0
  )
    return null;
  return { sequence, payload: plain.subarray(16), physicalDataSize, logicalExtent };
}
