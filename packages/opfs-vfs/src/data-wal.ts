import { RecordRole, type RecordCodec } from './storage-contract';
import { VfsCorruptionError } from './fs-errors';

const WAL_FRAME_HEADER_BYTES = 8;
// Version 4 removes checkpoint frames. Checkpointing now truncates the WAL.
const WAL_VERSION = 4;

enum DataWalOpCode {
  Write = 1,
  Truncate = 2,
  Delete = 3,
}

export type DataWalRecord =
  | { version: number; op: 'write'; inodeId: number; path?: string; offset: number; data: Uint8Array }
  | { version: number; op: 'truncate'; inodeId: number; path?: string; size: number }
  | { version: number; op: 'delete'; inodeId: number; path?: string };

export type ReplayTarget = {
  applyWrite(inodeId: number, offset: number, data: Uint8Array, debugPath?: string): void;
  applyTruncate(inodeId: number, size: number, debugPath?: string): void;
  applyDelete(inodeId: number, debugPath?: string): void;
  /** Optional hook fired once when a record's application throws (INT-5 salvage). */
  onApplyError?(index: number, record: DataWalRecord, error: unknown): void;
};

export class DataWalCorruptionError extends VfsCorruptionError {
  constructor(message: string, offset: number) {
    super('data-wal', message, offset);
    this.name = 'DataWalCorruptionError';
  }
}

function encodeU32(value: number, view: DataView, at: number) {
  view.setUint32(at, value >>> 0, true);
}

function decodeU32(view: DataView, at: number): number {
  return view.getUint32(at, true);
}

function encodeU64(value: number, view: DataView, at: number) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DataWalCorruptionError(`Data WAL u64 value is not a safe unsigned integer: ${value}`, at);
  }
  view.setBigUint64(at, BigInt(value), true);
}

function decodeU64(view: DataView, at: number, frameOffset: number): number {
  const value = view.getBigUint64(at, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DataWalCorruptionError('Data WAL u64 value exceeds Number.MAX_SAFE_INTEGER', frameOffset);
  }
  return Number(value);
}

