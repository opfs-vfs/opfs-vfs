import { Context, Effect, Exit, Layer, Scope, Schema } from 'effect';
import {
  OpfsVfs,
  peekVolume,
  type LocalPersistenceState,
  type OpfsVfsOptions,
  type VolumePeek,
} from '@opfs-vfs/opfs-vfs';
import type { ConfiguredVfsPlugin } from '@opfs-vfs/opfs-vfs/plugins';
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

export class Volume extends Context.Service<Volume, VolumeService>()('@opfs-vfs/effect/Volume') {}

const invalidName = (fileName: string) =>
  typeof fileName !== 'string' || fileName.length <= 4 || !fileName.endsWith('.bin') || /[/\\]/.test(fileName);

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

const make = <E, R>(input: Input<E, R>): Effect.Effect<VolumeService, MountError | E, Scope.Scope | R> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const parent = yield* Effect.scope;
      const child = yield* Scope.fork(parent, 'sequential');
      let closed = false;
      let backend: OpfsVfs | undefined;
      let release: Promise<void> | undefined;
      let service: VolumeService | undefined;
      const ensureOpen = (fileName: string | null) =>
        closed
          ? Effect.fail(
              volumeError(new Error('Volume scope is closed'), fileName, 'acquire', 'lifecycle', 'not-applied'),
            )
          : Effect.void;
      yield* Scope.addFinalizer(
        child,
        Effect.sync(() => {
          closed = true;
        }),
      );
      const closeBackend = () => {
        closed = true;
        if (service) closedBackends.add(service);
        if (backend) release ??= Promise.resolve(backend.closeVfs()).then(() => undefined);
        return release ?? Promise.resolve();
      };

      const acquire = Effect.gen(function* () {
        const parentScopedInput = Effect.isEffect(input)
          ? Effect.provideService(input, Scope.Scope, child)
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
          child,
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
        yield* ensureOpen(fileName);
        return service;
      });

      return yield* acquire.pipe(
        Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(child, exit) : Effect.void)),
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
export function makeDirect<E, R>(input: Input<E, R>) {
  return make<E, R>(input);
}

export function layerDirect(input: DirectMountOptions): Layer.Layer<Volume, MountError>;
export function layerDirect<E, R>(
  input: Effect.Effect<DirectMountOptions, E, R>,
): Layer.Layer<Volume, MountError | E, R>;
export function layerDirect<E, R>(input: Input<E, R>) {
  return Layer.effect(Volume, make<E, R>(input));
}
export const unsafeBackend = (volume: VolumeService): OpfsVfs => {
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
const backends = new WeakMap<VolumeService, OpfsVfs>();
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
