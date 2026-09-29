import { Cause, Context, Deferred, Effect, Exit, Layer, Queue, Schema, Scope, Stream } from 'effect';
import type { FileChangeSource } from '@opfs-vfs/opfs-vfs/changes';
import {
  subscribe as subscribePlugin,
  type FileChange,
  type SubscribeLifecycle,
  type SubscribeOptions as PluginSubscribeOptions,
  type Subscription as PluginSubscription,
  type SubscriptionRetirement as PluginRetirement,
  type SubscriptionSetup,
} from '@opfs-vfs/plugin-subscriptions/client';
import { getCoordinator, type Coordinator, type SubscriptionSetupRecord } from './coordinator.js';
import { remoteDetails, SubscriptionError, VolumeError } from './errors.js';
import { Volume } from './volume.js';

const queueCapacity = 16;
const retrySameGeneration = Symbol('retry subscription on captured generation');
const knownCodes = new Set([
  'SUBSCRIPTION_OVERFLOW',
  'SUBSCRIPTION_INTERRUPTED',
  'SUBSCRIPTION_CALLBACK_FAILED',
  'SUBSCRIPTION_RESYNC_REQUIRED',
  'SUBSCRIPTION_RETIREMENT_UNKNOWN',
  'SUBSCRIPTION_SETUP_FAILED',
  'EINVAL',
  'EBADF',
]);

export type SubscribeOptions = Omit<PluginSubscribeOptions, 'onError' | 'signal'>;
export type SubscriptionRetirement =
  | { readonly status: 'released' }
  | { readonly status: 'unknown'; readonly error: SubscriptionError };

export interface Subscription {
  readonly changes: Stream.Stream<FileChange, SubscriptionError>;
  readonly retired: Effect.Effect<SubscriptionRetirement>;
}

export interface SubscriptionsService {
  readonly subscribe: (options: SubscribeOptions) => Effect.Effect<Subscription, SubscriptionError, Scope.Scope>;
}

export class Subscriptions extends Context.Service<Subscriptions, SubscriptionsService>()(
  '@opfs-vfs/effect/Subscriptions',
) {}

const subscriptionError = (cause: unknown, fileName: string, path: string): SubscriptionError => {
  let decoded: SubscriptionError | undefined;
  let trustedCause: VolumeError | undefined;
  try {
    if (Schema.is(SubscriptionError)(cause)) decoded = cause;
    else if (Schema.is(VolumeError)(cause)) trustedCause = cause;
  } catch {
    // Foreign causes are represented by sanitized details only.
  }
  const details = decoded?.details ?? remoteDetails(cause);
  const codeValue = decoded?.code ?? details.code;
  const sourceCode = decoded?.sourceCode ?? (codeValue === 'SUBSCRIPTION_SETUP_FAILED' ? undefined : codeValue);
  const code =
    codeValue && knownCodes.has(codeValue)
      ? (codeValue as SubscriptionError['code'])
      : sourceCode && knownCodes.has(sourceCode)
        ? (sourceCode as SubscriptionError['code'])
        : 'SUBSCRIPTION_SETUP_FAILED';
  return new SubscriptionError({
    code,
    fileName,
    path,
    ...(sourceCode && sourceCode !== code ? { sourceCode } : {}),
    details,
    ...(trustedCause === undefined ? {} : { cause: trustedCause }),
  });
};

const retirementUnknown = (cause: unknown, fileName: string, path: string) => {
  let decoded: SubscriptionError | undefined;
  try {
    if (Schema.is(SubscriptionError)(cause)) decoded = cause;
  } catch {
    // Use the sanitized remote projection for invalid foreign errors.
  }
  const details = decoded?.details ?? remoteDetails(cause);
  return new SubscriptionError({
    code: 'SUBSCRIPTION_RETIREMENT_UNKNOWN',
    fileName,
    path,
    ...((decoded?.sourceCode ?? decoded?.code ?? details.code)
      ? { sourceCode: decoded?.sourceCode ?? decoded?.code ?? details.code }
      : {}),
    details,
  });
};

