import { Context, Effect, Exit, Layer, Scope, Schema } from 'effect';
import {
  OpfsVfs,
  peekVolume,
  type LocalPersistenceState,
  type OpfsVfsOptions,
  type VolumePeek,
} from '@opfs-vfs/opfs-vfs';
import { openOpfsVfsWorker, VfsCommandError } from '@opfs-vfs/opfs-vfs/worker';
import type { OpenOpfsVfsWorkerOptions, VfsWorkerFactory } from '@opfs-vfs/opfs-vfs/worker';
import type { OpfsVfsWorkerClient } from '@opfs-vfs/opfs-vfs/worker-client';
import type { ConfiguredVfsPlugin, VfsPluginRequest } from '@opfs-vfs/opfs-vfs/plugins';
// @ts-expect-error Vite inline worker import.
import SubscriptionsWorker from './subscriptions.worker?worker&inline';
import {
  EncryptionError,
  SubscriptionError,
  VolumeError,
  mountError,
  remoteDetails,
  volumeError,
  type MountError,
  type RemoteErrorDetails,
} from './errors.js';

export interface DirectMountOptions extends Omit<OpfsVfsOptions, 'plugins'> {
  readonly fileName: string;
  readonly plugins?: () => readonly ConfiguredVfsPlugin[];
}
export interface WorkerMountOptions extends Omit<OpenOpfsVfsWorkerOptions, 'signal' | 'plugins'> {
  readonly fileName: string;
  readonly plugins?: readonly VfsPluginRequest[] | (() => readonly VfsPluginRequest[]);
}
export interface PersistenceSnapshot {
  readonly state: LocalPersistenceState | 'unknown';
  readonly error: RemoteErrorDetails | null;
}
export interface VolumeService {
  readonly fileName: string;
  readonly sync: Effect.Effect<void, MountError>;
  readonly persistence: Effect.Effect<PersistenceSnapshot, VolumeError>;
  readonly acknowledgeOwnerChange: Effect.Effect<void, VolumeError>;
}
type Input<E, R> = DirectMountOptions | Effect.Effect<DirectMountOptions, E, R>;
type WorkerInput<E, R> = WorkerMountOptions | Effect.Effect<WorkerMountOptions, E, R>;

export class Volume extends Context.Service<Volume, VolumeService>()('@opfs-vfs/effect/Volume') {}

const invalidName = (fileName: string) =>
  typeof fileName !== 'string' || fileName.length <= 4 || !fileName.endsWith('.bin') || /[/\\]/.test(fileName);
const workerFactoryError = () =>
  Object.assign(new Error('Worker factory failed'), { code: 'VFS_WORKER_FACTORY_FAILED' });
const guardFactory =
  <A extends unknown[], T>(factory: (...args: A) => T) =>
  (...args: A): T => {
    try {
      return factory(...args);
    } catch {
      throw workerFactoryError();
    }
  };

export const inspect = (fileName: string): Effect.Effect<VolumePeek, VolumeError> => {
  if (invalidName(fileName))
    return Effect.fail(
      volumeError(
        new TypeError('Volume name must be a basename ending in .bin'),
        fileName,
        'inspect',
        'configuration',
        'not-applied',
      ),
    );
  return Effect.tryPromise({
    try: () => peekVolume(fileName),
    catch: (error) => volumeError(error, fileName, 'inspect', 'filesystem', 'not-applied'),
  });
};

