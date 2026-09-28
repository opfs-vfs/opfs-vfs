import { testPlugin } from './test-plugin';
import { OpenFlags, OpfsVfs, type OpfsVfsOptions, type SyncAccessHandleTag } from '../opfs-vfs';
import { MetaSnapshotCorruptionError } from '../binary-metadata';

export type Scenario =
  | 'gap'
  | 'ino-reuse'
  | 'relink'
  | 'repair-marker'
  | 'storage-extent'
  | 'log-order'
  | 'disk-sync'
  | 'newer-log'
  | 'compacted-log'
  | 'wal-tail'
  | 'wal-checkpoint'
  | 'wal-checkpoint-failure'
  | 'sparse'
  | 'sparse-quota'
  | 'disk-attrs';
type Request = { name: string; scenario: Scenario; step: number };

const create = OpenFlags.O_CREAT | OpenFlags.O_RDWR;
const BLOCK = 4096;

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const byteAt = (i: number, seed: number) => ((i * 31 + seed * 17) % 251) + 1;

function pattern(size: number, seed: number) {
  return Uint8Array.from({ length: size }, (_, i) => byteAt(i, seed));
}

function put(vfs: OpfsVfs, path: string, data: Uint8Array, offset = 0) {
  const fd = vfs.openSync(path, create);
  try {
    check(vfs.writeSync(fd, data, offset) === data.length, `${path}: write count`);
  } finally {
    vfs.closeSync(fd);
  }
}

function read(vfs: OpfsVfs, path: string) {
  const fd = vfs.openSync(path);
  try {
    return vfs.readSync(fd, vfs.statSync(path).size).buffer;
  } finally {
    vfs.closeSync(fd);
  }
}

function sameBytes(actual: Uint8Array, expected: Uint8Array, label: string) {
  check(actual.length === expected.length, `${label}: length ${actual.length} != ${expected.length}`);
  const mismatch = actual.findIndex((byte, i) => byte !== expected[i]);
  check(mismatch === -1, `${label}: byte ${mismatch} is ${actual[mismatch]}, expected ${expected[mismatch]}`);
}

async function mount(name: string, options: OpfsVfsOptions) {
  const vfs = new OpfsVfs(name, options);
  await vfs.ready;
  return vfs;
}

type Blocks = { inodes: Map<string, { blocks: number[] }> };

