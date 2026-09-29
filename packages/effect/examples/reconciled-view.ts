import { Cause, Effect, Fiber, FileSystem, Layer, Queue, Schedule, Schema, Stream } from 'effect';
import { OpfsFileSystem, Subscriptions, SubscriptionError, Volume } from '@opfs-vfs/effect';
import { subscriptionsRequest } from '@opfs-vfs/plugin-subscriptions/config';

export { Effect, Fiber, FileSystem, Queue, Volume };

export const makeLayer = (fileName: string) => {
  const volume = Volume.layer({ fileName, plugins: [subscriptionsRequest()] });
  return Layer.merge(
    volume,
    Layer.merge(Layer.provide(Subscriptions.layer, volume), Layer.provide(OpfsFileSystem.layer, volume)),
  );
};

export interface ReconciledViewOptions {
  readonly path: string;
  readonly publish: (paths: ReadonlyArray<string>) => Effect.Effect<void>;
  readonly markStale: () => Effect.Effect<void>;
}

const recoverable = new Set(['SUBSCRIPTION_INTERRUPTED', 'SUBSCRIPTION_OVERFLOW', 'SUBSCRIPTION_RESYNC_REQUIRED']);

const isRecoverableCause = (cause: Cause.Cause<unknown>): boolean => {
  const [reason] = cause.reasons;
  return (
    cause.reasons.length === 1 &&
    reason?._tag === 'Fail' &&
    Schema.is(SubscriptionError)(reason.error) &&
    recoverable.has(reason.error.code)
  );
};

export const keepViewCurrent = (options: ReconciledViewOptions) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const subscriptions = yield* Subscriptions.Subscriptions;

    const attempt = Effect.gen(function* () {
      let retired: Effect.Effect<Subscriptions.SubscriptionRetirement> | undefined;
      const exit = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const sub = yield* subscriptions.subscribe({
              path: options.path,
              scope: 'directory',
              recursive: true,
              content: false,
            });
            retired = sub.retired;
            yield* options.publish(yield* fs.readDirectory(options.path, { recursive: true }));
            yield* sub.changes.pipe(
              Stream.runForEach(() =>
                fs.readDirectory(options.path, { recursive: true }).pipe(Effect.flatMap(options.publish)),
              ),
            );
          }),
        ).pipe(Effect.onExit((result) => (result._tag === 'Failure' ? options.markStale() : Effect.void))),
      );
      if (retired) yield* retired;
      return yield* exit;
    });

    return yield* attempt.pipe(
      Effect.catchCause((cause) => Effect.fail(cause)),
      Effect.retry(($) =>
        $(Schedule.spaced('250 millis')).pipe(
          Schedule.while(({ input, attempt }) => attempt <= 3 && isRecoverableCause(input)),
        ),
      ),
      Effect.catch((cause) => Effect.failCause(cause)),
    );
  });