const makeDirectInternal = <E, R>(input: Input<E, R>): Effect.Effect<VolumeService, MountError | E, Scope.Scope | R> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const parent = yield* Effect.scope;
      const owner = yield* Scope.fork(parent, 'sequential');
      const resource = yield* Scope.make('sequential');
      let closed = false;
      let backend: OpfsVfs | undefined;
      let release: Promise<void> | undefined;
      let service: VolumeService | undefined;
      const ensureOpen = (fileName: string | null) =>
        closed || owner.state._tag === 'Closed'
          ? Effect.fail(
              volumeError(new Error('Volume scope is closed'), fileName, 'acquire', 'lifecycle', 'not-applied'),
            )
          : Effect.void;
      const closeBackend = () => {
        if (service) closedBackends.add(service);
        if (backend) release ??= Promise.resolve(backend.closeVfs()).then(() => undefined);
        return release ?? Promise.resolve();
      };
      let firstCloseExit: Exit.Exit<unknown, unknown> | undefined;
      const cachedClose: Effect.Effect<void, never> = yield* Effect.cached(
        Effect.suspend(() => Scope.close(resource, firstCloseExit!)),
      );
      const closeResource = (exit: Exit.Exit<unknown, unknown>): Effect.Effect<void, never> => {
        firstCloseExit ??= exit;
        return cachedClose;
      };
      yield* Scope.addFinalizerExit(owner, closeResource);
      yield* ensureOpen(null);

      const acquire = Effect.gen(function* () {
        const parentScopedInput = Effect.isEffect(input)
          ? Effect.provideService(input, Scope.Scope, resource)
          : Effect.succeed(input);
        const options = yield* restore(parentScopedInput);
        yield* ensureOpen(null);
        let plugins: readonly ConfiguredVfsPlugin[] | undefined;
        if (options.plugins) {
          try {
            plugins = options.plugins();
          } catch {
            return yield* Effect.fail(
              volumeError(
                new Error('Plugin configuration failed'),
                options.fileName,
                'configure plugins',
                'configuration',
                'not-applied',
              ),
            );
          }
        }
        const { fileName, plugins: _plugins, ...coreOptions } = options;
        yield* ensureOpen(fileName);
        if (invalidName(fileName))
          return yield* Effect.fail(
            volumeError(
              new TypeError('Volume name must be a basename ending in .bin'),
              fileName,
              'configure',
              'configuration',
              'not-applied',
            ),
          );
        try {
          backend = new OpfsVfs(fileName, { ...coreOptions, plugins });
        } catch (error) {
          return yield* Effect.fail(
            typeof error === 'object' && error !== null && 'code' in error && error.code === 'EINVAL'
              ? volumeError(error, fileName, 'mount', 'configuration', 'not-applied')
              : mountError(error, fileName, 'mount'),
          );
        }
        yield* Scope.addFinalizer(
          resource,
          Effect.tryPromise({
            try: closeBackend,
            catch: (error) => mountError(error, fileName, 'close', 'lifecycle'),
          }).pipe(Effect.catch((error) => Effect.die(error))),
        );
        yield* ensureOpen(fileName);
        yield* restore(
          Effect.tryPromise({
            try: () => backend!.ready,
            catch: (error) => mountError(error, fileName, 'initialize', 'filesystem'),
          }),
        );
        yield* ensureOpen(fileName);
        service = createService(backend!, fileName, () => closed);
        backends.set(service, backend!);
        yield* Scope.addFinalizer(
          resource,
          Effect.sync(() => {
            closed = true;
            if (service) closedBackends.add(service);
          }),
        );
        yield* ensureOpen(fileName);
        return service;
      });

      return yield* acquire.pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? Effect.gen(function* () {
                const resourceExit = yield* Effect.exit(closeResource(exit));
                yield* Effect.exit(Scope.close(owner, exit));
                if (Exit.isFailure(resourceExit)) return yield* Effect.failCause(resourceExit.cause);
              })
            : Effect.void,
        ),
      );
    }),
  );

