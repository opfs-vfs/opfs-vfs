import { Deferred, Effect, Exit, Fiber, Layer, Scope, Stream } from 'effect';
import { TestClock } from 'effect/testing';
import type { ChangeFrame, ChangeReply, FileChangeChannel, FileChangeSource } from '@opfs-vfs/opfs-vfs/changes';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { subscribe as subscribePlugin } from '@opfs-vfs/plugin-subscriptions/client';
import { Subscriptions, layer as subscriptionsLayer } from './subscriptions.js';
import { makeCoordinator, registerCoordinator } from './coordinator.js';
import type { VolumeService } from './volume.js';
import { Volume } from './volume.js';
import { SubscriptionError } from './errors.js';

class FakeSource implements FileChangeSource {
  readonly commands: Array<{ readonly type: string; readonly subscriptionId?: string }> = [];
  acknowledgements = 0;
  generation = 'generation-1';
  receive!: (frame: ChangeFrame) => void;
  next: ChangeReply | undefined;
  onOpen: (() => void) | undefined;
  onInterrupted!: (code: 'SUBSCRIPTION_INTERRUPTED' | 'SUBSCRIPTION_RESYNC_REQUIRED') => void;
  holdRegister = false;
  acknowledgeCancel = true;
  openDelay = 0;

  async openFileChangeChannel(
    receive: (frame: ChangeFrame) => void,
    interrupted: (code: 'SUBSCRIPTION_INTERRUPTED' | 'SUBSCRIPTION_RESYNC_REQUIRED') => void,
    _closed: () => void,
  ): Promise<FileChangeChannel> {
    this.onOpen?.();
    if (this.openDelay) await new Promise((resolve) => setTimeout(resolve, this.openDelay));
    this.receive = receive;
    this.onInterrupted = interrupted;
    return {
      generation: this.generation,
      request: async (command) => {
        this.commands.push(command);
        if (command.type === 'ack') this.acknowledgements++;
        if (command.type === 'register') {
          if (this.holdRegister) return new Promise<ChangeReply>(() => {});
          return (
            this.next ?? {
              type: 'registered',
              subscriptionId: command.subscriptionId,
            }
          );
        }
        if (command.type === 'cancel' && this.acknowledgeCancel)
          queueMicrotask(() => receive({ type: 'closed', subscriptionId: command.subscriptionId }));
        return { type: 'ok' };
      },
      close: () => {},
    };
  }

  emit(type: 'create' | 'update' | 'delete' = 'update', sequence = 1) {
    const registration = this.commands.find((command) => command.type === 'register');
    if (!registration?.subscriptionId) throw new Error('subscription is not registered');
    this.receive({
      type: 'event',
      subscriptionId: registration.subscriptionId,
      deliveryId: sequence,
      change: {
        type,
        path: '/note.txt',
        kind: 'file',
        cursor: { generation: this.generation, sequence },
        content: { status: 'omitted', reason: 'disabled' },
      },
    });
  }

  terminate() {
    const registration = this.commands.find((command) => command.type === 'register');
    if (!registration?.subscriptionId) throw new Error('subscription is not registered');
    this.receive({
      type: 'terminal',
      subscriptionId: registration.subscriptionId,
      code: 'SUBSCRIPTION_OVERFLOW',
    });
  }

  close(subscriptionId: string) {
    this.receive({ type: 'closed', subscriptionId });
  }
}

const source = new FakeSource();
let currentGeneration = 'generation-1';
const volume: VolumeService = {
  fileName: 'subscriptions.bin',
  sync: Effect.void,
  persistence: Effect.succeed({ state: 'unknown', error: null }),
  acknowledgeOwnerChange: Effect.void,
};
const state = makeCoordinator({
  backend: source as never,
  fileName: volume.fileName,
  isClosed: () => false,
  currentGeneration: () => currentGeneration,
  canRecapture: () => true,
  readinessTimeout: 1000,
  subscriptionsAvailable: true,
  terminal: () => undefined,
  awaitReady: () => Effect.succeed(currentGeneration),
});
registerCoordinator(volume, state);
const liveLayer = Layer.provide(subscriptionsLayer, Layer.succeed(Volume, volume));
const options = { path: '/', scope: 'directory' as const };

