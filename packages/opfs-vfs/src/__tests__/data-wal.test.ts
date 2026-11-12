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

  it('treats a checksum-failing final frame as a torn append instead of throwing (INT-5)', () => {
    const write = encodeDataWalRecord({
      version: DATA_WAL_VERSION,
      op: 'write',
      inodeId: 2,
      path: '/file.bin',
      offset: 0,
      data: new Uint8Array([1]),
    });
    const torn = write.slice();
    torn[torn.length - 1] ^= 0xff;

    // The only frame: nothing valid follows it, so nothing durable is lost.
    const only = decodeDataWalRecords(torn);
    expect(only.records).toHaveLength(0);
    expect(only.hadPartialTail).toBe(true);
    expect(only.corruptionOffset).toBeUndefined();
    expect(only.parsedBytes).toBe(0);

    // The last frame, with unreadable bytes after it: earlier frames are kept.
    const log = new Uint8Array(write.length + torn.length + 5);
    log.set(write, 0);
    log.set(torn, write.length);
    log.set([9, 9, 9, 9, 9], write.length + torn.length);
    const last = decodeDataWalRecords(log);
    expect(last.records).toHaveLength(1);
    expect(last.hadPartialTail).toBe(true);
    expect(last.corruptionOffset).toBeUndefined();
    expect(last.parsedBytes).toBe(write.length);
  });

  it('reports a checksum failure as corruption when a valid frame follows it', () => {
    const write = encodeDataWalRecord({
      version: DATA_WAL_VERSION,
      op: 'write',
      inodeId: 2,
      path: '/file.bin',
      offset: 0,
      data: new Uint8Array([1]),
    });
    const corrupt = write.slice();
    corrupt[corrupt.length - 1] ^= 0xff;
    // Two failing frames in a row, then a valid one: the first is still corruption.
    const log = new Uint8Array(write.length * 3);
    log.set(corrupt, 0);
    log.set(corrupt, write.length);
    log.set(write, write.length * 2);

    const decoded = decodeDataWalRecords(log);
    expect(decoded.records).toHaveLength(0);
    expect(decoded.hadPartialTail).toBe(false);
    expect(decoded.corruptionOffset).toBe(0);
    expect(decoded.parsedBytes).toBe(0);
  });

  it('reports corruption when the length field of an early frame is damaged and valid frames follow', () => {
    const frames = [0, 1, 2].map((i) =>
      encodeDataWalRecord({
        version: DATA_WAL_VERSION,
        op: 'write',
        inodeId: 2 + i,
        path: `/file${i}.bin`,
        offset: 0,
        data: new Uint8Array([i, i, i]),
      }),
    );
    const log = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
    let at = 0;
    for (const frame of frames) {
      log.set(frame, at);
      at += frame.length;
    }
    // Length one short: still fits in the file, but the walk from it is misaligned.
    const view = new DataView(log.buffer);
    view.setUint32(0, view.getUint32(0, true) - 1, true);

    const decoded = decodeDataWalRecords(log);
    expect(decoded.records).toHaveLength(0);
    expect(decoded.hadPartialTail).toBe(false);
    expect(decoded.corruptionOffset).toBe(0);
  });

  it('reports corruption when a damaged length points past the end of the file and valid frames follow', () => {
    const frames = [0, 1].map((i) =>
      encodeDataWalRecord({
        version: DATA_WAL_VERSION,
        op: 'write',
        inodeId: 2 + i,
        path: `/file${i}.bin`,
        offset: 0,
        data: new Uint8Array([i]),
      }),
    );
    const log = new Uint8Array(frames[0].length + frames[1].length);
    log.set(frames[0], 0);
    log.set(frames[1], frames[0].length);
    new DataView(log.buffer).setUint32(0, log.length * 2, true);

    const decoded = decodeDataWalRecords(log);
    expect(decoded.records).toHaveLength(0);
    expect(decoded.hadPartialTail).toBe(false);
    expect(decoded.corruptionOffset).toBe(0);
  });

  it('classifies a torn multi-megabyte write as a torn append without scanning it expensively', () => {
    // Every aligned offset reads as a plausible 16 KiB length, which would cost a CRC each without the layout filter.
    const data = new Uint8Array(8 * 1024 * 1024);
    for (let i = 0; i < data.length; i += 4) data[i + 1] = 0x40;
    const frame = encodeDataWalRecord({
      version: DATA_WAL_VERSION,
      op: 'write',
      inodeId: 2,
      path: '/big.bin',
      offset: 0,
      data,
    });
    const torn = frame.subarray(0, frame.length - 1000);

    const started = performance.now();
    const decoded = decodeDataWalRecords(torn);
    const elapsed = performance.now() - started;
    expect(decoded.records).toHaveLength(0);
    expect(decoded.hadPartialTail).toBe(true);
    expect(decoded.corruptionOffset).toBeUndefined();
    expect(elapsed).toBeLessThan(1000);
  });

  it('reports corruption for a sealed log whose early frame length is damaged and a valid sealed frame follows', () => {
    // Stand-in codec: the payload followed by a tag derived from the frame's identity.
    const sealer = {
      overheadBytes: 4,
      seal(plaintext: Uint8Array, _role: number, identity: number) {
        const out = new Uint8Array(plaintext.length + 4);
        out.set(plaintext, 0);
        out.fill(identity & 0xff, plaintext.length);
        return out;
      },
      sealInto(plaintext: Uint8Array, role: number, identity: number, out: Uint8Array, outOffset: number) {
        const sealed = sealer.seal(plaintext, role, identity);
        out.set(sealed, outOffset);
        return sealed.length;
      },
      open(sealed: Uint8Array, _role: number, identity: number) {
        const body = sealed.subarray(0, sealed.length - 4);
        if (sealed.subarray(body.length).some((byte) => byte !== (identity & 0xff))) throw new Error('bad tag');
        return body;
      },
    };
    const frames: Uint8Array[] = [];
    let at = 0;
    for (let i = 0; i < 3; i++) {
      const frame = encodeDataWalRecord(
        {
          version: DATA_WAL_VERSION,
          op: 'write',
          inodeId: 2 + i,
          path: `/f${i}`,
          offset: 0,
          data: new Uint8Array([i]),
        },
        sealer,
        at,
      );
      frames.push(frame);
      at += frame.length;
    }
    const log = new Uint8Array(at);
    at = 0;
    for (const frame of frames) {
      log.set(frame, at);
      at += frame.length;
    }
    expect(decodeDataWalRecords(log, sealer).records).toHaveLength(3);

    const view = new DataView(log.buffer);
    view.setUint32(0, view.getUint32(0, true) - 1, true);
    const decoded = decodeDataWalRecords(log, sealer);
    expect(decoded.records).toHaveLength(0);
    expect(decoded.hadPartialTail).toBe(false);
    expect(decoded.corruptionOffset).toBe(0);
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

  it('treats an all-zero tail as a torn append, not corruption', () => {
    const write = encodeDataWalRecord({
      version: DATA_WAL_VERSION,
      op: 'write',
      inodeId: 2,
      path: '/file.bin',
      offset: 0,
      data: new Uint8Array([1]),
    });
    for (const zeros of [FRAME_HEADER_BYTES, 64]) {
      const log = new Uint8Array(write.length + zeros);
      log.set(write, 0);

      const decoded = decodeDataWalRecords(log);
      expect(decoded.records).toHaveLength(1);
      expect(decoded.hadPartialTail).toBe(true);
      expect(decoded.corruptionOffset).toBeUndefined();
      expect(decoded.parsedBytes).toBe(write.length);
    }
  });

  it('still reports corruption when bytes follow an all-zero frame header', () => {
    const write = encodeDataWalRecord({
      version: DATA_WAL_VERSION,
      op: 'write',
      inodeId: 2,
      path: '/file.bin',
      offset: 0,
      data: new Uint8Array([1]),
    });
    const log = new Uint8Array(FRAME_HEADER_BYTES + write.length);
    log.set(write, FRAME_HEADER_BYTES);

    const decoded = decodeDataWalRecords(log);
    expect(decoded.records).toHaveLength(0);
    expect(decoded.hadPartialTail).toBe(false);
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