const createService = (backend: OpfsVfs, fileName: string, isClosed: () => boolean): VolumeService => {
  const check = (operation: string) =>
    isClosed()
      ? volumeError(new Error('Volume is closed'), fileName, operation, 'lifecycle', 'not-applied')
      : undefined;
  const sync: Effect.Effect<void, MountError> = Effect.try({
    try: () => {
      const failure = check('sync');
      if (failure) throw failure;
      backend.syncSync();
    },
    catch: (error) =>
      error instanceof VolumeError || error instanceof EncryptionError
        ? error
        : mountError(error, fileName, 'sync', 'persistence'),
  });
  const persistence: Effect.Effect<PersistenceSnapshot, VolumeError> = Effect.try({
    try: () => {
      const failure = check('persistence');
      if (failure) throw failure;
      const status = backend.getLocalPersistenceStatusSync();
      return {
        state: status.localPersistenceState,
        error:
          status.localPersistenceState === 'error' && status.lastError !== undefined
            ? remoteDetails(status.lastError)
            : null,
      };
    },
    catch: (error) => (error instanceof VolumeError ? error : volumeError(error, fileName, 'persistence', 'lifecycle')),
  });
  const acknowledgeOwnerChange: Effect.Effect<void, VolumeError> = Effect.try({
    try: () => {
      const failure = check('acknowledgeOwnerChange');
      if (failure) throw failure;
    },
    catch: (error) =>
      error instanceof VolumeError ? error : volumeError(error, fileName, 'acknowledgeOwnerChange', 'lifecycle'),
  });
  return { fileName, sync, persistence, acknowledgeOwnerChange };
};

export function makeDirect(input: DirectMountOptions): Effect.Effect<VolumeService, MountError, Scope.Scope>;
export function makeDirect<E, R>(
  input: Effect.Effect<DirectMountOptions, E, R>,
): Effect.Effect<VolumeService, MountError | E, Scope.Scope | R>;
export function makeDirect<E = never, R = never>(
  input: Input<E, R>,
): Effect.Effect<VolumeService, MountError | E, Scope.Scope | R>;
export function makeDirect<E, R>(input: Input<E, R>) {
  return makeDirectInternal<E, R>(input);
}

