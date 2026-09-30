import {
  Context,
  Effect,
  Exit,
  FileSystem,
  Layer,
  ManagedRuntime,
  PlatformError,
  Redacted,
  Schema,
  Stream,
} from 'effect';
import { OpfsFileSystem, Subscriptions, Volume, VolumeError, EncryptionError } from '@opfs-vfs/effect';
import { encryptionRequest } from '@opfs-vfs/plugin-encryption/config';
import { subscriptionsRequest } from '@opfs-vfs/plugin-subscriptions/config';

export { Context, Effect, Exit, FileSystem, Layer, ManagedRuntime, PlatformError, Redacted, Schema, Stream };
export { EncryptionError, OpfsFileSystem, Subscriptions, Volume, VolumeError };

export type PluginProfile = 'plain' | 'subscriptions' | 'encrypted' | 'combined';
export type CombinedRequestOrder = 'encryption-first' | 'subscriptions-first';
export type Secret = Redacted.Redacted<string | Uint8Array>;

const worker = () => new Worker(new URL('./encrypted-session.worker.ts', import.meta.url), { type: 'module' });

const requests = (config: SessionConfig) => {
  const encryption =
    config.profile === 'encrypted' || config.profile === 'combined'
      ? encryptionRequest({
          secret: Redacted.value(config.secret),
          ...(config.openMode === 'create-new' && config.initialPasskey
            ? { initialPasskey: { secret: config.initialPasskey } }
            : {}),
        })
      : undefined;
  const subscriptions =
    config.profile === 'subscriptions' || config.profile === 'combined' ? subscriptionsRequest() : undefined;
  const order = config.order ?? 'encryption-first';
  if (order === 'subscriptions-first') return [subscriptions, encryption].filter((item) => item !== undefined);
  return [encryption, subscriptions].filter((item) => item !== undefined);
};

interface SessionConfigBase {
  readonly fileName: string;
  readonly order?: CombinedRequestOrder;
}

export type SessionConfig = SessionConfigBase &
  (
    | { readonly profile: 'plain' | 'subscriptions'; readonly openMode: 'create-new' | 'open-existing' }
    | {
        readonly profile: 'encrypted' | 'combined';
        readonly openMode: 'create-new';
        readonly secret: Secret;
        readonly initialPasskey?: Uint8Array;
      }
    | {
        readonly profile: 'encrypted' | 'combined';
        readonly openMode: 'open-existing';
        readonly secret: Secret;
        readonly initialPasskey?: never;
      }
  );

const encrypted = (profile: PluginProfile) => profile === 'encrypted' || profile === 'combined';
const observed = (profile: PluginProfile) => profile === 'subscriptions' || profile === 'combined';

const missingVolume = (fileName: string) =>
  new VolumeError({
    kind: 'filesystem',
    fileName,
    operation: 'open-existing',
    code: 'ENOENT',
    outcome: 'not-applied',
    details: { message: 'The requested existing volume does not exist', code: 'ENOENT' },
  });

const inspectionPolicyFailure = (fileName: string, code: string, message: string, kind: VolumeError['kind']) =>
  new VolumeError({
    kind,
    fileName,
    operation: 'inspect',
    code,
    outcome: 'not-applied',
    details: { message, code },
  });

const volumeLayer = (config: SessionConfig) => {
  const options = {
    fileName: config.fileName,
    openMode: config.openMode,
    transport: 'dedicated' as const,
    ...(encrypted(config.profile) ? { worker } : {}),
    plugins: () => requests(config),
  };
  if (config.openMode === 'create-new') return Volume.layer(options);
  return Layer.effect(
    Volume.Volume,
    Effect.gen(function* () {
      const info = yield* Volume.inspect(config.fileName);
      if (!info.exists) return yield* Effect.fail(missingVolume(config.fileName));
      if (info.importing)
        return yield* Effect.fail(
          inspectionPolicyFailure(config.fileName, 'VOLUME_IMPORTING', 'Volume import is incomplete', 'lifecycle'),
        );
      if (info.compatible === false)
        return yield* Effect.fail(
          inspectionPolicyFailure(
            config.fileName,
            'VFS_INCOMPATIBLE_VOLUME',
            'Volume metadata is incompatible with this build',
            'unsupported',
          ),
        );
      return yield* Volume.make(options);
    }),
  );
};

