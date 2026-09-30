import { ByteSize, Deferred, Effect, Exit, Fiber, Option as EffectOption, Scope } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VfsCommandError } from '@opfs-vfs/opfs-vfs/worker';
import type { VfsDirEntry, VfsStat } from '@opfs-vfs/opfs-vfs';
import type { OpfsVfsWorkerClient, ClientStatus } from '@opfs-vfs/opfs-vfs/worker-client';
import type { VfsPluginRequest } from '@opfs-vfs/opfs-vfs/plugins';
import { Volume } from './index.js';
import { OpfsFileSystem } from './filesystem.js';
import type { WorkerMountOptions } from './volume.js';
import { EncryptionError, VolumeError } from './errors.js';

const workerMocks = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('@opfs-vfs/opfs-vfs/worker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@opfs-vfs/opfs-vfs/worker')>()),
  openOpfsVfsWorker: workerMocks.open,
}));

const status = (overrides: Partial<ClientStatus> = {}): ClientStatus => ({
  fileName: 'worker.bin',
  transport: 'dedicated',
  fallbackReason: null,
  state: 'ready',
  role: 'leader',
  ownerGeneration: 'generation-1',
  error: null,
  persistence: null,
  ...overrides,
});

class FakeWorkerClient {
  current: ClientStatus;
  listeners = new Set<() => void>();
  closeCalls = 0;
  generations: string[] = [];
  onSubscribe: (() => void) | undefined;
  onClose: (() => Promise<void>) | undefined;
  onSync: (() => Promise<void>) | undefined;
  onWriteFileBuffer: ((generation: string, path: string, bytes: Uint8Array) => Promise<void>) | undefined;
  onReadFileBuffer: ((generation: string, path: string) => Promise<Uint8Array>) | undefined;
  onDescriptorWrite: (() => Promise<void>) | undefined;
  onDescriptorRead: (() => Promise<void>) | undefined;
  onDescriptorOpen: (() => Promise<void>) | undefined;
  onNamespaceCommand: ((generation: string, method: string, args: ReadonlyArray<unknown>) => Promise<void>) | undefined;
  afterDescriptorWrite: (() => void) | undefined;
  maxWrite = Number.POSITIVE_INFINITY;
  writes: Array<{ generation: string; path: string }> = [];
  reads: Array<{ generation: string; path: string; limit: number }> = [];
  descriptorCalls: Array<{ generation: string; method: string }> = [];
  descriptorWriteLengths: number[] = [];
  namespaceCalls: Array<{ generation: string; method: string; args: ReadonlyArray<unknown> }> = [];
  pathStats = new Map<string, VfsStat>();
  directoryEntries = new Map<string, Array<VfsDirEntry>>();
  linkTarget = '../target';
  bytes = new Uint8Array();
  nextFd = 1;
  openFlags = new Map<number, number>();
  syncCalls = 0;
  readonly ready: Promise<void>;
  resolveReady!: () => void;
  rejectReady!: (error: unknown) => void;

  constructor(initial: ClientStatus = status()) {
    this.current = initial;
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    void this.ready.catch(() => {});
    if (initial.state === 'ready') this.resolveReady();
  }

  getStatus() {
    return this.current;
  }

  subscribeStatus(listener: () => void) {
    this.listeners.add(listener);
    this.onSubscribe?.();
    return () => this.listeners.delete(listener);
  }

  publish(next: Partial<ClientStatus>) {
    this.current = Object.freeze({ ...this.current, ...next });
    for (const listener of [...this.listeners]) queueMicrotask(listener);
    if (this.current.state === 'ready') this.resolveReady();
    if (this.current.state === 'failed' || this.current.state === 'closed') this.rejectReady(this.current.error);
  }

  forGeneration(generation: string) {
    this.generations.push(generation);
    const ensureOwner = () => {
      if (this.current.ownerGeneration !== generation)
        throw new VfsCommandError(
          Object.assign(new Error('Owner changed'), { code: 'VFS_ATTACHMENT_LOST' }),
          'refused',
        );
    };
    const namespace = async (method: string, ...args: ReadonlyArray<unknown>) => {
      ensureOwner();
      this.namespaceCalls.push({ generation, method, args });
      await this.onNamespaceCommand?.(generation, method, args);
    };
    const statPath = (path: string): VfsStat =>
      this.pathStats.get(path) ?? {
        mode: 0o100644,
        size: 3,
        ino: 1,
        nlink: 1,
        blksize: 4096,
        blocks: 1,
        is_file: true,
        is_dir: false,
        mtimeMs: 1000,
        atimeMs: 2000,
      };
    return {
      stat: async (path: string) => {
        await namespace('stat', path);
        return statPath(path);
      },
      lstat: async (path: string) => {
        await namespace('lstat', path);
        return statPath(path);
      },
      readdirEntries: async (path: string) => {
        await namespace('readdirEntries', path);
        return this.directoryEntries.get(path) ?? [];
      },
      mkdir: async (path: string, options?: unknown) => namespace('mkdir', path, options),
      chmod: async (path: string, mode: number) => namespace('chmod', path, mode),
      utimes: async (path: string, atimeMs: number, mtimeMs: number) => namespace('utimes', path, atimeMs, mtimeMs),
      link: async (existingPath: string, newPath: string) => namespace('link', existingPath, newPath),
      symlink: async (target: string, path: string) => namespace('symlink', target, path),
      readlink: async (path: string) => {
        await namespace('readlink', path);
        return this.linkTarget;
      },
      realpath: async (path: string) => {
        await namespace('realpath', path);
        return path.replace(/\/$/, '') || '/';
      },
      unlink: async (path: string) => namespace('unlink', path),
      rmdir: async (path: string) => namespace('rmdir', path),
      remove: async (path: string) => namespace('remove', path),
      rename: async (oldPath: string, newPath: string) => namespace('rename', oldPath, newPath),
      truncate: async (path: string, size: number) => namespace('truncate', path, size),
      open: async (_path: string, flags = 0) => {
        ensureOwner();
        this.descriptorCalls.push({ generation, method: 'open' });
        await this.onDescriptorOpen?.();
        const fd = this.nextFd++;
        this.openFlags.set(fd, flags);
        return fd;
      },
      close: async (fd: number) => {
        this.descriptorCalls.push({ generation, method: 'close' });
        this.openFlags.delete(fd);
      },
      fstat: async (_fd: number) => {
        this.descriptorCalls.push({ generation, method: 'fstat' });
        return {
          mode: 0o100666,
          size: this.bytes.length,
          ino: 1,
          nlink: 1,
          blksize: 4096,
          blocks: 1,
          is_file: true,
          is_dir: false,
        };
      },
      read: async (_fd: number, size: number, offset = 0) => {
        ensureOwner();
        await this.onDescriptorRead?.();
        this.descriptorCalls.push({ generation, method: 'read' });
        const buffer = this.bytes.slice(offset, offset + size);
        return { buffer, read: buffer.length };
      },
      write: async (fd: number, data: Uint8Array, offset?: number) => {
        ensureOwner();
        await this.onDescriptorWrite?.();
        this.descriptorCalls.push({ generation, method: 'write' });
        this.descriptorWriteLengths.push(data.byteLength);
        const part = data.subarray(0, Math.min(data.byteLength, this.maxWrite));
        if ((this.openFlags.get(fd) ?? 0) & 1024) this.bytes = Uint8Array.from([...this.bytes, ...part]);
        else {
          const at = offset ?? 0;
          const result = new Uint8Array(Math.max(this.bytes.length, at + part.length));
          result.set(this.bytes);
          result.set(part, at);
          this.bytes = result;
        }
        this.afterDescriptorWrite?.();
        return part.length;
      },
      ftruncate: async (_fd: number, size: number) => {
        ensureOwner();
        this.descriptorCalls.push({ generation, method: 'ftruncate' });
        const result = new Uint8Array(size);
        result.set(this.bytes.subarray(0, size));
        this.bytes = result;
      },
      fsync: async (_fd: number) => {
        ensureOwner();
        this.descriptorCalls.push({ generation, method: 'fsync' });
        this.syncCalls++;
      },
      sync: () => {
        this.syncCalls++;
        return this.onSync?.() ?? Promise.resolve();
      },
      writeFileBuffer: (path: string, bytes: Uint8Array) => {
        this.writes.push({ generation, path });
        return this.onWriteFileBuffer?.(generation, path, bytes) ?? Promise.resolve();
      },
      readFileBuffer: (path: string, limit = 16 * 1024 * 1024) => {
        this.reads.push({ generation, path, limit });
        return this.onReadFileBuffer?.(generation, path) ?? Promise.resolve(new Uint8Array());
      },
    };
  }

  closeVfs() {
    this.closeCalls++;
    return this.onClose?.() ?? Promise.resolve();
  }

  dispose() {
    return this.closeVfs();
  }
}

const clientAsCore = (client: FakeWorkerClient) => client as unknown as OpfsVfsWorkerClient;
const mount = (options: Partial<WorkerMountOptions> = {}) => ({ fileName: 'worker.bin', ...options });
const waitUntil = async (predicate: () => boolean) => {
  await vi.waitFor(() => expect(predicate()).toBe(true));
};

