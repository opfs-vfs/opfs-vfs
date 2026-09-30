import { Deferred, Effect, Exit, Fiber, FileSystem, Layer, PlatformError, Queue, Scope, Stream } from 'effect';
import { TestClock } from 'effect/testing';
import type { ChangeFrame, ChangeReply, FileChangeChannel, FileChangeSource } from '@opfs-vfs/opfs-vfs/changes';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { subscribe as subscribePlugin } from '@opfs-vfs/plugin-subscriptions/client';
import { Subscriptions, layer as subscriptionsLayer } from './subscriptions.js';
import { makeCoordinator, registerCoordinator } from './coordinator.js';
import type { VolumeService } from './volume.js';
import { Volume } from './volume.js';
import { SubscriptionError } from './errors.js';
import { OpfsFileSystem } from './filesystem.js';
import { keepViewCurrent } from '../examples/reconciled-view.js';

class FakeSource implements FileChangeSource {
  readonly commands: Array<{
    readonly type: string;
    readonly subscriptionId?: string;
    readonly options?: {
      readonly path?: string;
      readonly scope?: 'file' | 'directory';
      readonly recursive?: boolean;
    };
  }> = [];
  acknowledgements = 0;
  generation = 'generation-1';
  targetStat = {
    mode: 0o100644,
    size: 0,
    ino: 1,
    nlink: 1,
    blksize: 4096,
    blocks: 0,
    is_dir: false,
    is_file: true,
  };
  lstatError: unknown;
  onRegister: (() => void) | undefined;
  afterLstat: (() => void) | undefined;
  readError: unknown;
  onReadDirectory: (() => void) | undefined;
  receive!: (frame: ChangeFrame) => void;
  next: ChangeReply | undefined;
  onOpen: (() => void) | undefined;
  onInterrupted!: (code: 'SUBSCRIPTION_INTERRUPTED' | 'SUBSCRIPTION_RESYNC_REQUIRED') => void;
  onChannelClosed!: () => void;
  holdRegister = false;
  acknowledgeCancel = true;
  openDelay = 0;

  async openFileChangeChannel(
    receive: (frame: ChangeFrame) => void,
    interrupted: (code: 'SUBSCRIPTION_INTERRUPTED' | 'SUBSCRIPTION_RESYNC_REQUIRED') => void,
    closed: () => void,
  ): Promise<FileChangeChannel> {
    this.onOpen?.();
    if (this.openDelay) await new Promise((resolve) => setTimeout(resolve, this.openDelay));
    this.receive = receive;
    this.onInterrupted = interrupted;
    this.onChannelClosed = closed;
    return {
      generation: this.generation,
      request: async (command) => {
        this.commands.push(command);
        if (command.type === 'ack') this.acknowledgements++;
        if (command.type === 'register') {
          queueMicrotask(() => this.onRegister?.());
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

  lstatSync(_path: string) {
    this.afterLstat?.();
    if (this.lstatError) throw this.lstatError;
    return this.targetStat;
  }

  readdirEntriesSync(_path: string) {
    this.onReadDirectory?.();
    if (this.readError) throw this.readError;
    return [];
  }

  emit(type: 'create' | 'update' | 'delete' = 'update', sequence = 1, path = '/note.txt') {
    const registration = this.commands.find((command) => command.type === 'register');
    if (!registration?.subscriptionId) throw new Error('subscription is not registered');
    this.receive({
      type: 'event',
      subscriptionId: registration.subscriptionId,
      deliveryId: sequence,
      change: {
        type,
        path,
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
const fileSystemLayer = Layer.provide(OpfsFileSystem.layer, Layer.succeed(Volume, volume));
const viewLayer = Layer.merge(liveLayer, fileSystemLayer);
const options = { path: '/', scope: 'directory' as const };
const failureOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.find((reason) => reason._tag === 'Fail')?.error : undefined;

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
  source.targetStat = {
    mode: 0o100644,
    size: 0,
    ino: 1,
    nlink: 1,
    blksize: 4096,
    blocks: 0,
    is_dir: false,
    is_file: true,
  };
  source.lstatError = undefined;
  source.onRegister = undefined;
  source.afterLstat = undefined;
  source.readError = undefined;
  source.onReadDirectory = undefined;
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

  it.each([['channel closed callback'], ['closed frame']])(
    'drains buffered changes and completes after %s',
    async (retirement) => {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const service = yield* Subscriptions;
            const subscription = yield* service.subscribe(options);
            const delivered: string[] = [];
            source.emit();
            yield* Effect.tryPromise({
              try: () => vi.waitFor(() => expect(source.acknowledgements).toBe(1)),
              catch: (cause) => cause,
            });
            if (retirement === 'channel closed callback') source.onChannelClosed();
            else source.close(source.commands.find((command) => command.type === 'register')!.subscriptionId!);
            yield* Effect.raceFirst(
              Stream.runForEach(subscription.changes, (change) => Effect.sync(() => delivered.push(change.path))),
              Effect.sleep(1000).pipe(Effect.andThen(Effect.die(new Error('subscription stream did not complete')))),
            );
            return { delivered, retired: yield* subscription.retired };
          }),
        ).pipe(Effect.provide(liveLayer)),
      );

      expect(result.delivered).toEqual(['/note.txt']);
      expect(result.retired).toEqual({ status: 'released' });
    },
  );

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
          const retired = yield* subscription.retired;
          return { retired, stream: yield* Effect.exit(Stream.runHead(subscription.changes)) };
        }),
      ).pipe(Effect.provide(liveLayer)),
    );

