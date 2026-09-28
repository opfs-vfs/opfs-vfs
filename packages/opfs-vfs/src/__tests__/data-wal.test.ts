import { describe, expect, it } from 'vitest';

import { DATA_WAL_VERSION, decodeDataWalRecords, encodeDataWalRecord, replayDataWalRecords } from '../data-wal';

const FRAME_HEADER_BYTES = 8;
const WRITE_OFFSET_PAYLOAD_OFFSET = 10;

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

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function rewriteFrameChecksum(frame: Uint8Array) {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const payloadLen = view.getUint32(0, true);
  const payload = frame.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + payloadLen);
  view.setUint32(4, crc32(payload), true);
}

function makeTarget() {
  const writes: Array<{ inodeId: number; offset: number; data: Uint8Array; debugPath?: string }> = [];
  const truncates: Array<{ inodeId: number; size: number; debugPath?: string }> = [];
  const deletes: Array<{ inodeId: number; debugPath?: string }> = [];
  return {
    target: {
      applyWrite: (inodeId: number, offset: number, data: Uint8Array, debugPath?: string) =>
        writes.push({ inodeId, offset, data, debugPath }),
      applyTruncate: (inodeId: number, size: number, debugPath?: string) =>
        truncates.push({ inodeId, size, debugPath }),
      applyDelete: (inodeId: number, debugPath?: string) => deletes.push({ inodeId, debugPath }),
    },
    writes,
    truncates,
    deletes,
  };
}