/** Each step ends either in a native termination by the driver or a clean close. */
async function run({ name, scenario, step }: Request): Promise<void> {
  switch (scenario) {
    case 'disk-attrs': {
      const vfs = await mount(name, {
        bufferMode: 'disk',
        localDurabilityMode: 'strict',
        noatime: true,
        maxTotalBytes: step === 0 ? undefined : 1,
      });
      if (step === 0) {
        put(vfs, '/file', Uint8Array.of(1, 2));
        vfs.syncSync();
        return; // Terminated without close.
      }
      const fd = vfs.openSync('/file', OpenFlags.O_RDWR);
      const expected = step === 1 ? [1, 2] : step === 2 ? [7, 2] : [7, 2, 0, 0, 0, 9];
      sameBytes(vfs.readSync(fd, BLOCK).buffer, Uint8Array.from(expected), 'attribute replay contents');
      const stat = vfs.fstatSync(fd);
      check(stat.size === expected.length, 'attribute replay size');
      if (step > 1) {
        const previousWriteTime = 1_700_000_000_000 + (step - 1) * 1000;
        check(stat.mtimeMs === previousWriteTime && stat.ctimeMs === previousWriteTime, 'attribute replay timestamps');
      }
      if (step === 3) {
        await vfs.closeVfs();
        return;
      }
      const state = vfs as unknown as {
        dirtyInodes: Set<string>;
        attrDirtyInodes: Set<string>;
        metaSnapshotSequence: number;
        logOffset: number;
        allocatedDataBlocks: number;
      };
      const sequence = state.metaSnapshotSequence;
      const logOffset = state.logOffset;
      const now = Date.now;
      Date.now = () => 1_700_000_000_000 + step * 1000;
      try {
        vfs.writeSync(fd, Uint8Array.of(step === 1 ? 7 : 9), step === 1 ? 0 : 5);
      } finally {
        Date.now = now;
      }
      check(!state.dirtyInodes.has('/file') && state.attrDirtyInodes.has('/file'), 'write dirtied only attributes');
      check(state.allocatedDataBlocks === 1, 'write reused the existing block despite lower quota');
      vfs.syncSync();
      check(state.metaSnapshotSequence === sequence && state.logOffset > logOffset, 'sync appended an attribute log');
      return; // Terminated without close.
    }
    case 'sparse': {
      const size = 1024 * 1024 * 1024 + 17;
      const middle = 512 * 1024 * 1024 + 29;
      const vfs = await mount(name, { bufferMode: 'disk', localDurabilityMode: 'strict' });
      const fd = vfs.openSync('/sparse', create);
      const state = vfs as unknown as Blocks & {
        allocatedDataBlocks: number;
        bitmap: { get(block: number): boolean };
      };
      if (step === 0) {
        vfs.ftruncateSync(fd, size);
        vfs.syncSync();
        const root = await navigator.storage.getDirectory();
        check((await (await root.getFileHandle(name)).getFile()).size < BLOCK, 'sparse grow wrote no data blocks');
        sameBytes(vfs.readSync(fd, 8, middle).buffer, new Uint8Array(8), 'initial hole');
        const into = new Uint8Array(8).fill(0xaa);
        check(vfs.readInto(fd, into, middle) === into.length, 'readInto count');
        sameBytes(into, new Uint8Array(8), 'readInto hole');
        put(vfs, '/secret', new Uint8Array(BLOCK).fill(0xaa));
        vfs.syncSync();
        vfs.unlinkSync('/secret');
        vfs.syncSync();
        vfs.writeSync(fd, Uint8Array.of(3, 4, 5), middle);
        vfs.writeSync(fd, Uint8Array.of(9), size - 1);
        vfs.syncSync();
        check(state.allocatedDataBlocks === 2, 'only written pages are allocated');
        check((await (await root.getFileHandle(name)).getFile()).size <= 3 * BLOCK, 'physical file stays small');
        return; // Terminated without close.
      }
      check(vfs.statSync('/sparse').size === (step === 1 ? size : middle + 3), 'logical size survived remount');
      const expected = new Uint8Array(step === 1 ? 16 : 11);
      expected.set([3, 4, 5], 8);
      sameBytes(vfs.readSync(fd, expected.length, middle - 8).buffer, expected, 'middle hole boundary');
      if (step === 1) {
        sameBytes(
          vfs.readSync(fd, 17, size - 17).buffer,
          Uint8Array.from({ length: 17 }, (_, i) => (i === 16 ? 9 : 0)),
          'tail hole',
        );
        check(state.allocatedDataBlocks === 2, 'bitmap rebuild counted two blocks');
        const tailBlock = state.inodes.get('/sparse')!.blocks.at(-1)!;
        vfs.ftruncateSync(fd, middle + 3);
        vfs.syncSync();
        check(
          Number(state.allocatedDataBlocks) === 1 && !state.bitmap.get(tailBlock),
          'shrink freed only the tail block',
        );
        return; // Terminated without close.
      }
      check(state.allocatedDataBlocks === 1, 'shrunken bitmap survived remount');
      const middleBlock = state.inodes.get('/sparse')!.blocks[Math.floor(middle / BLOCK)];
      vfs.closeSync(fd);
      vfs.unlinkSync('/sparse');
      vfs.syncSync();
      check(Number(state.allocatedDataBlocks) === 0 && !state.bitmap.get(middleBlock), 'unlink freed the last block');
      await vfs.closeVfs();
      return;
    }
    case 'sparse-quota': {
      const quota = 1024 * 1024;
      const vfs = await mount(name, { bufferMode: 'disk', maxTotalBytes: quota, localDurabilityMode: 'strict' });
      const fd = vfs.openSync('/sparse', create);
      if (step === 0) {
        vfs.ftruncateSync(fd, 1024 * 1024 * 1024);
        vfs.writeSync(fd, new Uint8Array(quota), 512 * 1024 * 1024);
        vfs.syncSync();
        return; // Terminated without close.
      }
      let code: string | undefined;
      try {
        vfs.writeSync(fd, Uint8Array.of(1), 768 * 1024 * 1024);
      } catch (error) {
        code = (error as { code?: string }).code;
      }
      check(code === 'ENOSPC', 'writing another hole exceeds physical quota after remount');
      check(
        (vfs as unknown as { allocatedDataBlocks: number }).allocatedDataBlocks === quota / BLOCK,
        'quota counter rebuilt',
      );
      await vfs.closeVfs();
      return;
    }
    case 'gap': {
      // A write past EOF must persist its zero gap: the gap's blocks may be the
      // freed blocks of a deleted file that still hold its bytes on disk.
      const options: OpfsVfsOptions = { bufferMode: 'memory', localDurabilityMode: 'relaxed' };
      const vfs = await mount(name, options);
      if (step === 0) {
        put(vfs, '/secret', pattern(16 * BLOCK, 1));
        vfs.syncSync();
        vfs.unlinkSync('/secret');
        put(vfs, '/new', Uint8Array.of(7), 16 * BLOCK);
        vfs.syncSync();
        return; // Terminated without close.
      }
      const expected = new Uint8Array(16 * BLOCK + 1);
      expected[16 * BLOCK] = 7;
      sameBytes(read(vfs, '/new'), expected, '/new');
      await vfs.closeVfs();
      return;
    }
    case 'ino-reuse': {
      // Surviving WAL records of a deleted inode must not replay into a later
      // file that reuses its inode number.
      const options: OpfsVfsOptions = { bufferMode: 'memory', localDurabilityMode: 'strict' };
      const vfs = await mount(name, options);
      if (step === 0) {
        put(vfs, '/keep', pattern(10, 2));
        put(vfs, '/tmp', pattern(100, 3));
        vfs.unlinkSync('/tmp');
        return;
      }
      if (step === 1) {
        put(vfs, '/new', pattern(3, 4));
        return;
      }
      sameBytes(read(vfs, '/keep'), pattern(10, 2), '/keep');
      sameBytes(read(vfs, '/new'), pattern(3, 4), '/new');
      await vfs.closeVfs();
      return;
    }
    case 'relink': {
      // A data-WAL delete must not remove a pathname that was linked again.
      const options: OpfsVfsOptions = { bufferMode: 'memory', localDurabilityMode: 'relaxed' };
      const vfs = await mount(name, options);
      if (step === 0) {
        put(vfs, '/x', pattern(5000, 5));
        vfs.linkSync('/x', '/y');
        vfs.syncSync();
        vfs.unlinkSync('/y');
        vfs.linkSync('/x', '/y');
        return;
      }
      sameBytes(read(vfs, '/x'), pattern(5000, 5), '/x');
      sameBytes(read(vfs, '/y'), pattern(5000, 5), '/y');
      await vfs.closeVfs();
      return;
    }
    case 'repair-marker': {
      // The mount-time repair flush must record the rebuilt allocation extent.
      const options: OpfsVfsOptions = { bufferMode: 'disk', localDurabilityMode: 'relaxed' };
      const root = await navigator.storage.getDirectory();
      if (step === 0) {
        const vfs = await mount(name, options);
        put(vfs, '/a', pattern(BLOCK, 8));
        put(vfs, '/b', pattern(3 * BLOCK, 9));
        await vfs.closeVfs();
        const handle = await (await root.getFileHandle(name)).createSyncAccessHandle();
        handle.truncate(handle.getSize() - BLOCK); // Tear /b's last block.
        handle.flush();
        handle.close();
        return;
      }
      if (step === 1) {
        const vfs = await mount(name, options);
        check((vfs as unknown as Blocks).inodes.get('/b')!.blocks.length === 2, 'torn block was dropped');
        return; // Terminated immediately after repair, without close.
      }
      // Capture the persisted extent before another mount could repair it again.
      const slotFiles = await Promise.all(
        ['.meta.a', '.meta.b'].map(async (suffix) => {
          const file = await root.getFileHandle(name.replace(/\.bin$/, suffix));
          return new Uint8Array(await (await file.getFile()).arrayBuffer());
        }),
      );
      const snapshots = slotFiles.map((bytes) => ({
        sequence: new DataView(bytes.buffer).getUint32(4, true),
        logicalExtent: new DataView(bytes.buffer).getFloat64(24, true),
      }));
      const newest = snapshots.reduce((a, b) => (a.sequence > b.sequence ? a : b));
      const vfs = await mount(name, options);
      const { inodes } = vfs as unknown as Blocks;
      const highest = Math.max(...inodes.get('/a')!.blocks, ...inodes.get('/b')!.blocks);
      check(inodes.get('/b')!.blocks.length === 2, 'repaired mapping survives termination');
      check(newest.logicalExtent === (highest + 1) * BLOCK, 'persisted snapshot excludes the torn block');
      await vfs.closeVfs();
      return;
    }
    case 'storage-extent': {
      const limits: number[] = [];
      const options = (): OpfsVfsOptions => ({
        bufferMode: 'disk',
        localDurabilityMode: 'relaxed',
        noatime: true,
        plugins: [
          testPlugin(async ({ data }) => ({
            data,
            hasPhysicalBlock(block, physicalDataSize, logicalLimit) {
              check(block !== 0, 'storage must never be asked about a hole');
              limits.push(logicalLimit);
              return (block + 1) * BLOCK <= Math.min(physicalDataSize, logicalLimit);
            },
            destroy() {},
          })),
        ],
      });
      const content = pattern(2 * BLOCK, 13);
      if (step === 0) {
        const first = await mount(name, options());
        put(first, '/file', content.subarray(0, BLOCK));
        const hole = first.openSync('/hole', create);
        first.ftruncateSync(hole, 16 * BLOCK);
        first.closeSync(hole);
        await first.closeVfs();
        const second = await mount(name, options());
        const state = second as unknown as { metaSnapshotSequence: number; committedLogicalExtent: number };
        const sequence = state.metaSnapshotSequence;
        check(state.committedLogicalExtent === 2 * BLOCK, 'snapshot records the original extent');
        put(second, '/file', content.subarray(BLOCK), BLOCK);
        second.syncSync();
        check(state.metaSnapshotSequence === sequence, 'growth is committed in an incremental transaction');
        check(state.committedLogicalExtent === 3 * BLOCK, 'transaction records the grown extent');
        return; // Keep the newer transaction for replay after native termination.
      }
      const vfs = await mount(name, options());
      check(limits.length > 0 && limits.every((limit) => limit === 3 * BLOCK), 'storage receives the replayed extent');
      sameBytes(read(vfs, '/file'), content, 'storage preserves blocks beyond the snapshot extent');
      sameBytes(read(vfs, '/hole'), new Uint8Array(16 * BLOCK), 'repair preserves holes beyond the physical extent');
      await vfs.closeVfs();
      return;
    }
    case 'wal-tail': {
      // A torn trailing WAL frame is cut at mount, so later appends never sit
      // in front of its leftover payload.
      const options: OpfsVfsOptions = { bufferMode: 'memory', localDurabilityMode: 'strict' };
      const walName = name.replace(/\.bin$/, '.data.log');
      const root = await navigator.storage.getDirectory();
      if (step === 0) {
        const vfs = await mount(name, options);
        put(vfs, '/a', pattern(100, 12));
        return;
      }
      if (step === 1) {
        const handle = await (await root.getFileHandle(walName)).createSyncAccessHandle();
        const clean = handle.getSize();
        handle.write(Uint8Array.of(200, 0, 0), { at: clean }); // Half a frame header.
        handle.flush();
        handle.close();
        const vfs = await mount(name, options);
        const size = (vfs as unknown as { dataLogHandle: { getSize(): number } }).dataLogHandle.getSize();
        check(size === clean, `torn tail truncated (${size} != ${clean})`);
        sameBytes(read(vfs, '/a'), pattern(100, 12), '/a');
        return;
      }
      const vfs = await mount(name, options);
      sameBytes(read(vfs, '/a'), pattern(100, 12), '/a');
      await vfs.closeVfs();
      return;
    }
    case 'compacted-log':
    case 'newer-log': {
      const options: OpfsVfsOptions = { bufferMode: 'disk', localDurabilityMode: 'relaxed' };
      const root = await navigator.storage.getDirectory();
      if (step === 0) {
        const first = await mount(name, options);
        put(first, '/file', pattern(BLOCK, 3));
        await first.closeVfs();
        if (scenario === 'compacted-log') return;
        const second = await mount(name, options);
        second.utimesSync('/file', 1_800_000_000_000, 1_800_000_000_000);
        second.syncSync();
        return; // native worker termination leaves the newer-generation log
      }
      const slots = await Promise.all(
        ['.meta.a', '.meta.b'].map(async (suffix) => {
          const file = await root.getFileHandle(name.replace(/\.bin$/, suffix));
          const bytes = new Uint8Array(await (await file.getFile()).arrayBuffer());
          return { file, sequence: new DataView(bytes.buffer).getUint32(4, true) };
        }),
      );
      const newest = slots.reduce((a, b) => (a.sequence > b.sequence ? a : b));
      const handle = await newest.file.createSyncAccessHandle();
      handle.write(Uint8Array.of(0), { at: 0 });
      handle.flush();
      handle.close();
      let failed = false;
      try {
        await mount(name, { ...options, recoveryMode: 'fail-stop' });
      } catch (error) {
        failed = error instanceof MetaSnapshotCorruptionError;
      }
      check(failed, 'newer log rejects fallback snapshot in fail-stop mode');
      const salvaged = await mount(name, options);
      check(!salvaged.existsSync('/file'), 'fallback snapshot discards newer log');
      await salvaged.closeVfs();
      return;
    }
    case 'disk-sync': {
      const trace: string[] = [];
      const root = await navigator.storage.getDirectory();
      const vfs = await mount(name, {
        bufferMode: 'disk',
        localDurabilityMode: 'relaxed',
        _wrapSyncAccessHandle: (real: FileSystemSyncAccessHandle, tag: SyncAccessHandleTag) =>
          ({
            read: (b: AllowSharedBufferSource, o?: FileSystemReadWriteOptions) => real.read(b, o),
            write: (b: AllowSharedBufferSource, o?: FileSystemReadWriteOptions) => real.write(b, o),
            truncate: (size: number) => real.truncate(size),
            flush: () => {
              trace.push(tag);
              real.flush();
            },
            getSize: () => real.getSize(),
            close: () => real.close(),
          }) as unknown as FileSystemSyncAccessHandle,
      });
      put(vfs, '/file', pattern(BLOCK, 7));
      trace.length = 0;
      vfs.syncSync();
      check(trace.length === 2, `disk sync uses two flushes: ${trace.join(' ')}`);
      check(trace[0] === 'data' && trace[1] === 'metaLog', `data precedes metadata: ${trace.join(' ')}`);
      await vfs.closeVfs();
      try {
        await root.getFileHandle(name.replace(/\.bin$/, '.commit'), { create: false });
        throw new Error('disk sync created a .commit file');
      } catch (error) {
        check((error as DOMException).name === 'NotFoundError', 'disk sync has no .commit file');
      }
      return;
    }
    case 'wal-checkpoint': {
      const options: OpfsVfsOptions = { bufferMode: 'memory', localDurabilityMode: 'relaxed' };
      const vfs = await mount(name, options);
      if (step === 0) {
        put(vfs, '/keep', pattern(2 * BLOCK + 13, 13));
        vfs.truncateSync('/keep', BLOCK + 7);
        put(vfs, '/gone', pattern(BLOCK, 14));
        vfs.unlinkSync('/gone');
        put(vfs, '/other', pattern(37, 15));
        const log = (vfs as unknown as { dataLogHandle: FileSystemSyncAccessHandle }).dataLogHandle;
        const saved = new Uint8Array(log.getSize());
        check(log.read(saved, { at: 0 }) === saved.length && saved.length > 0, 'captured pre-sync WAL');
        vfs.syncSync();
        check(log.getSize() === 0, 'sync truncated WAL');
        log.write(saved, { at: 0 });
        log.flush();
        return; // Terminated after restoring the pre-checkpoint WAL.
      }
      sameBytes(read(vfs, '/keep'), pattern(BLOCK + 7, 13), '/keep');
      sameBytes(read(vfs, '/other'), pattern(37, 15), '/other');
      check(!vfs.existsSync('/gone'), 'deleted file stayed deleted');
      await vfs.closeVfs();
      return;
    }
    case 'wal-checkpoint-failure': {
      let failFlush = false;
      const failure = new Error('checkpoint flush failed');
      const vfs = await mount(name, {
        bufferMode: 'memory',
        localDurabilityMode: 'strict',
        _wrapSyncAccessHandle: (handle, tag) =>
          new Proxy(handle, {
            get(target, key) {
              if (tag === 'dataLog' && key === 'flush')
                return () => {
                  if (failFlush) throw failure;
                  target.flush();
                };
              const value = Reflect.get(target, key);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          }),
      });
      if (step === 0) {
        put(vfs, '/a', Uint8Array.of(1, 2, 3, 4));
        failFlush = true;
        let caught: unknown;
        try {
          vfs.syncSync();
        } catch (error) {
          caught = error;
        }
        check(caught === failure, 'checkpoint flush failed');
        failFlush = false;
        put(vfs, '/a', Uint8Array.of(9), 1);
        return; // Crash after the strict write, without retrying sync.
      }
      sameBytes(read(vfs, '/a'), Uint8Array.of(1, 9, 3, 4), '/a');
      await vfs.closeVfs();
      return;
    }
    case 'log-order': {
      const root = await navigator.storage.getDirectory();
      // Memory mode rewrites (possibly just-freed) blocks in place during sync;
      // both recovery logs must be durable before the first data write.
      const trace: string[] = [];
      const vfs = await mount(name, {
        bufferMode: 'memory',
        localDurabilityMode: 'balanced',
        _wrapSyncAccessHandle: (real: FileSystemSyncAccessHandle, tag: SyncAccessHandleTag) =>
          ({
            read: (b: AllowSharedBufferSource, o?: FileSystemReadWriteOptions) => real.read(b, o),
            write: (b: AllowSharedBufferSource, o?: FileSystemReadWriteOptions) => {
              trace.push(`${tag}.write`);
              return real.write(b, o);
            },
            truncate: (size: number) => {
              trace.push(`${tag}.truncate`);
              real.truncate(size);
            },
            flush: () => {
              trace.push(`${tag}.flush`);
              real.flush();
            },
            getSize: () => real.getSize(),
            close: () => real.close(),
          }) as unknown as FileSystemSyncAccessHandle,
      });
      put(vfs, '/a', pattern(3 * BLOCK, 10));
      vfs.syncSync();
      const afterFirstSyncLogOffset = (vfs as unknown as { logOffset: number }).logOffset;
      vfs.unlinkSync('/a');
      put(vfs, '/b', pattern(3 * BLOCK, 11));
      const state = vfs as unknown as {
        flushedDataSize: number;
        flushedLogicalExtent: number;
        logHandle: { getSize(): number; read(bytes: Uint8Array, options: { at: number }): number };
      };
      const pendingLog = new Uint8Array(state.logHandle.getSize());
      state.logHandle.read(pendingLog, { at: 0 });
      check(pendingLog.length >= afterFirstSyncLogOffset + 36, 'namespace transaction written before data flush');
      const pendingView = new DataView(pendingLog.buffer);
      check(
        pendingView.getFloat64(afterFirstSyncLogOffset + 20, true) === state.flushedDataSize,
        'transaction uses last flushed data size',
      );
      check(
        pendingView.getFloat64(afterFirstSyncLogOffset + 28, true) === state.flushedLogicalExtent,
        'transaction uses last flushed extent',
      );
      trace.length = 0;
      vfs.syncSync();
      const firstData = trace.indexOf('data.write');
      check(firstData >= 0, 'sync wrote data');
      for (const log of ['dataLog', 'metaLog']) {
        const before = trace.slice(0, firstData);
        const lastWrite = before.lastIndexOf(`${log}.write`);
        const flushed = before.lastIndexOf(`${log}.flush`);
        check(flushed >= 0 && flushed > lastWrite, `${log} flushed before in-place data writes: ${trace.join(' ')}`);
      }
      check(!trace.some((entry) => entry.startsWith('commit.')), 'sync has no commit write or flush');
      const checkpoint = trace.slice(firstData);
      check(checkpoint.filter((event) => event === 'dataLog.flush').length === 1, 'checkpoint flushed data WAL once');
      check(
        checkpoint.indexOf('dataLog.truncate') >= 0 &&
          checkpoint.indexOf('dataLog.truncate') < checkpoint.indexOf('dataLog.flush'),
        'checkpoint truncated before flushing',
      );
      check(!checkpoint.includes('dataLog.write'), 'checkpoint wrote no WAL record');
      await vfs.closeVfs();
      try {
        await root.getFileHandle(name.replace(/\.bin$/, '.commit'), { create: false });
        throw new Error('sync created a .commit file');
      } catch (error) {
        check((error as DOMException).name === 'NotFoundError', 'no .commit file');
      }
      return;
    }
  }
}

self.onmessage = async ({ data }: MessageEvent<Request>) => {
  try {
    await run(data);
    self.postMessage({ ok: true });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
  }
};
