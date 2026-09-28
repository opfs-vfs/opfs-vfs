import { OpenFlags, OpfsVfs, type OpfsVfsOptions } from '../opfs-vfs';
import { testPlugin } from './test-plugin';
import { deleteVolume } from '../volume-files';
import type { VolumeStorageFactory } from '../storage-contract';

const volumes: string[] = [];
const unique = () => {
  const name = `audit-${crypto.randomUUID()}.bin`;
  volumes.push(name);
  return name;
};
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const create = OpenFlags.O_CREAT | OpenFlags.O_RDWR;
const BLOCK_SIZE = 4096;

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function bytesEqual(actual: Uint8Array, expected: Uint8Array, message: string) {
  check(actual.length === expected.length && actual.every((byte, i) => byte === expected[i]), message);
}

type ContributedFault = 'short' | 'count' | 'partial-throw' | 'early-eof';

interface ContributedState {
  readonly fault: ContributedFault;
  armed: boolean;
  count?: number;
  calls: number;
  progressed?: boolean;
  eofAt?: number;
  readonly failure?: DOMException;
  readonly writeLengths: number[];
}

function contributedStorage(state: ContributedState): VolumeStorageFactory {
  return async ({ data }) => {
    const transfer = (kind: 'read' | 'write', buffer: ArrayBufferView, at: number) => {
      if (!state.armed) return kind === 'read' ? data.read(buffer, { at }) : data.write(buffer, { at });
      state.calls++;
      if (state.fault === 'count') return state.count!;
      if (state.fault === 'partial-throw' && state.progressed) throw state.failure;
      if (state.fault === 'early-eof' && kind === 'read' && state.eofAt !== undefined) return 0;
      const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      const partial = bytes.subarray(0, Math.min(257, bytes.byteLength));
      if (kind === 'write') state.writeLengths.push(bytes.byteLength);
      const result = kind === 'read' ? data.read(partial, { at }) : data.write(partial, { at });
      if (state.fault === 'partial-throw') state.progressed = true;
      if (state.fault === 'early-eof' && kind === 'read') state.eofAt = at + result;
      return result;
    };
    return {
      data: {
        read: (buffer, { at }) => transfer('read', buffer, at),
        write: (buffer, { at }) => transfer('write', buffer, at),
        getSize: () => state.eofAt ?? data.getSize(),
        truncate: (size) => data.truncate(size),
        flush: () => data.flush(),
        close: () => data.close(),
      },
      destroy() {},
    };
  };
}

function contributedState(fault: ContributedFault, count?: number): ContributedState {
  return {
    fault,
    armed: false,
    count,
    calls: 0,
    failure:
      fault === 'partial-throw' ? new DOMException('contributed data write failed', 'InvalidStateError') : undefined,
    writeLengths: [],
  };
}

function contributedOptions(state: ContributedState, bufferMode: 'disk' | 'memory' = 'disk'): OpfsVfsOptions {
  return {
    bufferMode,
    localDurabilityMode: 'strict',
    plugins: [testPlugin(contributedStorage(state))],
  };
}