describe('Volume worker acquisition and sessions', () => {
  beforeEach(() => {
    workerMocks.open.mockReset();
  });

  it('routes large whole-file writes through copied, generation-pinned descriptors', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const source = new Uint8Array(16 * 1024 * 1024 + 1);
    source.fill(37);
    client.onDescriptorWrite = async () => {
      source.fill(0);
      client.onDescriptorWrite = undefined;
    };
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          yield* OpfsFileSystem.make(volume).writeFile('/large', source);
        }),
      ),
    );
    expect(source.every((value) => value === 0)).toBe(true);
    expect(client.bytes.byteLength).toBe(source.byteLength);
    expect(client.bytes.every((value) => value === 37)).toBe(true);
    expect(client.writes).toEqual([]);
    expect(client.descriptorWriteLengths).toEqual([...Array(256).fill(64 * 1024), 1]);
    expect(client.descriptorCalls.every(({ generation }) => generation === 'generation-1')).toBe(true);
    expect(client.descriptorCalls[0]).toEqual({ generation: 'generation-1', method: 'open' });
    expect(client.descriptorCalls.at(-1)).toEqual({ generation: 'generation-1', method: 'close' });
    expect(client.descriptorCalls.filter(({ method }) => method === 'write')).toHaveLength(257);
  });

  it('bounds writeAll dispatches after short writes', async () => {
    const client = new FakeWorkerClient();
    client.maxWrite = 32 * 1024;
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const source = new Uint8Array(64 * 1024 + 1);
    source.fill(37);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          const file = yield* OpfsFileSystem.make(volume).open('/short', { flag: 'w' });
          yield* file.writeAll(source);
        }),
      ),
    );
    expect(client.descriptorWriteLengths).toEqual([64 * 1024, 32 * 1024 + 1, 1]);
    expect(client.bytes).toEqual(source);
  });

  it('keeps an open File pinned to its owner and closes it through that owner after takeover', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          const opened = yield* OpfsFileSystem.make(volume).open('/note', { flag: 'r+' });
          client.publish({ ownerGeneration: 'generation-2' });
          const failed = yield* Effect.result(opened.write(new Uint8Array([1])));
          return failed;
        }),
      ),
    );
    expect(result._tag).toBe('Failure');
    expect(client.descriptorCalls.map(({ generation, method }) => [generation, method])).toEqual([
      ['generation-1', 'open'],
      ['generation-1', 'close'],
    ]);
  });

  it('joins a pending OPEN cleanup before releasing its volume', async () => {
    const client = new FakeWorkerClient();
    let started = false;
    let resolveOpen!: () => void;
    const openGate = new Promise<void>((resolve) => {
      resolveOpen = resolve;
    });
    client.onDescriptorOpen = async () => {
      started = true;
      await openGate;
    };
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const volumeScope = Scope.makeUnsafe('sequential');
    const callerScope = Scope.makeUnsafe('sequential');
    await Effect.runPromise(
      Effect.gen(function* () {
        const volume = yield* Effect.provideService(Volume.make(mount()), Scope.Scope, volumeScope);
        const opening = yield* Effect.forkChild(
          Effect.provideService(OpfsFileSystem.make(volume).open('/pending', { flag: 'r+' }), Scope.Scope, callerScope),
        );
        yield* Effect.sleep(0);
        expect(started).toBe(true);
        const closing = yield* Effect.forkChild(Scope.close(volumeScope, Exit.void));
        yield* Effect.sleep(0);
        expect(client.closeCalls).toBe(0);
        resolveOpen();
        const opened = yield* Fiber.await(opening);
        expect(opened).toMatchObject({
          _tag: 'Failure',
          cause: { reasons: [{ error: { reason: { _tag: 'BadResource' } } }] },
        });
        yield* Fiber.join(closing);
        expect(client.descriptorCalls.map(({ generation, method }) => [generation, method])).toEqual([
          ['generation-1', 'open'],
          ['generation-1', 'close'],
        ]);
      }),
    );
    await Effect.runPromise(Scope.close(callerScope, Exit.void));
    expect(client.closeCalls).toBe(1);
  });

  it('falls back from EFBIG whole-file helper reads to descriptors on the same generation', async () => {
    const client = new FakeWorkerClient();
    client.bytes = new TextEncoder().encode('descriptor fallback');
    client.onReadFileBuffer = async () => {
      throw Object.assign(new Error('helper limit'), { code: 'EFBIG' });
    };
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          return yield* OpfsFileSystem.make(volume).readFile('/note');
        }),
      ),
    );
    expect(new TextDecoder().decode(result)).toBe('descriptor fallback');
    expect(client.reads.map(({ generation }) => generation)).toEqual(['generation-1']);
    expect(client.descriptorCalls.map(({ generation, method }) => [generation, method])).toEqual([
      ['generation-1', 'open'],
      ['generation-1', 'fstat'],
      ['generation-1', 'read'],
      ['generation-1', 'close'],
    ]);
  });

  it('reads large whole files through bounded descriptor requests', async () => {
    const client = new FakeWorkerClient();
    client.bytes = new Uint8Array(16 * 1024 * 1024 + 1);
    client.bytes.fill(23);
    client.onReadFileBuffer = async () => {
      throw Object.assign(new Error('helper limit'), { code: 'EFBIG' });
    };
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          return yield* OpfsFileSystem.make(volume).readFile('/large');
        }),
      ),
    );
    expect(result.byteLength).toBe(16 * 1024 * 1024 + 1);
    expect(result[0]).toBe(23);
    expect(result.at(-1)).toBe(23);
    expect(client.descriptorCalls.filter(({ method }) => method === 'read')).toHaveLength(257);
    expect(client.descriptorCalls.at(-1)?.method).toBe('close');
  });

  it('lets a queued cursor operation be interrupted while an earlier read is held', async () => {
    const client = new FakeWorkerClient();
    client.bytes = new Uint8Array([1, 2]);
    const entered = await Effect.runPromise(Deferred.make<void>());
    const resume = await Effect.runPromise(Deferred.make<void>());
    client.onDescriptorRead = async () => {
      await Effect.runPromise(Deferred.succeed(entered, undefined));
      await Effect.runPromise(Deferred.await(resume));
    };
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          const opened = yield* OpfsFileSystem.make(volume).open('/note', { flag: 'r' });
          const active = yield* Effect.forkChild(opened.readAlloc(1));
          yield* Deferred.await(entered);
          const queued = yield* Effect.forkChild(Effect.exit(opened.readAlloc(1)));
          yield* Effect.sleep(0);
          yield* Fiber.interrupt(queued);
          const exit = yield* Fiber.await(queued);
          expect(exit._tag).toBe('Failure');
          if (exit._tag === 'Failure')
            expect(exit.cause.reasons.some((reason) => reason._tag === 'Interrupt')).toBe(true);
          yield* Deferred.succeed(resume, undefined);
          const first = yield* Fiber.join(active);
          expect(first).toMatchObject({ _tag: 'Some', value: new Uint8Array([1]) });
        }),
      ),
    );
  });

  it('routes namespace methods through the pinned worker facade and preserves relative symlink targets', async () => {
    const client = new FakeWorkerClient();
    client.linkTarget = '../dangling';
    client.pathStats.set('/meta', {
      mode: 0o100640,
      size: 12,
      ino: 7,
      nlink: 2,
      blksize: 4096,
      blocks: 1,
      is_file: true,
      is_dir: false,
      mtimeMs: 1000,
      atimeMs: 2000,
    });
    client.pathStats.set('/malformed', {
      mode: 0o100644,
      size: Number.MAX_SAFE_INTEGER + 1,
      ino: 1,
      nlink: 1,
      blksize: 4096,
      blocks: 1,
      is_file: true,
      is_dir: false,
    });
    client.directoryEntries.set('/tree', [
      { name: 'z', mode: 0o100644, is_dir: false, is_file: true },
      { name: 'dir', mode: 0o040755, is_dir: true, is_file: false },
      { name: 'link', mode: 0o120777, is_dir: false, is_file: false },
      { name: 'a', mode: 0o100644, is_dir: false, is_file: true },
    ]);
    client.directoryEntries.set('/tree/dir', [{ name: 'nested', mode: 0o100644, is_dir: false, is_file: true }]);
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          const fs = OpfsFileSystem.make(volume);
          yield* fs.makeDirectory('/tree/new/deep', { recursive: true, mode: 0o750 });
          yield* fs.chmod('/meta', 0o600);
          yield* fs.link('/meta', '/meta-hard');
          yield* fs.symlink('../dangling', '/tree/link-new');
          const link = yield* fs.readLink('/tree/link-new');
          const real = yield* fs.realPath('/tree/');
          yield* fs.rename('/meta-hard', '/meta-moved');
          yield* fs.truncate('/meta-moved', 4);
          yield* fs.utimes('/meta', 1.25, new Date(2500));
          yield* fs.access('/meta', { readable: true, writable: true });
          const info = yield* fs.stat('/meta');
          const malformed = yield* Effect.result(fs.stat('/malformed'));
          const tree = yield* fs.readDirectory('/tree', { recursive: true });
          return { info, malformed, tree, link, real };
        }),
      ),
    );
    expect(result).toMatchObject({
      info: {
        type: 'File',
        dev: 0,
        mode: 0o100640,
        size: ByteSize.bytes(12n),
        ino: EffectOption.some(7),
        nlink: EffectOption.some(2),
        blksize: EffectOption.some(ByteSize.bytes(4096n)),
        blocks: EffectOption.some(1),
        atime: EffectOption.some(new Date(2000)),
        mtime: EffectOption.some(new Date(1000)),
        uid: EffectOption.none(),
        gid: EffectOption.none(),
        rdev: EffectOption.none(),
        birthtime: EffectOption.none(),
      },
      tree: ['a', 'dir', 'dir/nested', 'link', 'z'],
      link: '../dangling',
      real: '/tree',
    });
    expect(client.namespaceCalls.map(({ method, args }) => [method, ...args])).toEqual([
      ['mkdir', '/tree/new/deep', { mode: 0o750, recursive: true }],
      ['chmod', '/meta', 0o600],
      ['link', '/meta', '/meta-hard'],
      ['symlink', '../dangling', '/tree/link-new'],
      ['readlink', '/tree/link-new'],
      ['realpath', '/tree/'],
      ['rename', '/meta-hard', '/meta-moved'],
      ['truncate', '/meta-moved', 4],
      ['utimes', '/meta', 1250, 2500],
      ['stat', '/meta'],
      ['stat', '/meta'],
      ['stat', '/malformed'],
      ['readdirEntries', '/tree'],
      ['readdirEntries', '/tree/dir'],
    ]);
    expect(result.malformed).toMatchObject({ _tag: 'Failure', failure: { reason: { _tag: 'BadArgument' } } });
    expect(Object.hasOwn(result.info, 'ctime')).toBe(false);
  });

  it('validates every namespace path before worker dispatch and rejects malformed timestamps', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          const fs = OpfsFileSystem.make(volume);
          for (const operation of [
            fs.access('relative'),
            fs.chmod('relative', 0o600),
            fs.makeDirectory('relative'),
            fs.readLink('relative'),
            fs.realPath('relative'),
            fs.remove('relative'),
            fs.stat('relative'),
            fs.truncate('relative'),
            fs.utimes('relative', 1, 1),
            fs.link('relative', '/destination'),
            fs.rename('relative', '/destination'),
            fs.rename('/source', 'relative'),
            fs.link('/source', 'relative'),
            fs.symlink('../target', 'relative'),
            fs.readDirectory('relative'),
            fs.chown('relative', 1, 1),
            fs.glob('**/*.txt', { root: 'relative' }),
            fs.utimes('/file', '1' as unknown as number, 1),
            fs.utimes('/file', Symbol('time') as unknown as number, 1),
            fs.utimes('/file', Number.NaN, 1),
            fs.utimes('/file', Number.POSITIVE_INFINITY, 1),
            fs.utimes('/file', new Date(Number.NaN), 1),
            fs.utimes('/file', 8.64e12 + 1, 1),
          ]) {
            const result = yield* Effect.result(operation);
            expect(result._tag).toBe('Failure');
          }
          const unsupportedGlob = yield* Effect.result(fs.glob('**/*.txt'));
          expect(unsupportedGlob).toMatchObject({
            _tag: 'Failure',
            failure: {
              reason: { _tag: 'Unknown', cause: { _tag: 'VolumeError', kind: 'unsupported', code: 'ENOTSUP' } },
            },
          });
          const unsupportedChown = yield* Effect.result(fs.chown('/file', 1, 1));
          expect(unsupportedChown).toMatchObject({
            _tag: 'Failure',
            failure: {
              reason: { _tag: 'Unknown', cause: { _tag: 'VolumeError', kind: 'unsupported', code: 'ENOTSUP' } },
            },
          });
        }),
      ),
    );
    expect(client.namespaceCalls).toEqual([]);
  });

  it('uses one pinned generation for recursive listing and nonrecursive remove', async () => {
    const client = new FakeWorkerClient();
    client.directoryEntries.set('/tree', [{ name: 'dir', mode: 0o040755, is_dir: true, is_file: false }]);
    client.directoryEntries.set('/tree/dir', [{ name: 'child', mode: 0o100644, is_dir: false, is_file: true }]);
    client.pathStats.set('/tree/dir', {
      mode: 0o040755,
      size: 0,
      ino: 2,
      nlink: 2,
      blksize: 4096,
      blocks: 0,
      is_dir: true,
      is_file: false,
    });
    let reads = 0;
    client.onNamespaceCommand = async (_generation, method) => {
      if (method === 'readdirEntries' && ++reads === 1) client.publish({ ownerGeneration: 'generation-2' });
    };
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          return yield* Effect.result(OpfsFileSystem.make(volume).readDirectory('/tree', { recursive: true }));
        }),
      ),
    );
    expect(result._tag).toBe('Failure');
    expect(client.namespaceCalls.map(({ generation, method }) => [generation, method])).toEqual([
      ['generation-1', 'readdirEntries'],
    ]);

    const removal = new FakeWorkerClient();
    removal.pathStats.set('/dir', {
      mode: 0o040755,
      size: 0,
      ino: 2,
      nlink: 2,
      blksize: 4096,
      blocks: 0,
      is_dir: true,
      is_file: false,
    });
    workerMocks.open.mockResolvedValue(clientAsCore(removal));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          yield* OpfsFileSystem.make(volume).remove('/dir');
        }),
      ),
    );
    expect(removal.namespaceCalls.map(({ generation, method }) => [generation, method])).toEqual([
      ['generation-1', 'lstat'],
      ['generation-1', 'rmdir'],
    ]);
  });

  it('interrupts a recursive listing before a late directory reply can dispatch its child', async () => {
    const client = new FakeWorkerClient();
    client.directoryEntries.set('/tree', [{ name: 'child', mode: 0o040755, is_dir: true, is_file: false }]);
    client.directoryEntries.set('/tree/child', []);
    const entered = await Effect.runPromise(Deferred.make<void>());
    const resume = await Effect.runPromise(Deferred.make<void>());
    client.onNamespaceCommand = async (_generation, method, args) => {
      if (method === 'readdirEntries' && args[0] === '/tree') {
        await Effect.runPromise(Deferred.succeed(entered, undefined));
        await Effect.runPromise(Deferred.await(resume));
      }
    };
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = OpfsFileSystem.make(yield* Volume.make(mount()));
          const listing = yield* Effect.forkChild(Effect.exit(fs.readDirectory('/tree', { recursive: true })));
          yield* Deferred.await(entered);
          yield* Fiber.interrupt(listing);
          const exit = yield* Fiber.await(listing);
          expect(exit._tag).toBe('Failure');
          if (exit._tag === 'Failure')
            expect(exit.cause.reasons.some((reason) => reason._tag === 'Interrupt')).toBe(true);
          yield* Deferred.succeed(resume, undefined);
          yield* Effect.sleep(0);
        }),
      ),
    );
    expect(client.namespaceCalls.map(({ args }) => args[0])).toEqual(['/tree']);
  });

  it('does not dispatch the next recursive directory read after its volume closes', async () => {
    const client = new FakeWorkerClient();
    client.directoryEntries.set('/tree', [{ name: 'child', mode: 0o040755, is_dir: true, is_file: false }]);
    client.directoryEntries.set('/tree/child', []);
    const entered = await Effect.runPromise(Deferred.make<void>());
    const resume = await Effect.runPromise(Deferred.make<void>());
    client.onNamespaceCommand = async (_generation, method, args) => {
      if (method === 'readdirEntries' && args[0] === '/tree') {
        await Effect.runPromise(Deferred.succeed(entered, undefined));
        await Effect.runPromise(Deferred.await(resume));
      }
    };
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const volumeScope = Scope.makeUnsafe('sequential');
    await Effect.runPromise(
      Effect.gen(function* () {
        const volume = yield* Effect.provideService(Volume.make(mount()), Scope.Scope, volumeScope);
        const listing = yield* Effect.forkChild(
          Effect.exit(OpfsFileSystem.make(volume).readDirectory('/tree', { recursive: true })),
        );
        yield* Deferred.await(entered);
        yield* Scope.close(volumeScope, Exit.void);
        yield* Deferred.succeed(resume, undefined);
        const exit = yield* Fiber.join(listing);
        expect(exit._tag).toBe('Failure');
      }),
    );
    expect(client.namespaceCalls.map(({ args }) => args[0])).toEqual(['/tree']);
  });

  it('gives a reused directory listing effect a fresh readiness budget', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount({ initTimeout: 200 }));
          const listing = OpfsFileSystem.make(volume).readDirectory('/tree');
          for (const delay of [140, 100]) {
            client.publish({ state: 'recovering', ownerGeneration: null });
            const timer = setTimeout(() => client.publish({ state: 'ready', ownerGeneration: 'generation-1' }), delay);
            const result = yield* Effect.result(listing);
            clearTimeout(timer);
            client.publish({ state: 'ready', ownerGeneration: 'generation-1' });
            expect(result._tag).toBe('Success');
          }
        }),
      ),
    );
  });

  it('keeps force removal narrow and refuses a delete after takeover between lstat and unlink', async () => {
    const client = new FakeWorkerClient();
    client.onNamespaceCommand = async (_generation, method, args) => {
      const path = args[0];
      if (method === 'lstat' && path === '/missing') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      if (method === 'unlink' && path === '/gone') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      if (method === 'unlink' && path === '/denied') throw Object.assign(new Error('denied'), { code: 'EACCES' });
    };
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          const fs = OpfsFileSystem.make(volume);
          yield* fs.remove('/missing', { force: true });
          yield* fs.remove('/gone', { force: true });
          const denied = yield* Effect.result(fs.remove('/denied', { force: true }));
          return denied;
        }),
      ),
    );
    expect(result).toMatchObject({ _tag: 'Failure', failure: { reason: { _tag: 'PermissionDenied' } } });
    expect(client.namespaceCalls.map(({ method, args }) => [method, ...args])).toEqual([
      ['lstat', '/missing'],
      ['lstat', '/gone'],
      ['unlink', '/gone'],
      ['lstat', '/denied'],
      ['unlink', '/denied'],
    ]);

    const stale = new FakeWorkerClient();
    stale.onNamespaceCommand = async (_generation, method) => {
      if (method === 'lstat') stale.publish({ ownerGeneration: 'generation-2' });
    };
    workerMocks.open.mockResolvedValue(clientAsCore(stale));
    const staleResult = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          return yield* Effect.result(OpfsFileSystem.make(volume).remove('/entry'));
        }),
      ),
    );
    expect(staleResult._tag).toBe('Failure');
    expect(stale.namespaceCalls.map(({ generation, method }) => [generation, method])).toEqual([
      ['generation-1', 'lstat'],
    ]);
  });

  it('tracks namespace mutation outcomes without retrying sent or replied commands', async () => {
    for (const dispatch of ['refused', 'sent', 'replied'] as const) {
      const client = new FakeWorkerClient();
      client.onNamespaceCommand = async (_generation, method) => {
        if (method === 'mkdir')
          throw new VfsCommandError(Object.assign(new Error('mkdir failed'), { code: 'EIO' }), dispatch);
      };
      workerMocks.open.mockResolvedValue(clientAsCore(client));
      const sync = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const volume = yield* Volume.make(mount());
            const failed = yield* Effect.result(OpfsFileSystem.make(volume).makeDirectory('/once'));
            expect(failed._tag).toBe('Failure');
            expect(client.namespaceCalls.map(({ method }) => method)).toEqual(['mkdir']);
            client.publish({ ownerGeneration: 'generation-2' });
            return yield* Effect.result(volume.sync);
          }),
        ),
      );
      expect(sync._tag).toBe(dispatch === 'refused' ? 'Success' : 'Failure');
      if (sync._tag === 'Failure') expect(sync.failure).toMatchObject({ code: 'VFS_SYNC_OWNER_CHANGED' });
    }
  });

  it('uses File.sync as a same-owner persistence barrier', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          const opened = yield* OpfsFileSystem.make(volume).open('/note', { flag: 'w' });
          yield* opened.sync;
          client.publish({ ownerGeneration: 'generation-2' });
          yield* volume.sync;
        }),
      ),
    );
    expect(client.syncCalls).toBe(2);
  });

  it('appends concurrent worker handles at the current EOF', async () => {
    const client = new FakeWorkerClient();
    client.bytes = new TextEncoder().encode('base');
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          const fs = OpfsFileSystem.make(volume);
          const first = yield* fs.open('/note', { flag: 'a' });
          const second = yield* fs.open('/note', { flag: 'a' });
          const one = yield* Effect.forkChild(first.writeAll(new TextEncoder().encode('A')));
          const two = yield* Effect.forkChild(second.writeAll(new TextEncoder().encode('B')));
          yield* Fiber.join(one);
          yield* Fiber.join(two);
        }),
      ),
    );
    expect(new TextDecoder().decode(client.bytes)).toMatch(/^base(?:AB|BA)$/);
  });

  it('keeps partial writeAll progress on its owner and reports it as possibly applied', async () => {
    const client = new FakeWorkerClient();
    client.maxWrite = 1;
    client.afterDescriptorWrite = () => client.publish({ ownerGeneration: 'generation-2' });
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          const opened = yield* OpfsFileSystem.make(volume).open('/note', { flag: 'r+' });
          return yield* Effect.result(opened.writeAll(new Uint8Array([1, 2, 3])));
        }),
      ),
    );
    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: {
        reason: {
          _tag: 'BadResource',
          cause: { _tag: 'VolumeError', operation: 'writeAll', outcome: 'possibly-applied' },
        },
      },
    });
    expect(client.bytes).toEqual(new Uint8Array([1]));
    expect(client.descriptorCalls.map(({ generation, method }) => [generation, method])).toEqual([
      ['generation-1', 'open'],
      ['generation-1', 'write'],
      ['generation-1', 'close'],
    ]);
  });

  it('preserves an integrity failure through partial writeAll aggregation', async () => {
    const client = new FakeWorkerClient();
    client.maxWrite = 1;
    let writes = 0;
    client.onDescriptorWrite = async () => {
      if (++writes === 2)
        throw new VfsCommandError(Object.assign(new Error('integrity'), { code: 'ECRYPTOINTEGRITY' }), 'replied');
    };
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          const opened = yield* OpfsFileSystem.make(volume).open('/note', { flag: 'w' });
          yield* opened.writeAll(new Uint8Array([1, 2]));
        }),
      ),
    );
    if (!Exit.isFailure(exit)) throw new Error('Expected partial write failure');
    const failure = exit.cause.reasons.find((reason) => reason._tag === 'Fail');
    if (failure?._tag !== 'Fail') throw new Error('Expected typed partial write failure');
    expect(failure.error).toMatchObject({ reason: { _tag: 'InvalidData' } });
    expect(Volume.errorOf(failure.error as never) as EncryptionError | undefined).toMatchObject({
      _tag: 'EncryptionError',
      reason: 'IntegrityFailure',
      code: 'ECRYPTOINTEGRITY',
      outcome: 'possibly-applied',
    });
  });

  it('preserves corruption details through partial writeAll aggregation', async () => {
    const client = new FakeWorkerClient();
    client.maxWrite = 1;
    let writes = 0;
    client.onDescriptorWrite = async () => {
      if (++writes === 2)
        throw new VfsCommandError(
          Object.assign(new Error('corrupt'), { code: 'EIO', category: 'meta-log', name: 'VfsCorruptionError' }),
          'replied',
        );
    };
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          const opened = yield* OpfsFileSystem.make(volume).open('/note', { flag: 'w' });
          yield* opened.writeAll(new Uint8Array([1, 2]));
        }),
      ),
    );
    if (!Exit.isFailure(exit)) throw new Error('Expected partial write failure');
    const failure = exit.cause.reasons.find((reason) => reason._tag === 'Fail');
    if (failure?._tag !== 'Fail') throw new Error('Expected typed partial write failure');
    expect(failure.error).toMatchObject({ reason: { _tag: 'InvalidData' } });
    expect(Volume.errorOf(failure.error as never) as VolumeError | undefined).toMatchObject({
      kind: 'corruption',
      code: 'EIO',
      outcome: 'possibly-applied',
      details: { category: 'meta-log' },
    });
  });

  it('preserves a terminal lifecycle wrapper through partial writeAll aggregation', async () => {
    const client = new FakeWorkerClient();
    client.maxWrite = 1;
    const inner = new EncryptionError({
      reason: 'IntegrityFailure',
      fileName: 'worker.bin',
      operation: 'worker',
      code: 'ECRYPTOINTEGRITY',
      outcome: 'unknown',
      details: { message: 'integrity', code: 'ECRYPTOINTEGRITY' },
    });
    const terminal = new VolumeError({
      kind: 'lifecycle',
      fileName: 'worker.bin',
      operation: 'worker',
      code: 'VFS_WORKER_FAILED',
      outcome: 'unknown',
      details: { message: 'worker failed', code: 'VFS_WORKER_FAILED' },
      cause: inner,
    });
    let writes = 0;
    client.onDescriptorWrite = async () => {
      if (++writes === 2) throw new VfsCommandError(terminal, 'replied');
    };
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          const opened = yield* OpfsFileSystem.make(volume).open('/note', { flag: 'w' });
          yield* opened.writeAll(new Uint8Array([1, 2]));
        }),
      ),
    );
    if (!Exit.isFailure(exit)) throw new Error('Expected partial write failure');
    const failure = exit.cause.reasons.find((reason) => reason._tag === 'Fail');
    if (failure?._tag !== 'Fail') throw new Error('Expected typed partial write failure');
    expect(failure.error).toMatchObject({
      reason: {
        _tag: 'Unknown',
        cause: {
          _tag: 'VolumeError',
          kind: 'lifecycle',
          outcome: 'possibly-applied',
          cause: { _tag: 'VolumeError', kind: 'lifecycle', cause: inner },
        },
      },
    });
  });

  it('rejects an existing handle immediately while its owner is unavailable', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount({ initTimeout: 500 }));
          const opened = yield* OpfsFileSystem.make(volume).open('/note');
          client.publish({ state: 'recovering', ownerGeneration: null });
          const result = yield* Effect.timeout(Effect.result(opened.readAlloc(1)), 30);
          expect(result).toMatchObject({ _tag: 'Failure', failure: { reason: { _tag: 'BadResource' } } });
        }),
      ),
    );
  });

  it('rejects local handle operations after its generation changes', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          const opened = yield* OpfsFileSystem.make(volume).open('/note');
          client.publish({ ownerGeneration: 'generation-2' });
          const results = yield* Effect.all([
            Effect.result(opened.seek(0n, 'start')),
            Effect.result(opened.readAlloc(0)),
            Effect.result(opened.writeAll(new Uint8Array())),
          ]);
          for (const result of results)
            expect(result).toMatchObject({ _tag: 'Failure', failure: { reason: { _tag: 'BadResource' } } });
        }),
      ),
    );
    expect(client.descriptorCalls.map(({ generation, method }) => [generation, method])).toEqual([
      ['generation-1', 'open'],
      ['generation-1', 'close'],
    ]);
  });

  it('does not replay an EFBIG fallback on a successor generation', async () => {
    const client = new FakeWorkerClient();
    client.onReadFileBuffer = async (generation) => {
      if (generation === 'generation-1') {
        client.publish({ ownerGeneration: 'generation-2' });
        throw Object.assign(new Error('helper limit'), { code: 'EFBIG' });
      }
      return new Uint8Array([9]);
    };
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          return yield* OpfsFileSystem.make(volume).readFile('/note');
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(client.reads.map(({ generation }) => generation)).toEqual(['generation-1']);
  });

  it('keeps a successful mutating OPEN uncertain when its first write is refused', async () => {
    const client = new FakeWorkerClient();
    client.onDescriptorWrite = async () => {
      throw new VfsCommandError(Object.assign(new Error('owner changed'), { code: 'VFS_ATTACHMENT_LOST' }), 'refused');
    };
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          yield* OpfsFileSystem.make(volume).writeFile('/note', new Uint8Array([1]), { mode: 0o100644 });
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = exit.cause.reasons.find((reason) => reason._tag === 'Fail');
      expect(failure?._tag).toBe('Fail');
      if (failure?._tag === 'Fail')
        expect((Volume.errorOf(failure.error as never) as VolumeError | undefined)?.outcome).toBe('possibly-applied');
    }
  });

  it('rejects malformed read buffers without advancing the cursor', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const facade = client.forGeneration.bind(client);
    let malformed = true;
    vi.spyOn(client, 'forGeneration').mockImplementation((generation) => ({
      ...facade(generation),
      read: async () =>
        malformed ? { read: 2, buffer: new Uint8Array([1]) } : { read: 1, buffer: new Uint8Array([7]) },
    }));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          const opened = yield* OpfsFileSystem.make(volume).open('/note');
          const failure = yield* Effect.result(opened.read(new Uint8Array(2)));
          expect(failure).toMatchObject({ _tag: 'Failure', failure: { reason: { _tag: 'Unknown' } } });
          malformed = false;
          expect(yield* opened.readAlloc(1)).toMatchObject({ _tag: 'Some', value: new Uint8Array([7]) });
        }),
      ),
    );
  });

  it('rejects malformed write counts as typed unknown failures without advancing the cursor', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const facade = client.forGeneration.bind(client);
    const offsets: Array<number | undefined> = [];
    let malformed = true;
    vi.spyOn(client, 'forGeneration').mockImplementation((generation) => ({
      ...facade(generation),
      write: async (_fd: number, bytes: Uint8Array, offset?: number) => {
        offsets.push(offset);
        if (malformed) return bytes.byteLength + 1;
        return bytes.byteLength;
      },
    }));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          const opened = yield* OpfsFileSystem.make(volume).open('/note', { flag: 'r+' });
          const failure = yield* Effect.result(opened.write(new Uint8Array([1])));
          expect(failure).toMatchObject({
            _tag: 'Failure',
            failure: { reason: { cause: { outcome: 'unknown' } } },
          });
          malformed = false;
          yield* opened.write(new Uint8Array([2]));
        }),
      ),
    );
    expect(offsets).toEqual([0, 0]);
  });

  it('validates flags and modes before descriptor dispatch', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          const fs = OpfsFileSystem.make(volume);
          const invalidFlag = yield* Effect.result(fs.open('/note', { flag: 'toString' as never }));
          const invalidMode = yield* Effect.result(fs.open('/note', { flag: 'w', mode: Number.POSITIVE_INFINITY }));
          expect(invalidFlag._tag).toBe('Failure');
          expect(invalidMode._tag).toBe('Failure');
          expect(client.descriptorCalls).toEqual([]);
          yield* fs.open('/note', { flag: 'w', mode: 0o100644 });
        }),
      ),
    );
    expect(client.descriptorCalls.map(({ method }) => method)).toEqual(['open', 'close']);
  });

  it('does not dispatch a mutating OPEN after its caller scope has closed', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const caller = Scope.makeUnsafe('sequential');
    await Effect.runPromise(Scope.close(caller, Exit.void));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          const result = yield* Effect.result(
            OpfsFileSystem.make(volume).open('/note', { flag: 'w' }).pipe(Effect.provideService(Scope.Scope, caller)),
          );
          expect(result).toMatchObject({ _tag: 'Failure', failure: { reason: { _tag: 'BadResource' } } });
        }),
      ),
    );
    expect(client.descriptorCalls).toEqual([]);
  });

  it('restores clean continuity when a queued mutating OPEN is closed before dispatch', async () => {
    const client = new FakeWorkerClient();
    const entered = await Effect.runPromise(Deferred.make<void>());
    const release = await Effect.runPromise(Deferred.make<void>());
    let held = true;
    client.onSync = async () => {
      if (!held) return;
      await Effect.runPromise(Deferred.succeed(entered, undefined));
      await Effect.runPromise(Deferred.await(release));
    };
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const caller = Scope.makeUnsafe('sequential');
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          const syncing = yield* Effect.forkChild(volume.sync);
          yield* Deferred.await(entered);
          const opening = yield* Effect.forkChild(
            OpfsFileSystem.make(volume).open('/note', { flag: 'w' }).pipe(Effect.provideService(Scope.Scope, caller)),
          );
          yield* Effect.sleep(0);
          yield* Scope.close(caller, Exit.void);
          held = false;
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(syncing);
          expect((yield* Fiber.await(opening))._tag).toBe('Failure');
          expect(client.descriptorCalls).toEqual([]);
          client.publish({ ownerGeneration: 'generation-2' });
          yield* volume.sync;
        }),
      ),
    );
  });

  it('joins a caller close with an OPEN that has already reached the backend', async () => {
    const client = new FakeWorkerClient();
    let finishOpen!: () => void;
    let started = false;
    client.onDescriptorOpen = () => {
      started = true;
      return new Promise<void>((resolve) => {
        finishOpen = resolve;
      });
    };
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const caller = Scope.makeUnsafe('sequential');
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          const opening = yield* Effect.forkChild(
            OpfsFileSystem.make(volume).open('/note').pipe(Effect.provideService(Scope.Scope, caller)),
          );
          yield* Effect.promise(() => waitUntil(() => started));
          const closing = yield* Effect.forkChild(Scope.close(caller, Exit.void));
          yield* Effect.sleep(0);
          expect(closing.pollUnsafe()).toBeUndefined();
          finishOpen();
          yield* Fiber.await(opening);
          yield* Fiber.join(closing);
        }),
      ).pipe(Effect.orDie),
    );
    expect(client.descriptorCalls.map(({ method }) => method)).toEqual(['open', 'close']);
  });

  it('cancels a pending OPEN admission without dispatching it', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const caller = Scope.makeUnsafe('sequential');
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount({ initTimeout: 500 }));
          client.publish({ state: 'recovering', ownerGeneration: null });
          const opening = yield* Effect.forkChild(
            OpfsFileSystem.make(volume).open('/note', { flag: 'w' }).pipe(Effect.provideService(Scope.Scope, caller)),
          );
          yield* Effect.promise(() => waitUntil(() => client.listeners.size > 1));
          yield* Fiber.interrupt(opening);
          expect(client.descriptorCalls).toEqual([]);
        }),
      ),
    );
    await Effect.runPromise(Scope.close(caller, Exit.void));
  });

  it('closes a late descriptor when an interrupted OPEN settles', async () => {
    const client = new FakeWorkerClient();
    let finishOpen!: () => void;
    client.onDescriptorOpen = () =>
      new Promise<void>((resolve) => {
        finishOpen = resolve;
      });
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const caller = Scope.makeUnsafe('sequential');
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          const opening = yield* Effect.forkChild(
            OpfsFileSystem.make(volume).open('/note').pipe(Effect.provideService(Scope.Scope, caller)),
          );
          yield* Effect.promise(() => waitUntil(() => client.descriptorCalls.some(({ method }) => method === 'open')));
          const interrupting = yield* Effect.forkChild(Fiber.interrupt(opening));
          yield* Effect.sleep(0);
          finishOpen();
          yield* Fiber.join(interrupting);
          expect(client.descriptorCalls.filter(({ method }) => method === 'close')).toHaveLength(1);
        }),
      ),
    );
    await Effect.runPromise(Scope.close(caller, Exit.void));
  });

  it('keeps one late close defect with the primary failed OPEN', async () => {
    const client = new FakeWorkerClient();
    let finishOpen!: () => void;
    client.onDescriptorOpen = () =>
      new Promise<void>((resolve) => {
        finishOpen = resolve;
      });
    const closeFailure = new Error('late descriptor close failed');
    const facade = client.forGeneration.bind(client);
    vi.spyOn(client, 'forGeneration').mockImplementation((generation) => ({
      ...facade(generation),
      close: async () => {
        throw closeFailure;
      },
    }));
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const caller = Scope.makeUnsafe('sequential');
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          const opening = Effect.runPromiseExit(
            OpfsFileSystem.make(volume).open('/note').pipe(Effect.provideService(Scope.Scope, caller)),
          );
          yield* Effect.promise(() => waitUntil(() => client.descriptorCalls.some(({ method }) => method === 'open')));
          const callerClose = Effect.runPromiseExit(Scope.close(caller, Exit.void));
          finishOpen();
          const exit = yield* Effect.promise(() => opening);
          yield* Effect.promise(() => callerClose);
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const primary = exit.cause.reasons.find((reason) => reason._tag === 'Fail');
            expect(primary?._tag).toBe('Fail');
            if (primary?._tag === 'Fail')
              expect((primary.error as { reason?: { _tag?: string } }).reason?._tag).toBe('BadResource');
            expect(
              exit.cause.reasons.filter(
                (reason) =>
                  reason._tag === 'Die' &&
                  (reason.defect as { details?: { message?: string } }).details?.message === closeFailure.message,
              ),
            ).toHaveLength(1);
          }
        }),
      ),
    );
  });

  it('does not recapture a refused descriptor OPEN on a successor owner', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const facade = client.forGeneration.bind(client);
    const generations: string[] = [];
    vi.spyOn(client, 'forGeneration').mockImplementation((generation) => ({
      ...facade(generation),
      open: async () => {
        generations.push(generation);
        if (generation === 'generation-1') {
          client.publish({ ownerGeneration: 'generation-2' });
          throw new VfsCommandError(
            Object.assign(new Error('owner changed'), { code: 'VFS_ATTACHMENT_LOST' }),
            'refused',
          );
        }
        return 7;
      },
    }));
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          return yield* OpfsFileSystem.make(volume).open('/note', { flag: 'w' });
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(generations).toEqual(['generation-1']);
  });

  it('does not fold a separately completed OPEN into public writeAll uncertainty', async () => {
    const client = new FakeWorkerClient();
    client.onDescriptorWrite = async () => {
      throw new VfsCommandError(Object.assign(new Error('refused'), { code: 'EBADF' }), 'refused');
    };
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          const opened = yield* OpfsFileSystem.make(volume).open('/note', { flag: 'w' });
          yield* opened.writeAll(new Uint8Array([1]));
        }),
      ),
    );
    if (!Exit.isFailure(exit)) throw new Error('Expected writeAll failure');
    const failure = exit.cause.reasons.find((reason) => reason._tag === 'Fail');
    if (failure?._tag !== 'Fail') throw new Error('Expected typed writeAll failure');
    expect((Volume.errorOf(failure.error as never) as VolumeError | undefined)?.outcome).toBe('not-applied');
  });

  it('joins a held caller file close before backend release', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const entered = await Effect.runPromise(Deferred.make<void>());
    const release = await Effect.runPromise(Deferred.make<void>());
    const facade = client.forGeneration.bind(client);
    vi.spyOn(client, 'forGeneration').mockImplementation((generation) => ({
      ...facade(generation),
      open: async () => 7,
      close: async () => {
        await Effect.runPromise(Deferred.succeed(entered, undefined));
        await Effect.runPromise(Deferred.await(release));
      },
    }));
    const volumeScope = Scope.makeUnsafe('sequential');
    const caller = Scope.makeUnsafe('sequential');
    const volume = await Effect.runPromise(Volume.make(mount()).pipe(Effect.provideService(Scope.Scope, volumeScope)));
    await Effect.runPromise(OpfsFileSystem.make(volume).open('/note').pipe(Effect.provideService(Scope.Scope, caller)));
    const callerClosing = Effect.runPromise(Scope.close(caller, Exit.void));
    await Effect.runPromise(Deferred.await(entered));
    let volumeClosed = false;
    const volumeClosing = Effect.runPromise(Scope.close(volumeScope, Exit.void)).then(() => {
      volumeClosed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.closeCalls).toBe(0);
    expect(volumeClosed).toBe(false);
    await Effect.runPromise(Deferred.succeed(release, undefined));
    await Promise.all([callerClosing, volumeClosing]);
    expect(client.closeCalls).toBe(1);
  });

  it('keeps an original failure and one decoded file-close defect', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const closeFailure = new VfsCommandError(
      Object.assign(new Error('owner changed'), { code: 'VFS_ATTACHMENT_LOST' }),
      'refused',
    );
    const facade = client.forGeneration.bind(client);
    vi.spyOn(client, 'forGeneration').mockImplementation((generation) => ({
      ...facade(generation),
      close: async () => {
        throw closeFailure;
      },
    }));
    const original = new Error('use failed');
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          yield* OpfsFileSystem.make(volume).open('/note');
          return yield* Effect.fail(original);
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(exit.cause.reasons).toContainEqual(expect.objectContaining({ _tag: 'Fail', error: original }));
      expect(
        exit.cause.reasons.filter(
          (reason) =>
            reason._tag === 'Die' &&
            (reason.defect as { code?: string; kind?: string; outcome?: string })?.code === 'VFS_ATTACHMENT_LOST' &&
            (reason.defect as { kind?: string }).kind === 'lifecycle' &&
            (reason.defect as { outcome?: string }).outcome === 'not-applied',
        ),
      ).toHaveLength(1);
    }
  });

  it('keeps a replied crypto cause on a public File close finalizer', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const facade = client.forGeneration.bind(client);
    vi.spyOn(client, 'forGeneration').mockImplementation((generation) => ({
      ...facade(generation),
      close: async () => {
        throw new VfsCommandError(Object.assign(new Error('integrity'), { code: 'ECRYPTOINTEGRITY' }), 'replied');
      },
    }));
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          yield* OpfsFileSystem.make(volume).open('/note');
        }),
      ),
    );
    if (!Exit.isFailure(exit)) throw new Error('Expected close finalizer failure');
    const cleanup = exit.cause.reasons.find((reason) => reason._tag === 'Die');
    expect(cleanup).toMatchObject({
      _tag: 'Die',
      defect: { _tag: 'EncryptionError', reason: 'IntegrityFailure', code: 'ECRYPTOINTEGRITY', outcome: 'unknown' },
    });
  });

  it('keeps a replied corruption cause on a descriptor read finalizer', async () => {
    const client = new FakeWorkerClient();
    client.onReadFileBuffer = async () => {
      throw Object.assign(new Error('helper limit'), { code: 'EFBIG' });
    };
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const facade = client.forGeneration.bind(client);
    vi.spyOn(client, 'forGeneration').mockImplementation((generation) => ({
      ...facade(generation),
      close: async () => {
        throw new VfsCommandError(
          Object.assign(new Error('corrupt'), { code: 'EIO', category: 'meta-log', name: 'VfsCorruptionError' }),
          'replied',
        );
      },
    }));
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          yield* OpfsFileSystem.make(volume).readFile('/note');
        }),
      ),
    );
    if (!Exit.isFailure(exit)) throw new Error('Expected descriptor finalizer failure');
    const cleanup = exit.cause.reasons.find((reason) => reason._tag === 'Die');
    expect(cleanup).toMatchObject({
      _tag: 'Die',
      defect: {
        _tag: 'VolumeError',
        kind: 'corruption',
        code: 'EIO',
        outcome: 'unknown',
        details: { category: 'meta-log' },
      },
    });
  });

  it('keeps truncate cursor rules across default, failure, and append operations', async () => {
    const client = new FakeWorkerClient();
    client.bytes = new Uint8Array([1, 2, 3, 4]);
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          const fs = OpfsFileSystem.make(volume);
          const regular = yield* fs.open('/note', { flag: 'r+' });
          yield* regular.seek(3n, 'start');
          yield* regular.truncate();
          expect(yield* regular.seek(0n, 'current')).toBe(0n);
          const facade = client.forGeneration.bind(client);
          vi.spyOn(client, 'forGeneration').mockImplementation((generation) => ({
            ...facade(generation),
            ftruncate: async () => {
              throw new Error('truncate failed');
            },
          }));
          yield* regular.seek(2n, 'start');
          expect((yield* Effect.result(regular.truncate(1)))._tag).toBe('Failure');
          expect(yield* regular.seek(0n, 'current')).toBe(2n);
          const appended = yield* fs.open('/note', { flag: 'a+' });
          yield* appended.seek(2n, 'start');
          expect((yield* Effect.result(appended.truncate(1)))._tag).toBe('Failure');
          expect(yield* appended.seek(0n, 'current')).toBe(2n);
        }),
      ),
    );
  });

  it('keeps an escaped closed handle from using a reused descriptor', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const facade = client.forGeneration.bind(client);
    const reads: number[] = [];
    vi.spyOn(client, 'forGeneration').mockImplementation((generation) => ({
      ...facade(generation),
      open: async () => 7,
      read: async (fd: number) => {
        reads.push(fd);
        return { read: 0, buffer: new Uint8Array() };
      },
    }));
    const caller = Scope.makeUnsafe('sequential');
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          const fs = OpfsFileSystem.make(volume);
          const first = yield* fs.open('/first', { flag: 'r' }).pipe(Effect.provideService(Scope.Scope, caller));
          yield* Scope.close(caller, Exit.void);
          const second = yield* fs.open('/second', { flag: 'r' });
          expect((yield* Effect.result(first.readAlloc(1)))._tag).toBe('Failure');
          yield* second.readAlloc(1);
        }),
      ),
    );
    expect(reads).toEqual([7]);
  });

  it('holds File.sync behind writes and retains an older lost continuity obligation', async () => {
    const client = new FakeWorkerClient();
    const entered = await Effect.runPromise(Deferred.make<void>());
    const release = await Effect.runPromise(Deferred.make<void>());
    client.onDescriptorWrite = async () => {
      await Effect.runPromise(Deferred.succeed(entered, undefined));
      await Effect.runPromise(Deferred.await(release));
    };
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          const fs = OpfsFileSystem.make(volume);
          const first = yield* fs.open('/first', { flag: 'r+' });
          const writing = yield* Effect.forkChild(first.write(new Uint8Array([1])));
          yield* Deferred.await(entered);
          const syncing = yield* Effect.forkChild(first.sync);
          yield* Effect.sleep(0);
          expect(syncing.pollUnsafe()).toBeUndefined();
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(writing);
          yield* Fiber.join(syncing);
          yield* first.write(new Uint8Array([2]));
          client.publish({ ownerGeneration: 'generation-2' });
          const second = yield* fs.open('/second', { flag: 'r+' });
          yield* second.sync;
          const lost = yield* Effect.result(volume.sync);
          expect(lost).toMatchObject({
            _tag: 'Failure',
            failure: { code: 'VFS_SYNC_OWNER_CHANGED', outcome: 'unknown' },
          });
        }),
      ),
    );
  });

  it('reuses a write effect without transferring its caller buffer', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const facade = client.forGeneration.bind(client);
    const writes: number[][] = [];
    vi.spyOn(client, 'forGeneration').mockImplementation((generation) => ({
      ...facade(generation),
      write: async (_fd: number, bytes: Uint8Array) => {
        const copied = Array.from(bytes);
        writes.push(copied);
        structuredClone(bytes, { transfer: [bytes.buffer] });
        return copied.length;
      },
    }));
    const input = new Uint8Array([1, 2, 3]);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          const opened = yield* OpfsFileSystem.make(volume).open('/note', { flag: 'r+' });
          const write = opened.write(input);
          yield* write;
          yield* write;
        }),
      ),
    );
    expect(writes).toEqual([
      [1, 2, 3],
      [1, 2, 3],
    ]);
    expect(Array.from(input)).toEqual([1, 2, 3]);
  });

  it('passes reusable plugin requests, transport settings and an acquisition signal once', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const request: VfsPluginRequest = {
      id: 'subscriptions',
      contractVersion: 1,
      compatibilityKey: 'subscriptions-v1',
      options: {},
    };
    let calls = 0;
    await Effect.runPromise(
      Effect.scoped(
        Volume.make(
          mount({
            transport: 'shared-worker',
            worker: () => new Worker('about:blank'),
            plugins: () => {
              calls++;
              return [request];
            },
          }),
        ),
      ),
    );
    expect(calls).toBe(1);
    expect(workerMocks.open).toHaveBeenCalledWith(
      'worker.bin',
      expect.objectContaining({ transport: 'shared-worker', plugins: [request], signal: expect.any(AbortSignal) }),
    );
    expect(workerMocks.open.mock.calls[0]?.[1].sharedWorker).toBeUndefined();
    expect(typeof workerMocks.open.mock.calls[0]?.[1].worker).toBe('function');
    expect(client.closeCalls).toBe(1);
  });

  it.each(['worker', 'sharedWorker'] as const)(
    'redacts thrown %s factory errors at the adapter boundary',
    async (factoryName) => {
      const secret = 'credential-bearing factory message';
      const failingFactory = () => {
        throw new Error(secret);
      };
      workerMocks.open.mockImplementation((_name, options) => {
        const factory = options[factoryName];
        expect(factory).toBeTypeOf('function');
        let failure: unknown;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            factory(factoryName === 'sharedWorker' ? 'worker.bin' : undefined);
          } catch (error) {
            failure = error;
          }
        }
        return Promise.reject(failure ?? new Error('Factory did not throw'));
      });
      const error = await Effect.runPromise(
        Effect.flip(
          Effect.scoped(Volume.make(mount({ [factoryName]: failingFactory } as Partial<WorkerMountOptions>))),
        ),
      );
      expect(error).toMatchObject({
        _tag: 'VolumeError',
        kind: 'configuration',
        code: 'VFS_WORKER_FACTORY_FAILED',
        details: { message: 'Worker factory failed' },
      });
      expect(JSON.stringify(error)).not.toContain(secret);
    },
  );

  it('does not start discovery when scoped configuration is interrupted', async () => {
    const started = await Effect.runPromise(Deferred.make<void>());
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const opening = yield* Effect.forkChild(
            Volume.make(
              Effect.gen(function* () {
                yield* Deferred.succeed(started, undefined);
                yield* Effect.never;
                return { fileName: 'worker.bin' };
              }),
            ),
          );
          yield* Deferred.await(started);
          yield* Fiber.interrupt(opening);
        }),
      ),
    );
    expect(workerMocks.open).not.toHaveBeenCalled();
  });

  it('does not start discovery when the parent closes during configuration', async () => {
    const parent = await Effect.runPromise(Scope.make());
    const started = await Effect.runPromise(Deferred.make<void>());
    const resume = await Effect.runPromise(Deferred.make<void>());
    const fiber = await Effect.runPromise(
      Scope.provide(parent)(
        Volume.make(
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(resume);
            return { fileName: 'worker.bin' };
          }),
        ).pipe(Effect.forkDetach),
      ),
    );
    await Effect.runPromise(Deferred.await(started));
    await Effect.runPromise(Scope.close(parent, Exit.void));
    await Effect.runPromise(Deferred.succeed(resume, undefined));
    expect(Exit.isFailure(await Effect.runPromise(Fiber.await(fiber)))).toBe(true);
    expect(workerMocks.open).not.toHaveBeenCalled();
  });

  it.each([
    ['leader INIT timeout', 'VFS_INITIALIZATION_TIMEOUT', 'lifecycle'],
    ['worker crash during startup', 'VFS_WORKER_FAILED', 'lifecycle'],
  ] as const)('maps %s at the Effect mount boundary', async (_reason, code, kind) => {
    workerMocks.open.mockRejectedValue(Object.assign(new Error('worker failed'), { code }));
    const error = await Effect.runPromise(Effect.flip(Effect.scoped(Volume.make(mount({ transport: 'auto' })))));
    expect(error).toMatchObject({ _tag: 'VolumeError', kind, code, operation: 'mount' });
  });

  it('keeps a parent scope usable after worker acquisition fails', async () => {
    const parent = await Effect.runPromise(Scope.make());
    const client = new FakeWorkerClient();
    let released = 0;
    const options = Effect.acquireRelease(Effect.succeed(mount()), () => Effect.sync(() => released++));
    workerMocks.open.mockRejectedValueOnce(Object.assign(new Error('worker failed'), { code: 'VFS_WORKER_FAILED' }));
    workerMocks.open.mockResolvedValueOnce(clientAsCore(client));
    const first = await Effect.runPromise(Scope.provide(parent)(Effect.flip(Volume.make(options))));
    expect(first).toMatchObject({ _tag: 'VolumeError', code: 'VFS_WORKER_FAILED' });
    expect(released).toBe(1);
    const second = await Effect.runPromise(Scope.provide(parent)(Volume.make(mount())));
    expect(second.fileName).toBe('worker.bin');
    expect(client.closeCalls).toBe(0);
    await Effect.runPromise(Scope.close(parent, Exit.void));
    expect(client.closeCalls).toBe(1);
  });

  it('joins late discovery and closes a client once when parent closure races interruption', async () => {
    const parent = await Effect.runPromise(Scope.make());
    const started = await Effect.runPromise(Deferred.make<void>());
    let resolveDiscovery!: (client: OpfsVfsWorkerClient) => void;
    let signal: AbortSignal | undefined;
    const client = new FakeWorkerClient();
    workerMocks.open.mockImplementation((_name, options) => {
      expect(options).toBeDefined();
      signal = options.signal;
      void Effect.runPromise(Deferred.succeed(started, undefined));
      return new Promise((resolve) => {
        resolveDiscovery = resolve;
      });
    });
    const fiber = await Effect.runPromise(Scope.provide(parent)(Volume.make(mount()).pipe(Effect.forkDetach)));
    await Effect.runPromise(Deferred.await(started));
    const close = Effect.runPromiseExit(Scope.close(parent, Exit.void));
    await waitUntil(() => signal?.aborted === true);
    const interrupt = Effect.runPromise(Fiber.interrupt(fiber));
    resolveDiscovery(clientAsCore(client));
    await Promise.all([close, interrupt]);
    const exit = await Effect.runPromise(Fiber.await(fiber));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(client.closeCalls).toBe(1);
  });

  it('joins late discovery and closes a client once when only the parent closes', async () => {
    const parent = await Effect.runPromise(Scope.make());
    const started = await Effect.runPromise(Deferred.make<void>());
    let resolveDiscovery!: (client: OpfsVfsWorkerClient) => void;
    let signal: AbortSignal | undefined;
    const client = new FakeWorkerClient();
    workerMocks.open.mockImplementation((_name, options) => {
      signal = options.signal;
      void Effect.runPromise(Deferred.succeed(started, undefined));
      return new Promise((resolve) => {
        resolveDiscovery = resolve;
      });
    });
    const fiber = await Effect.runPromise(Scope.provide(parent)(Volume.make(mount()).pipe(Effect.forkDetach)));
    await Effect.runPromise(Deferred.await(started));
    const close = Effect.runPromiseExit(Scope.close(parent, Exit.void));
    await waitUntil(() => signal?.aborted === true);
    resolveDiscovery(clientAsCore(client));
    const [closeExit, acquireExit] = await Promise.all([close, Effect.runPromise(Fiber.await(fiber))]);
    expect(Exit.isSuccess(closeExit)).toBe(true);
    expect(Exit.isFailure(acquireExit)).toBe(true);
    expect(client.closeCalls).toBe(1);
  });

  it('joins a late discovery rejection after cancellation', async () => {
    const parent = await Effect.runPromise(Scope.make());
    const started = await Effect.runPromise(Deferred.make<void>());
    let rejectDiscovery!: (error: unknown) => void;
    let signal: AbortSignal | undefined;
    workerMocks.open.mockImplementation((_name, options) => {
      signal = options.signal;
      void Effect.runPromise(Deferred.succeed(started, undefined));
      return new Promise((_resolve, reject) => {
        rejectDiscovery = reject;
      });
    });
    const fiber = await Effect.runPromise(Scope.provide(parent)(Volume.make(mount()).pipe(Effect.forkDetach)));
    await Effect.runPromise(Deferred.await(started));
    const interrupt = Effect.runPromise(Fiber.interrupt(fiber));
    await waitUntil(() => signal?.aborted === true);
    rejectDiscovery(new DOMException('aborted', 'AbortError'));
    await interrupt;
    await Effect.runPromise(Scope.close(parent, Exit.void));
    expect(Exit.isFailure(await Effect.runPromise(Fiber.await(fiber)))).toBe(true);
  });

  it('closes the client when readiness is interrupted', async () => {
    const parent = await Effect.runPromise(Scope.make());
    const client = new FakeWorkerClient(status({ state: 'opening', role: null, ownerGeneration: null }));
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const fiber = await Effect.runPromise(Scope.provide(parent)(Volume.make(mount()).pipe(Effect.forkDetach)));
    await waitUntil(() => client.listeners.size === 1);
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(client.closeCalls).toBe(1);
    expect(client.listeners.size).toBe(0);
    await Effect.runPromise(Scope.close(parent, Exit.void));
  });

  it('does not admit a ready client after the parent has closed', async () => {
    const parent = await Effect.runPromise(Scope.make());
    const client = new FakeWorkerClient(status({ state: 'opening', role: null, ownerGeneration: null }));
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const fiber = await Effect.runPromise(Scope.provide(parent)(Volume.make(mount()).pipe(Effect.forkDetach)));
    await waitUntil(() => client.listeners.size === 1);
    const close = await Effect.runPromiseExit(Scope.close(parent, Exit.void));
    client.resolveReady();
    const acquireExit = await Effect.runPromise(Fiber.await(fiber));
    expect(Exit.isSuccess(close)).toBe(true);
    expect(Exit.isFailure(acquireExit)).toBe(true);
    expect(client.listeners.size).toBe(0);
    expect(client.closeCalls).toBe(1);
  });

  it('preserves a parent-close failure and one late discovery cleanup failure', async () => {
    const parent = await Effect.runPromise(Scope.make());
    const started = await Effect.runPromise(Deferred.make<void>());
    const closeStarted = await Effect.runPromise(Deferred.make<void>());
    const finished = await Effect.runPromise(Deferred.make<void>());
    let resolveDiscovery!: (client: OpfsVfsWorkerClient) => void;
    let rejectClose!: (error: Error) => void;
    let signal: AbortSignal | undefined;
    const closeFailure = new Error('late close failed');
    const client = new FakeWorkerClient();
    client.onClose = () =>
      new Promise<void>((_resolve, reject) => {
        rejectClose = reject;
        void Effect.runPromise(Deferred.succeed(closeStarted, undefined));
      });
    workerMocks.open.mockImplementation((_name, options) => {
      expect(options).toBeDefined();
      signal = options.signal;
      void Effect.runPromise(Deferred.succeed(started, undefined));
      return new Promise((resolve) => {
        resolveDiscovery = resolve;
      });
    });
    const fiber = await Effect.runPromise(
      Scope.provide(parent)(Volume.make(mount()).pipe(Effect.onExit(() => Deferred.succeed(finished, undefined)))).pipe(
        Effect.forkDetach,
      ),
    );
    await Effect.runPromise(Deferred.await(started));
    const closeFiber = await Effect.runPromise(Scope.close(parent, Exit.void).pipe(Effect.forkDetach));
    await waitUntil(() => signal?.aborted === true);
    resolveDiscovery(clientAsCore(client));
    await Effect.runPromise(Deferred.await(closeStarted));
    expect(await Effect.runPromise(Deferred.isDone(finished))).toBe(false);
    rejectClose(closeFailure);
    expect(client.closeCalls).toBe(1);
    const acquireExit = await Effect.runPromise(Fiber.await(fiber));
    await Effect.runPromise(Fiber.await(closeFiber));
    expect(Exit.isFailure(acquireExit)).toBe(true);
    if (Exit.isFailure(acquireExit)) {
      expect(
        acquireExit.cause.reasons.filter(
          (reason) =>
            reason._tag === 'Fail' && reason.error instanceof VolumeError && reason.error.operation === 'acquire',
        ),
      ).toHaveLength(1);
      expect(
        acquireExit.cause.reasons.filter(
          (reason) =>
            reason._tag === 'Die' &&
            (reason.defect as { details?: { message?: string } }).details?.message === closeFailure.message,
        ),
      ).toHaveLength(1);
    }
  });

  it('preserves interruption and one late discovery cleanup failure', async () => {
    const parent = await Effect.runPromise(Scope.make());
    const started = await Effect.runPromise(Deferred.make<void>());
    const closeStarted = await Effect.runPromise(Deferred.make<void>());
    const finished = await Effect.runPromise(Deferred.make<void>());
    const closeFailure = new Error('late close failed');
    const client = new FakeWorkerClient();
    let resolveDiscovery!: (client: OpfsVfsWorkerClient) => void;
    let rejectClose!: (error: Error) => void;
    let signal: AbortSignal | undefined;
    client.onClose = () =>
      new Promise<void>((_resolve, reject) => {
        rejectClose = reject;
        void Effect.runPromise(Deferred.succeed(closeStarted, undefined));
      });
    workerMocks.open.mockImplementation((_name, options) => {
      signal = options.signal;
      void Effect.runPromise(Deferred.succeed(started, undefined));
      return new Promise((resolve) => {
        resolveDiscovery = resolve;
      });
    });
    const fiber = await Effect.runPromise(
      Scope.provide(parent)(Volume.make(mount()).pipe(Effect.onExit(() => Deferred.succeed(finished, undefined)))).pipe(
        Effect.forkDetach,
      ),
    );
    await Effect.runPromise(Deferred.await(started));
    const interrupt = Effect.runPromise(Fiber.interrupt(fiber));
    await waitUntil(() => signal?.aborted === true);
    resolveDiscovery(clientAsCore(client));
    await Effect.runPromise(Deferred.await(closeStarted));
    expect(await Effect.runPromise(Deferred.isDone(finished))).toBe(false);
    rejectClose(closeFailure);
    await interrupt;
    const exit = await Effect.runPromise(Fiber.await(fiber));
    expect(client.closeCalls).toBe(1);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(exit.cause.reasons.filter((reason) => reason._tag === 'Interrupt')).toHaveLength(1);
      expect(
        exit.cause.reasons.filter(
          (reason) =>
            reason._tag === 'Die' &&
            (reason.defect as { details?: { message?: string } }).details?.message === closeFailure.message,
        ),
      ).toHaveLength(1);
    }
    await Effect.runPromise(Scope.close(parent, Exit.void));
  });

  it('waits for a held parent-close cleanup after worker ready rejects', async () => {
    const parent = await Effect.runPromise(Scope.make());
    const closeStarted = await Effect.runPromise(Deferred.make<void>());
    const releaseClose = await Effect.runPromise(Deferred.make<void>());
    const finished = await Effect.runPromise(Deferred.make<void>());
    const client = new FakeWorkerClient(status({ state: 'opening', role: null, ownerGeneration: null }));
    client.onClose = () =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Deferred.succeed(closeStarted, undefined);
          yield* Deferred.await(releaseClose);
        }),
      );
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const acquisition = Scope.provide(parent)(
      Volume.make(mount()).pipe(Effect.onExit(() => Deferred.succeed(finished, undefined))),
    );
    const acquisitionFiber = await Effect.runPromise(acquisition.pipe(Effect.forkDetach));
    await waitUntil(() => client.listeners.size === 1);
    const closeFiber = await Effect.runPromise(Scope.close(parent, Exit.void).pipe(Effect.forkDetach));
    await Effect.runPromise(Deferred.await(closeStarted));
    client.rejectReady(new Error('init failed'));
    await Effect.runPromise(Effect.yieldNow);
    expect(await Effect.runPromise(Deferred.isDone(finished))).toBe(false);
    await Effect.runPromise(Deferred.succeed(releaseClose, undefined));
    const exit = await Effect.runPromise(Fiber.await(acquisitionFiber));
    await Effect.runPromise(Fiber.await(closeFiber));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(client.closeCalls).toBe(1);
  });

  it('preserves worker ready, close, and configuration cleanup failures once', async () => {
    const parent = await Effect.runPromise(Scope.make());
    const configFinalizerStarted = await Effect.runPromise(Deferred.make<void>());
    const releaseConfigFinalizer = await Effect.runPromise(Deferred.make<void>());
    const finished = await Effect.runPromise(Deferred.make<void>());
    const readyFailure = new Error('init failed');
    const closeFailure = new Error('close failed');
    const configFailure = new Error('configuration cleanup failed');
    const order: string[] = [];
    const client = new FakeWorkerClient(status({ state: 'opening', role: null, ownerGeneration: null }));
    client.onClose = () => {
      order.push('backend');
      return Promise.reject(closeFailure);
    };
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const config = Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          order.push('configuration');
          yield* Deferred.succeed(configFinalizerStarted, undefined);
          yield* Deferred.await(releaseConfigFinalizer);
          return yield* Effect.die(configFailure);
        }),
      );
      return mount();
    });
    try {
      const fiber = await Effect.runPromise(
        Scope.provide(parent)(
          Volume.make(config).pipe(Effect.onExit(() => Deferred.succeed(finished, undefined))),
        ).pipe(Effect.forkDetach),
      );
      await waitUntil(() => client.listeners.size === 1);
      const closeFiber = await Effect.runPromise(Scope.close(parent, Exit.void).pipe(Effect.forkDetach));
      await Effect.runPromise(Deferred.await(configFinalizerStarted));
      expect(client.closeCalls).toBe(1);
      expect(order).toEqual(['backend', 'configuration']);
      client.rejectReady(readyFailure);
      await Effect.runPromise(Effect.yieldNow);
      expect(await Effect.runPromise(Deferred.isDone(finished))).toBe(false);
      await Effect.runPromise(Deferred.succeed(releaseConfigFinalizer, undefined));
      const exit = await Effect.runPromise(Fiber.await(fiber));
      await Effect.runPromise(Fiber.await(closeFiber));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons).toContainEqual(
          expect.objectContaining({
            _tag: 'Fail',
            error: expect.objectContaining({ details: { message: readyFailure.message } }),
          }),
        );
        expect(
          exit.cause.reasons.filter(
            (reason) =>
              reason._tag === 'Die' &&
              (reason.defect as { details?: { message?: string } }).details?.message === closeFailure.message,
          ),
        ).toHaveLength(1);
        expect(exit.cause.reasons).toContainEqual(expect.objectContaining({ _tag: 'Die', defect: configFailure }));
      }
    } finally {
      await Effect.runPromise(Scope.close(parent, Exit.void));
    }
  });

  it('returns a service after ready and reads the current worker persistence snapshot', async () => {
    const client = new FakeWorkerClient();
    client.publish({ persistence: { state: 'dirty', lastError: null, failureRevision: 0, lastSalvage: null } });
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Volume.make(mount({ initTimeout: 63 }));
          expect(yield* service.persistence).toEqual({ state: 'dirty', error: null });
          expect(Volume.unsafeBackend(service)).toBe(clientAsCore(client));
          yield* service.sync;
          expect(client.generations).toEqual(['generation-1']);
        }),
      ),
    );
    expect(workerMocks.open.mock.calls[0]?.[1].initTimeout).toBe(63);
    expect(client.closeCalls).toBe(1);
  });

  it('admits a ready snapshot published during subscription before waiting', async () => {
    const client = new FakeWorkerClient(status({ state: 'recovering', role: 'follower', ownerGeneration: null }));
    client.resolveReady();
    client.onSubscribe = () => {
      client.onSubscribe = undefined;
      client.current = status({ ownerGeneration: 'generation-2', role: 'follower' });
    };
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Volume.make(mount());
          yield* service.sync;
        }),
      ),
    );
    expect(client.generations).toEqual(['generation-2']);
    expect(client.listeners.size).toBe(0);
  });

  it('preserves a service through dedicated takeover and admits the replacement generation', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Volume.make(mount());
          client.publish({ state: 'recovering', role: 'follower', ownerGeneration: null, persistence: null });
          expect(yield* service.persistence).toEqual({ state: 'unknown', error: null });
          const sync = yield* Effect.forkChild(service.sync);
          yield* Effect.sleep(0);
          client.publish({ state: 'ready', ownerGeneration: 'generation-2', persistence: null });
          yield* Fiber.join(sync);
          expect(Volume.unsafeBackend(service)).toBe(clientAsCore(client));
        }),
      ),
    );
    expect(client.generations).toEqual(['generation-2']);
    expect(client.closeCalls).toBe(1);
  });

  it('uses initTimeout as the readiness budget and removes the status listener on expiry', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Volume.make(mount({ initTimeout: 20 }));
          client.publish({ state: 'recovering', ownerGeneration: null });
          return yield* Effect.flip(service.sync);
        }),
      ),
    );
    expect(error).toMatchObject({ _tag: 'VolumeError', code: 'VFS_OWNER_READY_TIMEOUT', outcome: 'not-applied' });
    expect(client.listeners.size).toBe(0);
    expect(client.closeCalls).toBe(1);
  });

  it('keeps pending-write uncertainty when SYNC admission times out', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Volume.make(mount({ initTimeout: 10 }));
          yield* OpfsFileSystem.make(service).writeFile('/note.txt', new Uint8Array([1]));
          client.publish({ state: 'recovering', ownerGeneration: null });
          return yield* Effect.flip(service.sync);
        }),
      ),
    );
    expect(error).toMatchObject({ code: 'VFS_OWNER_READY_TIMEOUT', outcome: 'unknown' });
  });

  it('exposes a terminal crypto cause directly from initial worker readiness', async () => {
    const cause = Object.assign(new Error('vault rejected'), { code: 'EVOLUMELOCKED' });
    const client = new FakeWorkerClient(
      status({
        state: 'failed',
        role: null,
        ownerGeneration: null,
        error: { message: cause.message, code: cause.code },
      }),
    );
    client.rejectReady(cause);
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const error = await Effect.runPromise(Effect.flip(Effect.scoped(Volume.make(mount()))));
    expect(error).toBeInstanceOf(EncryptionError);
    expect(error).toMatchObject({ reason: 'CredentialsRejected', code: 'EVOLUMELOCKED' });
    expect(client.closeCalls).toBe(1);
  });

  it('exposes a terminal crypto cause directly when failure is latched after ready resolves', async () => {
    const client = new FakeWorkerClient();
    client.onSubscribe = () =>
      client.publish({
        state: 'failed',
        role: null,
        ownerGeneration: null,
        error: { message: 'credentials rejected', code: 'EVOLUMELOCKED' },
      });
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const error = await Effect.runPromise(Effect.flip(Effect.scoped(Volume.make(mount()))));
    expect(error).toBeInstanceOf(EncryptionError);
    expect(error).toMatchObject({ reason: 'CredentialsRejected', code: 'EVOLUMELOCKED' });
  });

  it('latches a terminal crypto cause for persistence and exposes it directly from sync', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Volume.make(mount());
          client.publish({
            state: 'failed',
            role: null,
            ownerGeneration: null,
            error: { message: 'integrity check failed', code: 'ECRYPTOINTEGRITY' },
          });
          const syncError = yield* Effect.flip(service.sync);
          const persistenceError = yield* Effect.flip(service.persistence);
          expect(syncError).toBeInstanceOf(EncryptionError);
          expect(syncError).toMatchObject({ reason: 'IntegrityFailure' });
          expect(persistenceError).toMatchObject({
            _tag: 'VolumeError',
            kind: 'lifecycle',
            cause: { _tag: 'EncryptionError' },
          });
        }),
      ),
    );
  });

  it('maps a follower relay timeout once and ignores its late reply', async () => {
    const client = new FakeWorkerClient(status({ transport: 'shared-worker', role: 'follower' }));
    let resolveLate!: () => void;
    client.onSync = () =>
      Promise.race([
        new Promise<void>((resolve) => {
          resolveLate = resolve;
        }),
        Promise.reject(
          new VfsCommandError(
            Object.assign(new Error('follower relay timed out'), { code: 'LEADER_RESPONSE_TIMEOUT' }),
            'sent',
          ),
        ),
      ]);
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Volume.make(mount({ transport: 'shared-worker' }));
          const syncError = yield* Effect.flip(service.sync);
          resolveLate();
          yield* Effect.sleep(0);
          expect(yield* service.persistence).toEqual({ state: 'unknown', error: null });
          return syncError;
        }),
      ),
    );
    expect(error).toMatchObject({
      _tag: 'VolumeError',
      kind: 'lifecycle',
      code: 'LEADER_RESPONSE_TIMEOUT',
      outcome: 'unknown',
    });
    expect(client.generations).toEqual(['generation-1']);
  });

  it('keeps foreign sync errors typed without reading their cause accessor', async () => {
    const secret = 'do-not-expose-this-secret';
    const foreign = new Error('foreign sync failed');
    let causeReads = 0;
    Object.defineProperty(foreign, 'cause', {
      get() {
        causeReads++;
        throw new Error(secret);
      },
    });
    const client = new FakeWorkerClient();
    client.onSync = () => Promise.reject(foreign);
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Volume.make(mount());
          return yield* Effect.flip(service.sync);
        }),
      ),
    );
    expect(error).toBeInstanceOf(VolumeError);
    expect(error).toMatchObject({ kind: 'unknown', operation: 'sync', details: { message: 'foreign sync failed' } });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(causeReads).toBe(0);
  });

  it('does not classify a foreign nested cause as crypto', async () => {
    const foreign = new Error('foreign sync failed', {
      cause: Object.assign(new Error('volume locked'), { code: 'EVOLUMELOCKED' }),
    });
    const client = new FakeWorkerClient();
    client.onSync = () => Promise.reject(foreign);
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Volume.make(mount());
          return yield* Effect.flip(service.sync);
        }),
      ),
    );
    expect(error).toBeInstanceOf(VolumeError);
    expect(error).toMatchObject({ kind: 'unknown', operation: 'sync' });
    expect(error).not.toBeInstanceOf(EncryptionError);
  });

  it.each(['sent', 'replied'] as const)('unwraps %s VfsCommandError sync failures', async (dispatch) => {
    const source = Object.assign(new Error('volume locked'), { code: 'EVOLUMELOCKED' });
    const client = new FakeWorkerClient();
    client.onSync = () => Promise.reject(new VfsCommandError(source, dispatch));
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Volume.make(mount());
          return yield* Effect.flip(service.sync);
        }),
      ),
    );
    expect(error).toBeInstanceOf(EncryptionError);
    expect(error).toMatchObject({
      reason: 'CredentialsRejected',
      code: 'EVOLUMELOCKED',
      outcome: 'unknown',
      details: { message: 'volume locked' },
    });
  });

  it('keeps a worker crash terminal at the Effect service boundary', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Volume.make(mount());
          client.publish({
            state: 'failed',
            role: null,
            ownerGeneration: null,
            error: { message: 'worker crashed', code: 'VFS_WORKER_FAILED' },
          });
          return yield* Effect.flip(service.sync);
        }),
      ),
    );
    expect(error).toMatchObject({
      _tag: 'VolumeError',
      kind: 'lifecycle',
      code: 'VFS_WORKER_FAILED',
      cause: { _tag: 'VolumeError', code: 'VFS_WORKER_FAILED' },
    });
  });

  it.each(['ENOENT', 'EACCES', 'EBADF', 'LEADER_RESPONSE_TIMEOUT'])(
    'maps terminal %s status to Unknown',
    async (code) => {
      const client = new FakeWorkerClient();
      workerMocks.open.mockResolvedValue(clientAsCore(client));
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const service = yield* Volume.make(mount());
            client.publish({
              state: 'failed',
              role: null,
              ownerGeneration: null,
              error: { message: 'terminal', code },
            });
            const result = yield* Effect.result(
              OpfsFileSystem.make(service).writeFile('/note.txt', new Uint8Array([1])),
            );
            expect(result).toMatchObject({
              _tag: 'Failure',
              failure: { reason: { _tag: 'Unknown', cause: { _tag: 'VolumeError', kind: 'lifecycle', code } } },
            });
          }),
        ),
      );
    },
  );

  it('keeps a live filesystem admission timeout as TimedOut', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Volume.make(mount({ initTimeout: 10 }));
          client.publish({ state: 'recovering', ownerGeneration: null });
          const result = yield* Effect.result(OpfsFileSystem.make(service).writeFile('/note.txt', new Uint8Array([1])));
          expect(result).toMatchObject({
            _tag: 'Failure',
            failure: { reason: { _tag: 'TimedOut', cause: { code: 'VFS_OWNER_READY_TIMEOUT' } } },
          });
        }),
      ),
    );
  });

  it('exposes a terminal crypto cause when failure arrives during ready admission', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Volume.make(mount());
          client.publish({ state: 'recovering', ownerGeneration: null });
          const syncing = yield* Effect.forkChild(Effect.flip(service.sync));
          yield* Effect.sleep(0);
          client.publish({
            state: 'failed',
            role: null,
            ownerGeneration: null,
            error: { message: 'vault corrupt', code: 'EVAULTCORRUPT' },
          });
          const error = yield* Fiber.join(syncing);
          expect(error).toBeInstanceOf(EncryptionError);
          expect(error).toMatchObject({ reason: 'VaultCorrupt' });
        }),
      ),
    );
  });

  it('fails ready admission as soon as the worker enters closing', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Volume.make(mount());
          client.publish({ state: 'recovering', ownerGeneration: null });
          const syncing = yield* Effect.forkChild(Effect.flip(service.sync));
          yield* Effect.sleep(0);
          client.publish({ state: 'closing', role: null, ownerGeneration: null });
          return yield* Fiber.join(syncing);
        }),
      ),
    );
    expect(error).toMatchObject({ _tag: 'VolumeError', kind: 'lifecycle', operation: 'worker' });
  });

  it('keeps SharedWorker attachment loss terminal with the decoded cause retained', async () => {
    const client = new FakeWorkerClient(status({ transport: 'shared-worker', role: 'follower' }));
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Volume.make(mount());
          client.publish({
            state: 'failed',
            role: null,
            ownerGeneration: null,
            error: { message: 'attachment lost', code: 'VFS_ATTACHMENT_LOST' },
          });
          const error = yield* Effect.flip(service.persistence);
          expect(error).toMatchObject({
            kind: 'lifecycle',
            code: 'VFS_ATTACHMENT_LOST',
            cause: { _tag: 'VolumeError', code: 'VFS_ATTACHMENT_LOST' },
          });
        }),
      ),
    );
    expect(client.closeCalls).toBe(1);
  });

  it('retains the oldest unsaved generation across later writes and requires a fresh acknowledgment barrier', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Volume.make(mount());
          const fs = OpfsFileSystem.make(service);
          yield* fs.writeFile('/note.txt', new Uint8Array([1]));
          client.publish({ ownerGeneration: 'generation-2' });
          const lost = yield* Effect.result(service.sync);
          expect(lost).toMatchObject({
            _tag: 'Failure',
            failure: { _tag: 'VolumeError', code: 'VFS_SYNC_OWNER_CHANGED' },
          });
          yield* fs.writeFile('/note.txt', new Uint8Array([2]));
          const stillLost = yield* Effect.result(service.sync);
          expect(stillLost).toMatchObject({
            _tag: 'Failure',
            failure: { _tag: 'VolumeError', code: 'VFS_SYNC_OWNER_CHANGED' },
          });
          yield* service.acknowledgeOwnerChange;
          client.publish({ ownerGeneration: 'generation-3' });
          const afterAckTakeover = yield* Effect.result(service.sync);
          expect(afterAckTakeover).toMatchObject({
            _tag: 'Failure',
            failure: { _tag: 'VolumeError', code: 'VFS_SYNC_OWNER_CHANGED', outcome: 'unknown' },
          });
        }),
      ),
    );
    expect(client.writes.map(({ generation }) => generation)).toEqual(['generation-1', 'generation-2']);
  });

  it('keeps a lost G1 barrier after acknowledging G2 without a G2 write', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Volume.make(mount());
          yield* OpfsFileSystem.make(service).writeFile('/note.txt', new Uint8Array([1]));
          client.publish({ ownerGeneration: 'generation-2' });
          yield* Effect.result(service.sync);
          yield* service.acknowledgeOwnerChange;
          client.publish({ ownerGeneration: 'generation-3' });
          const result = yield* Effect.result(service.sync);
          expect(result).toMatchObject({
            _tag: 'Failure',
            failure: { _tag: 'VolumeError', code: 'VFS_SYNC_OWNER_CHANGED', outcome: 'unknown' },
          });
        }),
      ),
    );
    expect(client.writes.map(({ generation }) => generation)).toEqual(['generation-1']);
  });

  it('keeps already-lost durability unknown through a ready-owner timeout', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount({ initTimeout: 10 }));
          yield* OpfsFileSystem.make(volume).writeFile('/note.txt', new Uint8Array([1]));
          client.publish({ ownerGeneration: 'generation-2' });
          const lost = yield* Effect.result(volume.sync);
          expect(lost).toMatchObject({
            _tag: 'Failure',
            failure: { code: 'VFS_SYNC_OWNER_CHANGED', outcome: 'unknown' },
          });
          client.publish({ state: 'recovering', ownerGeneration: null });
          const timed = yield* Effect.result(volume.sync);
          expect(timed).toMatchObject({ _tag: 'Failure', failure: { outcome: 'unknown' } });
          client.publish({ state: 'ready', ownerGeneration: 'generation-2' });
          const stillLost = yield* Effect.result(volume.sync);
          expect(stillLost).toMatchObject({
            _tag: 'Failure',
            failure: { code: 'VFS_SYNC_OWNER_CHANGED', outcome: 'unknown' },
          });
        }),
      ),
    );
    expect(client.syncCalls).toBe(0);
  });

  it('pins whole-file reads and keeps a successful old-owner SYNC receipt after a later status change', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    client.onReadFileBuffer = async () => new TextEncoder().encode('note');
    client.onSync = async () => {
      client.publish({ ownerGeneration: 'generation-2' });
    };
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Volume.make(mount());
          const fs = OpfsFileSystem.make(service);
          expect(yield* fs.readFileString('/note.txt')).toBe('note');
          yield* fs.writeFile('/note.txt', new Uint8Array([1]));
          yield* service.sync;
          yield* service.sync;
        }),
      ),
    );
    expect(client.reads).toEqual([{ generation: 'generation-1', path: '/note.txt', limit: 16 * 1024 * 1024 }]);
    expect(client.syncCalls).toBe(2);
  });

  it('recaptures one locally refused whole-file write and pins the retry to the new owner', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    let calls = 0;
    client.onWriteFileBuffer = async (generation) => {
      if (calls++ === 0) {
        client.publish({ ownerGeneration: 'generation-2' });
        throw new VfsCommandError(
          Object.assign(new Error('owner changed'), { code: 'VFS_ATTACHMENT_LOST' }),
          'refused',
        );
      }
      expect(generation).toBe('generation-2');
    };
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          const fs = OpfsFileSystem.make(volume);
          yield* fs.writeFile('/note.txt', new Uint8Array([1]));
          yield* volume.sync;
        }),
      ),
    );
    expect(client.writes.map(({ generation }) => generation)).toEqual(['generation-1', 'generation-2']);
  });

  it('does not recapture a same-generation facade refusal', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    client.onWriteFileBuffer = async () => {
      throw new VfsCommandError(Object.assign(new Error('owner changed'), { code: 'VFS_ATTACHMENT_LOST' }), 'refused');
    };
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          const fs = OpfsFileSystem.make(volume);
          const result = yield* Effect.result(fs.writeFile('/note.txt', new Uint8Array([1])));
          expect(result).toMatchObject({
            _tag: 'Failure',
            failure: {
              reason: {
                _tag: 'Unknown',
                cause: { _tag: 'VolumeError', code: 'VFS_ATTACHMENT_LOST', outcome: 'not-applied' },
              },
            },
          });
        }),
      ),
    );
    expect(client.writes).toHaveLength(1);
  });

  it('does not replay a facade refusal after recovery returns to the same generation', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    client.onSubscribe = () => {
      if (client.current.state === 'recovering') client.publish({ state: 'ready', ownerGeneration: 'generation-1' });
    };
    client.onWriteFileBuffer = async () => {
      client.publish({ state: 'recovering', ownerGeneration: null });
      throw new VfsCommandError(Object.assign(new Error('owner changed'), { code: 'VFS_ATTACHMENT_LOST' }), 'refused');
    };
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          yield* Effect.result(OpfsFileSystem.make(volume).writeFile('/note.txt', new Uint8Array([1])));
        }),
      ),
    );
    expect(client.writes).toHaveLength(1);
  });

  it('surfaces terminal crypto while recapturing a refused write', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    client.onSubscribe = () => {
      if (client.current.state === 'recovering')
        client.publish({
          state: 'failed',
          role: null,
          ownerGeneration: null,
          error: { message: 'locked', code: 'EVOLUMELOCKED' },
        });
    };
    client.onWriteFileBuffer = async () => {
      client.publish({ state: 'recovering', ownerGeneration: null });
      throw new VfsCommandError(Object.assign(new Error('lost'), { code: 'VFS_ATTACHMENT_LOST' }), 'refused');
    };
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          return yield* Effect.result(OpfsFileSystem.make(volume).writeFile('/note.txt', new Uint8Array([1])));
        }),
      ),
    );
    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: {
        reason: { cause: { _tag: 'VolumeError', kind: 'lifecycle', cause: { reason: 'CredentialsRejected' } } },
      },
    });
    if (result._tag === 'Failure')
      expect(Volume.errorOf(result.failure)).toMatchObject({ reason: 'CredentialsRejected' });
    expect(client.writes).toHaveLength(1);
  });

  it('does not recapture a SharedWorker facade refusal', async () => {
    const client = new FakeWorkerClient(status({ transport: 'shared-worker', role: 'follower' }));
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    client.onWriteFileBuffer = async () => {
      client.publish({ ownerGeneration: 'generation-2' });
      throw new VfsCommandError(Object.assign(new Error('owner changed'), { code: 'VFS_ATTACHMENT_LOST' }), 'refused');
    };
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount({ transport: 'shared-worker' }));
          yield* Effect.result(OpfsFileSystem.make(volume).writeFile('/note.txt', new Uint8Array([1])));
        }),
      ),
    );
    expect(client.writes).toHaveLength(1);
  });

  it('preserves possibly-applied for a sent attachment-loss write', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    client.onWriteFileBuffer = async () => {
      throw new VfsCommandError(Object.assign(new Error('lost'), { code: 'VFS_ATTACHMENT_LOST' }), 'sent');
    };
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          return yield* Effect.result(OpfsFileSystem.make(volume).writeFile('/note.txt', new Uint8Array([1])));
        }),
      ),
    );
    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: { reason: { cause: { code: 'VFS_ATTACHMENT_LOST', outcome: 'possibly-applied' } } },
    });
  });

  it('keeps initiating dispatch evidence when a sent write collides with terminal crypto failure', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    client.onWriteFileBuffer = async () => {
      client.publish({
        state: 'failed',
        role: null,
        ownerGeneration: null,
        error: { message: 'integrity failed', code: 'ECRYPTOINTEGRITY' },
      });
      throw new VfsCommandError(Object.assign(new Error('lost'), { code: 'VFS_ATTACHMENT_LOST' }), 'sent');
    };
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          return yield* Effect.result(OpfsFileSystem.make(volume).writeFile('/note.txt', new Uint8Array([1])));
        }),
      ),
    );
    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: {
        reason: {
          _tag: 'Unknown',
          cause: {
            _tag: 'VolumeError',
            kind: 'lifecycle',
            outcome: 'possibly-applied',
            cause: { _tag: 'EncryptionError', reason: 'IntegrityFailure' },
          },
        },
      },
    });
    if (result._tag === 'Failure') expect(Volume.errorOf(result.failure)).toMatchObject({ reason: 'IntegrityFailure' });
  });

  it.each([
    ['EVAULTCORRUPT', 'VaultCorrupt'],
    ['ECRYPTSIDECAR', 'SidecarCorrupt'],
  ])('maps nonterminal %s failures to InvalidData', async (code, reason) => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    client.onWriteFileBuffer = async () => {
      throw new VfsCommandError(Object.assign(new Error('corrupt'), { code }), 'sent');
    };
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          return yield* Effect.result(OpfsFileSystem.make(volume).writeFile('/note.txt', new Uint8Array([1])));
        }),
      ),
    );
    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: { reason: { _tag: 'InvalidData', cause: { _tag: 'EncryptionError', reason } } },
    });
  });

  it('does not replay a replied attachment-loss write', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    client.onWriteFileBuffer = async () => {
      throw new VfsCommandError(Object.assign(new Error('lost'), { code: 'VFS_ATTACHMENT_LOST' }), 'replied');
    };
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          return yield* Effect.result(OpfsFileSystem.make(volume).writeFile('/note.txt', new Uint8Array([1])));
        }),
      ),
    );
    expect(result).toMatchObject({
      _tag: 'Failure',
      failure: { reason: { cause: { code: 'VFS_ATTACHMENT_LOST', outcome: 'unknown' } } },
    });
    expect(client.writes).toHaveLength(1);
  });

  it('keeps a held readonly read interrupted without synthesizing a platform failure', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const entered = await Effect.runPromise(Deferred.make<void>());
    const resume = await Effect.runPromise(Deferred.make<void>());
    client.onReadFileBuffer = async () => {
      await Effect.runPromise(Deferred.succeed(entered, undefined));
      await Effect.runPromise(Deferred.await(resume));
      return new Uint8Array();
    };
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = OpfsFileSystem.make(yield* Volume.make(mount()));
          const reader = yield* Effect.forkChild(Effect.exit(fs.readFile('/note.txt')));
          yield* Deferred.await(entered);
          yield* Fiber.interrupt(reader);
          const exit = yield* Fiber.await(reader);
          expect(exit._tag).toBe('Failure');
          if (exit._tag === 'Failure') {
            expect(exit.cause.reasons.some((reason) => reason._tag === 'Interrupt')).toBe(true);
            expect(exit.cause.reasons.some((reason) => reason._tag === 'Fail')).toBe(false);
          }
          yield* Deferred.succeed(resume, undefined);
        }),
      ),
    );
    expect(client.reads).toHaveLength(1);
  });

  it('uses one recapture allowance across a queued local change and facade refusal', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const entered = await Effect.runPromise(Deferred.make<void>());
    const resume = await Effect.runPromise(Deferred.make<void>());
    client.onWriteFileBuffer = async (_generation, _path, bytes) => {
      if (bytes[0] === 1) {
        await Effect.runPromise(Deferred.succeed(entered, undefined));
        await Effect.runPromise(Deferred.await(resume));
      } else {
        client.publish({ ownerGeneration: 'generation-3' });
        throw new VfsCommandError(Object.assign(new Error('lost'), { code: 'VFS_ATTACHMENT_LOST' }), 'refused');
      }
    };
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = OpfsFileSystem.make(yield* Volume.make(mount()));
          const first = yield* Effect.forkChild(fs.writeFile('/first.txt', new Uint8Array([1])));
          yield* Deferred.await(entered);
          const second = yield* Effect.forkChild(Effect.result(fs.writeFile('/second.txt', new Uint8Array([2]))));
          yield* Effect.sleep(0);
          client.publish({ ownerGeneration: 'generation-2' });
          yield* Deferred.succeed(resume, undefined);
          yield* Fiber.join(first);
          const result = yield* Fiber.join(second);
          expect(result._tag).toBe('Failure');
        }),
      ),
    );
    expect(client.writes).toHaveLength(2);
  });

  it('does not spend readiness budget while a recapture waits for the gate', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const entered = await Effect.runPromise(Deferred.make<void>());
    const resume = await Effect.runPromise(Deferred.make<void>());
    client.onWriteFileBuffer = async (_generation, _path, bytes) => {
      if (bytes[0] === 1) {
        await Effect.runPromise(Deferred.succeed(entered, undefined));
        await Effect.runPromise(Deferred.await(resume));
      }
    };
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = OpfsFileSystem.make(yield* Volume.make(mount({ initTimeout: 1 })));
          const first = yield* Effect.forkChild(fs.writeFile('/first.txt', new Uint8Array([1])));
          yield* Deferred.await(entered);
          const second = yield* Effect.forkChild(fs.writeFile('/second.txt', new Uint8Array([2])));
          yield* Effect.sleep(0);
          client.publish({ ownerGeneration: 'generation-2' });
          yield* Effect.sleep(10);
          yield* Deferred.succeed(resume, undefined);
          yield* Fiber.join(first);
          yield* Fiber.join(second);
        }),
      ),
    );
    expect(client.writes.map(({ generation }) => generation)).toEqual(['generation-1', 'generation-2']);
  });

  it('keeps a pending marker when a later write is locally refused', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    let calls = 0;
    client.onWriteFileBuffer = async () => {
      if (calls++ === 1)
        throw new VfsCommandError(Object.assign(new Error('refused'), { code: 'VFS_ATTACHMENT_LOST' }), 'refused');
    };
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Volume.make(mount());
          const fs = OpfsFileSystem.make(service);
          yield* fs.writeFile('/first.txt', new Uint8Array([1]));
          yield* Effect.result(fs.writeFile('/second.txt', new Uint8Array([2])));
          client.publish({ ownerGeneration: 'generation-2' });
          const result = yield* Effect.result(service.sync);
          expect(result).toMatchObject({
            _tag: 'Failure',
            failure: { _tag: 'VolumeError', code: 'VFS_SYNC_OWNER_CHANGED', outcome: 'unknown' },
          });
        }),
      ),
    );
    expect(client.syncCalls).toBe(0);
  });

  it('keeps an interrupted holder permit until its write settles', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const entered = await Effect.runPromise(Deferred.make<void>());
    const resume = await Effect.runPromise(Deferred.make<void>());
    client.onWriteFileBuffer = async (_generation, _path, bytes) => {
      if (bytes[0] === 1) {
        await Effect.runPromise(Deferred.succeed(entered, undefined));
        await Effect.runPromise(Deferred.await(resume));
      }
    };
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = OpfsFileSystem.make(yield* Volume.make(mount()));
          const first = yield* Effect.forkChild(fs.writeFile('/first.txt', new Uint8Array([1])));
          yield* Deferred.await(entered);
          const interrupted = yield* Effect.forkChild(Fiber.interrupt(first));
          const second = yield* Effect.forkChild(fs.writeFile('/second.txt', new Uint8Array([2])));
          yield* Effect.sleep(0);
          expect(client.writes).toHaveLength(1);
          yield* Deferred.succeed(resume, undefined);
          yield* Fiber.join(interrupted);
          yield* Fiber.join(second);
        }),
      ),
    );
    expect(client.writes).toHaveLength(2);
  });

  it('does not give a healthy SYNC an init-timeout deadline while a write waits', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const entered = await Effect.runPromise(Deferred.make<void>());
    const resume = await Effect.runPromise(Deferred.make<void>());
    client.onSync = async () => {
      await Effect.runPromise(Deferred.succeed(entered, undefined));
      await Effect.runPromise(Deferred.await(resume));
    };
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Volume.make(mount({ initTimeout: 1 }));
          const fs = OpfsFileSystem.make(service);
          const syncing = yield* Effect.forkChild(service.sync);
          yield* Deferred.await(entered);
          const writing = yield* Effect.forkChild(fs.writeFile('/note.txt', new Uint8Array([1])));
          yield* Effect.sleep(10);
          expect(client.writes).toHaveLength(0);
          yield* Deferred.succeed(resume, undefined);
          yield* Fiber.join(syncing);
          yield* Fiber.join(writing);
        }),
      ),
    );
    expect(client.syncCalls).toBe(1);
    expect(client.writes).toHaveLength(1);
  });

  it('cancels a queued writer without releasing the in-flight writer permit', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const entered = await Effect.runPromise(Deferred.make<void>());
    const resume = await Effect.runPromise(Deferred.make<void>());
    client.onWriteFileBuffer = async (_generation, _path, bytes) => {
      if (bytes[0] === 1) {
        await Effect.runPromise(Deferred.succeed(entered, undefined));
        await Effect.runPromise(Deferred.await(resume));
      }
    };
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Volume.make(mount());
          const fs = OpfsFileSystem.make(service);
          const first = yield* Effect.forkChild(fs.writeFile('/note.txt', new Uint8Array([1])));
          yield* Deferred.await(entered);
          const queued = yield* Effect.forkChild(fs.writeFile('/note.txt', new Uint8Array([2])));
          yield* Effect.sleep(0);
          yield* Fiber.interrupt(queued);
          yield* Deferred.succeed(resume, undefined);
          yield* Fiber.join(first);
          expect(client.writes.map(({ path }) => path)).toEqual(['/note.txt']);
        }),
      ),
    );
  });

  it('cancels queued SYNC before dispatch while an earlier writer still owns the permit', async () => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const entered = await Effect.runPromise(Deferred.make<void>());
    const resume = await Effect.runPromise(Deferred.make<void>());
    client.onWriteFileBuffer = async () => {
      await Effect.runPromise(Deferred.succeed(entered, undefined));
      await Effect.runPromise(Deferred.await(resume));
    };
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Volume.make(mount());
          const fs = OpfsFileSystem.make(service);
          const writer = yield* Effect.forkChild(fs.writeFile('/note.txt', new Uint8Array([1])));
          yield* Deferred.await(entered);
          const syncing = yield* Effect.forkChild(service.sync);
          yield* Effect.sleep(0);
          yield* Fiber.interrupt(syncing);
          yield* Deferred.succeed(resume, undefined);
          yield* Fiber.join(writer);
          expect(client.syncCalls).toBe(0);
          expect(client.writes).toHaveLength(1);
        }),
      ),
    );
  });

  it.each(['worker failure', 'scope close'])('wakes a queued writer on %s without dispatching it', async (ending) => {
    const client = new FakeWorkerClient();
    workerMocks.open.mockResolvedValue(clientAsCore(client));
    const entered = await Effect.runPromise(Deferred.make<void>());
    const resume = await Effect.runPromise(Deferred.make<void>());
    client.onWriteFileBuffer = async (_generation, _path, bytes) => {
      if (bytes[0] === 1) {
        await Effect.runPromise(Deferred.succeed(entered, undefined));
        await Effect.runPromise(Deferred.await(resume));
      }
    };
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* Scope.make();
          const service = yield* Volume.make(mount()).pipe(Effect.provideService(Scope.Scope, owner));
          const fs = OpfsFileSystem.make(service);
          const writer = yield* Effect.forkChild(fs.writeFile('/note.txt', new Uint8Array([1])));
          yield* Deferred.await(entered);
          const queued = yield* Effect.forkChild(Effect.result(fs.writeFile('/note.txt', new Uint8Array([2]))));
          yield* Effect.sleep(0);
          if (ending === 'scope close') yield* Scope.close(owner, Exit.void);
          else
            client.publish({
              state: 'failed',
              role: null,
              ownerGeneration: null,
              error: { message: 'crash', code: 'VFS_WORKER_FAILED' },
            });
          yield* Deferred.succeed(resume, undefined);
          const result = yield* Fiber.join(queued);
          expect(result).toMatchObject({
            _tag: 'Failure',
            failure: {
              reason: {
                cause: { _tag: 'VolumeError', fileName: 'worker.bin', operation: 'writeFile', outcome: 'not-applied' },
              },
            },
          });
          yield* Fiber.join(writer);
          expect(client.writes).toHaveLength(1);
          yield* Scope.close(owner, Exit.void);
        }),
      ),
    );
  });
});