describe('data WAL codec', () => {
  it('encodes and decodes records with versioned framing', () => {
    const write = encodeDataWalRecord({
      version: DATA_WAL_VERSION,
      op: 'write',
      inodeId: 2,
      path: '/file.bin',
      offset: 2,
      data: new Uint8Array([1, 2, 3]),
    });
    const truncate = encodeDataWalRecord({
      version: DATA_WAL_VERSION,
      op: 'truncate',
      inodeId: 2,
      path: '/file.bin',
      size: 1,
    });
    const log = new Uint8Array(write.length + truncate.length);
    log.set(write, 0);
    log.set(truncate, write.length);

    const decoded = decodeDataWalRecords(log);
    expect(decoded.hadPartialTail).toBe(false);
    expect(decoded.records.map((record) => record.op)).toEqual(['write', 'truncate']);
    expect(decoded.records[0]).toMatchObject({
      version: DATA_WAL_VERSION,
      op: 'write',
      inodeId: 2,
      path: '/file.bin',
      offset: 2,
    });
    // PERF-12: frameEnds give each record's frame end so callers need not
    // re-encode to find offsets. They must equal the cumulative encoded sizes.
    expect(decoded.frameEnds).toEqual([write.length, write.length + truncate.length]);
    expect(decoded.frameEnds[decoded.frameEnds.length - 1]).toBe(decoded.parsedBytes);
  });

  it('encodes and decodes write offsets larger than u32', () => {
    const offset = 2 ** 32 + 123;
    const write = encodeDataWalRecord({
      version: DATA_WAL_VERSION,
      op: 'write',
      inodeId: 2,
      path: '/large.bin',
      offset,
      data: new Uint8Array([1]),
    });

    const decoded = decodeDataWalRecords(write);
    expect(decoded.records[0]).toMatchObject({ op: 'write', inodeId: 2, path: '/large.bin', offset });
  });

  it('encodes and decodes truncate sizes larger than u32', () => {
    const size = 2 ** 32 + 456;
    const truncate = encodeDataWalRecord({
      version: DATA_WAL_VERSION,
      op: 'truncate',
      inodeId: 2,
      path: '/large.bin',
      size,
    });

    const decoded = decodeDataWalRecords(truncate);
    expect(decoded.records[0]).toMatchObject({ op: 'truncate', inodeId: 2, path: '/large.bin', size });
  });

  it('stops safely at partial trailing records', () => {
    const write = encodeDataWalRecord({
      version: DATA_WAL_VERSION,
      op: 'write',
      inodeId: 2,
      path: '/file.bin',
      offset: 0,
      data: new Uint8Array([7, 8]),
    });
    const truncated = write.subarray(0, write.length - 1);

    const decoded = decodeDataWalRecords(truncated);
    expect(decoded.records).toHaveLength(0);
    expect(decoded.hadPartialTail).toBe(true);
  });

  it('reports a corruption offset for checksum failures instead of throwing (INT-5)', () => {
    const write = encodeDataWalRecord({
      version: DATA_WAL_VERSION,
      op: 'write',
      inodeId: 2,
      path: '/file.bin',
      offset: 0,
      data: new Uint8Array([1]),
    });
    write[write.length - 1] ^= 0xff;

    const decoded = decodeDataWalRecords(write);
    expect(decoded.records).toHaveLength(0);
    expect(decoded.hadPartialTail).toBe(false);
    expect(decoded.corruptionOffset).toBe(0);
    expect(decoded.parsedBytes).toBe(0);
  });

  it('reports a corruption offset for structurally invalid payloads (INT-5)', () => {
    // u64 above the safe-integer range still checksums but fails payload decode.
    const write = encodeDataWalRecord({
      version: DATA_WAL_VERSION,
      op: 'write',
      inodeId: 2,
      path: '/file.bin',
      offset: 0,
      data: new Uint8Array([1]),
    });
    const view = new DataView(write.buffer, write.byteOffset, write.byteLength);
    view.setBigUint64(FRAME_HEADER_BYTES + WRITE_OFFSET_PAYLOAD_OFFSET, BigInt(Number.MAX_SAFE_INTEGER) + 1n, true);
    rewriteFrameChecksum(write);

    const decoded = decodeDataWalRecords(write);
    expect(decoded.records).toHaveLength(0);
    expect(decoded.corruptionOffset).toBe(0);
  });

  it('keeps frames before a mid-WAL corruption and discards the corrupt frame and everything after (INT-5)', () => {
    const first = encodeDataWalRecord({
      version: DATA_WAL_VERSION,
      op: 'write',
      inodeId: 2,
      path: '/a.bin',
      offset: 0,
      data: new Uint8Array([1, 2, 3]),
    });
    const second = encodeDataWalRecord({
      version: DATA_WAL_VERSION,
      op: 'write',
      inodeId: 2,
      path: '/a.bin',
      offset: 3,
      data: new Uint8Array([4, 5, 6]),
    });
    const third = encodeDataWalRecord({
      version: DATA_WAL_VERSION,
      op: 'write',
      inodeId: 2,
      path: '/a.bin',
      offset: 6,
      data: new Uint8Array([7, 8, 9]),
    });

    const log = new Uint8Array(first.length + second.length + third.length);
    log.set(first, 0);
    log.set(second, first.length);
    log.set(third, first.length + second.length);
    // Corrupt the payload of frame #2 (a still-valid frame #3 follows it).
    log[first.length + FRAME_HEADER_BYTES] ^= 0xff;

    const decoded = decodeDataWalRecords(log);
    expect(decoded.records).toHaveLength(1);
    expect(decoded.records[0]).toMatchObject({ op: 'write', offset: 0 });
    expect(decoded.corruptionOffset).toBe(first.length);
    // parsedBytes is the safe truncation point — exactly the first frame's end.
    expect(decoded.parsedBytes).toBe(first.length);
  });

  it('stops replay at a record whose application throws and reports failedIndex (INT-5)', () => {
    const { target, writes, truncates } = makeTarget();
    const records = [
      {
        version: DATA_WAL_VERSION,
        op: 'write' as const,
        inodeId: 2,
        path: '/a.bin',
        offset: 0,
        data: new Uint8Array([1]),
      },
      { version: DATA_WAL_VERSION, op: 'truncate' as const, inodeId: 2, path: '/a.bin', size: 99 },
      {
        version: DATA_WAL_VERSION,
        op: 'write' as const,
        inodeId: 2,
        path: '/a.bin',
        offset: 1,
        data: new Uint8Array([2]),
      },
    ];
    // Throw when applying the truncate (record index 1).
    target.applyTruncate = () => {
      throw new RangeError('poison');
    };

    const result = replayDataWalRecords(target, records);
    expect(result.failedIndex).toBe(1);
    expect(result.replayedRecords).toBe(1);
    // The write after the poison record must NOT be applied (stop, not skip).
    expect(writes).toHaveLength(1);
    expect(truncates).toHaveLength(0);
  });

  it('replays writes, truncates, and deletes in order', () => {
    const events: Array<[string, number, number?]> = [];

    const records = [
      {
        version: DATA_WAL_VERSION,
        op: 'write' as const,
        inodeId: 2,
        path: '/file.bin',
        offset: 0,
        data: new Uint8Array([1, 2, 3, 4]),
      },
      {
        version: DATA_WAL_VERSION,
        op: 'write' as const,
        inodeId: 2,
        path: '/file.bin',
        offset: 2 ** 32 + 4096,
        data: new Uint8Array([9, 9]),
      },
      { version: DATA_WAL_VERSION, op: 'truncate' as const, inodeId: 2, path: '/file.bin', size: 2 },
      {
        version: DATA_WAL_VERSION,
        op: 'write' as const,
        inodeId: 2,
        path: '/file.bin',
        offset: 1,
        data: new Uint8Array([5]),
      },
      { version: DATA_WAL_VERSION, op: 'delete' as const, inodeId: 3, path: '/other.bin' },
    ];

    const replayed = replayDataWalRecords(
      {
        applyWrite: (inodeId, offset) => events.push(['write', inodeId, offset]),
        applyTruncate: (inodeId, size) => events.push(['truncate', inodeId, size]),
        applyDelete: (inodeId) => events.push(['delete', inodeId]),
      },
      records,
    );
    expect(replayed.replayedRecords).toBe(5);

    expect(events).toEqual([
      ['write', 2, 0],
      ['write', 2, 2 ** 32 + 4096],
      ['truncate', 2, 2],
      ['write', 2, 1],
      ['delete', 3],
    ]);
  });

  it('rejects the removed checkpoint opcode', () => {
    const frame = encodeDataWalRecord({ version: DATA_WAL_VERSION, op: 'delete', inodeId: 2 });
    frame[FRAME_HEADER_BYTES + 1] = 4;
    rewriteFrameChecksum(frame);

    expect(decodeDataWalRecords(frame).corruptionOffset).toBe(0);
  });
});
