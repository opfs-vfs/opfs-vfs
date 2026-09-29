import { Deferred, Effect, Exit, Fiber, Scope } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VfsCommandError } from '@opfs-vfs/opfs-vfs/worker';
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
  afterDescriptorWrite: (() => void) | undefined;
  maxWrite = Number.POSITIVE_INFINITY;
  writes: Array<{ generation: string; path: string }> = [];
  reads: Array<{ generation: string; path: string; limit: number }> = [];
  descriptorCalls: Array<{ generation: string; method: string }> = [];
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
    return {
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
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.make(mount());
          yield* OpfsFileSystem.make(volume).writeFile('/large', source);
        }),
      ),
    );
    expect(source.byteLength).toBe(16 * 1024 * 1024 + 1);
    expect(client.bytes).toEqual(source);
    expect(client.writes).toEqual([]);
    expect(client.descriptorCalls.map(({ generation, method }) => [generation, method])).toEqual([
      ['generation-1', 'open'],
      ['generation-1', 'write'],
      ['generation-1', 'close'],
    ]);
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