const CRC32_TABLE = (() => {
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

/**
 * Table-driven CRC32 (IEEE 802.3 / zlib polynomial). Exported so the meta log
 * and bitmap checksums (INT-9) share one implementation rather than duplicating
 * the table.
 */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * PERF-2: compute the encoded byte length of a record's payload up front (and
 * the path bytes, which the write path then reuses) so {@link encodeDataWalRecord}
 * can allocate ONE frame buffer and write the payload directly into it. This
 * eliminates the previous intermediate `payload` buffer and its full `.set`
 * copy into the frame — for large writes that copy was the file's data.
 */
function payloadSize(record: DataWalRecord, pathBytesLen: number): number {
  switch (record.op) {
    case 'write':
      return 1 + 1 + 4 + 4 + 8 + 4 + pathBytesLen + record.data.length;
    case 'truncate':
      return 1 + 1 + 4 + 4 + 8 + pathBytesLen;
    case 'delete':
      return 1 + 1 + 4 + 4 + pathBytesLen;
  }
}

/** Write a record's payload into `frame` starting at byte `base`. */
function writePayload(frame: Uint8Array, base: number, record: DataWalRecord, pathBytes: Uint8Array) {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  switch (record.op) {
    case 'write': {
      frame[base] = WAL_VERSION;
      frame[base + 1] = DataWalOpCode.Write;
      encodeU32(record.inodeId, view, base + 2);
      encodeU32(pathBytes.length, view, base + 6);
      encodeU64(record.offset, view, base + 10);
      encodeU32(record.data.length, view, base + 18);
      frame.set(pathBytes, base + 22);
      frame.set(record.data, base + 22 + pathBytes.length);
      return;
    }
    case 'truncate': {
      frame[base] = WAL_VERSION;
      frame[base + 1] = DataWalOpCode.Truncate;
      encodeU32(record.inodeId, view, base + 2);
      encodeU32(pathBytes.length, view, base + 6);
      encodeU64(record.size, view, base + 10);
      frame.set(pathBytes, base + 18);
      return;
    }
    case 'delete': {
      frame[base] = WAL_VERSION;
      frame[base + 1] = DataWalOpCode.Delete;
      encodeU32(record.inodeId, view, base + 2);
      encodeU32(pathBytes.length, view, base + 6);
      frame.set(pathBytes, base + 10);
      return;
    }
  }
}

/**
 * Encode one data-WAL frame.
 *
 * Issue #54: when `sealer` is provided the plaintext payload is AEAD-sealed
 * (role {@link AAD_ROLE_DATAWAL}, bound to `identity`) BEFORE framing, and the
 * frame's length + CRC32 cover the *sealed* bytes — so the torn-tail / CRC
 * salvage in {@link decodeDataWalRecords} still operates on the bytes actually
 * written to disk. `identity` pins the record's position in the AAD (the caller
 * passes the frame's intended WAL offset or a monotonic counter); it is only
 * consulted when `sealer` is present. With no `sealer`, behavior is byte-for-byte
 * identical to before (single-allocation, CRC over the in-place payload).
 */
export function encodeDataWalRecord(record: DataWalRecord, sealer?: RecordCodec, identity = 0): Uint8Array {
  // PERF-2: single-allocation encode. The path is encoded once; the frame holds
  // header + payload contiguously, the payload is written in place, and CRC is
  // computed over the payload subarray — no intermediate copies (the caller may
  // also pass `record.data` directly, avoiding a defensive slice).
  const pathBytes = textEncoder.encode(record.path ?? '');
  const plaintextLen = payloadSize(record, pathBytes.length);

  if (sealer) {
    // Build the plaintext payload in a standalone buffer, then seal it DIRECTLY
    // into the frame (L7 — the sealed length is deterministic, so the frame is
    // allocated at final size and the previous concat-buffer + frame copy are
    // gone). CRC is computed over the on-disk (sealed) payload.
    const plaintext = new Uint8Array(plaintextLen);
    writePayload(plaintext, 0, record, pathBytes);
    const sealedLen = plaintextLen + sealer.overheadBytes;
    const frame = new Uint8Array(WAL_FRAME_HEADER_BYTES + sealedLen);
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    sealer.sealInto(plaintext, RecordRole.dataWal, identity, frame, WAL_FRAME_HEADER_BYTES);
    encodeU32(sealedLen, view, 0);
    encodeU32(crc32(frame.subarray(WAL_FRAME_HEADER_BYTES)), view, 4);
    return frame;
  }

  const frame = new Uint8Array(WAL_FRAME_HEADER_BYTES + plaintextLen);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  writePayload(frame, WAL_FRAME_HEADER_BYTES, record, pathBytes);
  encodeU32(plaintextLen, view, 0);
  encodeU32(crc32(frame.subarray(WAL_FRAME_HEADER_BYTES)), view, 4);
  return frame;
}

// ── #54 review M1: per-cycle binding of sealed WAL frames ────────────────────
// The WAL is truncated to 0 at every checkpoint and the next cycle re-uses the
// same byte offsets, so an AAD identity of "frame offset" alone would let an
// attacker with OPFS write access splice an authentic frame captured from an
// EARLIER cycle back in at the same offset (CRC and AEAD both pass) — a
// selective rollback producing a state that never existed. Each encrypted WAL
// cycle therefore begins with a plaintext CYCLE STAMP carrying a fresh random
// 16-byte salt, and every frame in the cycle is sealed with the volume epoch
// XOR that salt (see {@link dataWalCycleEpoch}) — a frame from any other cycle
// fails authentication regardless of its offset. The stamp is self-validating
// (magic + version + CRC32). On an encrypted volume a non-empty WAL whose head
// is NOT a valid stamp is DISCARDED on mount (never decoded with the unsalted
// epoch), so an attacker cannot strip the stamp to force the frames through the
// legacy unsalted path — see OpfsVfs.replayDataWal. Whole-file rollback
// (restoring the stamp AND its frames together, alongside the rest of the
// volume's files) remains out of scope — see the threat model in
// docs/encryption.md.

/** `DWC1` — data-WAL cycle stamp magic. */
const WAL_CYCLE_STAMP_MAGIC = 0x44574331;
const WAL_CYCLE_STAMP_VERSION = 1;
/** Random per-cycle salt length (mixed into the AAD epoch). */
export const DATA_WAL_CYCLE_SALT_BYTES = 16;
/** On-disk stamp layout: u32 magic ‖ u32 version ‖ salt[16] ‖ u32 crc32(bytes 0..24). */
export const DATA_WAL_CYCLE_STAMP_BYTES = 4 + 4 + DATA_WAL_CYCLE_SALT_BYTES + 4;

/** Encode a cycle stamp for `cycleSalt` (written at byte 0 of a fresh WAL cycle). */
export function encodeDataWalCycleStamp(cycleSalt: Uint8Array): Uint8Array {
  if (cycleSalt.length !== DATA_WAL_CYCLE_SALT_BYTES) {
    throw new Error(`data WAL cycle salt must be ${DATA_WAL_CYCLE_SALT_BYTES} bytes, got ${cycleSalt.length}`);
  }
  const stamp = new Uint8Array(DATA_WAL_CYCLE_STAMP_BYTES);
  const view = new DataView(stamp.buffer);
  encodeU32(WAL_CYCLE_STAMP_MAGIC, view, 0);
  encodeU32(WAL_CYCLE_STAMP_VERSION, view, 4);
  stamp.set(cycleSalt, 8);
  encodeU32(crc32(stamp.subarray(0, DATA_WAL_CYCLE_STAMP_BYTES - 4)), view, DATA_WAL_CYCLE_STAMP_BYTES - 4);
  return stamp;
}

/**
 * Probe the head of a WAL for a cycle stamp. Returns the 16-byte cycle salt, or
 * `null` when the WAL carries no valid stamp (a plaintext volume, or a torn /
 * tampered / absent stamp on an encrypted one). On an encrypted volume the
 * caller DISCARDS a non-empty stampless WAL fail-closed, so a stripped or
 * tampered stamp can never make stale frames authenticate.
 */
export function decodeDataWalCycleStamp(logBytes: Uint8Array): Uint8Array | null {
  if (logBytes.length < DATA_WAL_CYCLE_STAMP_BYTES) return null;
  const view = new DataView(logBytes.buffer, logBytes.byteOffset, logBytes.byteLength);
  if (decodeU32(view, 0) !== WAL_CYCLE_STAMP_MAGIC) return null;
  if (decodeU32(view, 4) !== WAL_CYCLE_STAMP_VERSION) return null;
  const expectedCrc = decodeU32(view, DATA_WAL_CYCLE_STAMP_BYTES - 4);
  if (crc32(logBytes.subarray(0, DATA_WAL_CYCLE_STAMP_BYTES - 4)) !== expectedCrc) return null;
  return logBytes.slice(8, 8 + DATA_WAL_CYCLE_SALT_BYTES);
}

/**
 * Derive the AAD epoch for one WAL cycle: `volumeEpoch XOR cycleSalt`. Build the
 * cycle's {@link RecordCodec} over this instead of the raw epoch, so frames are
 * bound to (volume, key, cycle) — role and identity (frame offset) stay as
 * before. XOR keeps the epoch at its fixed 16-byte AAD slot; with a random salt
 * the mixed epoch never collides with the raw epoch or another cycle's.
 */

function decodeRecordPayload(payload: Uint8Array, offset: number): DataWalRecord {
  if (payload.length < 2) {
    throw new DataWalCorruptionError('Data WAL payload too small', offset);
  }
  const version = payload[0];
  if (version !== WAL_VERSION) {
    throw new DataWalCorruptionError(`Unsupported data WAL version: ${version}`, offset);
  }
  const op = payload[1];
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);

  if (op === DataWalOpCode.Write) {
    if (payload.length < 22) throw new DataWalCorruptionError('Data WAL write payload too small', offset);
    const inodeId = decodeU32(view, 2);
    const pathLen = decodeU32(view, 6);
    const writeOffset = decodeU64(view, 10, offset);
    const dataLen = decodeU32(view, 18);
    const expected = 22 + pathLen + dataLen;
    if (payload.length !== expected) {
      throw new DataWalCorruptionError('Data WAL write payload length mismatch', offset);
    }
    const path = textDecoder.decode(payload.subarray(22, 22 + pathLen));
    const data = payload.slice(22 + pathLen);
    return { version, op: 'write', inodeId, path: path || undefined, offset: writeOffset, data };
  }

  if (op === DataWalOpCode.Truncate) {
    if (payload.length < 18) throw new DataWalCorruptionError('Data WAL truncate payload too small', offset);
    const inodeId = decodeU32(view, 2);
    const pathLen = decodeU32(view, 6);
    const size = decodeU64(view, 10, offset);
    if (payload.length !== 18 + pathLen) {
      throw new DataWalCorruptionError('Data WAL truncate payload length mismatch', offset);
    }
    const path = textDecoder.decode(payload.subarray(18));
    return { version, op: 'truncate', inodeId, path: path || undefined, size };
  }

  if (op === DataWalOpCode.Delete) {
    if (payload.length < 10) throw new DataWalCorruptionError('Data WAL delete payload too small', offset);
    const inodeId = decodeU32(view, 2);
    const pathLen = decodeU32(view, 6);
    if (payload.length !== 10 + pathLen) {
      throw new DataWalCorruptionError('Data WAL delete payload length mismatch', offset);
    }
    const path = textDecoder.decode(payload.subarray(10));
    return { version, op: 'delete', inodeId, path: path || undefined };
  }

  throw new DataWalCorruptionError(`Unknown data WAL opcode: ${op}`, offset);
}