const asRetirement = (retirement: PluginRetirement, fileName: string, path: string): SubscriptionRetirement =>
  retirement.status === 'released'
    ? retirement
    : { status: 'unknown', error: subscriptionError(retirement.error, fileName, path) };

const unavailable = (fileName: string) =>
  new VolumeError({
    kind: 'unsupported',
    fileName,
    operation: 'subscribe',
    code: 'ENOTSUP',
    outcome: 'not-applied',
    details: null,
  });

const pruneOtherGenerations = (state: Coordinator, generation: string) => {
  for (const [promise, record] of state.subscriptionSetups)
    if (record.generation !== generation) state.subscriptionSetups.delete(promise);
  for (const oldGeneration of state.subscriptionUnknown.keys())
    if (oldGeneration !== generation) state.subscriptionUnknown.delete(oldGeneration);
};

const currentFailure = (state: Coordinator, generation: string, path: string) => {
  const terminal = state.terminal();
  if (terminal) return subscriptionError(terminal, state.fileName, path);
  const current = state.currentGeneration();
  if (state.isClosed() || current !== generation)
    return subscriptionError(
      Object.assign(new Error('Owner changed before subscription registration'), { code: 'VFS_ATTACHMENT_LOST' }),
      state.fileName,
      path,
    );
  return undefined;
};

const waitForRetiring = (
  state: Coordinator,
  generation: string,
  budget: { remaining: number },
  clock: { currentTimeMillisUnsafe(): number },
  path: string,
): Effect.Effect<void, SubscriptionError> =>
  Effect.suspend(() => {
    const failure = currentFailure(state, generation, path);
    if (failure) return Effect.fail(failure);
    pruneOtherGenerations(state, generation);
    const unknown = state.subscriptionUnknown.get(generation);
    if (unknown !== undefined) return Effect.fail(retirementUnknown(unknown, state.fileName, path));
    const pending = [...state.subscriptionSetups.values()]
      .filter((record) => record.generation === generation && record.state === 'retiring')
      .map((record) => record.closed);
    if (!pending.length) return Effect.void;
    const started = clock.currentTimeMillisUnsafe();
    const timeout = () =>
      new SubscriptionError({
        code: 'SUBSCRIPTION_SETUP_FAILED',
        fileName: state.fileName,
        path,
        sourceCode: 'VFS_SUBSCRIPTION_RETIREMENT_TIMEOUT',
        details: remoteDetails(
          Object.assign(new Error('Subscription retirement wait timed out'), {
            code: 'VFS_SUBSCRIPTION_RETIREMENT_TIMEOUT',
          }),
        ),
      });
    const waiting = Effect.tryPromise({
      try: () => Promise.all(pending).then(() => undefined),
      catch: (cause) => subscriptionError(cause, state.fileName, path),
    });
    return Effect.raceFirst(
      waiting,
      Effect.sleep(Math.max(0, budget.remaining)).pipe(Effect.andThen(Effect.fail(timeout()))),
    ).pipe(
      Effect.onExit(() =>
        Effect.sync(() => {
          const elapsed = Math.max(0, clock.currentTimeMillisUnsafe() - started);
          budget.remaining = Math.max(0, budget.remaining - elapsed);
        }),
      ),
      Effect.andThen(waitForRetiring(state, generation, budget, clock, path)),
    );
  });

type SetupResult =
  | { readonly ok: true; readonly handle: PluginSubscription }
  | { readonly ok: false; readonly cause: unknown };

