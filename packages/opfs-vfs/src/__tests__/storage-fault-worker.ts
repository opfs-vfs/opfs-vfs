import { testPlugin } from './test-plugin';
import { deleteVolume } from '../index';
import { OpenFlags, OpfsVfs } from '../opfs-vfs';
import type { VolumeStorageFactory } from '../storage-contract';

type Phase = 'payload' | 'padding' | 'metadata' | 'checkpoint';
const create = OpenFlags.O_CREAT | OpenFlags.O_RDWR;
const volumes: string[] = [];

function check(value: boolean, message: string): asserts value {
  if (!value) throw new Error(message);
}

function equal(actual: Uint8Array, expected: Uint8Array, label: string) {
  check(actual.length === expected.length && actual.every((byte, i) => byte === expected[i]), label);
}

function rawBytes(handle: FileSystemSyncAccessHandle) {
  const bytes = new Uint8Array(handle.getSize());
  check(handle.read(bytes, { at: 0 }) === bytes.length, 'snapshot must read the entire OPFS file');
  return bytes;
}

function readExact(vfs: OpfsVfs, path: string, expected: Uint8Array) {
  const fd = vfs.openSync(path);
  try {
    check(vfs.fstatSync(fd).size === expected.length, `${path}: exact file size`);
    const { buffer, read } = vfs.readSync(fd, expected.length + 1, 0);
    check(read === expected.length, `${path}: exact read length`);
    equal(buffer.subarray(0, read), expected, `${path}: exact bytes`);
    check(vfs.readSync(fd, 1, expected.length).read === 0, `${path}: EOF`);
  } finally {
    vfs.closeSync(fd);
  }
}