/**
 * Decode the data WAL frame stream.
 *
 * `parsedBytes` is the byte offset of the first frame boundary that is NOT part
 * of the returned records — i.e. the safe truncation point that keeps every
 * returned record durable. Three terminations are distinguished:
 *
 * - clean end: all bytes consumed (`parsedBytes === logBytes.length`,
 *   `hadPartialTail` false, `corruptionOffset` undefined).
 * - partial trailing record: a torn final frame whose payload is incomplete —
 *   tolerated and NOT corruption (`hadPartialTail` true). The torn tail is the
 *   normal crash-during-append window.
 * - corruption: a complete frame whose checksum or payload fails to validate
 *   (`corruptionOffset` set to that frame's boundary). Decoding STOPS there;
 *   frames after a corrupt frame are discarded even if they would individually
 *   checksum, because record ordering integrity is gone past that point.
 */
/**
 * Issue #54: when `sealer` is provided, each frame's payload is the AEAD-sealed
 * blob. The flow per frame becomes: validate the CRC over the on-disk (sealed)
 * payload FIRST (torn-tail / corruption detection, unchanged), then `sealer.open`
 * the payload (authenticity) before `decodeRecordPayload`. The AAD identity is
 * the frame's byte offset (`frameOffset`) — so the writer MUST encode each frame
 * with `encodeDataWalRecord(record, sealer, thatFramesWalOffset)`. An `open`
 * failure (tamper / wrong key) is treated exactly like a structural decode
 * failure: truncate at this frame's boundary, keep prior records. With no
 * `sealer`, behavior is byte-for-byte identical to before.
 *
 * `startOffset` (#54 review M1): byte offset of the first frame — non-zero when
 * the WAL begins with a cycle stamp (see {@link decodeDataWalCycleStamp}). All
 * returned offsets (`frameEnds`, `parsedBytes`, `corruptionOffset`) and the AAD
 * identities stay ABSOLUTE file offsets, matching what the writer sealed with.
 */
