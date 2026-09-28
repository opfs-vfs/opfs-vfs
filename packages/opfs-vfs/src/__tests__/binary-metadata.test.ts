import { describe, expect, it } from 'vitest';
import {
  CURRENT_BINARY_VERSION,
  deserializeBinaryMeta,
  frameMetaSnapshot,
  parseMetaSnapshot,
  replayLog,
  serializeLogAttrRecord,
  serializeLogRecord,
  serializeLogTransaction,
  serializeMeta,
} from '../binary-metadata';
import { VfsCorruptionError } from '../fs-errors';
import { crc32 } from '../data-wal';
import type { RecordCodec } from '../storage-contract';
import type { Inode } from '../opfs-vfs';

const testCodec: RecordCodec = {
  overheadBytes: 1,
  seal(plain) {
    const out = new Uint8Array(plain.length + 1);
    for (let i = 0; i < plain.length; i++) out[i] = plain[i] ^ 0xa5;
    out[plain.length] = plain.reduce((sum, byte) => (sum + byte) & 255, 0);
    return out;
  },
  sealInto(plain, role, identity, out, offset) {
    const sealed = this.seal(plain, role, identity);
    out.set(sealed, offset);
    return sealed.length;
  },
  open(sealed) {
    const plain = Uint8Array.from(sealed.subarray(0, -1), (byte) => byte ^ 0xa5);
    if (plain.reduce((sum, byte) => (sum + byte) & 255, 0) !== sealed[sealed.length - 1]) {
      throw new Error('bad tag');
    }
    return plain;
  },
};

let nextTestInode = 1;

function makeInode(overrides: Partial<Inode> = {}): Inode {
  return {
    ino: nextTestInode++,
    isDir: false,
    size: 0,
    blocks: [],
    children: [],
    mode: 33188,
    nlink: 1,
    atimeMs: 1712345677000,
    mtimeMs: 1712345678000,
    ctimeMs: 1712345679000,
    timestampMs: 1712345678000,
    ...overrides,
  };
}

