import { Deferred, Effect, Exit, Fiber, Layer, Schema, Scope } from 'effect';
import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { Volume } from './index.js';
import type { DirectMountOptions, VolumeService } from './volume.js';
import {
  EncryptionError,
  RemoteErrorDetails,
  SubscriptionError,
  VolumeError,
  mountError,
  remoteDetails,
  type MountError,
} from './errors.js';

type MakeConfigError = { readonly _tag: 'MakeConfigError' };
type MakeConfigContext = { readonly makeConfig: true };
type LayerConfigError = { readonly _tag: 'LayerConfigError' };
type LayerConfigContext = { readonly layerConfig: true };

const state = vi.hoisted(() => ({
  ready: Promise.resolve(),
  close: () => Promise.resolve(),
  onConstruct: () => {},
  closeCalls: 0,
  bytes: new Uint8Array(),
}));

vi.mock('@opfs-vfs/opfs-vfs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opfs-vfs/opfs-vfs')>();
  return {
    ...actual,
    OpfsVfs: class {
      readonly ready = state.ready;
      constructor() {
        state.onConstruct();
      }
      syncSync() {}
      getLocalPersistenceStatusSync() {
        return { localPersistenceState: 'clean' as const };
      }
      openSync() {
        return 1;
      }
      writeSync(_fd: number, bytes: Uint8Array) {
        state.bytes = bytes.slice();
        return bytes.byteLength;
      }
      readSync(_fd: number, size: number) {
        const buffer = state.bytes.slice(0, size);
        return { buffer, read: buffer.byteLength };
      }
      closeSync() {}
      closeVfs() {
        state.closeCalls++;
        return state.close();
      }
    },
  };
});

