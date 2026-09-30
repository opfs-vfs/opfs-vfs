import { Cause, Context, Deferred, Effect, Exit, Layer, Scope, Schema, Semaphore } from 'effect';
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
import { getCoordinator, latchTerminal, makeCoordinator, registerCoordinator } from './coordinator.js';

export interface DirectMountOptions extends Omit<OpfsVfsOptions, 'plugins'> {
  readonly fileName: string;
  readonly plugins?: () => readonly ConfiguredVfsPlugin[];
}
export interface WorkerMountOptions extends Omit<OpenOpfsVfsWorkerOptions, 'signal' | 'plugins'> {
  readonly fileName: string;
  readonly plugins?: readonly VfsPluginRequest[] | (() => readonly VfsPluginRequest[]);
}
export interface PersistenceSnapshot {
  /** Current backend telemetry; `clean` does not prove an earlier logical save survived, so await `sync`. */
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

const closeFiles = (coordinator: ReturnType<typeof makeCoordinator> | undefined) =>
  Effect.forEach([...(coordinator?.files ?? [])], (close) => Effect.exit(close()), { concurrency: 1 }).pipe(
    Effect.flatMap((exits) => {
      let cause: Cause.Cause<never> | undefined;
      for (const exit of exits) if (Exit.isFailure(exit)) cause = cause ? Cause.combine(cause, exit.cause) : exit.cause;
      return cause ? Effect.failCause(cause) : Effect.void;
    }),
  );

const combineCleanup = <A>(first: Exit.Exit<A, never>, second: Exit.Exit<void, never>) => {
  const cause = Exit.isFailure(first)
    ? Exit.isFailure(second)
      ? Cause.combine(first.cause, second.cause)
      : first.cause
    : Exit.isFailure(second)
      ? second.cause
      : undefined;
  return cause ? Effect.failCause(cause) : Effect.void;
};

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
      let coordinator: ReturnType<typeof makeCoordinator> | undefined;
      const ensureOpen = (fileName: string | null) =>
        closed || owner.state._tag === 'Closed'
          ? Effect.fail(
              volumeError(new Error('Volume scope is closed'), fileName, 'acquire', 'lifecycle', 'not-applied'),
            )
          : Effect.void;
      const closeBackend = () => {
        closed = true;
        if (coordinator)
          latchTerminal(coordinator, volumeError(new Error('Volume is closed'), null, 'close', 'lifecycle', 'unknown'));
        if (service) closedBackends.add(service);
        if (backend)
          release ??= Promise.resolve()
            .then(() => backend!.closeVfs())
            .then(() => undefined);
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
          Effect.gen(function* () {
            closed = true;
            if (coordinator)
              latchTerminal(
                coordinator,
                volumeError(new Error('Volume is closed'), null, 'close', 'lifecycle', 'unknown'),
              );
            const filesExit = yield* Effect.exit(closeFiles(coordinator));
            const backendExit = yield* Effect.exit(
              Effect.tryPromise({
                try: closeBackend,
                catch: (error) => mountError(error, fileName, 'close', 'lifecycle'),
              }).pipe(Effect.orDie),
            );
            return yield* combineCleanup(filesExit, backendExit);
          }),
        );
        yield* ensureOpen(fileName);
        yield* restore(
          Effect.tryPromise({
            try: () => backend!.ready,
            catch: (error) => mountError(error, fileName, 'initialize', 'filesystem'),
          }),
        );
        yield* ensureOpen(fileName);
        coordinator = makeCoordinator({
          fileName,
          scope: resource,
          readinessTimeout: Infinity,
          backend: backend!,
          isClosed: () => closed,
          currentGeneration: () => (closed ? undefined : 'direct'),
          canRecapture: () => false,
          terminal: () => undefined,
          awaitReady: (_budget, operation) =>
            closed
              ? Effect.fail(volumeError(new Error('Volume is closed'), fileName, operation, 'lifecycle', 'not-applied'))
              : Effect.succeed('direct'),
        });
        service = createService(backend!, fileName, () => closed, coordinator!);
        registerCoordinator(service, coordinator!);
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

const createService = (
  backend: OpfsVfs,
  fileName: string,
  isClosed: () => boolean,
  coordinator: ReturnType<typeof makeCoordinator>,
): VolumeService => {
  const check = (operation: string) =>
    isClosed()
      ? volumeError(new Error('Volume is closed'), fileName, operation, 'lifecycle', 'not-applied')
      : undefined;
  const sync: Effect.Effect<void, MountError> = Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const status = yield* restore(coordinator.awaitReady({ remaining: Infinity }, 'sync'));
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* restore(
            Effect.raceFirst(
              Effect.acquireRelease(Semaphore.take(coordinator.gate, 1), () => Semaphore.release(coordinator.gate, 1), {
                interruptible: true,
              }),
              Deferred.await(coordinator.terminalSignal).pipe(Effect.flatMap((error) => Effect.fail(syncError(error)))),
            ),
          );
          const failure = check('sync');
          if (failure) return yield* Effect.fail(syncError(failure));
          if (
            coordinator.continuity._tag === 'lost' ||
            (coordinator.continuity._tag === 'pending' && coordinator.continuity.generation !== status)
          ) {
            const generation = coordinator.continuity.generation;
            coordinator.continuity = { _tag: 'lost', generation };
            return yield* Effect.fail(
              volumeError(
                Object.assign(new Error('Writes accepted by a previous owner may not be durable'), {
                  code: 'VFS_SYNC_OWNER_CHANGED',
                }),
                fileName,
                'sync',
                'persistence',
                'unknown',
              ),
            );
          }
          yield* Effect.try({
            try: () => backend.syncSync(),
            catch: (error) =>
              error instanceof EncryptionError || error instanceof VolumeError
                ? error
                : mountError(error, fileName, 'sync', 'persistence'),
          });
          if (coordinator.continuity._tag === 'pending') coordinator.continuity = { _tag: 'clean' };
        }),
      );
    }),
  );
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
  const acknowledgeOwnerChange: Effect.Effect<void, VolumeError> = Effect.uninterruptibleMask((restore) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* restore(
          Effect.raceFirst(
            Effect.acquireRelease(Semaphore.take(coordinator.gate, 1), () => Semaphore.release(coordinator.gate, 1), {
              interruptible: true,
            }),
            Deferred.await(coordinator.terminalSignal).pipe(Effect.flatMap(Effect.fail)),
          ),
        );
        const failure = check('acknowledgeOwnerChange');
        if (failure) return yield* Effect.fail(failure);
      }),
    ),
  );
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
      let coordinator: ReturnType<typeof makeCoordinator> | undefined;
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
        if (coordinator)
          latchTerminal(coordinator, volumeError(new Error('Volume is closed'), null, 'close', 'lifecycle', 'unknown'));
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
          if (coordinator)
            latchTerminal(
              coordinator,
              volumeError(new Error('Volume is closed'), null, 'close', 'lifecycle', 'unknown'),
            );
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
          Effect.gen(function* () {
            closed = true;
            abort.abort();
            if (coordinator)
              latchTerminal(
                coordinator,
                volumeError(new Error('Volume is closed'), null, 'close', 'lifecycle', 'unknown'),
              );
            const filesExit = yield* Effect.exit(closeFiles(coordinator));
            const backendExit = yield* Effect.exit(
              Effect.tryPromise({
                try: () => {
                  if (service) closedBackends.add(service);
                  return closeClient(client!);
                },
                catch: (error) => mountError(error, fileName, 'close', 'lifecycle'),
              }).pipe(Effect.catch((error) => Effect.die(error))),
            );
            return yield* combineCleanup(filesExit, backendExit);
          }),
        );
        yield* ensureOpen(fileName);
        const latchStatus = () => {
          const status = client!.getStatus();
          if (!terminal && (status.state === 'closing' || status.state === 'failed' || status.state === 'closed'))
            terminal = terminalError(status, fileName, 'worker');
          if (terminal && service) {
            const coordinator = getCoordinator(service);
            if (coordinator) latchTerminal(coordinator, terminal);
          }
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
        coordinator = makeCoordinator({
          fileName,
          scope: resource,
          readinessTimeout: initTimeout,
          backend: client!,
          isClosed: () => closed,
          currentGeneration: () => {
            latchStatus();
            const status = client!.getStatus();
            return status.state === 'ready' ? (status.ownerGeneration ?? undefined) : undefined;
          },
          canRecapture: () => !closed && !terminal && client!.getStatus().transport === 'dedicated',
          terminal: () => {
            latchStatus();
            return terminal;
          },
          awaitReady: (budget, operation) =>
            waitForReady(client!, fileName, operation, budget, () => {
              latchStatus();
              return terminal;
            }).pipe(
              Effect.map((status) => status.ownerGeneration!),
              Effect.mapError((error) => error as VolumeError),
            ),
        });
        service = createWorkerService(
          client,
          fileName,
          () => closed,
          () => {
            latchStatus();
            return terminal;
          },
          initTimeout,
          coordinator!,
        );
        registerCoordinator(service, coordinator!);
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
  coordinator: ReturnType<typeof makeCoordinator>,
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
  const sync: VolumeService['sync'] = Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const failure = failIfUnavailable('sync');
      if (failure) return yield* Effect.fail(syncError(failure));
      const status = yield* restore(
        waitForReady(client, fileName, 'sync', { remaining: initTimeout }, terminal, (error) =>
          error.code === 'VFS_OWNER_READY_TIMEOUT' && coordinator.continuity._tag !== 'clean'
            ? volumeError(error, fileName, 'sync', 'lifecycle', 'unknown')
            : syncError(error),
        ),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* restore(
            Effect.raceFirst(
              Effect.acquireRelease(Semaphore.take(coordinator.gate, 1), () => Semaphore.release(coordinator.gate, 1), {
                interruptible: true,
              }),
              Deferred.await(coordinator.terminalSignal).pipe(Effect.flatMap((error) => Effect.fail(syncError(error)))),
            ),
          );
          const now = client.getStatus();
          const terminalFailure = failIfUnavailable('sync');
          if (terminalFailure) return yield* Effect.fail(syncError(terminalFailure));
          const generation = status.ownerGeneration!;
          if (now.state !== 'ready') {
            return yield* Effect.fail(
              volumeError(
                Object.assign(new Error('Owner is not ready before SYNC dispatch'), { code: 'VFS_ATTACHMENT_LOST' }),
                fileName,
                'sync',
                'lifecycle',
                'not-applied',
              ),
            );
          }
          if (now.ownerGeneration !== generation) {
            if (coordinator.continuity._tag === 'pending') {
              coordinator.continuity = { _tag: 'lost', generation: coordinator.continuity.generation };
              return yield* Effect.fail(
                volumeError(
                  Object.assign(new Error('Writes accepted by a previous owner may not be durable'), {
                    code: 'VFS_SYNC_OWNER_CHANGED',
                  }),
                  fileName,
                  'sync',
                  'persistence',
                  'unknown',
                ),
              );
            }
            return yield* Effect.fail(
              volumeError(
                Object.assign(new Error('Owner changed before SYNC dispatch'), { code: 'VFS_ATTACHMENT_LOST' }),
                fileName,
                'sync',
                'lifecycle',
                'not-applied',
              ),
            );
          }
          if (
            coordinator.continuity._tag === 'lost' ||
            (coordinator.continuity._tag === 'pending' && coordinator.continuity.generation !== generation)
          ) {
            const oldest = coordinator.continuity.generation;
            coordinator.continuity = { _tag: 'lost', generation: oldest };
            return yield* Effect.fail(
              volumeError(
                Object.assign(new Error('Writes accepted by a previous owner may not be durable'), {
                  code: 'VFS_SYNC_OWNER_CHANGED',
                }),
                fileName,
                'sync',
                'persistence',
                'unknown',
              ),
            );
          }
          yield* Effect.tryPromise({
            try: () => client.forGeneration(generation).sync(),
            catch: (error) => {
              const terminalNow = failIfUnavailable('sync');
              if (terminalNow) return syncError(terminalNow);
              const dispatch = error instanceof VfsCommandError ? error.dispatch : undefined;
              const raw = error instanceof VfsCommandError ? error.cause : error;
              const rawCode = remoteDetails(raw).code;
              if (
                dispatch === 'refused' &&
                rawCode === 'VFS_ATTACHMENT_LOST' &&
                coordinator.continuity._tag === 'pending'
              ) {
                const oldest = coordinator.continuity.generation;
                coordinator.continuity = { _tag: 'lost', generation: oldest };
                return volumeError(
                  Object.assign(new Error('Writes accepted by a previous owner may not be durable'), {
                    code: 'VFS_SYNC_OWNER_CHANGED',
                  }),
                  fileName,
                  'sync',
                  'persistence',
                  'unknown',
                );
              }
              return mountError(raw, fileName, 'sync', undefined, dispatch === 'refused' ? 'not-applied' : 'unknown');
            },
          });
          if (coordinator.continuity._tag === 'pending') coordinator.continuity = { _tag: 'clean' };
        }),
      );
    }),
  );
  const acknowledgeOwnerChange: VolumeService['acknowledgeOwnerChange'] = Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const failure = failIfUnavailable('acknowledgeOwnerChange');
      if (failure) return yield* Effect.fail(failure);
      const admitted = yield* restore(
        waitForReady(client, fileName, 'acknowledgeOwnerChange', { remaining: initTimeout }, terminal),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* restore(
            Effect.raceFirst(
              Effect.acquireRelease(Semaphore.take(coordinator.gate, 1), () => Semaphore.release(coordinator.gate, 1), {
                interruptible: true,
              }),
              Deferred.await(coordinator.terminalSignal).pipe(Effect.flatMap(Effect.fail)),
            ),
          );
          const after = failIfUnavailable('acknowledgeOwnerChange');
          if (after) return yield* Effect.fail(after);
          const current = client.getStatus();
          if (current.state !== 'ready' || current.ownerGeneration !== admitted.ownerGeneration) {
            return yield* Effect.fail(
              volumeError(
                Object.assign(new Error('Owner changed before acknowledgment'), { code: 'VFS_ACK_OWNER_CHANGED' }),
                fileName,
                'acknowledgeOwnerChange',
                'persistence',
                'not-applied',
              ),
            );
          }
          if (
            coordinator.continuity._tag === 'lost' ||
            (coordinator.continuity._tag === 'pending' &&
              coordinator.continuity.generation !== admitted.ownerGeneration)
          )
            coordinator.continuity = { _tag: 'pending', generation: admitted.ownerGeneration! };
        }),
      );
    }),
  );
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
    );
    if (budget.remaining <= 0) return yield* Effect.fail(mapTerminal(timeoutError));
    const start = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
    const timeout = Effect.sleep(budget.remaining).pipe(Effect.andThen(Effect.fail(mapTerminal(timeoutError))));
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