async function contributedShortIo() {
  const name = unique();
  const diskState = contributedState('short');
  const expected = new Uint8Array(BLOCK_SIZE * 2 + 4);
  expected[0] = 0xa5;
  expected.set(
    Uint8Array.from({ length: 31 }, (_, i) => i + 1),
    1,
  );
  expected[BLOCK_SIZE * 2 + 3] = 99;
  const disk = new OpfsVfs(name, contributedOptions(diskState));
  await disk.ready;
  try {
    diskState.armed = true;
    const fd = disk.openSync('/data', create);
    disk.writeSync(fd, new Uint8Array(BLOCK_SIZE).fill(expected[0]));
    disk.ftruncateSync(fd, 1);
    disk.writeSync(fd, expected.subarray(1, 32), 1);
    disk.writeSync(fd, expected.subarray(BLOCK_SIZE * 2 + 3), BLOCK_SIZE * 2 + 3); // stale tail and gap must zero
    disk.syncSync();
    bytesEqual(
      disk.readSync(fd, expected.length, 0).buffer,
      expected,
      'short contributed disk read must preserve holes',
    );
    const into = new Uint8Array(expected.length);
    check(disk.readInto(fd, into, 0) === into.length, 'short contributed readInto count');
    bytesEqual(into, expected, 'short contributed readInto bytes');
    disk.closeSync(fd);
    check(diskState.calls > 2, 'contributed data boundary must retry short disk I/O');
  } finally {
    diskState.armed = false;
    await disk.closeVfs();
  }

  const memoryState = contributedState('short');
  memoryState.armed = true;
  const memory = new OpfsVfs(name, contributedOptions(memoryState, 'memory'));
  await memory.ready;
  try {
    const fd = memory.openSync('/data');
    bytesEqual(
      memory.readSync(fd, expected.length, 0).buffer,
      expected,
      'short contributed hydration must preserve bytes',
    );
    memory.closeSync(fd);
    check(memoryState.calls > 1, 'memory hydration must retry contributed short reads');
  } finally {
    memoryState.armed = false;
    await memory.closeVfs();
  }

  const persistName = unique();
  const persistState = contributedState('short');
  const persisted = Uint8Array.from({ length: BLOCK_SIZE + 1 }, (_, i) => i % 251);
  const persistedVfs = new OpfsVfs(persistName, contributedOptions(persistState, 'memory'));
  await persistedVfs.ready;
  try {
    persistState.armed = true;
    const fd = persistedVfs.openSync('/data', create);
    persistedVfs.writeSync(fd, persisted);
    persistedVfs.syncSync();
    persistedVfs.closeSync(fd);
    check(
      persistState.writeLengths.includes(BLOCK_SIZE + 1) && persistState.writeLengths.includes(BLOCK_SIZE - 1),
      'dirty persistence must retry both payload and padding writes',
    );
  } finally {
    persistState.armed = false;
    await persistedVfs.closeVfs();
  }
  const verifyState = contributedState('short');
  verifyState.armed = true;
  const verified = new OpfsVfs(persistName, contributedOptions(verifyState));
  await verified.ready;
  try {
    const fd = verified.openSync('/data');
    bytesEqual(
      verified.readSync(fd, persisted.length, 0).buffer,
      persisted,
      'persisted payload and padding must reopen exactly',
    );
    verified.closeSync(fd);
  } finally {
    verifyState.armed = false;
    await verified.closeVfs();
  }
}

async function contributedInvalidCount(count: number) {
  const state = contributedState('count', count);
  const vfs = new OpfsVfs(unique(), contributedOptions(state));
  await vfs.ready;
  try {
    const fd = vfs.openSync('/data', create);
    vfs.writeSync(fd, new Uint8Array([7]));
    state.armed = true;
    let writeFailed = false;
    let readFailed = false;
    try {
      vfs.writeSync(fd, new Uint8Array([8]), 0);
    } catch {
      writeFailed = true;
    }
    try {
      vfs.readSync(fd, 1, 0);
    } catch {
      readFailed = true;
    }
    check(writeFailed && readFailed && state.calls === 2, `contributed count ${count} must fail once per operation`);
    vfs.closeSync(fd);
  } finally {
    state.armed = false;
    await vfs.closeVfs();
  }
}

async function contributedPartialThrow() {
  const state = contributedState('partial-throw');
  const name = unique();
  const vfs = new OpfsVfs(name, contributedOptions(state));
  await vfs.ready;
  try {
    const fd = vfs.openSync('/data', create);
    vfs.writeSync(fd, new Uint8Array(BLOCK_SIZE).fill(7));
    state.armed = true;
    let observed: unknown;
    try {
      vfs.writeSync(fd, new Uint8Array(512).fill(8), 0);
    } catch (error) {
      observed = error;
    }
    check(observed === state.failure, 'contributed partial write must preserve the original exception');
    check(
      vfs.getLocalPersistenceStatusSync().localPersistenceState === 'error',
      'partial contributed write remains observable',
    );
    vfs.closeSync(fd);
  } finally {
    state.armed = false;
    await vfs.closeVfs();
  }

  const readState = contributedState('partial-throw');
  const reader = new OpfsVfs(name, contributedOptions(readState));
  await reader.ready;
  try {
    readState.armed = true;
    const fd = reader.openSync('/data');
    let observed: unknown;
    try {
      reader.readSync(fd, 512, 0);
    } catch (error) {
      observed = error;
    } finally {
      reader.closeSync(fd);
    }
    check(observed === readState.failure, 'contributed partial read must preserve the original exception');
  } finally {
    readState.armed = false;
    await reader.closeVfs();
  }
}