export function layerDirect(input: DirectMountOptions): Layer.Layer<Volume, MountError>;
export function layerDirect<E, R>(
  input: Effect.Effect<DirectMountOptions, E, R>,
): Layer.Layer<Volume, MountError | E, R>;
export function layerDirect<E = never, R = never>(input: Input<E, R>): Layer.Layer<Volume, MountError | E, R>;
export function layerDirect<E, R>(input: Input<E, R>) {
  return Layer.effect(Volume, makeDirectInternal<E, R>(input));
}
const makeWorker = <E, R>(input: WorkerInput<E, R>): Effect.Effect<VolumeService, MountError | E, Scope.Scope | R> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const parent = yield* Effect.scope;
      const owner = yield* Scope.fork(parent, 'sequential');
      const resource = yield* Scope.make('sequential');
      let closed = false;
      let client: OpfsVfsWorkerClient | undefined;
      let releasedClient: OpfsVfsWorkerClient | undefined;
      let release: Promise<void> | undefined;
      let discovery: Promise<OpfsVfsWorkerClient> | undefined;
      let discoveryCleanup: Promise<void> | undefined;
      let service: VolumeService | undefined;
      let terminal: VolumeError | undefined;
      const abort = new AbortController();
      const ensureOpen = (fileName: string | null) =>
        closed || owner.state._tag === 'Closed'
          ? Effect.fail(
              volumeError(new Error('Volume scope is closed'), fileName, 'acquire', 'lifecycle', 'not-applied'),
            )
          : Effect.void;
      const closeClient = (value: OpfsVfsWorkerClient) => {
        if (releasedClient === value) return release!;
        releasedClient = value;
        release = Promise.resolve().then(() => value.closeVfs());
        return release;
      };
      const joinDiscovery = () => {
        abort.abort();
        if (!discovery) return Promise.resolve();
        return (discoveryCleanup ??= discovery.then(
          (value) =>
            releasedClient === value
              ? release!.then(
                  () => undefined,
                  () => undefined,
                )
              : closeClient(value),
          () => undefined,
        ));
      };
      let firstCloseExit: Exit.Exit<unknown, unknown> | undefined;
      const cachedClose: Effect.Effect<void, never> = yield* Effect.cached(
        Effect.suspend(() => Scope.close(resource, firstCloseExit!)),
      );
      const closeResource = (exit: Exit.Exit<unknown, unknown>): Effect.Effect<void, never> => {
        firstCloseExit ??= exit;
        return cachedClose;
      };
      yield* Scope.addFinalizerExit(owner, closeResource);
      yield* Scope.addFinalizer(
        resource,
        Effect.tryPromise({
          try: joinDiscovery,
          catch: (error) => mountError(error, null, 'close', 'lifecycle'),
        }).pipe(Effect.catch((error) => Effect.die(error))),
      );
      yield* Scope.addFinalizer(
        resource,
        Effect.sync(() => {
          closed = true;
          abort.abort();
        }),
      );
      yield* ensureOpen(null);

      const acquire = Effect.gen(function* () {
        const scopedInput = Effect.isEffect(input)
          ? Effect.provideService(input, Scope.Scope, resource)
          : Effect.succeed(input);
        const options = yield* restore(scopedInput);
        yield* ensureOpen(options.fileName);
        const { fileName, plugins: pluginInput, ...workerOptions } = options;
        const initTimeout = workerOptions.initTimeout || 15_000;
        if (invalidName(fileName))
          return yield* Effect.fail(
            volumeError(
              new TypeError('Volume name must be a basename ending in .bin'),
              fileName,
              'configure',
              'configuration',
              'not-applied',
            ),
          );
        let plugins: readonly VfsPluginRequest[];
        try {
          plugins = [...(typeof pluginInput === 'function' ? pluginInput() : (pluginInput ?? []))];
        } catch {
          return yield* Effect.fail(
            volumeError(
              new Error('Plugin configuration failed'),
              fileName,
              'configure plugins',
              'configuration',
              'not-applied',
            ),
          );
        }
        yield* ensureOpen(fileName);

        const defaultWorker = () => new SubscriptionsWorker();
        const worker = guardFactory(workerOptions.worker ?? (defaultWorker as VfsWorkerFactory));
        const sharedWorker = workerOptions.sharedWorker ? guardFactory(workerOptions.sharedWorker) : undefined;
        discovery = Promise.resolve().then(() =>
          openOpfsVfsWorker(fileName, { ...workerOptions, worker, sharedWorker, plugins, signal: abort.signal }),
        );
        client = yield* restore(
          Effect.tryPromise({
            try: () => discovery!,
            catch: (error) =>
              typeof error === 'object' && error !== null && 'code' in error && error.code === 'EINVAL'
                ? volumeError(error, fileName, 'mount', 'configuration')
                : mountError(error, fileName, 'mount', 'filesystem'),
          }),
        );
        yield* ensureOpen(fileName);
        yield* Scope.addFinalizer(
          resource,
          Effect.tryPromise({
            try: () => {
              closed = true;
              if (service) closedBackends.add(service);
              return closeClient(client!);
            },
            catch: (error) => mountError(error, fileName, 'close', 'lifecycle'),
          }).pipe(Effect.catch((error) => Effect.die(error))),
        );
        yield* ensureOpen(fileName);
        const latchStatus = () => {
          const status = client!.getStatus();
          if (!terminal && (status.state === 'closing' || status.state === 'failed' || status.state === 'closed'))
            terminal = terminalError(status, fileName, 'worker');
        };
        const unsubscribe = client.subscribeStatus(latchStatus);
        yield* Scope.addFinalizer(resource, Effect.sync(unsubscribe));
        latchStatus();
        yield* restore(
          Effect.tryPromise({
            try: () => client!.ready,
            catch: (error) => {
              latchStatus();
              if (terminal && Schema.is(EncryptionError)(terminal.cause)) return terminal.cause;
              if (terminal && Schema.is(VolumeError)(terminal.cause) && terminal.cause.kind === 'configuration')
                return terminal.cause;
              return terminal ?? mountError(error, fileName, 'initialize', 'filesystem');
            },
          }),
        );
        yield* ensureOpen(fileName);
        latchStatus();
        if (terminal) {
          if (Schema.is(EncryptionError)(terminal.cause)) return yield* Effect.fail(terminal.cause);
          return yield* Effect.fail(terminal);
        }
        service = createWorkerService(
          client,
          fileName,
          () => closed,
          () => {
            latchStatus();
            return terminal;
          },
          initTimeout,
        );
        backends.set(service, client);
        yield* ensureOpen(fileName);
        return service;
      });

      return yield* acquire.pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? Effect.gen(function* () {
                const resourceExit = yield* Effect.exit(closeResource(exit));
                yield* Effect.exit(Scope.close(owner, exit));
                if (Exit.isFailure(resourceExit)) return yield* Effect.failCause(resourceExit.cause);
              })
            : Effect.void,
        ),
      );
    }),
  );