export function decodeDataWalRecords(
  logBytes: Uint8Array,
  sealer?: RecordCodec,
  startOffset = 0,
): {
  records: DataWalRecord[];
  /**
   * PERF-12: `frameEnds[i]` is the byte offset just past record `i`'s frame.
   * Lets the caller truncate at the last successfully applied frame.
   */
  frameEnds: number[];
  parsedBytes: number;
  hadPartialTail: boolean;
  corruptionOffset?: number;
} {
  const records: DataWalRecord[] = [];
  const frameEnds: number[] = [];
  let cursor = startOffset;

  while (cursor + WAL_FRAME_HEADER_BYTES <= logBytes.length) {
    const frameOffset = cursor;
    const header = new DataView(logBytes.buffer, logBytes.byteOffset + cursor, WAL_FRAME_HEADER_BYTES);
    const payloadLen = decodeU32(header, 0);
    const expectedChecksum = decodeU32(header, 4);
    cursor += WAL_FRAME_HEADER_BYTES;

    if (cursor + payloadLen > logBytes.length) {
      return { records, frameEnds, parsedBytes: frameOffset, hadPartialTail: true };
    }

    const onDiskPayload = logBytes.subarray(cursor, cursor + payloadLen);
    const actualChecksum = crc32(onDiskPayload);
    if (actualChecksum !== expectedChecksum) {
      return { records, frameEnds, parsedBytes: frameOffset, hadPartialTail: false, corruptionOffset: frameOffset };
    }

    // Issue #54: CRC validated over on-disk bytes (torn-tail) — now AEAD-open to
    // recover the plaintext payload. An open failure is corruption, not a torn
    // tail: stop at this frame's boundary, keep prior records.
    let payload: Uint8Array;
    if (sealer) {
      try {
        payload = sealer.open(onDiskPayload, RecordRole.dataWal, frameOffset);
      } catch {
        return { records, frameEnds, parsedBytes: frameOffset, hadPartialTail: false, corruptionOffset: frameOffset };
      }
    } else {
      payload = onDiskPayload;
    }

    let record: DataWalRecord;
    try {
      record = decodeRecordPayload(payload, frameOffset);
    } catch (error) {
      // A checksum-valid frame whose payload still fails structural decode is a
      // corrupt frame, not a torn tail: truncate at this boundary, keep prior.
      if (error instanceof DataWalCorruptionError) {
        return { records, frameEnds, parsedBytes: frameOffset, hadPartialTail: false, corruptionOffset: frameOffset };
      }
      throw error;
    }
    records.push(record);
    cursor += payloadLen;
    frameEnds.push(cursor);
  }

  const hadPartialTail = cursor !== logBytes.length;
  return { records, frameEnds, parsedBytes: cursor, hadPartialTail };
}

/**
 * Apply decoded records to the replay target.
 *
 * If applying a record throws, replay STOPS at that record and reports its
 * index in `failedIndex` (do NOT skip-and-continue: a later record may depend
 * on the failed one's effects, so the only consistent state is "everything
 * strictly before it"). The caller truncates the WAL at the failed record's
 * frame boundary. `failedIndex` is undefined when every record applied.
 */
export function replayDataWalRecords(target: ReplayTarget, records: DataWalRecord[]) {
  let failedIndex: number | undefined;
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    try {
      if (record.op === 'delete') {
        target.applyDelete(record.inodeId, record.path);
      } else if (record.op === 'truncate') {
        target.applyTruncate(record.inodeId, record.size, record.path);
      } else {
        target.applyWrite(record.inodeId, record.offset, record.data, record.path);
      }
    } catch (error) {
      failedIndex = i;
      target.onApplyError?.(i, record, error);
      break;
    }
  }

  return { replayedRecords: failedIndex ?? records.length, failedIndex };
}

export const DATA_WAL_VERSION = WAL_VERSION;