function toArrayBuffer(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function rewriteLogRecordFlags(record: Uint8Array, flags: number) {
  const patched = record.slice();
  const view = new DataView(patched.buffer, patched.byteOffset, patched.byteLength);
  const pathLength = view.getUint32(4, true);
  view.setUint32(12 + pathLength, flags, true);
  return patched;
}

describe('binary-metadata codec', () => {
  it('reports a replay boundary and the newest committed extent', () => {
    const record = serializeLogRecord('/file', makeInode());
    const empty = serializeLogTransaction([], 1, undefined, 7, 4096, 4096);
    const good = serializeLogTransaction([record], empty.length + 1, undefined, 7, 8192, 8192);
    const bad = good.slice();
    bad[bad.length - 1] ^= 1;
    const log = new Uint8Array(empty.length + good.length + bad.length);
    log.set(empty);
    log.set(good, empty.length);
    log.set(bad, empty.length + good.length);
    const inodes = new Map<string, Inode>();
    expect(replayLog(log.buffer, inodes, [], 16, 7)).toMatchObject({
      count: 1,
      validEnd: empty.length + good.length,
      physicalDataSize: 8192,
      logicalExtent: 8192,
    });
    expect(inodes.has('/file')).toBe(true);
  });

  it('round-trips a file whose block list exceeds the argument-spread limit', () => {
    const inodes = new Map<string, Inode>();
    inodes.set('/', makeInode({ isDir: true, children: ['big'] }));
    const blocks = Array.from({ length: 200_000 }, (_, i) => i + 1);
    inodes.set('/big', makeInode({ size: blocks.length * 4096, blocks }));
    const result = deserializeBinaryMeta(serializeMeta(inodes, 262_144, 4096));
    expect(result.inodes.get('/big')!.blocks).toEqual(blocks);
  });

  it.each([false, true])('round-trips raw and extent block lists in snapshots and logs (sealed=%s)', (sealed) => {
    const sealer = sealed ? testCodec : undefined;
    const cases = [
      [],
      [7],
      [1, 2, 3, 4, 5, 6, 7, 8],
      [1, 3, 5, 7, 9, 11, 13, 15],
      [1, 2, 3, 4, 10, 11, 12, 13, 20, 22],
      [0, 0, 7, 0, 0, 0, 8, 0],
      Array.from({ length: 262_144 }, (_, i) => i + 1),
    ];
    for (const blocks of cases) {
      const inode = makeInode({ blocks, size: blocks.length * 4096 });
      const inodes = new Map<string, Inode>([
        ['/', makeInode({ isDir: true })],
        ['/f', inode],
      ]);
      const snapshot = serializeMeta(inodes, 262_145, 4096);
      expect(deserializeBinaryMeta(snapshot).inodes.get('/f')!.blocks).toEqual(blocks);

      const record = serializeLogRecord('/f', inode);
      const replayed = new Map<string, Inode>();
      const physicalDataSize = 262_145 * 4096;
      const batch = serializeLogTransaction([record], 1, sealer, 7, physicalDataSize, physicalDataSize);
      expect(replayLog(toArrayBuffer(batch), replayed, [], 262_145, 7, sealer)).toEqual({
        count: 1,
        validEnd: batch.byteLength,
        physicalDataSize,
        logicalExtent: physicalDataSize,
      });
      expect(replayed.get('/f')!.blocks).toEqual(blocks);
      if (blocks.length === 262_144) {
        expect(record.byteLength).toBeLessThan(100);
        expect(snapshot.byteLength).toBeLessThan(200);
      }
      if (blocks.length === 8 && blocks[1] === 3) {
        expect(record.byteLength).toBe(12 + 2 + 36 + blocks.length * 4);
        expect(snapshot.byteLength).toBe(40 + 2 * 48 + blocks.length * 4 + 16 + 1);
      }
    }
  });

  it('rejects malformed extents in snapshots and committed logs', () => {
    const blocks = [1, 2, 3, 4, 5, 6, 7, 8];
    const root = makeInode({ isDir: true });
    const inode = makeInode({ blocks, size: blocks.length * 4096 });
    const inodes = new Map<string, Inode>([
      ['/', root],
      ['/f', inode],
    ]);
    const corruptions = [
      { name: 'zero length', word: 2, value: 0 },
      { name: 'past volume', word: 1, value: 262_140 },
      { name: 'overflow', word: 1, value: 0xfffffffe },
      { name: 'truncated list', word: 0, value: 2 },
    ];
    for (const { name, word, value } of corruptions) {
      const snapshot = serializeMeta(inodes, 262_144, 4096);
      const snapshotView = new DataView(snapshot);
      const fileRecordOffset = 40 + 48;
      const blockListOffset = snapshotView.getUint32(fileRecordOffset + 16, true);
      snapshotView.setUint32(blockListOffset + word * 4, value, true);
      expect(() => deserializeBinaryMeta(snapshot), name).toThrow(/Corrupted binary metadata/);

      const record = serializeLogRecord('/f', inode);
      const recordView = new DataView(record.buffer);
      const listOffset = 12 + 2 + 12;
      recordView.setUint32(listOffset + word * 4, value, true);
      const replayed = new Map<string, Inode>();
      // Give the overflow fixture a valid start within the full u32 address space.
      const logTotalBlocks = name === 'overflow' ? 0x1_0000_0000 : 262_144;
      expect(
        replayLog(toArrayBuffer(serializeLogTransaction([record], 1)), replayed, [], logTotalBlocks).count,
        name,
      ).toBe(0);
    }
  });

  it('packs a run of hole blocks into one extent in snapshots and logs', () => {
    const inode = makeInode({ blocks: new Array(16).fill(0), size: 16 * 4096 });
    const inodes = new Map<string, Inode>([
      ['/', makeInode({ isDir: true })],
      ['/f', inode],
    ]);
    const snapshot = serializeMeta(inodes, 32, 4096);
    expect(snapshot.byteLength).toBeLessThan(200);
    expect(deserializeBinaryMeta(snapshot).inodes.get('/f')!.blocks).toEqual(inode.blocks);
    const record = serializeLogRecord('/f', inode);
    expect(record.byteLength).toBeLessThan(100);
    const replayed = new Map<string, Inode>();
    expect(replayLog(toArrayBuffer(serializeLogTransaction([record], 1)), replayed, [], 32).count).toBe(1);
    expect(replayed.get('/f')!.blocks).toEqual(inode.blocks);
  });

  it.each([false, true])('bounds raw blocks and extents during log replay (sealed=%s)', (sealed) => {
    const sealer = sealed ? testCodec : undefined;
    for (const blocks of [[16], [9, 10, 11, 12, 13, 14, 15, 16]]) {
      const batch = serializeLogTransaction(
        [
          serializeLogRecord('/stable', null),
          serializeLogRecord('/f', makeInode({ blocks, size: blocks.length * 4096 })),
        ],
        1,
        sealer,
      );
      for (const totalBlocks of [16, 17]) {
        const stable = makeInode();
        const inodes = new Map<string, Inode>([['/stable', stable]]);
        const paths = ['/stable'];
        const valid = totalBlocks === 17;
        expect(replayLog(toArrayBuffer(batch), inodes, paths, totalBlocks, 0, sealer)).toMatchObject({
          count: valid ? 2 : 0,
          validEnd: valid ? batch.byteLength : 0,
        });
        expect(inodes.get('/stable')).toBe(valid ? undefined : stable);
        expect(inodes.get('/f')?.blocks).toEqual(valid ? blocks : undefined);
        expect(paths).toEqual(valid ? ['/f'] : ['/stable']);
      }
    }
  });

  it.each([false, true])('rejects extents consuming the inode tail (sealed=%s)', (sealed) => {
    const record = serializeLogRecord(
      '/f',
      makeInode({
        ino: 4,
        nlink: 0,
        size: 8 * 4096,
        blocks: [1, 2, 3, 4, 5, 6, 7, 8],
      }),
    );
    const view = new DataView(record.buffer);
    const listOffset = 12 + 2 + 12;
    view.setUint32(listOffset, 2, true); // two runs instead of one
    view.setUint32(listOffset + 8, 4, true); // first run: [1, 4]
    view.setUint32(listOffset + 12, 9, true); // auxCount + ino become run [9, 4]
    const sealer = sealed ? testCodec : undefined;
    const stable = makeInode();
    const inodes = new Map<string, Inode>([['/stable', stable]]);
    const paths = ['/stable'];
    const batch = serializeLogTransaction([serializeLogRecord('/stable', null), record], 1, sealer);
    expect(replayLog(toArrayBuffer(batch), inodes, paths, 32, 0, sealer)).toMatchObject({ count: 0, validEnd: 0 });
    expect(inodes.get('/stable')).toBe(stable);
    expect(paths).toEqual(['/stable']);
  });

  it.each([false, true])('requires exact log payload lengths (sealed=%s)', (sealed) => {
    const sealer = sealed ? testCodec : undefined;
    const symlink = serializeLogRecord('/f', makeInode({ kind: 'symlink', mode: 0o120777, symlinkTarget: 'café' }));
    const records = [
      serializeLogRecord('/f', makeInode()),
      symlink,
      serializeLogAttrRecord('/f', makeInode()),
      serializeLogRecord('/f', null),
    ];
    const malformed: Uint8Array[] = [];
    for (const original of records) {
      const inodes = new Map<string, Inode>();
      const batch = serializeLogTransaction([original], 1, sealer);
      expect(replayLog(toArrayBuffer(batch), inodes, [], 32, 0, sealer)).toMatchObject({
        count: 1,
        validEnd: batch.byteLength,
      });
      if (original === symlink) expect(inodes.get('/f')!.symlinkTarget).toBe('café');
      const payloadSize = new DataView(original.buffer).getUint32(8, true);
      for (const delta of [-1, 1]) {
        if (payloadSize + delta < 0) continue;
        const record = new Uint8Array(original.length + delta);
        record.set(original.subarray(0, record.length));
        new DataView(record.buffer).setUint32(8, payloadSize + delta, true);
        malformed.push(record);
      }
    }
    const badAux = symlink.slice();
    new DataView(badAux.buffer).setUint32(12 + 2 + 12, 0xffffffff, true);
    malformed.push(badAux);
    for (const record of malformed) {
      const stable = makeInode();
      const inodes = new Map<string, Inode>([['/stable', stable]]);
      const paths = ['/stable'];
      const batch = serializeLogTransaction([serializeLogRecord('/stable', null), record], 1, sealer);
      expect(replayLog(toArrayBuffer(batch), inodes, paths, 32, 0, sealer)).toMatchObject({ count: 0, validEnd: 0 });
      expect(inodes.get('/stable')).toBe(stable);
      expect(inodes.has('/f')).toBe(false);
      expect(paths).toEqual(['/stable']);
    }
  });

  it('loads a directory tree deeper than the call stack', () => {
    const inodes = new Map<string, Inode>();
    inodes.set('/', makeInode({ isDir: true, children: ['d'] }));
    let path = '';
    for (let depth = 0; depth < 20_000; depth++) {
      path += '/d';
      inodes.set(path, makeInode({ isDir: true, children: depth < 19_999 ? ['d'] : [] }));
    }
    expect(deserializeBinaryMeta(serializeMeta(inodes, 16, 4096)).inodes.size).toBe(20_001);
  });

  it('rejects snapshots naming blocks outside the volume', () => {
    for (const block of [16]) {
      const inodes = new Map<string, Inode>();
      inodes.set('/', makeInode({ isDir: true, children: ['f'] }));
      inodes.set('/f', makeInode({ size: 4096, blocks: [block] }));
      expect(() => deserializeBinaryMeta(serializeMeta(inodes, 16, 4096))).toThrow(/outside the volume/);
    }
  });

  it('round-trips an empty filesystem (root only)', () => {
    const inodes = new Map<string, Inode>();
    inodes.set('/', makeInode({ isDir: true }));

    const buf = serializeMeta(inodes, 1024, 4096);
    const result = deserializeBinaryMeta(buf);

    expect(result.totalBlocks).toBe(1024);
    expect(result.blockSize).toBe(4096);
    expect(result.inodes.size).toBe(1);
    const root = result.inodes.get('/');
    expect(root).toBeDefined();
    expect(root!.isDir).toBe(true);
    expect(root!.size).toBe(0);
    expect(root!.blocks).toEqual([]);
    expect(root!.children).toEqual([]);
  });

  it('round-trips files with block lists', () => {
    const inodes = new Map<string, Inode>();
    inodes.set('/', makeInode({ isDir: true, children: ['hello.txt', 'data.bin'] }));
    inodes.set('/hello.txt', makeInode({ size: 12000, blocks: [1, 2, 3] }));
    inodes.set('/data.bin', makeInode({ size: 65536, blocks: [10, 20, 30, 40, 50, 60, 70, 80] }));

    const buf = serializeMeta(inodes, 2048, 4096);
    const result = deserializeBinaryMeta(buf);

    expect(result.inodes.size).toBe(3);

    const hello = result.inodes.get('/hello.txt')!;
    expect(hello.size).toBe(12000);
    expect(hello.blocks).toEqual([1, 2, 3]);
    expect(hello.isDir).toBe(false);

    const data = result.inodes.get('/data.bin')!;
    expect(data.size).toBe(65536);
    expect(data.blocks).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);

    const root = result.inodes.get('/')!;
    expect(root.isDir).toBe(true);
    expect([...result.inodes.keys()].sort()).toEqual(['/', '/data.bin', '/hello.txt']);
  });

  it('round-trips a nested directory tree (PGlite-like)', () => {
    const inodes = new Map<string, Inode>();
    inodes.set('/', makeInode({ isDir: true, children: ['pgdata'] }));
    inodes.set('/pgdata', makeInode({ isDir: true, children: ['base', 'pg_wal', 'pg_xact'] }));
    inodes.set('/pgdata/base', makeInode({ isDir: true, children: ['16384'] }));
    inodes.set('/pgdata/base/16384', makeInode({ isDir: true, children: ['pg_class'] }));
    inodes.set('/pgdata/base/16384/pg_class', makeInode({ size: 8192, blocks: [100, 101] }));
    inodes.set('/pgdata/pg_wal', makeInode({ isDir: true, children: ['000000010000000000000001'] }));
    inodes.set('/pgdata/pg_wal/000000010000000000000001', makeInode({ size: 16777216, blocks: [200, 201, 202, 203] }));
    inodes.set('/pgdata/pg_xact', makeInode({ isDir: true, children: ['0000'] }));
    inodes.set('/pgdata/pg_xact/0000', makeInode({ size: 8192, blocks: [300] }));

    const buf = serializeMeta(inodes, 4096, 4096);
    const result = deserializeBinaryMeta(buf);

    expect(result.inodes.size).toBe(9);

    const pgdata = result.inodes.get('/pgdata')!;
    expect(pgdata.isDir).toBe(true);
    for (const child of ['base', 'pg_wal', 'pg_xact']) expect(result.inodes.has(`/pgdata/${child}`)).toBe(true);

    const base16384 = result.inodes.get('/pgdata/base/16384')!;
    expect(base16384.isDir).toBe(true);
    expect(result.inodes.has('/pgdata/base/16384/pg_class')).toBe(true);

    const walFile = result.inodes.get('/pgdata/pg_wal/000000010000000000000001')!;
    expect(walFile.size).toBe(16777216);
    expect(walFile.blocks).toEqual([200, 201, 202, 203]);
  });

  it('round-trips empty files (size=0, no blocks)', () => {
    const inodes = new Map<string, Inode>();
    inodes.set('/', makeInode({ isDir: true, children: ['empty1', 'empty2'] }));
    inodes.set('/empty1', makeInode({ size: 0, blocks: [] }));
    inodes.set('/empty2', makeInode({ size: 0, blocks: [] }));

    const buf = serializeMeta(inodes, 512, 4096);
    const result = deserializeBinaryMeta(buf);

    expect(result.inodes.size).toBe(3);
    const e1 = result.inodes.get('/empty1')!;
    expect(e1.size).toBe(0);
    expect(e1.blocks).toEqual([]);
    expect(e1.isDir).toBe(false);

    const e2 = result.inodes.get('/empty2')!;
    expect(e2.size).toBe(0);
    expect(e2.blocks).toEqual([]);
  });

  it('round-trips unicode paths (CJK, accented characters)', () => {
    const inodes = new Map<string, Inode>();
    inodes.set('/', makeInode({ isDir: true, children: ['\u6570\u636E', 'caf\u00E9'] }));
    inodes.set('/\u6570\u636E', makeInode({ isDir: true, children: ['\u6587\u4EF6.txt'] }));
    inodes.set('/\u6570\u636E/\u6587\u4EF6.txt', makeInode({ size: 100, blocks: [5] }));
    inodes.set('/caf\u00E9', makeInode({ size: 200, blocks: [6, 7] }));

    const buf = serializeMeta(inodes, 256, 4096);
    const result = deserializeBinaryMeta(buf);

    expect(result.inodes.size).toBe(4);
    expect(result.inodes.has('/\u6570\u636E')).toBe(true);
    expect(result.inodes.has('/\u6570\u636E/\u6587\u4EF6.txt')).toBe(true);
    expect(result.inodes.has('/caf\u00E9')).toBe(true);

    const file = result.inodes.get('/\u6570\u636E/\u6587\u4EF6.txt')!;
    expect(file.size).toBe(100);
    expect(file.blocks).toEqual([5]);

    const dir = result.inodes.get('/\u6570\u636E')!;
    expect(dir.isDir).toBe(true);
    expect(result.inodes.has('/\u6570\u636E/\u6587\u4EF6.txt')).toBe(true);
  });

  it('round-trips inode timestamps and link counts', () => {
    const inodes = new Map<string, Inode>();
    inodes.set(
      '/',
      makeInode({
        isDir: true,
        children: ['hello.txt'],
        atimeMs: 1712345678000,
        mtimeMs: 1712345679000,
        ctimeMs: 1712345680000,
        nlink: 1,
      }),
    );
    inodes.set(
      '/hello.txt',
      makeInode({
        size: 5,
        blocks: [7],
        atimeMs: 1712345681000,
        mtimeMs: 1712345689000,
        ctimeMs: 1712345699000,
        nlink: 3,
      }),
    );

    const buf = serializeMeta(inodes, 128, 4096);
    const result = deserializeBinaryMeta(buf);

    expect(result.inodes.get('/')!.atimeMs).toBe(1712345678000);
    expect(result.inodes.get('/')!.mtimeMs).toBe(1712345679000);
    expect(result.inodes.get('/')!.ctimeMs).toBe(1712345680000);
    expect(result.inodes.get('/hello.txt')!.atimeMs).toBe(1712345681000);
    expect(result.inodes.get('/hello.txt')!.mtimeMs).toBe(1712345689000);
    expect(result.inodes.get('/hello.txt')!.ctimeMs).toBe(1712345699000);
    expect(result.inodes.get('/hello.txt')!.nlink).toBe(3);
  });

  it('round-trips stable inode numbers', () => {
    const inodes = new Map<string, Inode>();
    inodes.set('/', makeInode({ ino: 1, isDir: true, children: ['hello.txt'] }));
    inodes.set('/hello.txt', makeInode({ ino: 99, size: 5, blocks: [7] }));

    const buf = serializeMeta(inodes, 128, 4096);
    const result = deserializeBinaryMeta(buf);

    expect(result.inodes.get('/')!.ino).toBe(1);
    expect(result.inodes.get('/hello.txt')!.ino).toBe(99);
    expect(result.nextInodeNumber).toBeGreaterThan(99);
  });

  it('round-trips symlink targets and kinds', () => {
    const inodes = new Map<string, Inode>();
    inodes.set('/', makeInode({ ino: 1, kind: 'dir', isDir: true, children: ['target.txt', 'link.txt'] }));
    inodes.set('/target.txt', makeInode({ ino: 2, kind: 'file', size: 5, blocks: [7] }));
    inodes.set(
      '/link.txt',
      makeInode({ ino: 3, kind: 'symlink', isDir: false, size: 11, symlinkTarget: './target.txt', mode: 0o120777 }),
    );

    const buf = serializeMeta(inodes, 128, 4096);
    const result = deserializeBinaryMeta(buf);

    expect(result.inodes.get('/link.txt')!.kind).toBe('symlink');
    expect(result.inodes.get('/link.txt')!.symlinkTarget).toBe('./target.txt');
    expect(result.inodes.get('/link.txt')!.mode).toBe(0o120777);
  });

  it('preserves shared inode identity across multiple paths', () => {
    const shared = makeInode({ ino: 42, size: 5, blocks: [7], nlink: 2 });
    const inodes = new Map<string, Inode>();
    inodes.set('/', makeInode({ ino: 1, kind: 'dir', isDir: true, children: ['a.txt', 'b.txt'] }));
    inodes.set('/a.txt', shared);
    inodes.set('/b.txt', shared);

    const buf = serializeMeta(inodes, 128, 4096);
    const result = deserializeBinaryMeta(buf);

    expect(result.inodes.get('/a.txt')).toBe(result.inodes.get('/b.txt'));
    expect(result.inodes.get('/a.txt')!.ino).toBe(42);
    expect(result.inodes.get('/a.txt')!.nlink).toBe(2);
  });

  it('heals stale presorted path snapshots during full metadata serialization', () => {
    const inodes = new Map<string, Inode>();
    inodes.set('/', makeInode({ ino: 1, kind: 'dir', isDir: true, children: ['hello.txt', 'nested'] }));
    inodes.set('/hello.txt', makeInode({ ino: 2, size: 5, blocks: [7] }));
    inodes.set('/nested', makeInode({ ino: 3, kind: 'dir', isDir: true, children: ['child.txt'] }));
    inodes.set('/nested/child.txt', makeInode({ ino: 4, size: 9, blocks: [8] }));

    const buf = serializeMeta(inodes, 128, 4096, ['/', '/ghost.txt', '/hello.txt', '/hello.txt']);
    const result = deserializeBinaryMeta(buf);

    expect(new Set(result.inodes.keys())).toEqual(new Set(['/', '/hello.txt', '/nested', '/nested/child.txt']));
    expect(result.inodes.get('/hello.txt')!.ino).toBe(2);
    expect(result.inodes.get('/nested/child.txt')!.size).toBe(9);
  });

  it('reuses shared inode identity when replaying an alias update', () => {
    const shared = makeInode({ ino: 42, size: 3, blocks: [7], nlink: 2 });
    const inodes = new Map<string, Inode>();
    inodes.set('/', makeInode({ ino: 1, kind: 'dir', isDir: true, children: ['a.txt', 'b.txt'] }));
    inodes.set('/a.txt', shared);
    inodes.set('/b.txt', shared);
    const sortedPaths = ['/', '/a.txt', '/b.txt'];

    const batch = serializeLogTransaction(
      [
        serializeLogRecord(
          '/a.txt',
          makeInode({
            ino: 42,
            size: 4,
            blocks: [9],
            nlink: 2,
            atimeMs: 1712345682000,
            mtimeMs: 1712345683000,
            ctimeMs: 1712345684000,
          }),
        ),
      ],
      12,
    );

    expect(replayLog(toArrayBuffer(batch), inodes, sortedPaths, 128).count).toBe(1);
    expect(inodes.get('/a.txt')).toBe(inodes.get('/b.txt'));
    expect(inodes.get('/b.txt')!.size).toBe(4);
    expect(inodes.get('/b.txt')!.blocks).toEqual([9]);
    expect(inodes.get('/b.txt')!.mtimeMs).toBe(1712345683000);
  });

  it('throws on file size exceeding u32 max', () => {
    const inodes = new Map<string, Inode>();
    inodes.set('/', makeInode({ isDir: true, children: ['big'] }));
    inodes.set('/big', makeInode({ size: 0x1_0000_0000, blocks: [0] }));

    expect(() => serializeMeta(inodes, 1024, 4096)).toThrow(/exceeds u32 max/);
  });

  it('throws on corrupted/truncated buffer', () => {
    // Too small for header
    expect(() => deserializeBinaryMeta(new ArrayBuffer(4))).toThrow(/buffer too small/);

    // Wrong magic
    const wrongMagic = new ArrayBuffer(40);
    new DataView(wrongMagic).setUint32(0, 0xdeadbeef, true);
    expect(() => deserializeBinaryMeta(wrongMagic)).toThrow(/Invalid binary metadata magic/);

    // Legacy version is not supported
    const wrongVersion = new ArrayBuffer(40);
    const wvView = new DataView(wrongVersion);
    wvView.setUint32(0, 0x42564653, true);
    wvView.setUint32(4, 6, true);
    expect(() => deserializeBinaryMeta(wrongVersion)).toThrow(/Unsupported binary metadata version: 6/);

    // Wrong version
    wvView.setUint32(4, 99, true);
    expect(() => deserializeBinaryMeta(wrongVersion)).toThrow(/Unsupported binary metadata version/);

    // Header says 10 inodes but buffer is too small. Use the CURRENT binary
    // version so deserialize passes the version gate
    // and reaches the truncation check rather than rejecting on version.
    const truncated = new ArrayBuffer(40);
    const tView = new DataView(truncated);
    tView.setUint32(0, 0x42564653, true);
    tView.setUint32(4, CURRENT_BINARY_VERSION, true);
    tView.setUint32(16, 10, true); // 10 inodes
    expect(() => deserializeBinaryMeta(truncated)).toThrow(/Corrupted binary metadata/);
  });

  it('replays committed metadata batches atomically', () => {
    const inodes = new Map<string, Inode>();
    inodes.set('/', makeInode({ isDir: true, children: ['old'] }));
    inodes.set('/old', makeInode({ size: 3, blocks: [1] }));
    const sortedPaths = ['/', '/old'];

    const batch = serializeLogTransaction(
      [
        serializeLogRecord('/old', null),
        serializeLogRecord(
          '/new',
          makeInode({ size: 5, blocks: [2], atimeMs: 1712345697000, mtimeMs: 1712345699000, ctimeMs: 1712345701000 }),
        ),
      ],
      42,
    );

    expect(replayLog(toArrayBuffer(batch), inodes, sortedPaths, 128).count).toBe(2);
    expect(inodes.has('/old')).toBe(false);
    expect(inodes.get('/new')!.size).toBe(5);
    expect(inodes.get('/new')!.mtimeMs).toBe(1712345699000);
    expect(sortedPaths).toEqual(['/', '/new']);
  });

  it('ignores incomplete metadata batches during replay', () => {
    const inodes = new Map<string, Inode>();
    inodes.set('/', makeInode({ isDir: true, children: ['old'] }));
    inodes.set('/old', makeInode({ size: 3, blocks: [1] }));
    const sortedPaths = ['/', '/old'];

    const batch = serializeLogTransaction(
      [serializeLogRecord('/old', null), serializeLogRecord('/new', makeInode({ size: 5, blocks: [2] }))],
      7,
    );
    const truncated = batch.slice(0, batch.byteLength - 16); // drop commit marker

    expect(replayLog(toArrayBuffer(truncated), inodes, sortedPaths, 128).count).toBe(0);
    expect(inodes.has('/old')).toBe(true);
    expect(inodes.has('/new')).toBe(false);
    expect(sortedPaths).toEqual(['/', '/old']);
  });

  it('stops at a torn mutation record instead of replaying later batches', () => {
    const inodes = new Map<string, Inode>();
    inodes.set('/', makeInode({ isDir: true, children: ['stable'] }));
    inodes.set('/stable', makeInode({ size: 6, blocks: [1] }));
    const sortedPaths = ['/', '/stable'];

    const deleteStable = serializeLogRecord('/stable', null);
    const tornUpsert = serializeLogRecord('/broken', makeInode({ size: 2, blocks: [2] }));
    const tornBatch = serializeLogTransaction([deleteStable, tornUpsert], 10);
    const tornPrefixLength = 16 + deleteStable.byteLength + Math.floor(tornUpsert.byteLength / 2);
    const committed = serializeLogTransaction([serializeLogRecord('/late', makeInode({ size: 4, blocks: [3] }))], 11);
    const combined = new Uint8Array(tornPrefixLength + committed.byteLength);
    combined.set(tornBatch.subarray(0, tornPrefixLength), 0);
    combined.set(committed, tornPrefixLength);

    expect(replayLog(toArrayBuffer(combined), inodes, sortedPaths, 128)).toMatchObject({ count: 0, validEnd: 0 });
    expect(inodes.has('/stable')).toBe(true);
    expect(inodes.has('/broken')).toBe(false);
    expect(inodes.has('/late')).toBe(false);
    expect(sortedPaths).toEqual(['/', '/stable']);
  });

  it('stops replay at a record with an unsupported flag encoding instead of throwing', () => {
    const inodes = new Map<string, Inode>();
    inodes.set('/', makeInode({ ino: 1, isDir: true, children: ['stable'] }));
    inodes.set('/stable', makeInode({ ino: 2, size: 6, blocks: [1], mode: 0o100644 }));
    const sortedPaths = ['/', '/stable'];

    const legacyDir = makeInode({ ino: 3, isDir: true, children: [], mode: 0o40755 });
    const legacyBatch = serializeLogTransaction(
      [rewriteLogRecordFlags(serializeLogRecord('/legacy-dir', legacyDir), (legacyDir.mode << 1) | 1)],
      99,
    );

    expect(replayLog(toArrayBuffer(legacyBatch), inodes, sortedPaths, 128)).toMatchObject({ count: 0, validEnd: 0 });
    expect(inodes.has('/legacy-dir')).toBe(false);
    expect(sortedPaths).toEqual(['/', '/stable']);
  });

  it('stops at an abandoned metadata batch even when a committed batch follows', () => {
    const inodes = new Map<string, Inode>();
    inodes.set('/', makeInode({ isDir: true, children: ['stable'] }));
    inodes.set('/stable', makeInode({ size: 6, blocks: [1] }));
    const sortedPaths = ['/', '/stable'];

    const abandoned = serializeLogTransaction(
      [serializeLogRecord('/stable', null), serializeLogRecord('/broken', makeInode({ size: 1, blocks: [2] }))],
      10,
    ).slice(0, -16);
    const committed = serializeLogTransaction([serializeLogRecord('/late', makeInode({ size: 4, blocks: [3] }))], 11);
    const combined = new Uint8Array(abandoned.byteLength + committed.byteLength);
    combined.set(abandoned, 0);
    combined.set(committed, abandoned.byteLength);

    expect(replayLog(toArrayBuffer(combined), inodes, sortedPaths, 128).count).toBe(0);
    expect(inodes.has('/stable')).toBe(true);
    expect(inodes.has('/broken')).toBe(false);
    expect(inodes.has('/late')).toBe(false);
  });

  // ── INT-9: per-batch CRC32 on the committed meta-log batch ──

  it('rejects a meta-log batch whose committed bytes were bit-flipped (INT-9)', () => {
    const inodes = new Map<string, Inode>();
    inodes.set('/', makeInode({ isDir: true, children: [] }));
    const sortedPaths = ['/'];

    // A committed batch creating /f.bin (blocks [5]). The COMMIT marker now
    // carries a CRC over BEGIN+records; flipping a byte inside the record must
    // make replay discard the whole batch rather than apply corrupt state.
    const batch = serializeLogTransaction(
      [serializeLogRecord('/f.bin', makeInode({ ino: 9, size: 7, blocks: [5] }))],
      77,
    );
    const corrupt = batch.slice();
    // Change inode size without damaging record framing or extent validation.
    const flipAt = 16 + 20 + 12 + '/f.bin'.length + 4; // BEGIN + transaction header + record header + path + flags
    corrupt[flipAt] ^= 0xff;

    expect(replayLog(toArrayBuffer(corrupt), inodes, sortedPaths, 128).count).toBe(0);
    expect(inodes.has('/f.bin')).toBe(false);

    // The mutation remains parseable: repairing only its CRC must allow replay.
    new DataView(corrupt.buffer).setUint32(corrupt.length - 4, crc32(corrupt.subarray(0, -20)), true);
    expect(replayLog(toArrayBuffer(corrupt), new Map(), [], 128).count).toBe(1);
  });

  it('still applies a meta-log batch with an intact CRC (INT-9)', () => {
    const inodes = new Map<string, Inode>();
    inodes.set('/', makeInode({ isDir: true, children: [] }));
    const sortedPaths = ['/'];
    const batch = serializeLogTransaction(
      [serializeLogRecord('/ok.bin', makeInode({ ino: 9, size: 7, blocks: [5] }))],
      78,
    );
    expect(replayLog(toArrayBuffer(batch), inodes, sortedPaths, 128).count).toBe(1);
    expect(inodes.get('/ok.bin')!.blocks).toEqual([5]);
  });

  it('discards a corrupt batch but keeps an earlier valid one (INT-9 torn-tail)', () => {
    const inodes = new Map<string, Inode>();
    inodes.set('/', makeInode({ isDir: true, children: [] }));
    const sortedPaths = ['/'];

    const good = serializeLogTransaction(
      [serializeLogRecord('/good.bin', makeInode({ ino: 2, size: 3, blocks: [1] }))],
      90,
    );
    const bad = serializeLogTransaction(
      [serializeLogRecord('/bad.bin', makeInode({ ino: 3, size: 3, blocks: [2] }))],
      91,
    );
    const badCorrupt = bad.slice();
    badCorrupt[16 + 20 + 12 + '/bad.bin'.length + 4] ^= 0xff; // flip the inode size
    const combined = new Uint8Array(good.byteLength + badCorrupt.byteLength);
    combined.set(good, 0);
    combined.set(badCorrupt, good.byteLength);

    // Only the first (valid) batch applies; the corrupt batch and everything
    // after it are discarded (mid-stream corruption = torn tail).
    expect(replayLog(toArrayBuffer(combined), inodes, sortedPaths, 128).count).toBe(1);
    expect(inodes.has('/good.bin')).toBe(true);
    expect(inodes.has('/bad.bin')).toBe(false);

    new DataView(badCorrupt.buffer).setUint32(badCorrupt.length - 4, crc32(badCorrupt.subarray(0, -20)), true);
    expect(replayLog(toArrayBuffer(badCorrupt), new Map(), [], 128).count).toBe(1);
  });
});

