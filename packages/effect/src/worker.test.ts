import { Deferred, Effect, Exit, Fiber, Scope } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VfsCommandError } from '@opfs-vfs/opfs-vfs/worker';
import type { OpfsVfsWorkerClient, ClientStatus } from '@opfs-vfs/opfs-vfs/worker-client';
import type { VfsPluginRequest } from '@opfs-vfs/opfs-vfs/plugins';
import { Volume } from './index.js';
import type { WorkerMountOptions } from './volume.js';
import { EncryptionError } from './errors.js';

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
    return { sync: () => this.onSync?.() ?? Promise.resolve() };
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

  it('surfaces late discovery cleanup failure in the scope cause', async () => {
    const parent = await Effect.runPromise(Scope.make());
    const started = await Effect.runPromise(Deferred.make<void>());
    let resolveDiscovery!: (client: OpfsVfsWorkerClient) => void;
    let signal: AbortSignal | undefined;
    const closeFailure = new Error('late close failed');
    const client = new FakeWorkerClient();
    client.onClose = () => Promise.reject(closeFailure);
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
    resolveDiscovery(clientAsCore(client));
    const closeExit = await close;
    expect(client.closeCalls).toBe(1);
    const acquireExit = await Effect.runPromise(Fiber.await(fiber));
    expect(Exit.isFailure(acquireExit)).toBe(true);
    const closeDied = closeExit._tag === 'Failure' && closeExit.cause.reasons.some((reason) => reason._tag === 'Die');
    const acquireDied =
      acquireExit._tag === 'Failure' && acquireExit.cause.reasons.some((reason) => reason._tag === 'Die');
    expect(closeDied || acquireDied).toBe(true);
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
});
