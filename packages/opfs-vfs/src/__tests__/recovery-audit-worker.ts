import { deserializeBinaryMeta, parseMetaSnapshot, replayLog } from '../binary-metadata';
import { OpenFlags, OpfsVfs, type OpfsVfsOptions } from '../opfs-vfs';
import { deleteVolume } from '../volume-files';

const volumes: string[] = [];
const unique = () => {
  const name = `recovery-${crypto.randomUUID()}.bin`;
  volumes.push(name);
  return name;
};
function check(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

const options = (): OpfsVfsOptions => ({
  bufferMode: 'disk',
  localDurabilityMode: 'relaxed',
  noatime: true,
});

function mount(
  name: string,
  opts: OpfsVfsOptions,
  fault?: (tag: string, method: PropertyKey, handle: FileSystemSyncAccessHandle) => void,
) {
  const handles = new Map<string, FileSystemSyncAccessHandle>();
  const allHandles: FileSystemSyncAccessHandle[] = [];
  const vfs = new OpfsVfs(name, {
    ...opts,
    _wrapSyncAccessHandle: (handle, tag) => {
      allHandles.push(handle);
      if (!handles.has(tag)) handles.set(tag, handle);
      return new Proxy(handle, {
        get(target, key) {
          const value = Reflect.get(target, key);
          return typeof value === 'function'
            ? (...args: unknown[]) => {
                fault?.(tag, key, target);
                return value.apply(target, args);
              }
            : value;
        },
      });
    },
  });
  return { vfs, handles, allHandles };
}

function crash(mounted: ReturnType<typeof mount>) {
  (mounted.vfs as unknown as { closed: boolean }).closed = true;
  void (mounted.vfs as unknown as { releaseVolumeLock?: () => Promise<void> }).releaseVolumeLock?.();
  for (const handle of mounted.allHandles) handle.close();
}

async function seed(name: string, opts: OpfsVfsOptions, content = new Uint8Array([7, 8, 9, 10])) {
  const vfs = new OpfsVfs(name, opts);
  await vfs.ready;
  const fd = vfs.openSync('/file', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
  vfs.writeSync(fd, content);
  vfs.closeSync(fd);
  void vfs.closeVfs();
}

async function bytes(name: string) {
  const root = await navigator.storage.getDirectory();
  const file = await (await root.getFileHandle(name)).getFile();
  return new Uint8Array(await file.arrayBuffer());
}

function same(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

async function logTail(torn: boolean, failure?: string) {
  const name = unique();
  const opts = options();
  await seed(name, opts);
  const first = mount(name, opts);
  await first.vfs.ready;
  const log = first.handles.get('metaLog')!;
  const transactionStart = log.getSize();
  first.vfs.chmodSync('/file', 0o600);
  first.vfs.syncSync();
  const goodEnd = log.getSize();
  check(goodEnd - transactionStart > 56, 'fixture needs an incremental transaction');
  const committed = new Uint8Array(goodEnd - transactionStart);
  log.read(committed, { at: transactionStart });
  const replay = replayLog(
    committed.buffer,
    new Map(),
    [],
    (first.vfs as unknown as { totalBlocks: number }).totalBlocks,
    new DataView(committed.buffer).getUint32(16, true),
  );
  check(
    replay.count > 0 && replay.validEnd === committed.length,
    'fixture must contain a complete replayable transaction',
  );
  let tail = committed.slice();
  if (torn) tail = tail.subarray(0, tail.length - 5);
  else tail[tail.length - 1] ^= 1;
  log.write(tail, { at: goodEnd });
  log.flush();
  crash(first);

  if (failure) {
    let injected = false;
    const failed = mount(name, opts, (tag, method) => {
      if (!injected && tag === 'metaLog' && method === failure) {
        injected = true;
        throw new Error(`injected repair ${failure}`);
      }
    });
    let rejected = false;
    try {
      await failed.vfs.ready;
    } catch {
      rejected = true;
    }
    if (!rejected) void failed.vfs.closeVfs();
    check(injected && rejected, `repair ${failure} must reject mounting`);
    void failed.vfs.closeVfs();
  }

  const second = mount(name, opts);
  await second.vfs.ready;
  try {
    check((second.vfs.statSync('/file').mode & 0o777) === 0o600, 'first valid transaction survived');
    check(second.handles.get('metaLog')!.getSize() === goodEnd, 'mount removed the rejected suffix');
    second.vfs.chmodSync('/file', 0o640);
    second.vfs.syncSync();
    check(second.handles.get('metaLog')!.getSize() > goodEnd, 'second mutation appended, not compacted');
  } finally {
    crash(second);
  }
  const third = new OpfsVfs(name, opts);
  await third.ready;
  try {
    check((third.statSync('/file').mode & 0o777) === 0o640, 'new transaction survived a second crash');
    const fd = third.openSync('/file');
    check(same(third.readSync(fd, 4).buffer, new Uint8Array([7, 8, 9, 10])), 'existing contents survived');
  } finally {
    void third.closeVfs();
  }
}

async function allocation(phase: string, quota: boolean) {
  const name = unique();
  await seed(name, options(), new Uint8Array());
  let armed = false;
  let injected = false;
  const state = mount(name, options(), (tag, method) => {
    if (armed && !injected && tag === 'data' && method === 'write') {
      injected = true;
      throw new DOMException('injected data write', quota ? 'QuotaExceededError' : 'InvalidStateError');
    }
  });
  await state.vfs.ready;
  const fd = state.vfs.openSync('/file', OpenFlags.O_RDWR);
  const internals = state.vfs as unknown as {
    inodes: Map<string, { blocks: number[] }>;
    bitmap: { getRawBits(): Uint32Array };
  };
  const before = internals.bitmap.getRawBits().slice();
  const sparseSize = phase === 'truncate' ? 8192 : 0;
  const retryOffset = phase === 'truncate' ? 4113 : 0;
  try {
    armed = true;
    if (phase === 'truncate') {
      const physicalSize = state.handles.get('data')!.getSize();
      state.vfs.ftruncateSync(fd, sparseSize);
      check(!injected, 'sparse growth must not write data');
      check(state.handles.get('data')!.getSize() === physicalSize, 'sparse growth must preserve physical size');
    }
    let error: unknown;
    try {
      if (phase === 'truncate') state.vfs.writeSync(fd, new Uint8Array([42]), retryOffset);
      else if (phase === 'gap') state.vfs.writeSync(fd, new Uint8Array(4096), 4096);
      else state.vfs.writeSync(fd, new Uint8Array(phase === 'tail' ? 1 : 8192));
    } catch (caught) {
      error = caught;
    }
    armed = false;
    check(injected && error instanceof Error, 'fault must reject the write');
    if (quota) check((error as { code?: string }).code === 'ENOSPC', 'quota errors preserve ENOSPC');
    const blocks = internals.inodes.get('/file')!.blocks;
    check(
      blocks.length === sparseSize / 4096 && blocks.every((block) => block === 0),
      'failed write must preserve holes and discard new mappings',
    );
    check(
      internals.bitmap.getRawBits().every((value, i) => value === before[i]),
      'allocator ownership rolled back',
    );
    check(state.vfs.fstatSync(fd).size === sparseSize, 'failed write must preserve size');
    state.vfs.writeSync(fd, new Uint8Array([42]), retryOffset);
    state.vfs.syncSync();
    check(state.handles.get('data')!.getSize() % 4096 === 0, 'retry materialized a complete block');
  } finally {
    armed = false;
    void state.vfs.closeVfs();
  }
  const reopened = new OpfsVfs(name, options());
  await reopened.ready;
  try {
    const fd = reopened.openSync('/file');
    const expected = new Uint8Array(sparseSize || 1);
    expected[retryOffset] = 42;
    check(reopened.fstatSync(fd).size === expected.length, 'retry size survived remount');
    check(same(reopened.readSync(fd, expected.length).buffer, expected), 'retry contents and holes survived remount');
  } finally {
    void reopened.closeVfs();
  }
}

async function fragmentedAllocation(checkpoint: boolean) {
  const name = unique();
  await seed(name, options(), new Uint8Array());
  const state = mount(name, options());
  await state.vfs.ready;
  const fd = state.vfs.openSync('/file', OpenFlags.O_RDWR);
  const internals = state.vfs as unknown as {
    inodes: Map<string, { blocks: number[] }>;
    pendingFree: Set<number>;
    metaSnapshotSequence: number;
    bitmap: { alloc(): number; allocRun(count: number): number; getRawBits(): Uint32Array };
  };
  const bitmap = internals.bitmap;
  const alloc = bitmap.alloc.bind(bitmap);
  if (checkpoint) internals.pendingFree.add(alloc());
  const sequence = internals.metaSnapshotSequence;
  let reserved = -1;
  let calls = 0;
  bitmap.allocRun = () => -1;
  bitmap.alloc = () => {
    calls++;
    if (calls === 1) {
      reserved = alloc();
      return reserved;
    }
    if (checkpoint && calls === 2) return -1;
    throw new Error('injected fragmented allocation failure');
  };
  let error: unknown;
  try {
    state.vfs.writeSync(fd, new Uint8Array(8192));
  } catch (caught) {
    error = caught;
  }
  bitmap.alloc = alloc;
  try {
    check(error instanceof Error, 'allocation must fail after reserving one ID');
    check(internals.inodes.get('/file')!.blocks.length === 0, 'no provisional mapping survived allocation failure');
    check((bitmap.getRawBits()[reserved >>> 5] & (1 << (reserved & 31))) === 0, 'reserved bit released');
    if (checkpoint) {
      check(internals.metaSnapshotSequence > sequence, 'allocation forced a quarantine checkpoint');
      // Select by sequence rather than depending on the slot parity convention.
      const snapshots = ['metaA', 'metaB']
        .map((tag) => {
          const raw = state.handles.get(tag)!;
          const data = new Uint8Array(raw.getSize());
          raw.read(data, { at: 0 });
          return parseMetaSnapshot(data);
        })
        .filter((value) => value !== null)
        .sort((a, b) => b.sequence - a.sequence);
      const persisted = deserializeBinaryMeta(snapshots[0].payload.slice().buffer);
      check(persisted.inodes.get('/file')!.blocks.length === 0, 'checkpoint contains no provisional IDs');
    }
  } finally {
    crash(state);
  }
  const reopened = new OpfsVfs(name, options());
  await reopened.ready;
  try {
    check(reopened.statSync('/file').size === 0, 'crash remount retained old file');
  } finally {
    void reopened.closeVfs();
  }
}

async function existingGrowth() {
  const name = unique();
  await seed(name, options(), new Uint8Array(4096).fill(7));
  let armed = false;
  let writes = 0;
  const state = mount(name, options(), (tag, method) => {
    if (armed && tag === 'data' && method === 'write' && ++writes === 3) throw new Error('later data run failed');
  });
  await state.vfs.ready;
  const internals = state.vfs as unknown as {
    inodes: Map<string, { blocks: number[] }>;
    bitmap: { alloc(): number; free(id: number): void; getRawBits(): Uint32Array };
  };
  // Put a physical gap between existing and new pages so a write spans runs.
  const gap = internals.bitmap.alloc();
  const before = internals.bitmap.getRawBits().slice();
  const blocks = internals.inodes.get('/file')!.blocks.slice();
  const fd = state.vfs.openSync('/file', OpenFlags.O_RDWR);
  state.vfs.seekSync(fd, 2, 0);
  armed = true;
  let error: unknown;
  try {
    state.vfs.writeSync(fd, new Uint8Array(8192).fill(9));
  } catch (caught) {
    error = caught;
  }
  armed = false;
  try {
    check(error instanceof Error && writes === 3, 'failure follows two successful writes');
    check(state.vfs.fstatSync(fd).size === 4096, 'failed growth retained existing size');
    check(state.vfs.seekSync(fd, 0, 1) === 2, 'failed implicit write retained cursor');
    check(
      JSON.stringify(internals.inodes.get('/file')!.blocks) === JSON.stringify(blocks),
      'existing mappings retained',
    );
    check(
      internals.bitmap.getRawBits().every((word, i) => word === before[i]),
      'only provisional ownership rolled back',
    );
    state.vfs.writeSync(fd, new Uint8Array([42]), 4096);
    internals.bitmap.free(gap);
  } finally {
    void state.vfs.closeVfs();
  }
  const reopened = new OpfsVfs(name, options());
  await reopened.ready;
  try {
    const fd = reopened.openSync('/file');
    check(reopened.fstatSync(fd).size === 4097, 'retry retained the original extent');
    check(reopened.readSync(fd, 1, 4096).buffer[0] === 42, 'retry tail survived remount');
    // Existing bytes successfully overwritten before the failure are not undone.
    check(reopened.readSync(fd, 1, 2).buffer[0] === 9, 'test exercised a successful earlier data run');
  } finally {
    void reopened.closeVfs();
  }
}

async function modeSwitch(junk: boolean) {
  const name = unique();
  const opts = { ...options(), bufferMode: 'memory' as const };
  await seed(name, opts);
  const state = mount(name, opts);
  await state.vfs.ready;
  const fd = state.vfs.openSync('/file', OpenFlags.O_RDWR);
  state.vfs.writeSync(fd, new Uint8Array([42]), 1);
  const log = state.handles.get('dataLog')!;
  if (junk) {
    log.truncate(0);
    log.write(new Uint8Array([1, 2, 3]), { at: 0 });
  }
  log.flush();
  crash(state);
  const logName = name.replace(/\.bin$/, '.data.log');
  const before = await bytes(logName);
  let writes = 0;
  const disk = mount(name, options(), (_tag, method) => {
    if (method === 'write' || method === 'truncate' || method === 'flush') writes++;
  });
  let error: unknown;
  try {
    await disk.vfs.ready;
  } catch (caught) {
    error = caught;
  }
  if (!error) void disk.vfs.closeVfs();
  check((error as { code?: string })?.code === 'EBUSY', 'disk mount must require memory recovery');
  check((error as Error).message.includes('memory mode'), 'disk mount explains the recovery path');
  check(writes === 0, 'rejected mode switch must not perform recovery writes');
  check(same(await bytes(logName), before), 'mode rejection must preserve WAL bytes');
  if (junk) return;
  const recovered = new OpfsVfs(name, opts);
  await recovered.ready;
  const recoverFd = recovered.openSync('/file');
  check(
    same(recovered.readSync(recoverFd, 4).buffer, new Uint8Array([7, 42, 9, 10])),
    'memory recovery retained pending write',
  );
  void recovered.closeVfs();
  const switched = new OpfsVfs(name, options());
  await switched.ready;
  void switched.closeVfs();
}

async function memoryTail(failPadding: boolean) {
  const name = unique();
  const opts = { ...options(), bufferMode: 'memory' as const };
  let writes = 0;
  let armed = false;
  const state = mount(name, opts, (_tag, method, handle) => {
    if (armed && handle === state.handles.get('data') && method === 'write') {
      writes++;
      if (failPadding && writes === 2) throw new Error('injected padding failure');
    }
  });
  await state.vfs.ready;
  try {
    const fd = state.vfs.openSync('/file', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
    state.vfs.writeSync(fd, new Uint8Array([1, 2, 3, 4, 5, 6, 7]));
    armed = true;
    if (failPadding) {
      let failed = false;
      try {
        state.vfs.syncSync();
      } catch (error) {
        failed = error instanceof Error && error.message === 'injected padding failure';
      }
      check(failed, 'padding failure must propagate');
      check(state.handles.get('dataLog')!.getSize() > 0, 'failed padding must retain the recovery WAL');
    }
    state.vfs.syncSync();
    if (!failPadding) check(writes === 2, 'incomplete physical blocks need padding');
    writes = 0;
    state.vfs.writeSync(fd, new Uint8Array([42]), 1);
    state.vfs.syncSync();
    check(writes === 1, 'a complete physical block must not be written twice');
    state.vfs.closeSync(fd);
  } finally {
    armed = false;
    await state.vfs.closeVfs();
  }
  const disk = new OpfsVfs(name, options());
  await disk.ready;
  try {
    const fd = disk.openSync('/file');
    check(same(disk.readSync(fd, 8).buffer, new Uint8Array([1, 42, 3, 4, 5, 6, 7])), 'partial tail survived');
    disk.closeSync(fd);
  } finally {
    await disk.closeVfs();
  }
}

self.onmessage = async ({ data }) => {
  try {
    if (data.scenario === 'logTail') await logTail(data.torn, data.failure);
    else if (data.scenario === 'existingGrowth') await existingGrowth();
    else if (data.scenario === 'fragmented') await fragmentedAllocation(data.checkpoint);
    else if (data.scenario === 'allocation') await allocation(data.phase, data.quota);
    else if (data.scenario === 'memoryTail') await memoryTail(data.failPadding);
    else await modeSwitch(data.junk);
    await Promise.all(volumes.map(deleteVolume));
    self.postMessage({ ok: true });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? `${error.message}\n${error.stack}` : String(error) });
  }
};