beforeEach(() => {
  source.commands.length = 0;
  source.acknowledgements = 0;
  source.generation = 'generation-1';
  currentGeneration = 'generation-1';
  source.next = undefined;
  source.onOpen = undefined;
  source.holdRegister = false;
  source.acknowledgeCancel = true;
  source.openDelay = 0;
  state.subscriptionSetups.clear();
  state.subscriptionUnknown.clear();
  registerCoordinator(volume, state);
});

describe('Effect subscriptions', () => {
  it('delivers one event and retires after early stream completion', async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Subscriptions;
          const subscription = yield* service.subscribe(options);
          source.emit();
          const event = yield* Stream.runHead(Stream.take(subscription.changes, 1));
          const retired = yield* subscription.retired;
          const retiredAgain = yield* subscription.retired;
          const second = yield* Effect.exit(Stream.runDrain(subscription.changes));
          return { event, retired, retiredAgain, second };
        }),
      ).pipe(Effect.provide(liveLayer)),
    );

    expect(result.event).toMatchObject({ _tag: 'Some', value: { type: 'update', path: '/note.txt' } });
    expect(result.retired).toEqual({ status: 'released' });
    expect(result.retiredAgain).toEqual(result.retired);
    expect(Exit.isFailure(result.second)).toBe(true);
    expect(source.commands.map((command) => command.type)).toContain('cancel');
  });

  it('releases an unused subscription when its caller scope closes', async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Subscriptions;
          yield* service.subscribe(options);
          expect(state.files.size).toBe(1);
        }),
      ).pipe(Effect.provide(liveLayer)),
    );

    expect(state.files.size).toBe(0);
    expect(source.commands.map((command) => command.type)).toContain('cancel');
  });

  it('rejects acquisition into a scope that was already closed', async () => {
    const scope = await Effect.runPromise(Scope.make('sequential'));
    await Effect.runPromise(Scope.close(scope, Exit.void));
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* Subscriptions;
        return yield* Effect.exit(Effect.provideService(service.subscribe(options), Scope.Scope, scope));
      }).pipe(Effect.provide(liveLayer)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit))
      expect(exit.cause.reasons).toContainEqual(
        expect.objectContaining({ error: expect.objectContaining({ code: 'EBADF' }) }),
      );
    expect(source.commands).toEqual([]);
  });

  it('surfaces a terminal plugin error as a typed stream failure and drops queued events', async () => {
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Subscriptions;
          const subscription = yield* service.subscribe(options);
          source.emit();
          source.terminate();
          return yield* Effect.exit(Stream.runHead(subscription.changes));
        }),
      ).pipe(Effect.provide(liveLayer)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit))
      expect(exit.cause.reasons).toContainEqual(expect.objectContaining({ error: expect.any(SubscriptionError) }));
  });

  it('stops buffered delivery after terminal failure reaches the first consumer', async () => {
    let observed = 0;
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Subscriptions;
          const subscription = yield* service.subscribe(options);
          for (let sequence = 1; sequence <= 8; sequence++) {
            source.emit('update', sequence);
            yield* Effect.tryPromise({
              try: () => vi.waitFor(() => expect(source.acknowledgements).toBe(sequence)),
              catch: (cause) => cause,
            });
          }
          return yield* Effect.exit(
            Stream.runForEach(subscription.changes, () =>
              Effect.gen(function* () {
                observed++;
                if (observed === 1) {
                  source.terminate();
                  yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
                }
              }),
            ),
          );
        }),
      ).pipe(Effect.provide(liveLayer)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(observed).toBe(1);
  });

  it('bounds queued delivery at sixteen and lets terminal failure discard a full queue', async () => {
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Subscriptions;
          const subscription = yield* service.subscribe(options);
          for (let sequence = 1; sequence <= 16; sequence++) {
            source.emit('update', sequence);
            yield* Effect.tryPromise({
              try: () => vi.waitFor(() => expect(source.acknowledgements).toBe(sequence)),
              catch: (error) => error,
            });
          }
          source.emit('update', 17);
          yield* Effect.tryPromise({ try: () => new Promise((resolve) => setTimeout(resolve, 20)), catch: (e) => e });
          expect(source.acknowledgements).toBe(16);
          source.terminate();
          yield* Effect.tryPromise({ try: () => new Promise((resolve) => setTimeout(resolve, 0)), catch: (e) => e });
          return yield* Effect.exit(Stream.runHead(subscription.changes));
        }),
      ).pipe(Effect.provide(liveLayer)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit))
      expect(exit.cause.reasons).toContainEqual(expect.objectContaining({ error: expect.any(SubscriptionError) }));
  });

  it('vetoes a stale channel generation before sending register', async () => {
    source.generation = 'stale-generation';
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Subscriptions;
          return yield* Effect.exit(service.subscribe(options));
        }),
      ).pipe(Effect.provide(liveLayer)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(source.commands).toEqual([]);
  });

  it('retries a pre-dispatch retirement race only on the captured generation', async () => {
    let finish!: (result: { status: 'released' }) => void;
    const pending = new Promise<{ status: 'released' }>((resolve) => (finish = resolve));
    const record = { generation: currentGeneration, closed: pending, state: 'active' as 'active' | 'retiring' };
    state.subscriptionSetups.set(pending, record);
    source.onOpen = () => {
      source.onOpen = undefined;
      record.state = 'retiring';
      setTimeout(() => {
        finish({ status: 'released' });
        state.subscriptionSetups.delete(pending);
      }, 5);
    };

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Subscriptions;
          yield* service.subscribe(options);
        }),
      ).pipe(Effect.provide(liveLayer)),
    );

    expect(source.commands.filter((command) => command.type === 'register')).toHaveLength(1);
    expect(source.generation).toBe(currentGeneration);
  });

  it('blocks same-generation unknown retirement and forgets obsolete pending generations', async () => {
    state.subscriptionUnknown.set(
      currentGeneration,
      new SubscriptionError({
        code: 'SUBSCRIPTION_RETIREMENT_UNKNOWN',
        fileName: volume.fileName,
        path: '/',
        details: null,
      }),
    );
    const blocked = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Subscriptions;
          return yield* Effect.exit(service.subscribe(options));
        }),
      ).pipe(Effect.provide(liveLayer)),
    );
    expect(Exit.isFailure(blocked)).toBe(true);
    expect(source.commands).toEqual([]);

    state.subscriptionUnknown.clear();
    const pending = new Promise<{ status: 'released' }>(() => {});
    state.subscriptionSetups.set(pending, { generation: 'old-generation', closed: pending, state: 'retiring' });
    source.generation = 'generation-2';
    currentGeneration = 'generation-2';
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Subscriptions;
          yield* service.subscribe(options);
        }),
      ).pipe(Effect.provide(liveLayer)),
    );
    expect(state.subscriptionSetups.has(pending)).toBe(false);
    expect(source.commands.filter((command) => command.type === 'register')).toHaveLength(1);
  });

  it('does not let an old waiter prune a current unknown retirement', async () => {
    const originalCurrent = state.currentGeneration;
    const originalReady = state.awaitReady;
    let generation = 'generation-1';
    const admitted = Deferred.makeUnsafe<void>();
    Object.assign(state, {
      currentGeneration: () => generation,
      awaitReady: () =>
        Effect.gen(function* () {
          const captured = generation;
          if (captured === 'generation-1') yield* Deferred.succeed(admitted, undefined);
          return captured;
        }),
    });
    let finishOld!: (result: { status: 'released' }) => void;
    const oldRetirement = new Promise<{ status: 'released' }>((resolve) => (finishOld = resolve));
    state.subscriptionSetups.set(oldRetirement, {
      generation: 'generation-1',
      closed: oldRetirement,
      state: 'retiring',
    });
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const service = yield* Subscriptions;
            const oldAttempt = yield* Effect.forkChild(Effect.exit(service.subscribe(options)));
            yield* Deferred.await(admitted);
            yield* Effect.yieldNow;
            generation = source.generation = 'generation-2';
            const newer = yield* service.subscribe(options);
            source.onInterrupted('SUBSCRIPTION_INTERRUPTED');
            expect(yield* newer.retired).toMatchObject({ status: 'unknown' });
            expect(state.subscriptionUnknown.has('generation-2')).toBe(true);
            finishOld({ status: 'released' });
            expect(yield* Fiber.join(oldAttempt)).toMatchObject({ _tag: 'Failure' });
            const replacement = yield* Effect.exit(service.subscribe(options));
            expect(Exit.isFailure(replacement)).toBe(true);
            if (Exit.isFailure(replacement))
              expect(replacement.cause.reasons).toContainEqual(
                expect.objectContaining({
                  error: expect.objectContaining({ code: 'SUBSCRIPTION_RETIREMENT_UNKNOWN' }),
                }),
              );
          }),
        ).pipe(Effect.provide(liveLayer)),
      );
    } finally {
      finishOld({ status: 'released' });
      Object.assign(state, { currentGeneration: originalCurrent, awaitReady: originalReady });
    }
  });

  it('detaches a completed subscription child scope', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* Subscriptions;
        const parent = yield* Scope.make();
        try {
          const subscription = yield* service.subscribe(options).pipe(Effect.provideService(Scope.Scope, parent));
          source.emit();
          yield* Stream.runHead(subscription.changes);
          expect(yield* subscription.retired).toEqual({ status: 'released' });
          expect(parent.state._tag).toBe('Empty');
        } finally {
          yield* Scope.close(parent, Exit.void);
        }
      }).pipe(Effect.provide(liveLayer)),
    );
  });

  it('joins stream cleanup with a concurrent parent close', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* Subscriptions;
        const parent = yield* Scope.make();
        const started = Deferred.makeUnsafe<void>();
        const release = Deferred.makeUnsafe<void>();
        try {
          const subscription = yield* service.subscribe(options).pipe(Effect.provideService(Scope.Scope, parent));
          source.emit();
          const consume = yield* Effect.forkChild(
            Stream.runForEach(subscription.changes, () =>
              Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
            ),
            { startImmediately: true },
          );
          yield* Deferred.await(started);
          const close = yield* Effect.forkChild(Scope.close(parent, Exit.void), { startImmediately: true });
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(consume);
          yield* Fiber.join(close);
          expect(yield* subscription.retired).toEqual({ status: 'released' });
          expect(parent.state._tag).toBe('Closed');
        } finally {
          yield* Scope.close(parent, Exit.void);
        }
      }).pipe(Effect.provide(liveLayer)),
    );
  });

  it('keeps an unknown retirement readable when warning output throws', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('warning failed');
    });
    const failures: unknown[] = [];
    const onUnhandled = (event: PromiseRejectionEvent) => {
      event.preventDefault();
      failures.push(event.reason);
    };
    window.addEventListener('unhandledrejection', onUnhandled);
    try {
      const retirement = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const service = yield* Subscriptions;
            const subscription = yield* service.subscribe(options);
            source.onInterrupted('SUBSCRIPTION_INTERRUPTED');
            const first = yield* subscription.retired;
            const second = yield* subscription.retired;
            return { first, second };
          }),
        ).pipe(Effect.provide(liveLayer)),
      );
      expect(retirement.first).toMatchObject({ status: 'unknown' });
      expect(retirement.second).toEqual(retirement.first);
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(failures).toEqual([]);
    } finally {
      warning.mockRestore();
      window.removeEventListener('unhandledrejection', onUnhandled);
    }
  });

  it('uses one TestClock budget for the actual same-generation retirement wait', async () => {
    const pending = new Promise<{ status: 'released' }>(() => {});
    state.subscriptionSetups.set(pending, { generation: currentGeneration, closed: pending, state: 'retiring' });
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Effect.gen(function* () {
            const service = yield* Subscriptions;
            return yield* Effect.exit(service.subscribe(options));
          }).pipe(Effect.forkChild);
          yield* TestClock.adjust(1000);
          return yield* Fiber.join(fiber);
        }),
      ).pipe(Effect.provide(liveLayer), Effect.provide(TestClock.layer())),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit))
      expect(exit.cause.reasons).toContainEqual(
        expect.objectContaining({
          error: expect.objectContaining({ sourceCode: 'VFS_SUBSCRIPTION_RETIREMENT_TIMEOUT' }),
        }),
      );
    expect(source.commands).toEqual([]);
  });

  it('shares readiness time and repeated retirement waves under one TestClock budget', async () => {
    let finishFirst!: (result: { status: 'released' }) => void;
    const firstWave = new Promise<{ status: 'released' }>((resolve) => (finishFirst = resolve));
    const secondWave = new Promise<{ status: 'released' }>(() => {});
    const budgetState = makeCoordinator({
      backend: source as never,
      fileName: volume.fileName,
      isClosed: () => false,
      currentGeneration: () => currentGeneration,
      canRecapture: () => true,
      readinessTimeout: 1000,
      subscriptionsAvailable: true,
      terminal: () => undefined,
      awaitReady: (budget) =>
        Effect.gen(function* () {
          const start = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
          yield* Effect.sleep(500);
          const end = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
          budget.remaining = Math.max(0, budget.remaining - (end - start));
          return currentGeneration;
        }),
    });
    budgetState.subscriptionSetups.set(firstWave, {
      generation: currentGeneration,
      closed: firstWave,
      state: 'retiring',
    });
    registerCoordinator(volume, budgetState);
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Effect.gen(function* () {
            const service = yield* Subscriptions;
            return yield* Effect.exit(service.subscribe(options));
          }).pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          yield* TestClock.adjust(500);
          yield* TestClock.adjust(300);
          finishFirst({ status: 'released' });
          budgetState.subscriptionSetups.delete(firstWave);
          budgetState.subscriptionSetups.set(secondWave, {
            generation: currentGeneration,
            closed: secondWave,
            state: 'retiring',
          });
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          yield* TestClock.adjust(200);
          return yield* Fiber.join(fiber);
        }),
      ).pipe(Effect.provide(liveLayer), Effect.provide(TestClock.layer())),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit))
      expect(exit.cause.reasons).toContainEqual(
        expect.objectContaining({
          error: expect.objectContaining({ sourceCode: 'VFS_SUBSCRIPTION_RETIREMENT_TIMEOUT' }),
        }),
      );
    expect(source.commands).toEqual([]);
  });

  it('fails layer acquisition with a typed unsupported error without the fixed capability', async () => {
    registerCoordinator(
      volume,
      makeCoordinator({
        backend: source as never,
        fileName: volume.fileName,
        isClosed: () => false,
        currentGeneration: () => currentGeneration,
        canRecapture: () => true,
        readinessTimeout: 1000,
        subscriptionsAvailable: false,
        terminal: () => undefined,
        awaitReady: () => Effect.succeed(currentGeneration),
      }),
    );
    const error = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          yield* Subscriptions;
        }).pipe(Effect.provide(liveLayer)),
      ),
    );
    expect(error).toMatchObject({ _tag: 'VolumeError', kind: 'unsupported', code: 'ENOTSUP' });
  });

  it('times out a failed-setup wait, aborts it, and records the late unknown generation', async () => {
    source.holdRegister = true;
    source.acknowledgeCancel = false;
    const controller = new AbortController();
    const failedSetup = subscribePlugin(source, { ...options, signal: controller.signal, onError: () => {} }, () => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(failedSetup).rejects.toMatchObject({ name: 'AbortError' });
    const firstRegistration = source.commands.find((command) => command.type === 'register')?.subscriptionId;
    expect(firstRegistration).toBeDefined();

    const timeoutState = makeCoordinator({
      backend: source as never,
      fileName: volume.fileName,
      isClosed: () => false,
      currentGeneration: () => currentGeneration,
      canRecapture: () => true,
      readinessTimeout: 50,
      subscriptionsAvailable: true,
      terminal: () => undefined,
      awaitReady: () => Effect.succeed(currentGeneration),
    });
    registerCoordinator(volume, timeoutState);
    const timeout = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Effect.gen(function* () {
            const service = yield* Subscriptions;
            return yield* Effect.exit(service.subscribe(options));
          }).pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          yield* TestClock.adjust(50);
          return yield* Fiber.join(fiber);
        }),
      ).pipe(Effect.provide(liveLayer), Effect.provide(TestClock.layer())),
    );
    expect(Exit.isFailure(timeout)).toBe(true);
    if (Exit.isFailure(timeout))
      expect(timeout.cause.reasons).toContainEqual(
        expect.objectContaining({
          error: expect.objectContaining({ sourceCode: 'VFS_SUBSCRIPTION_RETIREMENT_TIMEOUT' }),
        }),
      );
    expect(source.commands.filter((command) => command.type === 'register')).toHaveLength(1);

    source.onInterrupted('SUBSCRIPTION_INTERRUPTED');
    source.generation = currentGeneration = 'generation-after-timeout';
    source.holdRegister = false;
    source.acknowledgeCancel = true;
    const fresh = await subscribePlugin(source, { ...options, onError: () => {} }, () => {});
    fresh.unsubscribe();
    await fresh.closed;
  });

  it('does not spend the setup budget while opening the plugin channel', async () => {
    source.openDelay = 25;
    const slowOpenState = makeCoordinator({
      backend: source as never,
      fileName: volume.fileName,
      isClosed: () => false,
      currentGeneration: () => currentGeneration,
      canRecapture: () => true,
      readinessTimeout: 1,
      subscriptionsAvailable: true,
      terminal: () => undefined,
      awaitReady: () => Effect.succeed(currentGeneration),
    });
    registerCoordinator(volume, slowOpenState);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Subscriptions;
          yield* service.subscribe(options);
        }),
      ).pipe(Effect.provide(liveLayer)),
    );
    expect(source.commands.filter((command) => command.type === 'register')).toHaveLength(1);
  });

  it('continues registration when the failed-setup retirement hook finishes', async () => {
    source.holdRegister = true;
    source.acknowledgeCancel = false;
    const controller = new AbortController();
    const failedSetup = subscribePlugin(source, { ...options, signal: controller.signal, onError: () => {} }, () => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(failedSetup).rejects.toMatchObject({ name: 'AbortError' });
    const firstRegistration = source.commands.find((command) => command.type === 'register')?.subscriptionId;
    expect(firstRegistration).toBeDefined();

    source.holdRegister = false;
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* Subscriptions;
          const fiber = yield* service.subscribe(options).pipe(Effect.forkChild);
          yield* Effect.tryPromise({ try: () => new Promise((resolve) => setTimeout(resolve, 10)), catch: (e) => e });
          expect(source.commands.filter((command) => command.type === 'register')).toHaveLength(1);
          source.close(firstRegistration!);
          const subscription = yield* Fiber.join(fiber);
          const secondRegistration = source.commands
            .filter((command) => command.type === 'register')
            .at(-1)?.subscriptionId;
          expect(secondRegistration).toBeDefined();
          source.close(secondRegistration!);
          return yield* subscription.retired;
        }),
      ).pipe(Effect.provide(liveLayer)),
    );
    expect(result).toEqual({ status: 'released' });
  });
});