const terminalError = (status: ReturnType<OpfsVfsWorkerClient['getStatus']>, fileName: string, operation: string) => {
  const decoded = status.error
    ? mountError(Object.assign(new Error(status.error.message), status.error), fileName, operation)
    : volumeError(new Error('Worker client closed'), fileName, operation, 'lifecycle');
  const details = decoded.details ?? null;
  return new VolumeError({
    kind: 'lifecycle',
    fileName,
    operation,
    ...(details?.code ? { code: details.code } : {}),
    outcome: 'unknown',
    details,
    cause: decoded,
  });
};

const createWorkerService = (
  client: OpfsVfsWorkerClient,
  fileName: string,
  isClosed: () => boolean,
  terminal: () => VolumeError | undefined,
  initTimeout: number,
): VolumeService => {
  const failIfUnavailable = (operation: string) => {
    if (isClosed()) return volumeError(new Error('Volume is closed'), fileName, operation, 'lifecycle', 'not-applied');
    return terminal();
  };
  const persistence: VolumeService['persistence'] = Effect.try({
    try: () => {
      const failure = failIfUnavailable('persistence');
      if (failure) throw failure;
      const status = client.getStatus().persistence;
      return status
        ? { state: status.state, error: status.state === 'error' ? status.lastError : null }
        : { state: 'unknown' as const, error: null };
    },
    catch: (error) => (error instanceof VolumeError ? error : volumeError(error, fileName, 'persistence', 'lifecycle')),
  });
  const sync: VolumeService['sync'] = Effect.gen(function* () {
    const failure = failIfUnavailable('sync');
    if (failure) return yield* Effect.fail(syncError(failure));
    const budget = { remaining: initTimeout };
    const status = yield* waitForReady(client, fileName, 'sync', budget, terminal, syncError);
    yield* Effect.tryPromise({
      try: () => client.forGeneration(status.ownerGeneration!).sync(),
      catch: (error) => {
        const terminalFailure = failIfUnavailable('sync');
        if (terminalFailure) {
          return syncError(terminalFailure);
        }
        const dispatch = error instanceof VfsCommandError ? error.dispatch : undefined;
        const raw = error instanceof VfsCommandError ? error.cause : error;
        return mountError(raw, fileName, 'sync', undefined, dispatch === 'refused' ? 'not-applied' : 'unknown');
      },
    });
  });
  const acknowledgeOwnerChange: VolumeService['acknowledgeOwnerChange'] = Effect.gen(function* () {
    const failure = failIfUnavailable('acknowledgeOwnerChange');
    if (failure) return yield* Effect.fail(failure);
    yield* waitForReady(client, fileName, 'acknowledgeOwnerChange', { remaining: initTimeout }, terminal);
    const after = failIfUnavailable('acknowledgeOwnerChange');
    if (after) return yield* Effect.fail(after);
    return yield* Effect.void;
  });
  return { fileName, sync, persistence, acknowledgeOwnerChange };
};