    expect(exit.retired).toEqual({ status: 'released' });
    expect(Exit.isFailure(exit.stream)).toBe(true);
    if (Exit.isFailure(exit.stream))
      expect(exit.stream.cause.reasons).toContainEqual(
        expect.objectContaining({ error: expect.any(SubscriptionError) }),
      );
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

  it('reports attachment loss when retry readiness changes without a current failure', async () => {
    let readyCalls = 0;
    let finish!: (result: { status: 'released' }) => void;
    const pending = new Promise<{ status: 'released' }>((resolve) => (finish = resolve));
    const record = { generation: currentGeneration, closed: pending, state: 'active' as 'active' | 'retiring' };
    state.subscriptionSetups.set(pending, record);
    const ready = vi
      .spyOn(state, 'awaitReady')
      .mockImplementation(() => Effect.succeed(++readyCalls < 3 ? currentGeneration : 'generation-2'));
    source.onOpen = () => {
      source.onOpen = undefined;
      record.state = 'retiring';
    };

    try {
      const exit = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const service = yield* Subscriptions;
            return yield* Effect.exit(service.subscribe(options));
          }),
        ).pipe(Effect.provide(liveLayer)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit))
        expect(exit.cause.reasons).toContainEqual(
          expect.objectContaining({
            error: expect.objectContaining({ code: 'SUBSCRIPTION_SETUP_FAILED', sourceCode: 'VFS_ATTACHMENT_LOST' }),
          }),
        );
    } finally {
      finish({ status: 'released' });
      state.subscriptionSetups.delete(pending);
      ready.mockRestore();
    }
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

  it('preflights standard watch paths and never registers after a pinned takeover', async () => {
    const fs = OpfsFileSystem.make(volume);
    const relative = await Effect.runPromise(Effect.exit(Stream.runHead(fs.watch('relative'))));
    expect(failureOf(relative)).toMatchObject({ reason: { _tag: 'BadArgument' } });
    expect(source.commands).toEqual([]);

    source.lstatError = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const missing = await Effect.runPromise(Effect.exit(Stream.runHead(fs.watch('/missing'))));
    expect(failureOf(missing)).toMatchObject({ reason: { _tag: 'NotFound' } });
    expect(source.commands).toEqual([]);

    source.lstatError = undefined;
    source.targetStat = { ...source.targetStat, mode: 0o120777, is_dir: false, is_file: false };
    const symlink = await Effect.runPromise(Effect.exit(Stream.runHead(fs.watch('/link'))));
    expect(failureOf(symlink)).toMatchObject({ reason: { _tag: 'BadResource' } });
    expect(source.commands).toEqual([]);

    source.targetStat = { ...source.targetStat, mode: 0o040755, is_dir: true, is_file: false };
    source.afterLstat = () => {
      currentGeneration = source.generation = 'generation-2';
    };
    const takeover = await Effect.runPromise(Effect.exit(Stream.runHead(fs.watch('/tree'))));
    const takeoverError = failureOf(takeover);
    if (!PlatformError.isPlatformError(takeoverError)) throw new Error('watch takeover was not a PlatformError');
    expect(takeoverError.reason._tag).toBe('Unknown');
    if (!(takeoverError.reason.cause instanceof SubscriptionError))
      throw new Error('watch takeover did not retain its SubscriptionError');
    expect(takeoverError.reason.cause).toMatchObject({
      code: 'SUBSCRIPTION_INTERRUPTED',
      sourceCode: 'VFS_ATTACHMENT_LOST',
    });
    expect(source.commands.filter((command) => command.type === 'register')).toHaveLength(0);
  });

  it('projects rich changes to standard events and releases on early completion', async () => {
    source.targetStat = { ...source.targetStat, mode: 0o040755, is_dir: true, is_file: false };
    const fs = OpfsFileSystem.make(volume);
    let registered!: () => void;
    const ready = new Promise<void>((resolve) => {
      registered = resolve;
    });
    source.onRegister = registered;
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const watching = yield* Stream.take(fs.watch('/tree', { recursive: true }), 3).pipe(
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* Effect.promise(() => ready);
          yield* Effect.yieldNow;
          source.emit('create', 1, '/tree/new.txt');
          source.emit('update', 2, '/tree/current.txt');
          source.emit('delete', 3, '/tree/old.txt');
          return yield* Fiber.join(watching);
        }),
      ),
    );
    expect(result).toEqual([
      { _tag: 'Create', path: '/tree/new.txt' },
      { _tag: 'Update', path: '/tree/current.txt' },
      { _tag: 'Remove', path: '/tree/old.txt' },
    ]);
    expect(source.commands.find((command) => command.type === 'register')).toMatchObject({
      options: { path: '/tree', scope: 'directory', recursive: true },
    });
    expect(source.commands.filter((command) => command.type === 'cancel')).toHaveLength(1);
    expect(state.files.size).toBe(0);
  });

  it('keeps file watches nonrecursive when the standard option is true', async () => {
    const fs = OpfsFileSystem.make(volume);
    let registered!: () => void;
    const ready = new Promise<void>((resolve) => {
      registered = resolve;
    });
    source.onRegister = registered;
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const watching = yield* Stream.runHead(fs.watch('/note.txt', { recursive: true })).pipe(Effect.forkChild);
          yield* Effect.promise(() => ready);
          yield* Effect.yieldNow;
          source.emit('update', 1, '/note.txt');
          return yield* Fiber.join(watching);
        }),
      ),
    );
    expect(result).toMatchObject({ _tag: 'Some', value: { _tag: 'Update', path: '/note.txt' } });
    expect(source.commands.find((command) => command.type === 'register')).toMatchObject({
      options: { path: '/note.txt', scope: 'file', recursive: false },
    });
  });

  it('preserves native interruption as Unknown with its original SubscriptionError', async () => {
    const fs = OpfsFileSystem.make(volume);
    let registered!: () => void;
    const ready = new Promise<void>((resolve) => {
      registered = resolve;
    });
    source.onRegister = registered;
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const watching = yield* Effect.exit(Stream.runHead(fs.watch('/note.txt'))).pipe(Effect.forkChild);
          yield* Effect.promise(() => ready);
          yield* Effect.yieldNow;
          source.onInterrupted('SUBSCRIPTION_INTERRUPTED');
          return yield* Fiber.join(watching);
        }),
      ),
    );
    const error = failureOf(exit);
    if (!PlatformError.isPlatformError(error)) throw new Error('watch interruption was not a PlatformError');
    expect(error.reason._tag).toBe('Unknown');
    if (!(error.reason.cause instanceof SubscriptionError))
      throw new Error('watch interruption did not retain its SubscriptionError');
    expect(error.reason.cause.code).toBe('SUBSCRIPTION_INTERRUPTED');
    expect(error.reason.cause.sourceCode).not.toBe('VFS_ATTACHMENT_LOST');
  });

  it('subscribes before the initial scan and marks a failed scan stale once without retry', async () => {
    source.readError = Object.assign(new Error('scan denied'), { code: 'EACCES' });
    source.onReadDirectory = () => {
      expect(source.commands.filter((command) => command.type === 'register')).toHaveLength(1);
    };
    let stale = 0;
    const exit = await Effect.runPromise(
      Effect.exit(
        keepViewCurrent({ path: '/', publish: () => Effect.void, markStale: () => Effect.sync(() => stale++) }),
      ).pipe(Effect.provide(viewLayer)),
    );
    const scanFailure = failureOf(exit);
    if (!PlatformError.isPlatformError(scanFailure)) throw new Error('failed scan was not a PlatformError');
    expect(scanFailure.reason._tag).toBe('PermissionDenied');
    expect(stale).toBe(1);
    expect(source.commands.filter((command) => command.type === 'register')).toHaveLength(1);
    expect(source.commands.filter((command) => command.type === 'cancel')).toHaveLength(1);
    expect(state.files.size).toBe(0);
  });

  it('rescans after a mutation queued during the initial scan', async () => {
    const started = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    const current = Deferred.makeUnsafe<void>();
    let scans = 0;
    let paths = ['before.txt'];
    const views: Array<ReadonlyArray<string>> = [];
    const fs = {
      ...OpfsFileSystem.make(volume),
      readDirectory: () =>
        Effect.gen(function* () {
          const snapshot = [...paths];
          expect(source.commands.filter((command) => command.type === 'register')).toHaveLength(1);
          if (++scans === 1) {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
          }
          return snapshot;
        }),
    };
    const layers = Layer.merge(liveLayer, Layer.succeed(FileSystem.FileSystem, fs));

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const watcher = yield* Effect.forkChild(
            keepViewCurrent({
              path: '/',
              publish: (view) =>
                Effect.gen(function* () {
                  views.push(view);
                  if (view.includes('during.txt')) yield* Deferred.succeed(current, undefined);
                }),
              markStale: () => Effect.void,
            }),
          );
          yield* Deferred.await(started);
          paths = ['before.txt', 'during.txt'];
          source.emit();
          yield* Effect.yieldNow;
          yield* Deferred.succeed(release, undefined);
          yield* Deferred.await(current);
          yield* Fiber.interrupt(watcher);
        }),
      ).pipe(Effect.provide(layers)),
    );

    expect(views[0]).toEqual(['before.txt']);
    expect(views.at(-1)).toEqual(['before.txt', 'during.txt']);
    expect(scans).toBe(2);
    expect(state.files.size).toBe(0);
  });

  it('does not let a canceled old scan publish into a new workflow', async () => {
    let resolveOld: ((paths: Array<string>) => void) | undefined;
    const oldRead = new Promise<Array<string>>((resolve) => {
      resolveOld = resolve;
    });
    const started = Deferred.makeUnsafe<void>();
    const publishedNew = Deferred.makeUnsafe<void>();
    let scans = 0;
    const views: Array<string> = [];
    const fs = {
      ...OpfsFileSystem.make(volume),
      readDirectory: () =>
        Effect.gen(function* () {
          if (++scans === 1) {
            yield* Deferred.succeed(started, undefined);
            return yield* Effect.promise(() => oldRead);
          }
          return ['new.txt'];
        }),
    };
    const layers = Layer.merge(liveLayer, Layer.succeed(FileSystem.FileSystem, fs));

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const old = yield* Effect.forkChild(
              keepViewCurrent({
                path: '/',
                publish: () => Effect.sync(() => views.push('old')),
                markStale: () => Effect.void,
              }),
            );
            yield* Deferred.await(started);
            yield* Fiber.interrupt(old);
            const next = yield* Effect.forkChild(
              keepViewCurrent({
                path: '/',
                publish: () =>
                  Effect.gen(function* () {
                    views.push('new');
                    yield* Deferred.succeed(publishedNew, undefined);
                  }),
                markStale: () => Effect.void,
              }),
            );
            yield* Deferred.await(publishedNew);
            resolveOld?.(['old.txt']);
            yield* Effect.yieldNow;
            expect(views).toEqual(['new']);
            expect(scans).toBe(2);
            yield* Fiber.interrupt(next);
          }),
        ).pipe(Effect.provide(layers)),
      );
    } finally {
      resolveOld?.(['old.txt']);
    }

    expect(state.files.size).toBe(0);
  });

  it('preserves a notification failure together with a cleanup defect without retrying', async () => {
    const notification = new SubscriptionError({
      code: 'SUBSCRIPTION_INTERRUPTED',
      fileName: volume.fileName,
      path: '/',
      details: null,
    });
    const cleanup = new Error('subscription cleanup defect');
    let registrations = 0;
    let stale = 0;
    const fakeSubscriptions = Layer.succeed(Subscriptions, {
      subscribe: () =>
        Effect.gen(function* () {
          registrations++;
          yield* Effect.addFinalizer(() => Effect.die(cleanup));
          return { changes: Stream.fail(notification), retired: Effect.succeed({ status: 'released' as const }) };
        }),
    });
    const layers = Layer.merge(fakeSubscriptions, fileSystemLayer);
    const exit = await Effect.runPromise(
      Effect.exit(
        keepViewCurrent({ path: '/', publish: () => Effect.void, markStale: () => Effect.sync(() => stale++) }),
      ).pipe(Effect.provide(layers)),
    );
    expect(registrations).toBe(1);
    expect(stale).toBe(1);
    expect(exit).toMatchObject({
      _tag: 'Failure',
      cause: {
        reasons: expect.arrayContaining([
          expect.objectContaining({ _tag: 'Fail', error: notification }),
          expect.objectContaining({ _tag: 'Die', defect: cleanup }),
        ]),
      },
    });
  });

  it('stops after a recoverable notification is followed by cleanup failure', async () => {
    const interrupted = new SubscriptionError({
      code: 'SUBSCRIPTION_INTERRUPTED',
      fileName: volume.fileName,
      path: '/',
      details: null,
    });
    const cleanup = new Error('retry cleanup defect');
    const starts = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const attempts = yield* Queue.unbounded<number>();
          let registrations = 0;
          let stale = 0;
          const fakeSubscriptions = Layer.succeed(Subscriptions, {
            subscribe: () =>
              Effect.gen(function* () {
                const current = ++registrations;
                yield* Queue.offer(attempts, current);
                if (current === 2) yield* Effect.addFinalizer(() => Effect.die(cleanup));
                return {
                  changes: Stream.fail(interrupted),
                  retired: Effect.succeed({ status: 'released' as const }),
                };
              }),
          });
          const fiber = yield* Effect.forkChild(
            Effect.exit(
              keepViewCurrent({ path: '/', publish: () => Effect.void, markStale: () => Effect.sync(() => stale++) }),
            ).pipe(Effect.provide(Layer.merge(fakeSubscriptions, fileSystemLayer))),
          );
          expect(yield* Queue.take(attempts)).toBe(1);
          yield* Effect.yieldNow;
          yield* TestClock.adjust(250);
          expect(yield* Queue.take(attempts)).toBe(2);
          const exit = yield* Fiber.join(fiber);
          return { registrations, stale, exit };
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );
    expect(starts.registrations).toBe(2);
    expect(starts.stale).toBe(2);
    expect(starts.exit).toMatchObject({
      _tag: 'Failure',
      cause: {
        reasons: expect.arrayContaining([
          expect.objectContaining({ _tag: 'Fail', error: interrupted }),
          expect.objectContaining({ _tag: 'Die', defect: cleanup }),
        ]),
      },
    });
  });

  it('makes at most three retries before a scan is published and leaves the last failure visible', async () => {
    const interrupted = new SubscriptionError({
      code: 'SUBSCRIPTION_INTERRUPTED',
      fileName: volume.fileName,
      path: '/',
      details: null,
    });
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const attempts = yield* Queue.unbounded<number>();
          let registrations = 0;
          let stale = 0;
          const fakeSubscriptions = Layer.succeed(Subscriptions, {
            subscribe: () =>
              Effect.gen(function* () {
                yield* Queue.offer(attempts, ++registrations);
                return yield* Effect.fail(interrupted);
              }),
          });
          const fiber = yield* Effect.forkChild(
            Effect.exit(
              keepViewCurrent({ path: '/', publish: () => Effect.void, markStale: () => Effect.sync(() => stale++) }),
            ).pipe(Effect.provide(Layer.merge(fakeSubscriptions, fileSystemLayer))),
          );
          for (let expected = 1; expected <= 4; expected++) {
            expect(yield* Queue.take(attempts)).toBe(expected);
            if (expected < 4) {
              yield* Effect.yieldNow;
              yield* TestClock.adjust(250);
            }
          }
          return { registrations, stale, exit: yield* Fiber.join(fiber) };
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );
    expect(result.registrations).toBe(4);
    expect(result.stale).toBe(4);
    expect(result.exit).toMatchObject({
      _tag: 'Failure',
      cause: { reasons: [expect.objectContaining({ _tag: 'Fail', error: interrupted })] },
    });
  });

  it('renews the retry budget after each successfully published scan', async () => {
    const interrupted = new SubscriptionError({
      code: 'SUBSCRIPTION_INTERRUPTED',
      fileName: volume.fileName,
      path: '/',
      details: null,
    });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const published = yield* Queue.unbounded<number>();
          const interruptions = yield* Queue.unbounded<void>();
          const stale = yield* Queue.unbounded<void>();
          let registrations = 0;
          const fakeSubscriptions = Layer.succeed(Subscriptions, {
            subscribe: () =>
              Effect.sync(() => {
                registrations++;
                return {
                  changes: Stream.fromEffect(Queue.take(interruptions).pipe(Effect.andThen(Effect.fail(interrupted)))),
                  retired: Effect.succeed({ status: 'released' as const }),
                };
              }),
          });
          const watcher = yield* Effect.forkChild(
            keepViewCurrent({
              path: '/',
              publish: () => Queue.offer(published, registrations),
              markStale: () => Queue.offer(stale, undefined),
            }).pipe(Effect.provide(Layer.merge(fakeSubscriptions, fileSystemLayer))),
          );
          expect(yield* Queue.take(published)).toBe(1);
          for (let expected = 2; expected <= 5; expected++) {
            yield* Queue.offer(interruptions, undefined);
            yield* Queue.take(stale);
            yield* Effect.yieldNow;
            yield* TestClock.adjust(250);
            expect(registrations).toBe(expected);
            expect(yield* Queue.take(published)).toBe(expected);
          }
          yield* Fiber.interrupt(watcher);
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );
  });

  it('does not retry nonrecoverable subscription failures', async () => {
    const failed = new SubscriptionError({
      code: 'SUBSCRIPTION_CALLBACK_FAILED',
      fileName: volume.fileName,
      path: '/',
      details: null,
    });
    let registrations = 0;
    let stale = 0;
    const fakeSubscriptions = Layer.succeed(Subscriptions, {
      subscribe: () => {
        registrations++;
        return Effect.succeed({
          changes: Stream.fail(failed),
          retired: Effect.succeed({ status: 'released' as const }),
        });
      },
    });
    const exit = await Effect.runPromise(
      Effect.exit(
        keepViewCurrent({ path: '/', publish: () => Effect.void, markStale: () => Effect.sync(() => stale++) }),
      ).pipe(Effect.provide(Layer.merge(fakeSubscriptions, fileSystemLayer))),
    );
    expect(registrations).toBe(1);
    expect(stale).toBe(1);
    expect(exit).toMatchObject({
      _tag: 'Failure',
      cause: { reasons: [expect.objectContaining({ _tag: 'Fail', error: failed })] },
    });
  });

  it('maps retirement timeout to TimedOut using the budget already spent on admission', async () => {
    let admissions = 0;
    let lstatFinished!: () => void;
    const lstatReady = new Promise<void>((resolve) => {
      lstatFinished = resolve;
    });
    const timeoutState = makeCoordinator({
      backend: source as never,
      fileName: volume.fileName,
      isClosed: () => false,
      currentGeneration: () => currentGeneration,
      canRecapture: () => true,
      readinessTimeout: 1000,
      subscriptionsAvailable: true,
      terminal: () => undefined,
      awaitReady: (budget) =>
        Effect.sync(() => {
          if (admissions++ === 0) budget.remaining -= 400;
          return currentGeneration;
        }),
    });
    registerCoordinator(volume, timeoutState);
    source.afterLstat = lstatFinished;
    const retiring = new Promise<{ status: 'released' }>(() => {});
    timeoutState.subscriptionSetups.set(retiring, {
      generation: currentGeneration,
      closed: retiring,
      state: 'retiring',
    });
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const watching = yield* Effect.exit(Stream.runHead(OpfsFileSystem.make(volume).watch('/note.txt'))).pipe(
            Effect.forkChild,
          );
          yield* Effect.promise(() => lstatReady);
          yield* Effect.yieldNow;
          yield* TestClock.adjust(601);
          return yield* Fiber.join(watching);
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );
    const timeoutFailure = failureOf(exit);
    if (!PlatformError.isPlatformError(timeoutFailure)) throw new Error('retirement timeout was not a PlatformError');
    expect(timeoutFailure.reason._tag).toBe('TimedOut');
    if (!(timeoutFailure.reason.cause instanceof SubscriptionError))
      throw new Error('retirement timeout did not retain its SubscriptionError');
    expect(timeoutFailure.reason.cause.sourceCode).toBe('VFS_SUBSCRIPTION_RETIREMENT_TIMEOUT');
    expect(source.commands.filter((command) => command.type === 'register')).toHaveLength(0);
  });
});