describe('Volume direct acquisition', () => {
  beforeEach(() => {
    state.ready = Promise.resolve();
    state.close = () => Promise.resolve();
    state.onConstruct = () => {};
    state.closeCalls = 0;
    state.bytes = new Uint8Array();
  });

  it('infers direct mount types for options, effects, and union inputs', () => {
    const options: DirectMountOptions = { fileName: 'type-check.bin' };
    const makeEffect: Effect.Effect<DirectMountOptions, MakeConfigError, MakeConfigContext> = Effect.succeed(options);
    const makeInput: DirectMountOptions | Effect.Effect<DirectMountOptions, MakeConfigError, MakeConfigContext> = [
      options,
      makeEffect,
    ][0];
    const layerEffect: Effect.Effect<DirectMountOptions, LayerConfigError, LayerConfigContext> =
      Effect.succeed(options);
    const layerInput: DirectMountOptions | Effect.Effect<DirectMountOptions, LayerConfigError, LayerConfigContext> = [
      options,
      layerEffect,
    ][0];

    expectTypeOf(Volume.makeDirect(options)).toEqualTypeOf<Effect.Effect<VolumeService, MountError, Scope.Scope>>();
    expectTypeOf(Volume.makeDirect(makeEffect)).toEqualTypeOf<
      Effect.Effect<VolumeService, MountError | MakeConfigError, Scope.Scope | MakeConfigContext>
    >();
    expectTypeOf(Volume.makeDirect(makeInput)).toEqualTypeOf<
      Effect.Effect<VolumeService, MountError | MakeConfigError, Scope.Scope | MakeConfigContext>
    >();
    expectTypeOf(Volume.layerDirect(options)).toEqualTypeOf<Layer.Layer<Volume.Volume, MountError>>();
    expectTypeOf(Volume.layerDirect(layerEffect)).toEqualTypeOf<
      Layer.Layer<Volume.Volume, MountError | LayerConfigError, LayerConfigContext>
    >();
    expectTypeOf(Volume.layerDirect(layerInput)).toEqualTypeOf<
      Layer.Layer<Volume.Volume, MountError | LayerConfigError, LayerConfigContext>
    >();
  });

  it('rejects invalid names through inspect', async () => {
    const error = await Effect.runPromise(Effect.flip(Volume.inspect('../bad.bin')));
    expect(error).toMatchObject({ _tag: 'VolumeError', kind: 'configuration' });
  });

  it('returns a typed error when storage inspection fails', async () => {
    const expected = new Error('storage unavailable');
    const getDirectory = vi.spyOn(navigator.storage, 'getDirectory').mockRejectedValue(expected);
    try {
      const error = await Effect.runPromise(Effect.flip(Volume.inspect('valid.bin')));
      expect(error).toMatchObject({
        _tag: 'VolumeError',
        kind: 'filesystem',
        details: { message: expected.message },
      });
    } finally {
      getDirectory.mockRestore();
    }
  });

  it('preserves caller failures and defects', async () => {
    const expected = new Error('config failed');
    const config = Effect.fail(expected).pipe(Effect.as({ fileName: 'unused.bin' }));
    const error = await Effect.runPromise(Effect.flip(Effect.scoped(Volume.makeDirect(config))));
    expect(error).toBe(expected);

    const defect = new Error('caller defect');
    const exit = await Effect.runPromiseExit(
      Effect.scoped(Volume.makeDirect(Effect.die(defect).pipe(Effect.as({ fileName: 'unused.bin' })))),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(exit.cause.reasons[0]).toMatchObject({ _tag: 'Die', defect });
  });

  it('wraps plugin thunk throws and invokes the thunk once', async () => {
    let calls = 0;
    const expected = new Error('plugin setup failed');
    const config: DirectMountOptions = {
      fileName: 'unused.bin',
      plugins: () => {
        calls++;
        throw expected;
      },
    };
    const error = await Effect.runPromise(Effect.flip(Effect.scoped(Volume.makeDirect(config))));
    expect(calls).toBe(1);
    expect(error).toMatchObject({
      _tag: 'VolumeError',
      kind: 'configuration',
      details: { message: 'Plugin configuration failed' },
    });
  });

  it('supports guarded direct observations and closes the borrowed backend with its scope', async () => {
    let service: Volume.VolumeService | undefined;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          service = yield* Volume.makeDirect({ fileName: 'direct.bin' });
          yield* service.sync;
          expect(yield* service.persistence).toEqual({ state: 'clean', error: null });
          yield* service.acknowledgeOwnerChange;
          const backend = Volume.unsafeBackend(service);
          const fd = backend.openSync('/file', 2);
          backend.writeSync(fd, new Uint8Array([1, 2, 3]));
          expect(backend.readSync(fd, 3).buffer).toEqual(new Uint8Array([1, 2, 3]));
          backend.closeSync(fd);
        }),
      ),
    );
    expect(state.closeCalls).toBe(1);
    expect(() => Volume.unsafeBackend(service!)).toThrow();
    const error = await Effect.runPromise(Effect.flip(service!.persistence));
    expect(error).toMatchObject({ _tag: 'VolumeError', kind: 'lifecycle' });
    expect(await Effect.runPromise(Effect.flip(service!.sync))).toMatchObject({
      _tag: 'VolumeError',
      kind: 'lifecycle',
    });
    expect(await Effect.runPromise(Effect.flip(service!.acknowledgeOwnerChange))).toMatchObject({
      _tag: 'VolumeError',
      kind: 'lifecycle',
    });
  });

  it('keeps configuration scope resources alive through use and releases them after the backend', async () => {
    const order: string[] = [];
    state.close = () => {
      order.push('backend');
      return Promise.resolve();
    };
    const config = Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.sync(() => order.push('configuration')));
      return { fileName: 'config-scope.bin' };
    });
    await Effect.runPromise(Effect.scoped(Volume.makeDirect(config)));
    expect(order).toEqual(['backend', 'configuration']);
  });

  it('closes a failed initialization and preserves the cleanup defect', async () => {
    state.ready = Promise.reject(new Error('init failed'));
    state.close = () => {
      throw new Error('close failed');
    };
    const exit = await Effect.runPromiseExit(Effect.scoped(Volume.makeDirect({ fileName: 'failed.bin' })));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(state.closeCalls).toBe(1);
    if (Exit.isFailure(exit)) {
      expect(exit.cause.reasons.some((reason) => reason._tag === 'Fail')).toBe(true);
      expect(exit.cause.reasons.some((reason) => reason._tag === 'Die')).toBe(true);
    }
  });

  it('cleans up a failed mount before recovery in its still-open parent scope', async () => {
    const parent = await Effect.runPromise(Scope.make());
    const cleanupFailure = new Error('close failed');
    const order: string[] = [];
    state.ready = Promise.reject(new Error('init failed'));
    state.close = () => {
      order.push('backend');
      throw cleanupFailure;
    };
    const config = Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.sync(() => order.push('configuration')));
      return { fileName: 'failed-open-parent.bin' };
    });

    try {
      await Effect.runPromise(
        Scope.provide(parent)(
          Effect.gen(function* () {
            const failed = yield* Effect.exit(Volume.makeDirect(config));
            expect(Exit.isFailure(failed)).toBe(true);
            expect(state.closeCalls).toBe(1);
            expect(order).toEqual(['backend', 'configuration']);
            if (Exit.isFailure(failed)) {
              expect(failed.cause.reasons).toContainEqual(
                expect.objectContaining({
                  _tag: 'Die',
                  defect: expect.objectContaining({
                    kind: 'lifecycle',
                    operation: 'close',
                    details: { message: cleanupFailure.message },
                  }),
                }),
              );
            }

            state.ready = Promise.resolve();
            state.close = () => {
              order.push('recovery backend');
              return Promise.resolve();
            };
            yield* Volume.makeDirect({ fileName: 'recovery-open-parent.bin' });
            expect(state.closeCalls).toBe(1);
          }),
        ),
      );
    } finally {
      await Effect.runPromise(Scope.close(parent, Exit.void));
    }
    expect(state.closeCalls).toBe(2);
    expect(order).toEqual(['backend', 'configuration', 'recovery backend']);
  });

  it('preserves both a use failure and a later close failure', async () => {
    const useFailure = new Error('use failed');
    state.close = () => {
      throw new Error('close failed');
    };
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Volume.makeDirect({ fileName: 'use-close-failure.bin' });
          return yield* Effect.fail(useFailure);
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(exit.cause.reasons.some((reason) => reason._tag === 'Fail' && reason.error === useFailure)).toBe(true);
      expect(exit.cause.reasons.some((reason) => reason._tag === 'Die')).toBe(true);
    }
  });

  it('cleans up when interrupted while waiting for ready', async () => {
    const started = await Effect.runPromise(Deferred.make<void>());
    state.ready = new Promise(() => {});
    state.onConstruct = () => {
      void Effect.runPromise(Deferred.succeed(started, undefined));
    };
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(Volume.makeDirect({ fileName: 'interrupted.bin' }));
          yield* Deferred.await(started);
          yield* Fiber.interrupt(fiber);
        }),
      ),
    );
    expect(state.closeCalls).toBe(1);
  });

  it('does not return a backend after its parent scope closes during configuration', async () => {
    const parent = await Effect.runPromise(Scope.make());
    const started = await Effect.runPromise(Deferred.make<void>());
    const resume = await Effect.runPromise(Deferred.make<void>());
    const acquisition = Scope.provide(parent)(
      Volume.makeDirect(
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(resume);
          return { fileName: 'closed-during-config.bin' };
        }),
      ),
    );
    const fiber = await Effect.runPromise(acquisition.pipe(Effect.forkDetach));
    await Effect.runPromise(Deferred.await(started));
    await Effect.runPromise(Scope.close(parent, Exit.void));
    await Effect.runPromise(Deferred.succeed(resume, undefined));
    const exit = await Effect.runPromise(Fiber.await(fiber));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(state.closeCalls).toBe(0);
  });

  it('closes a backend created as its parent scope closes before release registration', async () => {
    const parent = await Effect.runPromise(Scope.make());
    state.onConstruct = () => Effect.runSync(Scope.close(parent, Exit.void));
    const exit = await Effect.runPromiseExit(
      Scope.provide(parent)(Volume.makeDirect({ fileName: 'late-backend.bin' })),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(state.closeCalls).toBe(1);
    if (Exit.isFailure(exit)) expect(exit.cause.reasons[0]).toMatchObject({ error: { kind: 'lifecycle' } });
  });

  it('closes a backend when its parent scope closes while ready is pending', async () => {
    const parent = await Effect.runPromise(Scope.make());
    const started = await Effect.runPromise(Deferred.make<void>());
    let resolveReady!: () => void;
    state.ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    state.onConstruct = () => {
      void Effect.runPromise(Deferred.succeed(started, undefined));
    };
    const acquisition = Scope.provide(parent)(Volume.makeDirect({ fileName: 'closed-during-ready.bin' }));
    const fiber = await Effect.runPromise(acquisition.pipe(Effect.forkDetach));
    await Effect.runPromise(Deferred.await(started));
    await Effect.runPromise(Scope.close(parent, Exit.void));
    expect(state.closeCalls).toBe(1);
    resolveReady();
    const exit = await Effect.runPromise(Fiber.await(fiber));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(state.closeCalls).toBe(1);
  });

  it('waits for a held parent-close cleanup after ready rejects', async () => {
    const parent = await Effect.runPromise(Scope.make());
    const started = await Effect.runPromise(Deferred.make<void>());
    const closeStarted = await Effect.runPromise(Deferred.make<void>());
    const releaseClose = await Effect.runPromise(Deferred.make<void>());
    const finished = await Effect.runPromise(Deferred.make<void>());
    let rejectReady!: (error: Error) => void;
    state.ready = new Promise<void>((_resolve, reject) => {
      rejectReady = reject;
    });
    state.onConstruct = () => {
      void Effect.runPromise(Deferred.succeed(started, undefined));
    };
    state.close = () =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Deferred.succeed(closeStarted, undefined);
          yield* Deferred.await(releaseClose);
        }),
      );
    const acquisition = Scope.provide(parent)(
      Volume.makeDirect({ fileName: 'held-close-ready-reject.bin' }).pipe(
        Effect.onExit(() => Deferred.succeed(finished, undefined)),
      ),
    );
    const acquisitionFiber = await Effect.runPromise(acquisition.pipe(Effect.forkDetach));
    await Effect.runPromise(Deferred.await(started));
    const closeFiber = await Effect.runPromise(Scope.close(parent, Exit.void).pipe(Effect.forkDetach));
    await Effect.runPromise(Deferred.await(closeStarted));
    rejectReady(new Error('init failed'));
    await Effect.runPromise(Effect.yieldNow);
    expect(await Effect.runPromise(Deferred.isDone(finished))).toBe(false);
    await Effect.runPromise(Deferred.succeed(releaseClose, undefined));
    const exit = await Effect.runPromise(Fiber.await(acquisitionFiber));
    await Effect.runPromise(Fiber.await(closeFiber));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(state.closeCalls).toBe(1);
  });

  it('preserves ready, backend, and configuration cleanup failures once', async () => {
    const parent = await Effect.runPromise(Scope.make());
    const constructed = await Effect.runPromise(Deferred.make<void>());
    const configFinalizerStarted = await Effect.runPromise(Deferred.make<void>());
    const releaseConfigFinalizer = await Effect.runPromise(Deferred.make<void>());
    const finished = await Effect.runPromise(Deferred.make<void>());
    const readyFailure = new Error('init failed');
    const backendFailure = new Error('close failed');
    const configFailure = new Error('configuration cleanup failed');
    const order: string[] = [];
    let rejectReady!: (error: Error) => void;
    state.ready = new Promise<void>((_resolve, reject) => {
      rejectReady = reject;
    });
    state.onConstruct = () => {
      void Effect.runPromise(Deferred.succeed(constructed, undefined));
    };
    state.close = () => {
      order.push('backend');
      throw backendFailure;
    };
    const config = Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          order.push('configuration');
          yield* Deferred.succeed(configFinalizerStarted, undefined);
          yield* Deferred.await(releaseConfigFinalizer);
          return yield* Effect.die(configFailure);
        }),
      );
      return { fileName: 'cleanup-causes.bin' };
    });
    try {
      const fiber = await Effect.runPromise(
        Scope.provide(parent)(
          Volume.makeDirect(config).pipe(Effect.onExit(() => Deferred.succeed(finished, undefined))),
        ).pipe(Effect.forkDetach),
      );
      await Effect.runPromise(Deferred.await(constructed));
      const closeFiber = await Effect.runPromise(Scope.close(parent, Exit.void).pipe(Effect.forkDetach));
      await Effect.runPromise(Deferred.await(configFinalizerStarted));
      expect(state.closeCalls).toBe(1);
      expect(order).toEqual(['backend', 'configuration']);
      rejectReady(readyFailure);
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
              (reason.defect as { details?: { message?: string } }).details?.message === backendFailure.message,
          ),
        ).toHaveLength(1);
        expect(exit.cause.reasons).toContainEqual(expect.objectContaining({ _tag: 'Die', defect: configFailure }));
      }
    } finally {
      await Effect.runPromise(Scope.close(parent, Exit.void));
    }
  });

  it('decodes only known adapter errors from a platform cause', () => {
    const encryption = new EncryptionError({
      reason: 'IntegrityFailure',
      fileName: 'secret.bin',
      operation: 'read',
      outcome: 'unknown',
      details: null,
    });
    const wrapper = new VolumeError({
      kind: 'lifecycle',
      fileName: 'secret.bin',
      operation: 'mount',
      outcome: 'unknown',
      details: null,
      cause: encryption,
    });
    expect(Schema.is(EncryptionError)(encryption)).toBe(true);
    expect(Volume.errorOf({ reason: { cause: wrapper } })).toBe(encryption);
    expect(Volume.errorOf({ reason: { cause: new Error('foreign') } })).toBeUndefined();
    const coded = mountError(Object.assign(new Error('locked'), { code: 'EVOLUMELOCKED' }), 'x.bin', 'open');
    expect(coded).toMatchObject({ _tag: 'EncryptionError', reason: 'CredentialsRejected', code: 'EVOLUMELOCKED' });
    expect(coded.cause).toBeUndefined();
    expect(mountError(Object.assign(new Error('format'), { code: 'EVAULTFORMAT' }), 'x.bin', 'open')).toMatchObject({
      _tag: 'EncryptionError',
      reason: 'UnsupportedFormat',
    });
    expect(mountError(Object.assign(new Error('plain'), { code: 'EPLAINTEXTVOLUME' }), 'x.bin', 'open')).toMatchObject({
      _tag: 'EncryptionError',
      reason: 'PlaintextVolume',
    });
    expect(
      mountError(Object.assign(new Error('init timeout'), { code: 'VFS_INITIALIZATION_TIMEOUT' }), 'x.bin', 'mount'),
    ).toMatchObject({ _tag: 'VolumeError', kind: 'lifecycle' });
    expect(
      mountError(Object.assign(new Error('no provider'), { code: 'VFS_STORAGE_PLUGIN_REQUIRED' }), 'x.bin', 'mount'),
    ).toMatchObject({ _tag: 'VolumeError', kind: 'unsupported' });
    const details = remoteDetails(
      Object.assign(new Error('full'), {
        code: 'ENOSPC',
        errno: 28,
        category: 'data-wal',
        offset: 12,
      }),
    );
    expect(Schema.is(RemoteErrorDetails)(details)).toBe(true);
    expect(details).toMatchObject({ message: 'full', code: 'ENOSPC', errno: 28, category: 'data-wal', offset: 12 });
    expect(
      Schema.is(SubscriptionError)(
        new SubscriptionError({
          code: 'SUBSCRIPTION_INTERRUPTED',
          fileName: 'x.bin',
          path: '/',
          details: null,
        }),
      ),
    ).toBe(true);
    const hostile = {
      get reason(): never {
        throw new Error('getter');
      },
    };
    expect(Volume.errorOf(hostile)).toBeUndefined();
  });
});