const waitForReady = <E extends MountError = VolumeError>(
  client: OpfsVfsWorkerClient,
  fileName: string,
  operation: string,
  budget: { remaining: number },
  terminal: () => VolumeError | undefined,
  mapTerminal: (error: VolumeError) => E = ((error) => error) as (error: VolumeError) => E,
): Effect.Effect<ReturnType<OpfsVfsWorkerClient['getStatus']>, E> => {
  const waiting = Effect.callback<ReturnType<OpfsVfsWorkerClient['getStatus']>, E>((resume) => {
    let settled = false;
    let unsubscribe = () => {};
    const finish = (effect: Effect.Effect<ReturnType<OpfsVfsWorkerClient['getStatus']>, E>) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      resume(effect);
    };
    const check = () => {
      const status = client.getStatus();
      if (status.state === 'ready' && status.ownerGeneration) finish(Effect.succeed(status));
      else if (status.state === 'closing' || status.state === 'failed' || status.state === 'closed')
        finish(Effect.fail(mapTerminal(terminal() ?? terminalError(status, fileName, operation))));
    };
    unsubscribe = client.subscribeStatus(check);
    check();
    return Effect.sync(unsubscribe);
  });
  return Effect.gen(function* () {
    const timeoutError = volumeError(
      Object.assign(new Error('Ready owner wait timed out'), { code: 'VFS_OWNER_READY_TIMEOUT' }),
      fileName,
      operation,
      'lifecycle',
      'not-applied',
    ) as E;
    if (budget.remaining <= 0) return yield* Effect.fail(timeoutError);
    const start = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
    const timeout = Effect.sleep(budget.remaining).pipe(Effect.andThen(Effect.fail(timeoutError)));
    return yield* Effect.raceFirst(waiting, timeout).pipe(
      Effect.onExit(() =>
        Effect.clockWith((clock) => clock.currentTimeMillis).pipe(
          Effect.flatMap((end) =>
            Effect.sync(() => {
              budget.remaining = Math.max(0, budget.remaining - Math.max(0, end - start));
            }),
          ),
        ),
      ),
    );
  });
};

const syncError = (error: VolumeError): MountError => (Schema.is(EncryptionError)(error.cause) ? error.cause : error);

export function make<E = never, R = never>(
  input: WorkerMountOptions | Effect.Effect<WorkerMountOptions, E, R>,
): Effect.Effect<VolumeService, MountError | E, Scope.Scope | R> {
  return makeWorker(input);
}
export function layer<E = never, R = never>(
  input: WorkerMountOptions | Effect.Effect<WorkerMountOptions, E, R>,
): Layer.Layer<Volume, MountError | E, R> {
  return Layer.effect(Volume, makeWorker(input));
}
export const unsafeBackend = (volume: VolumeService): OpfsVfs | OpfsVfsWorkerClient => {
  const backend = backends.get(volume);
  if (!backend) throw new TypeError('Volume service was not created by this adapter');
  if (closedBackends.has(volume))
    throw volumeError(
      new Error('Volume scope is closed'),
      volume.fileName,
      'unsafeBackend',
      'lifecycle',
      'not-applied',
    );
  return backend;
};
const backends = new WeakMap<VolumeService, OpfsVfs | OpfsVfsWorkerClient>();
const closedBackends = new WeakSet<VolumeService>();

export const errorOf = (error: {
  readonly reason?: { readonly cause?: unknown };
}): VolumeError | EncryptionError | SubscriptionError | undefined => {
  try {
    const cause = error.reason?.cause;
    if (Schema.is(VolumeError)(cause) && cause.kind === 'lifecycle' && cause.cause !== undefined) {
      const inner = cause.cause;
      if (Schema.is(VolumeError)(inner) || Schema.is(EncryptionError)(inner) || Schema.is(SubscriptionError)(inner))
        return inner;
    }
    if (Schema.is(VolumeError)(cause) || Schema.is(EncryptionError)(cause) || Schema.is(SubscriptionError)(cause))
      return cause;
  } catch {
    return undefined;
  }
  return undefined;
};