async function contributedEarlyEof() {
  const name = unique();
  const initial = contributedState('short');
  const source = Uint8Array.from({ length: BLOCK_SIZE }, (_, i) => i % 251);
  const original = new OpfsVfs(name, contributedOptions(initial));
  await original.ready;
  try {
    const fd = original.openSync('/data', create);
    original.writeSync(fd, source);
    original.syncSync();
    original.closeSync(fd);
  } finally {
    await original.closeVfs();
  }

  for (const bufferMode of ['disk', 'memory'] as const) {
    const state = contributedState('early-eof');
    state.armed = true;
    const vfs = new OpfsVfs(name, contributedOptions(state, bufferMode));
    let failed = false;
    try {
      await vfs.ready;
      if (bufferMode === 'disk') {
        const fd = vfs.openSync('/data');
        try {
          vfs.readSync(fd, source.length, 0);
        } finally {
          vfs.closeSync(fd);
        }
      }
    } catch {
      failed = true;
    } finally {
      state.armed = false;
      await vfs.closeVfs();
    }
    check(failed, `${bufferMode} contributed EOF must reject an incomplete backed read`);
  }

  let eofAt: number | undefined;
  const raw = new OpfsVfs(name, {
    _wrapSyncAccessHandle: (handle, tag) => {
      if (tag !== 'data') return handle;
      return new Proxy(handle, {
        get(target, key) {
          if (key === 'read') {
            return (buffer: ArrayBufferView, { at }: { at: number }) => {
              if (eofAt !== undefined) return 0;
              const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength).subarray(0, 257);
              const read = target.read(bytes, { at });
              eofAt = at + read;
              return read;
            };
          }
          if (key === 'getSize') return () => eofAt ?? target.getSize();
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  });
  await raw.ready;
  try {
    const fd = raw.openSync('/data');
    let failed = false;
    try {
      raw.readSync(fd, source.length, 0);
    } catch {
      failed = true;
    } finally {
      raw.closeSync(fd);
    }
    check(failed, 'raw data EOF must reject an incomplete backed read');
  } finally {
    await raw.closeVfs();
  }
}

async function shortIo(mode: 'memory' | 'disk', operation: 'read' | 'write') {
  const name = unique();
  const options: OpfsVfsOptions = {
    bufferMode: mode,
    localDurabilityMode: 'strict',
  };
  let partialCalls = 0;
  const short: OpfsVfsOptions['_wrapSyncAccessHandle'] = (handle) =>
    new Proxy(handle, {
      get(target, key) {
        if (key === operation) {
          return (buffer: ArrayBufferView, at: { at: number }) => {
            const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
            if (bytes.length > 257) partialCalls++;
            return target[operation](bytes.subarray(0, 257), at);
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  const original = Uint8Array.from({ length: 9001 }, (_, i) => (i * 31 + 7) % 251);
  const expected = new Uint8Array(12345);
  expected.set(original);
  expected.set([8, 9, 10], 10000);
  const vfs = new OpfsVfs(name, { ...options, _wrapSyncAccessHandle: operation === 'write' ? short : undefined });
  await vfs.ready;
  try {
    const fd = vfs.openSync('/data', create);
    vfs.writeSync(fd, original);
    vfs.writeSync(fd, new Uint8Array([8, 9, 10]), 10000);
    vfs.ftruncateSync(fd, expected.length);
    vfs.syncSync();
    bytesEqual(vfs.readSync(fd, expected.length, 0).buffer, expected, 'live bytes must match after short I/O');
    vfs.closeSync(fd);
  } finally {
    void vfs.closeVfs();
  }
  const reopened = new OpfsVfs(name, { ...options, _wrapSyncAccessHandle: operation === 'read' ? short : undefined });
  await reopened.ready;
  try {
    const fd = reopened.openSync('/data');
    bytesEqual(reopened.readSync(fd, expected.length, 0).buffer, expected, 'remounted bytes must match');
    check(partialCalls > 0, 'fault injection must perform partial I/O');
    reopened.closeSync(fd);
  } finally {
    void reopened.closeVfs();
  }
  return { partialCalls };
}

async function invalidWriteCount(count: number) {
  let armed = false;
  let attempts = 0;
  const vfs = new OpfsVfs(unique(), {
    bufferMode: 'disk',
    _wrapSyncAccessHandle: (handle, tag) =>
      new Proxy(handle, {
        get(target, key) {
          if (key === 'write' && tag === 'data') {
            return (buffer: AllowSharedBufferSource, options?: FileSystemReadWriteOptions) => {
              if (armed) {
                attempts++;
                return count;
              }
              return target.write(buffer, options);
            };
          }
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
  });
  await vfs.ready;
  try {
    const fd = vfs.openSync('/data', create);
    vfs.writeSync(fd, new Uint8Array(4096).fill(5));
    armed = true;
    let failed = false;
    try {
      vfs.writeSync(fd, new Uint8Array(4096).fill(8), 0);
    } catch {
      failed = true;
    }
    check(failed, `write must reject invalid byte count ${count}`);
    check(attempts === 1, 'invalid progress must fail without spinning');
  } finally {
    armed = false;
    void vfs.closeVfs();
  }
}

async function hardLinks() {
  const name = unique();
  const original = new OpfsVfs(name);
  await original.ready;
  const fd = original.openSync('/a', create);
  original.writeSync(fd, encoder.encode('original'));
  original.linkSync('/a', '/b');
  original.closeSync(fd);
  void original.closeVfs();

  let dataReads = 0;
  const vfs = new OpfsVfs(name, {
    bufferMode: 'memory',
    _wrapSyncAccessHandle: (handle, tag) =>
      new Proxy(handle, {
        get(target, key) {
          if (tag === 'data' && key === 'read') {
            return (buffer: AllowSharedBufferSource, options?: FileSystemReadWriteOptions) => {
              dataReads++;
              return target.read(buffer, options);
            };
          }
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
  });
  await vfs.ready;
  try {
    const a = vfs.openSync('/a', OpenFlags.O_RDWR);
    const b = vfs.openSync('/b', OpenFlags.O_RDWR);
    vfs.writeSync(a, encoder.encode('changed!'), 0);
    check(decoder.decode(vfs.readSync(b, 8, 0).buffer) === 'changed!', 'open alias descriptor must see overwrite');
    vfs.writeSync(b, encoder.encode('aliased!'), 0);
    check(decoder.decode(vfs.readSync(a, 8, 0).buffer) === 'aliased!', 'alias writes must update original descriptor');
    check(dataReads === 1, `one data read per inode expected, got ${dataReads}`);
    vfs.closeSync(a);
    vfs.closeSync(b);
  } finally {
    void vfs.closeVfs();
  }
  const reopened = new OpfsVfs(name);
  await reopened.ready;
  try {
    const fd = reopened.openSync('/a');
    check(decoder.decode(reopened.readSync(fd, 8).buffer) === 'aliased!', 'alias writes must survive another remount');
    reopened.closeSync(fd);
  } finally {
    void reopened.closeVfs();
  }
  return { dataReads };
}

self.onmessage = async ({ data }) => {
  try {
    const result =
      data.scenario === 'contributedShortIo'
        ? await contributedShortIo()
        : data.scenario === 'contributedInvalidCount'
          ? await contributedInvalidCount(data.count)
          : data.scenario === 'contributedPartialThrow'
            ? await contributedPartialThrow()
            : data.scenario === 'contributedEarlyEof'
              ? await contributedEarlyEof()
              : data.scenario === 'hardLinks'
                ? await hardLinks()
                : data.scenario === 'invalidWriteCount'
                  ? await invalidWriteCount(data.count)
                  : await shortIo(data.mode, data.operation);
    await Promise.all(volumes.map(deleteVolume));
    self.postMessage({ result });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