// ── INT-9: bitmap warm-start cache framing (checksum + generation) ──

describe('compact metadata log records', () => {
  // PERF-9 — compact attr-only log records.
  it('serializes an attr-only record much smaller than a full record', () => {
    const big = makeInode({ size: 1_000_000, blocks: Array.from({ length: 256 }, (_, i) => i + 10) });
    const full = serializeLogRecord('/big', big);
    const compact = serializeLogAttrRecord('/big', big);
    // The full record carries the 256-entry block table; the compact one does not.
    expect(compact.byteLength).toBeLessThan(full.byteLength);
    // Compact = 12-byte header + path + 28-byte fixed payload, regardless of blocks.
    const pathLen = new TextEncoder().encode('/big').byteLength;
    expect(compact.byteLength).toBe(12 + pathLen + 28);
  });

  it('replays a mixed compact + full record stream to identical state', () => {
    // Seed: one file with a block table.
    const seeded = makeInode({ ino: 42, size: 8192, blocks: [10, 11] });
    const inodes = new Map<string, Inode>([
      ['/', makeInode({ ino: 1, isDir: true, mode: 16877, nlink: 2, children: ['f'] })],
      ['/f', seeded],
    ]);
    const sortedPaths = ['/', '/f'];

    // Full record: change blocks (structural). Then a compact record: bump
    // size + timestamps only, keeping the (newer) block table.
    const fullUpdate = makeInode({ ino: 42, size: 8192, blocks: [10, 11, 12] });
    const attrUpdate = makeInode({
      ino: 42,
      size: 9000,
      blocks: [99, 99, 99], // intentionally wrong — compact must IGNORE blocks
      atimeMs: 1712399999000,
      mtimeMs: 1712399999000,
      ctimeMs: 1712399999000,
    });

    const batch1 = serializeLogTransaction([serializeLogRecord('/f', fullUpdate)], 1);
    const batch2 = serializeLogTransaction([serializeLogAttrRecord('/f', attrUpdate)], 2);
    const combined = new Uint8Array(batch1.byteLength + batch2.byteLength);
    combined.set(batch1, 0);
    combined.set(batch2, batch1.byteLength);

    expect(replayLog(toArrayBuffer(combined), inodes, sortedPaths, 128).count).toBe(2);

    const result = inodes.get('/f')!;
    // Compact record updated size/timestamps but PRESERVED the full record's blocks.
    expect(result.size).toBe(9000);
    expect(result.blocks).toEqual([10, 11, 12]);
    expect(result.mtimeMs).toBe(1712399999000);
    expect(result.ino).toBe(42);
  });

  it('synthesizes an empty inode when an attr-only record has no prior full record', () => {
    const inodes = new Map<string, Inode>([['/', makeInode({ ino: 1, isDir: true, mode: 16877, nlink: 2 })]]);
    const sortedPaths = ['/'];
    const attrOnly = makeInode({ ino: 7, size: 4096, blocks: [5, 6] });
    const batch = serializeLogTransaction([serializeLogAttrRecord('/orphan', attrOnly)], 1);

    expect(replayLog(toArrayBuffer(batch), inodes, sortedPaths, 128).count).toBe(1);
    const result = inodes.get('/orphan')!;
    expect(result.size).toBe(4096);
    expect(result.blocks).toEqual([]); // no block table available -> empty
    expect(result.ino).toBe(7);
    expect(sortedPaths).toContain('/orphan');
  });

  // §6.4 — on-disk format versioning.
  it('round-trips current-version binary metadata', () => {
    const inodes = new Map<string, Inode>([['/', makeInode({ ino: 1, isDir: true, mode: 16877, nlink: 2 })]]);
    const buf = serializeMeta(inodes, 1024, 4096);
    expect(() => deserializeBinaryMeta(buf)).not.toThrow();
  });

  it('refuses a future/unknown binary-metadata version with a typed corruption error', () => {
    const inodes = new Map<string, Inode>([['/', makeInode({ ino: 1, isDir: true, mode: 16877, nlink: 2 })]]);
    const buf = serializeMeta(inodes, 1024, 4096);
    // Bump the version u32 (offset 4) to a future value.
    const view = new DataView(buf);
    view.setUint32(4, 999, true);
    try {
      deserializeBinaryMeta(buf);
      throw new Error('expected a corruption error');
    } catch (error) {
      expect(error).toBeInstanceOf(VfsCorruptionError);
      expect((error as VfsCorruptionError).category).toBe('format-version');
    }
  });

  it('round-trips snapshot extents and rejects a changed extent', () => {
    const framed = frameMetaSnapshot(Uint8Array.of(1, 2, 3), 8, undefined, 8192, 4096);
    expect(parseMetaSnapshot(framed)).toMatchObject({
      sequence: 8,
      physicalDataSize: 8192,
      logicalExtent: 4096,
    });
    const tampered = framed.slice();
    tampered[24] ^= 1;
    expect(parseMetaSnapshot(tampered)).toBeNull();
  });

  it.each([16, 24])('authenticates snapshot extent at byte %i even with a repaired CRC', (offset) => {
    const payload = Uint8Array.of(1, 2, 3);
    const framed = frameMetaSnapshot(payload, 8, testCodec, 8192, 4096);
    expect(parseMetaSnapshot(framed, testCodec)).toEqual({
      sequence: 8,
      physicalDataSize: 8192,
      logicalExtent: 4096,
      payload,
    });
    const tampered = framed.slice();
    const view = new DataView(tampered.buffer);
    tampered[offset + 6] ^= 0x10; // Changes the decoded extent to another valid positive integer.
    view.setUint32(8, crc32(tampered.subarray(16)), true);
    expect(parseMetaSnapshot(tampered, testCodec)).toBeNull();
  });

  it.each([false, true])('discards transactions from another snapshot generation (sealed=%s)', (sealed) => {
    const sealer = sealed ? testCodec : undefined;
    const tx = serializeLogTransaction(
      [serializeLogRecord('/wrong', makeInode({ size: 8 * 4096, blocks: [16, 17, 18, 19, 20, 21, 22, 23] }))],
      1,
      sealer,
      4,
      24 * 4096,
      24 * 4096,
    );
    const inodes = new Map<string, Inode>();
    expect(replayLog(toArrayBuffer(tx), inodes, [], 32, 5, sealer)).toMatchObject({
      count: 0,
      validEnd: 0,
      generationMismatch: 'stale',
    });
    expect(inodes.has('/wrong')).toBe(false);
    // A newer generation may have grown beyond the older snapshot's capacity.
    expect(replayLog(toArrayBuffer(tx), inodes, [], 16, 3, sealer)).toMatchObject({
      count: 0,
      validEnd: 0,
      generationMismatch: 'newer',
    });
    expect(inodes.has('/wrong')).toBe(false);
    const damaged = tx.slice();
    damaged[damaged.length - 1] ^= 1;
    expect(replayLog(toArrayBuffer(damaged), inodes, [], 16, 3, sealer).generationMismatch).toBeUndefined();
  });

  it('seals the transaction generation with the record body', () => {
    const tx = serializeLogTransaction([serializeLogRecord('/sealed', makeInode())], 1, testCodec, 7, 8192, 4096);
    expect(tx[16]).not.toBe(7);
    expect(replayLog(toArrayBuffer(tx), new Map(), [], 16, 7, testCodec).count).toBe(1);
    const tampered = tx.slice();
    tampered[16] ^= 1;
    new DataView(tampered.buffer).setUint32(
      tampered.length - 4,
      crc32(tampered.subarray(0, tampered.length - 20)),
      true,
    );
    const inodes = new Map<string, Inode>();
    expect(replayLog(toArrayBuffer(tampered), inodes, [], 16, 6, testCodec).count).toBe(0);
    expect(inodes.has('/sealed')).toBe(false);
  });
});