const makeSubscription = (
  state: Coordinator,
  input: SubscribeOptions,
): Effect.Effect<Subscription, SubscriptionError, Scope.Scope> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const parent = yield* Effect.scope;
      if (parent.state._tag === 'Closed')
        return yield* Effect.fail(
          subscriptionError(
            Object.assign(new Error('Subscription scope is closed'), { code: 'EBADF' }),
            state.fileName,
            '',
          ),
        );
      const child = yield* Scope.fork(parent, 'sequential');
      const path = typeof input?.path === 'string' ? input.path : '';
      const controller = new AbortController();
      let closing = false;
      let consumed = false;
      let terminal: SubscriptionError | undefined;
      let setup: SubscriptionSetup | undefined;
      let record: SubscriptionSetupRecord | undefined;
      let handle: PluginSubscription | undefined;
      let setupResult: Promise<SetupResult> | undefined;
      const queue = yield* Queue.bounded<FileChange, Cause.Done>(queueCapacity);
      const terminalSignal = Deferred.makeUnsafe<SubscriptionError | undefined>();
      const setTerminal = (cause: unknown) => {
        if (terminal) return;
        terminal = subscriptionError(cause, state.fileName, path);
        Deferred.doneUnsafe(terminalSignal, Effect.succeed(terminal));
        Queue.shutdownUnsafe(queue);
      };
      let cachedCleanup!: Effect.Effect<void>;
      let cachedRelease!: Effect.Effect<void>;
      let release!: () => Effect.Effect<void>;
      const cleanupBase = Effect.uninterruptibleMask(() =>
        Effect.gen(function* () {
          closing = true;
          controller.abort();
          if (record) record.state = 'retiring';
          if (setupResult) {
            const result = yield* Effect.tryPromise({ try: () => setupResult!, catch: (cause) => cause });
            if (result.ok) {
              handle = result.handle;
              if (record) record.state = 'retiring';
              handle.unsubscribe();
            }
          }
          Queue.shutdownUnsafe(queue);
          Deferred.doneUnsafe(terminalSignal, Effect.succeed(undefined));
        }).pipe(Effect.ensuring(Effect.sync(() => state.files.delete(release))), Effect.orDie),
      );
      cachedCleanup = yield* Effect.cached(cleanupBase);
      cachedRelease = yield* Effect.cached(
        Effect.uninterruptible(Scope.close(child, Exit.void).pipe(Effect.andThen(cachedCleanup))),
      );
      release = () => cachedRelease;
      state.files.add(release);
      yield* Scope.addFinalizer(child, cachedCleanup);
      if (child.state._tag === 'Closed' || state.isClosed()) {
        yield* release();
        return yield* Effect.fail(
          subscriptionError(
            Object.assign(new Error('Subscription scope is closed'), { code: 'EBADF' }),
            state.fileName,
            '',
          ),
        );
      }

      const acquire = Effect.gen(function* () {
        if (!state.subscriptionsAvailable)
          return yield* Effect.fail(subscriptionError(unavailable(state.fileName), state.fileName, path));
        if (typeof path !== 'string' || !path.startsWith('/'))
          return yield* Effect.fail(
            subscriptionError(
              Object.assign(new Error('path must be absolute'), { code: 'EINVAL' }),
              state.fileName,
              path,
            ),
          );
        if (state.isClosed()) return yield* Effect.fail(subscriptionError(state.terminal(), state.fileName, path));

        const clock = yield* Effect.clockWith((value) => Effect.succeed(value));
        const budget = { remaining: state.readinessTimeout };
        let generation: string;
        generation = yield* restore(
          state
            .awaitReady(budget, 'subscribe')
            .pipe(Effect.mapError((cause) => subscriptionError(cause, state.fileName, path))),
        );
        const failure = currentFailure(state, generation, path);
        if (failure) return yield* Effect.fail(failure);
        pruneOtherGenerations(state, generation);
        yield* restore(waitForRetiring(state, generation, budget, clock, path));
        const admittedAgain = yield* restore(
          state
            .awaitReady(budget, 'subscribe')
            .pipe(Effect.mapError((cause) => subscriptionError(cause, state.fileName, path))),
        );
        if (admittedAgain !== generation)
          return yield* Effect.fail(
            currentFailure(state, generation, path) ??
              subscriptionError(
                Object.assign(new Error('Owner changed during subscription setup'), { code: 'VFS_ATTACHMENT_LOST' }),
                state.fileName,
                path,
              ),
          );

        const source = state.backend as unknown as FileChangeSource;
        while (true) {
          const started = Deferred.makeUnsafe<number>();
          const finished = Deferred.makeUnsafe<number>();
          const lifecycle: SubscribeLifecycle = {
            awaitSetupRetirements: async (wait) => {
              const failure = currentFailure(state, generation, path);
              if (failure) throw failure;
              const at = clock.currentTimeMillisUnsafe();
              Deferred.doneUnsafe(started, Effect.succeed(at));
              try {
                await wait(controller.signal);
              } finally {
                const end = clock.currentTimeMillisUnsafe();
                budget.remaining = Math.max(0, budget.remaining - Math.max(0, end - at));
                Deferred.doneUnsafe(finished, Effect.succeed(end));
              }
            },
            registering: (candidate) => {
              const failure = currentFailure(state, generation, path);
              if (failure) throw failure;
              if (generation !== 'direct' && candidate.generation !== generation)
                throw Object.assign(new Error('Subscription channel generation changed'), {
                  code: 'VFS_ATTACHMENT_LOST',
                });
              pruneOtherGenerations(state, generation);
              const unknown = state.subscriptionUnknown.get(generation);
              if (unknown !== undefined) throw retirementUnknown(unknown, state.fileName, path);
              if (
                [...state.subscriptionSetups.values()].some(
                  (existing) => existing.generation === generation && existing.state === 'retiring',
                )
              )
                throw retrySameGeneration;
              setup = candidate;
              record = { generation, closed: candidate.closed, state: 'active' };
              state.subscriptionSetups.set(candidate.closed, record);
              void candidate.closed.then(
                (retirement) => {
                  if (state.subscriptionSetups.get(candidate.closed) === record)
                    state.subscriptionSetups.delete(candidate.closed);
                  if (retirement.status === 'unknown') {
                    const decoded = subscriptionError(retirement.error, state.fileName, path);
                    if (state.currentGeneration() === generation) state.subscriptionUnknown.set(generation, decoded);
                    try {
                      console.warn('OPFS VFS subscription retirement is unknown', {
                        fileName: state.fileName,
                        path,
                        generation,
                        code: decoded.code,
                      });
                    } catch {
                      // Diagnostics cannot turn an observable retirement into an unhandled rejection.
                    }
                  }
                },
                (cause) => {
                  if (state.subscriptionSetups.get(candidate.closed) === record)
                    state.subscriptionSetups.delete(candidate.closed);
                  const decoded = subscriptionError(cause, state.fileName, path);
                  if (state.currentGeneration() === generation) state.subscriptionUnknown.set(generation, decoded);
                },
              );
            },
            retiring: (candidate) => {
              const existing = state.subscriptionSetups.get(candidate.closed);
              if (existing) existing.state = 'retiring';
            },
          };
          const watcher = Deferred.await(started).pipe(
            Effect.flatMap((at) => {
              const elapsed = Math.max(0, clock.currentTimeMillisUnsafe() - at);
              return Effect.raceFirst(
                Deferred.await(finished).pipe(Effect.as('finished' as const)),
                Effect.sleep(Math.max(0, budget.remaining - elapsed)).pipe(Effect.as('timeout' as const)),
              ).pipe(
                Effect.flatMap((result) =>
                  result === 'finished'
                    ? Effect.never
                    : Effect.fail(
                        new SubscriptionError({
                          code: 'SUBSCRIPTION_SETUP_FAILED',
                          fileName: state.fileName,
                          path,
                          sourceCode: 'VFS_SUBSCRIPTION_RETIREMENT_TIMEOUT',
                          details: remoteDetails(
                            Object.assign(new Error('Subscription retirement wait timed out'), {
                              code: 'VFS_SUBSCRIPTION_RETIREMENT_TIMEOUT',
                            }),
                          ),
                        }),
                      ),
                ),
              );
            }),
          );
          const main = Effect.tryPromise({
            try: (signal) => {
              const abort = () => controller.abort();
              signal.addEventListener('abort', abort, { once: true });
              if (signal.aborted) controller.abort();
              const attempt = subscribePlugin(
                source,
                { ...input, signal: controller.signal, onError: setTerminal },
                async (change) => {
                  if (!closing && !terminal) await Effect.runPromise(Queue.offer(queue, change));
                },
                lifecycle,
              );
              setupResult = attempt.then(
                (value) => {
                  handle = value;
                  if (closing) {
                    if (record) record.state = 'retiring';
                    value.unsubscribe();
                  }
                  return { ok: true as const, handle: value };
                },
                (cause) => ({ ok: false as const, cause }),
              );
              void setupResult.then(() => signal.removeEventListener('abort', abort));
              return setupResult;
            },
            catch: (cause) =>
              cause === retrySameGeneration ? (cause as never) : subscriptionError(cause, state.fileName, path),
          });
          const attempt = yield* Effect.result(restore(Effect.raceFirst(main, watcher)));
          if (attempt._tag === 'Success') {
            if (attempt.success.ok) {
              handle = attempt.success.handle;
              if (closing) {
                handle.unsubscribe();
                return yield* Effect.fail(
                  subscriptionError(
                    Object.assign(new Error('Subscription scope closed'), { code: 'EBADF' }),
                    state.fileName,
                    path,
                  ),
                );
              }
              break;
            }
          }
          const cause =
            attempt._tag === 'Failure'
              ? attempt.failure
              : 'cause' in attempt.success
                ? attempt.success.cause
                : undefined;
          if (cause === retrySameGeneration) {
            const ready = yield* restore(
              state
                .awaitReady(budget, 'subscribe')
                .pipe(Effect.mapError((error) => subscriptionError(error, state.fileName, path))),
            );
            if (ready !== generation) return yield* Effect.fail(currentFailure(state, generation, path)!);
            yield* restore(waitForRetiring(state, generation, budget, clock, path));
            continue;
          }
          return yield* Effect.fail(subscriptionError(cause, state.fileName, path));
        }

        const retirement: Promise<SubscriptionRetirement> = setup!.closed.then((result) =>
          asRetirement(result, state.fileName, path),
        );
        const changes = Stream.suspend(() => {
          if (consumed) return Stream.die(new Error('A subscription stream can only be consumed once'));
          consumed = true;
          return Stream.concat(
            Stream.fromEffectRepeat(Queue.take(queue)).pipe(
              Stream.flatMap((change) => (terminal ? Stream.fail(terminal) : Stream.succeed(change))),
              Stream.catchCause((cause) =>
                terminal ? Stream.fail(terminal) : closing ? Stream.empty : Stream.failCause(cause),
              ),
            ),
            Stream.unwrap(
              Deferred.await(terminalSignal).pipe(Effect.map((error) => (error ? Stream.fail(error) : Stream.empty))),
            ),
          ).pipe(Stream.ensuring(release()));
        });
        return { changes, retired: Effect.promise(() => retirement) };
      });

      return yield* acquire.pipe(
        Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(child, exit) : Effect.void)),
      );
    }),
  );

const makeService = (state: Coordinator): SubscriptionsService => ({
  subscribe: (options) => makeSubscription(state, options),
});

export const layer: Layer.Layer<Subscriptions, VolumeError, Volume> = Layer.effect(
  Subscriptions,
  Effect.gen(function* () {
    const volume = yield* Volume;
    const state = getCoordinator(volume);
    if (!state) return yield* Effect.fail(unavailable(volume.fileName));
    if (!state.subscriptionsAvailable) return yield* Effect.fail(unavailable(state.fileName));
    return makeService(state);
  }),
);