async function fault(phase: Phase, operation: 'write' | 'flush') {
  const name = `storage-fault-${crypto.randomUUID()}.bin`;
  volumes.push(name);
  const handles = new Map<string, FileSystemSyncAccessHandle>();
  let dataHandle: FileSystemSyncAccessHandle | undefined;
  let armed = false;
  let failures = 0;
  let dataWrites = 0;
  let metaMutations = 0;
  let metaWrites = 0;
  const failure = new DOMException(`injected ${phase} ${operation} failure`, 'InvalidStateError');
  const vfs = new OpfsVfs(name, {
    bufferMode: 'memory',
    localDurabilityMode: 'strict',
    _wrapSyncAccessHandle: (handle, tag) => {
      // init acquires the volume data file first; crypto sidecars also use "data".
      dataHandle ??= handle;
      handles.set(tag, handle);
      return new Proxy(handle, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (key === 'write' || key === 'truncate' || key === 'flush') {
            return (...args: unknown[]) => {
              if (armed) {
                const metadata = tag === 'metaA' || tag === 'metaB' || tag === 'metaLog';
                if (metadata) metaMutations++;
                if (metadata && key === 'write') metaWrites++;
                if (target === dataHandle && key === 'write' && (args[0] as ArrayBufferView).byteLength !== 4096)
                  dataWrites++;
                const inject =
                  (phase === 'payload' &&
                    target === dataHandle &&
                    key === operation &&
                    (operation === 'flush' || (args[0] as ArrayBufferView).byteLength === 4097)) ||
                  (phase === 'padding' &&
                    target === dataHandle &&
                    key === 'write' &&
                    (args[0] as ArrayBufferView).byteLength === 4095) ||
                  (phase === 'metadata' && metadata && key === operation) ||
                  (phase === 'checkpoint' && tag === 'dataLog' && key === operation);
                if (inject) {
                  failures++;
                  throw failure;
                }
              }
              return (value as (...args: unknown[]) => unknown).apply(target, args);
            };
          }
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  });
  await vfs.ready;
  const keep = new Uint8Array(4096).fill(73);
  const expected = Uint8Array.from({ length: 4097 }, (_, i) => (i * 31 + 17) % 251);
  try {
    const keepFd = vfs.openSync('/keep', create);
    vfs.writeSync(keepFd, keep);
    vfs.closeSync(keepFd);
    vfs.syncSync();
    const fd = vfs.openSync('/new', create);
    vfs.writeSync(fd, expected);
    vfs.closeSync(fd);
    const metadataBefore = ['metaA', 'metaB', 'metaLog'].map((tag) => rawBytes(handles.get(tag)!));
    const activeSlot = (vfs as unknown as { activeMetaSlot: number }).activeMetaSlot;
    const walBefore = rawBytes(handles.get('dataLog')!);
    const pendingBefore = vfs.getLocalPersistenceStatusSync().walPendingBytes;
    check(pendingBefore > 0 && walBefore.length > 0, 'fixture must have pending WAL data');
    armed = true;
    let observed: unknown;
    try {
      vfs.flushVfs();
    } catch (error) {
      observed = error;
    }
    armed = false;
    check(observed === failure && failures === 1, `${phase}: the injected exception must reach the caller once`);
    check(
      vfs.getLocalPersistenceStatusSync().localPersistenceState === 'error',
      `${phase}: failure must remain observable`,
    );
    if (phase !== 'checkpoint') {
      check(vfs.getLocalPersistenceStatusSync().walPendingBytes === pendingBefore, `${phase}: pending WAL preserved`);
      equal(rawBytes(handles.get('dataLog')!), walBefore, `${phase}: failed flush must preserve WAL bytes`);
    } else {
      const after = rawBytes(handles.get('dataLog')!);
      check(after.length === 0, 'checkpoint flush failed after truncating the WAL');
    }
    if (phase === 'payload' || phase === 'padding') {
      check(
        dataWrites === (phase === 'payload' && operation === 'write' ? 1 : 2),
        `${phase}: injection hit the intended data write`,
      );
      check(metaMutations === 0, `${phase}: metadata cannot reference incomplete physical blocks`);
      ['metaA', 'metaB', 'metaLog'].forEach((tag, i) =>
        equal(rawBytes(handles.get(tag)!), metadataBefore[i], `${phase}: ${tag} must remain unchanged`),
      );
    } else if (phase === 'metadata') {
      check(dataWrites === 2 && metaWrites === 1, 'metadata failure must follow payload and padding');
      const tag = activeSlot === 0 ? 'metaA' : 'metaB';
      equal(rawBytes(handles.get(tag)!), metadataBefore[activeSlot], 'metadata failure keeps active snapshot');
    } else {
      check(metaWrites > 0, 'checkpoint fault must occur after metadata publication');
      check((vfs as unknown as { activeMetaSlot: number }).activeMetaSlot !== activeSlot, 'snapshot already published');
    }
    vfs.flushVfs();
    check(vfs.getLocalPersistenceStatusSync().localPersistenceState === 'clean', 'retry clears the error state');
    check(vfs.getLocalPersistenceStatusSync().walPendingBytes === 0, 'retry checkpoints pending WAL');
    check(handles.get('dataLog')!.getSize() === 0, 'retry compacts the WAL');
    readExact(vfs, '/new', expected);
    readExact(vfs, '/keep', keep);
  } finally {
    armed = false;
    await vfs.closeVfs();
  }
  for (const bufferMode of ['disk', 'memory'] as const) {
    const reopened = new OpfsVfs(name, { bufferMode });
    await reopened.ready;
    try {
      readExact(reopened, '/new', expected);
      readExact(reopened, '/keep', keep);
    } finally {
      await reopened.closeVfs();
    }
  }
}

async function materialized(blockSize: number, failPayload = false) {
  const name = `storage-materialized-${crypto.randomUUID()}.bin`;
  volumes.push(name);
  let writes = 0;
  let physicalWrites = 0;
  let armed = false;
  const failure = new DOMException('injected transformed payload failure', 'InvalidStateError');
  const storageFactory: VolumeStorageFactory = async ({ data }) => ({
    data: {
      read(buffer, { at }) {
        const count = data.read(buffer, { at });
        const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        for (let i = 0; i < count; i++) bytes[i] ^= 0xa5;
        return count;
      },
      write(buffer, { at }) {
        if (armed) writes++;
        const start = Math.floor(at / blockSize) * blockSize;
        const end = Math.ceil((at + buffer.byteLength) / blockSize) * blockSize;
        const bytes = new Uint8Array(end - start);
        const count = data.read(bytes, { at: start });
        for (let i = 0; i < count; i++) bytes[i] ^= 0xa5;
        bytes.set(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength), at - start);
        for (let i = 0; i < bytes.length; i++) bytes[i] ^= 0xa5;
        if (armed) {
          physicalWrites++;
          if (failPayload && physicalWrites === 1) throw failure;
        }
        data.write(bytes, { at: start });
        return buffer.byteLength;
      },
      getSize: () => data.getSize(),
      truncate: (size) => data.truncate(size),
      flush: () => data.flush(),
      close: () => data.close(),
    },
    destroy() {},
  });
  const vfs = new OpfsVfs(name, { bufferMode: 'memory', plugins: [testPlugin(storageFactory)] });
  await vfs.ready;
  const expected = Uint8Array.from({ length: 4097 }, (_, i) => (i * 13 + 9) % 251);
  try {
    const fd = vfs.openSync('/tail', create);
    vfs.writeSync(fd, expected);
    vfs.closeSync(fd);
    armed = true;
    if (failPayload) {
      let observed: unknown;
      try {
        vfs.syncSync();
      } catch (error) {
        observed = error;
      }
      check(observed === failure && writes === 1, 'transformed payload failure must fire and propagate');
      check(vfs.getLocalPersistenceStatusSync().localPersistenceState === 'error', 'payload failure stays observable');
      check(vfs.getLocalPersistenceStatusSync().walPendingBytes > 0, 'payload failure preserves pending WAL');
    }
    vfs.syncSync();
    armed = false;
    check(
      writes === (failPayload ? 2 : 1),
      `bs=${blockSize}: one payload write, no redundant transformed tail write; got ${writes}`,
    );
    check(physicalWrites === writes, 'count only physical writes through the actual volume data handle');
    const root = await navigator.storage.getDirectory();
    const physical = await (await root.getFileHandle(name)).getFile();
    check(physical.size % blockSize === 0, 'backend materializes complete physical blocks');
    readExact(vfs, '/tail', expected);
  } finally {
    armed = false;
    await vfs.closeVfs();
  }
  for (const bufferMode of ['disk', 'memory'] as const) {
    const reopened = new OpfsVfs(name, { bufferMode, plugins: [testPlugin(storageFactory)] });
    await reopened.ready;
    try {
      readExact(reopened, '/tail', expected);
    } finally {
      await reopened.closeVfs();
    }
  }
}

self.onmessage = async ({ data }) => {
  let result: { ok: true } | { error: string };
  try {
    if (data.phase) await fault(data.phase, data.operation);
    else await materialized(data.blockSize, data.failPayload);
    result = { ok: true };
  } catch (error) {
    result = { error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error) };
  }
  try {
    for (const name of volumes) await deleteVolume(name);
  } catch (error) {
    result = { error: `cleanup failed: ${String(error)}` };
  }
  self.postMessage(result);
};