export const makeSessionLayer = (config: SessionConfig) => {
  const volume = volumeLayer(config);
  return observed(config.profile)
    ? Layer.merge(OpfsFileSystem.layer, Subscriptions.layer).pipe(Layer.provideMerge(volume))
    : OpfsFileSystem.layer.pipe(Layer.provideMerge(volume));
};

export const createEncryptedLayer = (
  fileName: string,
  secret: Secret,
  initialPasskey?: Uint8Array,
  order: CombinedRequestOrder = 'encryption-first',
) =>
  makeSessionLayer({
    fileName,
    profile: 'encrypted',
    openMode: 'create-new',
    secret,
    order,
    initialPasskey,
  });

export const makeSessionRuntime = (config: SessionConfig) => ManagedRuntime.make(makeSessionLayer(config));

export type SessionRuntime = ReturnType<typeof makeSessionRuntime>;
export type SessionExit<A = unknown> = Exit.Exit<A, unknown>;

export const startSessionRuntime = async (runtime: SessionRuntime) => {
  const startExit: SessionExit<void> = await runtime.runPromiseExit(Effect.void);
  if (Exit.isSuccess(startExit)) return { _tag: 'Started' as const, runtime, startExit };
  const disposeExit = await Effect.runPromiseExit(runtime.disposeEffect);
  return { _tag: 'StartFailed' as const, runtime, startExit, disposeExit };
};

const credentialsFailure = (exit: SessionExit): EncryptionError | undefined => {
  if (Exit.isSuccess(exit) || exit.cause.reasons.length !== 1) return undefined;
  const [reason] = exit.cause.reasons;
  if (reason?._tag !== 'Fail') return undefined;
  const error = reason.error;
  if (Schema.is(EncryptionError)(error) && error.reason === 'CredentialsRejected') return error;
  if (!PlatformError.isPlatformError(error)) return undefined;
  const wrapper = error.reason.cause;
  if (
    Schema.is(VolumeError)(wrapper) &&
    wrapper.kind === 'lifecycle' &&
    Schema.is(EncryptionError)(wrapper.cause) &&
    wrapper.cause.reason === 'CredentialsRejected'
  )
    return wrapper.cause;
  return undefined;
};

const saveOnce = (contents: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const volume = yield* Volume.Volume;
    yield* fs.writeFileString('/session-save.txt', contents);
    yield* volume.sync;
    return 'saved' as const;
  });

export type SessionSaveResult =
  | { readonly _tag: 'Saved'; readonly useExit: SessionExit<'saved'> }
  | {
      readonly _tag: 'Replaced';
      readonly useExit: SessionExit<'saved'>;
      readonly disposeExit: Exit.Exit<void, never>;
      readonly startExit: SessionExit<void>;
    }
  | {
      readonly _tag: 'ReplacementBlocked';
      readonly useExit: SessionExit<'saved'>;
      readonly disposeExit: Exit.Exit<void, never>;
    }
  | {
      readonly _tag: 'ReplacementCancelled';
      readonly useExit: SessionExit<'saved'>;
      readonly disposeExit: Exit.Exit<void, never>;
    }
  | {
      readonly _tag: 'ReplacementFailed';
      readonly useExit: SessionExit<'saved'>;
      readonly disposeExit: Exit.Exit<void, never>;
      readonly startExit: SessionExit<void>;
      readonly replacementDisposeExit: Exit.Exit<void, never>;
    }
  | { readonly _tag: 'Failed'; readonly useExit: SessionExit<'saved'> }
  | { readonly _tag: 'Unavailable' };

/**
 * `config` must match `initial`'s fileName, profile, and plugin request order. A replacement supplies a new secret only.
 */
export const makeSessionController = (
  initial: SessionRuntime,
  config: SessionConfigBase & { readonly profile: 'encrypted' | 'combined' },
  requestCredentials: (error: EncryptionError) => Promise<Secret | undefined>,
) => {
  let current: SessionRuntime | undefined = initial;
  let accepting = true;
  let closed = false;
  const closeRequested = Promise.withResolvers<undefined>();
  let serial = Promise.resolve();
  const ordered = <A>(work: () => Promise<A>): Promise<A> => {
    const result = serial.then(work, work);
    serial = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const save = (contents: string): Promise<SessionSaveResult> => {
    const admitted = accepting ? current : undefined;
    return ordered(async () => {
      if (!admitted || !accepting || current !== admitted) return { _tag: 'Unavailable' };
      const previous = current;
      if (!previous) return { _tag: 'Unavailable' };
      const useExit: SessionExit<'saved'> = await previous.runPromiseExit(saveOnce(contents));
      if (Exit.isSuccess(useExit)) return { _tag: 'Saved', useExit };
      const credentials = credentialsFailure(useExit);
      if (!credentials) return { _tag: 'Failed', useExit };

      accepting = false;
      current = undefined;
      // The use fiber has exited. Disposal runs outside that runtime and its full Exit is retained.
      const disposeExit = await Effect.runPromiseExit(previous.disposeEffect);
      if (Exit.isFailure(disposeExit)) return { _tag: 'ReplacementBlocked', useExit, disposeExit };

      if (closed) return { _tag: 'ReplacementCancelled', useExit, disposeExit };

      let secret: Secret | undefined;
      try {
        secret = await Promise.race([requestCredentials(credentials), closeRequested.promise]);
      } catch {
        return { _tag: 'ReplacementCancelled', useExit, disposeExit };
      }
      if (closed || !secret) return { _tag: 'ReplacementCancelled', useExit, disposeExit };

      const replacement = makeSessionRuntime({ ...config, openMode: 'open-existing', secret });
      const startExit: SessionExit<void> = await replacement.runPromiseExit(Effect.void);
      if (Exit.isFailure(startExit)) {
        const replacementDisposeExit = await Effect.runPromiseExit(replacement.disposeEffect);
        return { _tag: 'ReplacementFailed', useExit, disposeExit, startExit, replacementDisposeExit };
      }
      current = replacement;
      accepting = !closed;
      return { _tag: 'Replaced', useExit, disposeExit, startExit };
    });
  };

  const runtime = () => current;
  const close = () => {
    closed = true;
    accepting = false;
    closeRequested.resolve(undefined);
    return ordered(async () => {
      if (!current) return Exit.succeed(undefined);
      const closing = current;
      current = undefined;
      return Effect.runPromiseExit(closing.disposeEffect);
    });
  };

  return { save, runtime, close };
};

export const acceptReconciledSave = Effect.gen(function* () {
  const volume = yield* Volume.Volume;
  yield* volume.acknowledgeOwnerChange;
  yield* volume.sync;
});

export class DocumentsFs extends Context.Service<
  DocumentsFs,
  { readonly fs: FileSystem.FileSystem; readonly volume: Volume.VolumeService }
>()('app/DocumentsFs') {}
export class CacheFs extends Context.Service<
  CacheFs,
  { readonly fs: FileSystem.FileSystem; readonly volume: Volume.VolumeService }
>()('app/CacheFs') {}

export const makeSharedNamedFileSystems = (fileName: string) => {
  const volume = Volume.layer({ fileName, plugins: [subscriptionsRequest()] });
  const services = Layer.merge(OpfsFileSystem.layer, Subscriptions.layer).pipe(Layer.provideMerge(volume));
  const consumers = Layer.mergeAll(
    Layer.effect(
      DocumentsFs,
      Effect.gen(function* () {
        return { fs: yield* FileSystem.FileSystem, volume: yield* Volume.Volume };
      }),
    ),
    Layer.effect(
      CacheFs,
      Effect.gen(function* () {
        return { fs: yield* FileSystem.FileSystem, volume: yield* Volume.Volume };
      }),
    ),
  );
  return consumers.pipe(Layer.provideMerge(services));
};

export const makeDocumentsFileSystem = (fileName: string) =>
  Layer.effect(
    DocumentsFs,
    Effect.gen(function* () {
      return { fs: yield* FileSystem.FileSystem, volume: yield* Volume.Volume };
    }),
  ).pipe(
    Layer.provideMerge(
      Layer.merge(OpfsFileSystem.layer, Subscriptions.layer).pipe(
        Layer.provideMerge(Volume.layer({ fileName, plugins: [subscriptionsRequest()] })),
      ),
    ),
  );

export const makeCacheFileSystem = (fileName: string) =>
  Layer.effect(
    CacheFs,
    Effect.gen(function* () {
      return { fs: yield* FileSystem.FileSystem, volume: yield* Volume.Volume };
    }),
  ).pipe(
    Layer.provideMerge(
      Layer.merge(OpfsFileSystem.layer, Subscriptions.layer).pipe(
        Layer.provideMerge(Volume.layer({ fileName, plugins: [subscriptionsRequest()] })),
      ),
    ),
  );
