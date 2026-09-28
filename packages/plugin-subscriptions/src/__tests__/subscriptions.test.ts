import type { ChangeCommand, ChangeFrame, ChangeReply } from '@opfs-vfs/opfs-vfs/changes';
import { describe, expect, it } from 'vitest';
import { subscriptionsRequest } from '../config';
import { subscribe } from '../client';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const state = <T>(promise: Promise<T>) => Promise.race([promise, flush().then(() => 'pending' as const)]);

describe('subscriptions', () => {
  it('snapshots and validates subscription options before opening a channel', async () => {
    let opened = 0;
    const source = {
      openFileChangeChannel: async () => {
        opened++;
        throw new Error('must not open');
      },
    };
    await expect(
      subscribe(source, { path: '/', scope: 'directory', events: [], onError() {} }, () => {}),
    ).rejects.toMatchObject({ code: 'EINVAL' });
    await expect(subscribe(source, null as never, () => {})).rejects.toMatchObject({ code: 'EINVAL' });
    await expect(
      subscribe(source, { path: '/', scope: 'directory', content: null as never, onError() {} }, () => {}),
    ).rejects.toMatchObject({ code: 'EINVAL' });
    await expect(
      subscribe(
        source,
        { path: '/', scope: 'directory', content: { maxBytes: 1, [Symbol('extra')]: true } as never, onError() {} },
        () => {},
      ),
    ).rejects.toMatchObject({ code: 'EINVAL' });
    expect(opened).toBe(0);
    expect(() => subscriptionsRequest({ invalid: true } as never)).toThrow(/Subscriptions accept no configuration/);
  });

  it('sends valid content options to the owner', async () => {
    let registered: ChangeCommand | undefined;
    const source = {
      openFileChangeChannel: async () => ({
        generation: 'test',
        request(command: ChangeCommand): Promise<ChangeReply> {
          if (command.type === 'register') {
            registered = command;
            return Promise.resolve({ type: 'registered', subscriptionId: command.subscriptionId });
          }
          return Promise.resolve({ type: 'ok' });
        },
        close() {},
      }),
    };
    await expect(
      subscribe(source, { path: '/', scope: 'directory', content: { maxBytes: 1 }, onError() {} }, () => {}),
    ).resolves.toHaveProperty('unsubscribe');
    expect(registered).toMatchObject({ type: 'register', options: { content: { maxBytes: 1 } } });
  });

  it('rejects sparse events and nonempty configuration before opening a channel', async () => {
    let opened = 0;
    const source = {
      openFileChangeChannel: async () => {
        opened++;
        throw new Error('must not open');
      },
    };
    const sparse = new Array(1) as ('create' | 'update' | 'delete')[];
    await expect(
      subscribe(source, { path: '', scope: 'directory', events: sparse, onError() {} }, () => {}),
    ).rejects.toMatchObject({ code: 'EINVAL' });
    await expect(
      subscribe(source, { path: '/', scope: 'directory', signal: {} as AbortSignal, onError() {} }, () => {}),
    ).rejects.toMatchObject({ code: 'EINVAL' });
    expect(() => subscriptionsRequest([] as never)).toThrow(/Subscriptions accept no configuration/);
    expect(() => subscriptionsRequest({ [Symbol('unknown')]: true } as never)).toThrow(
      /Subscriptions accept no configuration/,
    );
    expect(opened).toBe(0);
  });

  it('reads subscription option getters once', async () => {
    const reads = { path: 0, maxBytes: 0, onError: 0, signal: 0 };
    const controller = new AbortController();
    const options = {
      get path() {
        reads.path++;
        return '/';
      },
      scope: 'directory' as const,
      get content() {
        return {
          get maxBytes() {
            reads.maxBytes++;
            return 1;
          },
        };
      },
      get onError() {
        reads.onError++;
        return () => {};
      },
      get signal() {
        reads.signal++;
        return controller.signal;
      },
    };
    await expect(
      subscribe(
        {
          openFileChangeChannel: async () => {
            throw new Error('must not open');
          },
        },
        options,
        () => {},
      ),
    ).rejects.toThrow('must not open');
    expect(reads).toEqual({ path: 1, maxBytes: 1, onError: 1, signal: 1 });
  });

  it('forgets a rejected channel opening so an explicit later subscribe can retry', async () => {
    let openings = 0;
    const source = {
      openFileChangeChannel: async () => {
        openings++;
        if (openings === 1) throw new Error('owner replaced');
        return {
          generation: 'retry',
          request(command: ChangeCommand): Promise<ChangeReply> {
            return Promise.resolve(
              command.type === 'register'
                ? { type: 'registered', subscriptionId: command.subscriptionId }
                : { type: 'ok' },
            );
          },
          close() {},
        };
      },
    };
    await expect(subscribe(source, { path: '/', scope: 'directory', onError() {} }, () => {})).rejects.toThrow(
      'owner replaced',
    );
    await expect(subscribe(source, { path: '/', scope: 'directory', onError() {} }, () => {})).resolves.toHaveProperty(
      'unsubscribe',
    );
    expect(openings).toBe(2);
  });

  it('keeps an established sibling alive when another registration is rejected', async () => {
    let receive!: (frame: ChangeFrame) => void;
    let registrations = 0;
    let firstId = '';
    let closed = 0;
    const source = {
      openFileChangeChannel: async (onFrame: (frame: ChangeFrame) => void) => {
        receive = onFrame;
        return {
          generation: 'test',
          request(command: ChangeCommand): Promise<ChangeReply> {
            if (command.type !== 'register') return Promise.resolve({ type: 'ok' });
            registrations++;
            if (registrations === 1) {
              firstId = command.subscriptionId;
              return Promise.resolve({ type: 'registered', subscriptionId: firstId });
            }
            return Promise.reject(Object.assign(new Error('subscription capacity exhausted'), { code: 'ENOSPC' }));
          },
          close() {
            closed++;
          },
        };
      },
    };
    const errors: string[] = [];
    let delivered!: () => void;
    const deliveredPromise = new Promise<void>((resolve) => (delivered = resolve));
    const first = await subscribe(
      source,
      { path: '/first', scope: 'file', onError: (cause) => errors.push(cause.code) },
      () => delivered(),
    );
    await expect(subscribe(source, { path: '/second', scope: 'file', onError() {} }, () => {})).rejects.toMatchObject({
      code: 'ENOSPC',
    });
    receive({
      type: 'event',
      subscriptionId: firstId,
      deliveryId: 1,
      change: {
        type: 'update',
        path: '/first',
        kind: 'file',
        cursor: { generation: 'test', sequence: 1 },
        content: { status: 'omitted', reason: 'disabled' },
      },
    });
    await deliveredPromise;
    expect(closed).toBe(0);
    expect(errors).toEqual([]);
    first.unsubscribe();
  });

  it('terminal setup races acknowledge retirement without replaying cancel', async () => {
    let receive!: (frame: ChangeFrame) => void;
    let subscriptionId = '';
    let resolveRegister!: () => void;
    const commands: ChangeCommand[] = [];
    const source = {
      openFileChangeChannel: async (onFrame: (frame: ChangeFrame) => void) => {
        receive = onFrame;
        return {
          generation: 'test',
          request(command: ChangeCommand): Promise<ChangeReply> {
            if (command.type === 'register') {
              subscriptionId = command.subscriptionId;
              return new Promise((resolve) => {
                resolveRegister = () => resolve({ type: 'registered', subscriptionId });
              });
            }
            commands.push(command);
            return Promise.resolve({ type: 'ok' });
          },
          close() {},
        };
      },
    };
    const pending = subscribe(source, { path: '/', scope: 'directory', onError() {} }, () => {});
    while (!subscriptionId) await new Promise((resolve) => setTimeout(resolve, 0));
    receive({ type: 'terminal', subscriptionId, code: 'SUBSCRIPTION_OVERFLOW' });
    resolveRegister();
    await expect(pending).rejects.toMatchObject({ code: 'SUBSCRIPTION_OVERFLOW' });
    expect(commands.map((command) => command.type)).toEqual(['terminal-ack']);
  });

  it('reports a terminal frame received after the register reply wins setup', async () => {
    let receive!: (frame: ChangeFrame) => void;
    let subscriptionId = '';
    let resolveRegister!: () => void;
    const source = {
      openFileChangeChannel: async (onFrame: (frame: ChangeFrame) => void) => {
        receive = onFrame;
        return {
          generation: 'test',
          request(command: ChangeCommand): Promise<ChangeReply> {
            if (command.type !== 'register') return Promise.resolve({ type: 'ok' });
            subscriptionId = command.subscriptionId;
            return new Promise((resolve) => {
              resolveRegister = () => resolve({ type: 'registered', subscriptionId });
            });
          },
          close() {},
        };
      },
    };
    const pending = subscribe(source, { path: '/', scope: 'directory', onError() {} }, () => {});
    while (!subscriptionId) await new Promise((resolve) => setTimeout(resolve, 0));
    resolveRegister();
    receive({ type: 'terminal', subscriptionId, code: 'SUBSCRIPTION_OVERFLOW' });
    await expect(pending).rejects.toMatchObject({ code: 'SUBSCRIPTION_OVERFLOW' });
  });

  it('calls listeners without an internal this value', async () => {
    let receive!: (frame: ChangeFrame) => void;
    let subscriptionId = '';
    const source = {
      openFileChangeChannel: async (onFrame: (frame: ChangeFrame) => void) => {
        receive = onFrame;
        return {
          generation: 'test',
          request(command: ChangeCommand): Promise<ChangeReply> {
            if (command.type === 'register') {
              subscriptionId = command.subscriptionId;
              return Promise.resolve({ type: 'registered', subscriptionId });
            }
            return Promise.resolve({ type: 'ok' });
          },
          close() {},
        };
      },
    };
    let unbound: boolean | undefined;
    const delivered = new Promise<void>((resolve) => {
      void subscribe(source, { path: '/', scope: 'directory', onError() {} }, function (this: undefined) {
        unbound = this === undefined;
        resolve();
      });
    });
    while (!subscriptionId) await new Promise((resolve) => setTimeout(resolve, 0));
    receive({
      type: 'event',
      subscriptionId,
      deliveryId: 1,
      change: {
        type: 'create',
        path: '/file',
        kind: 'file',
        cursor: { generation: 'test', sequence: 1 },
        content: { status: 'omitted', reason: 'disabled' },
      },
    });
    await delivered;
    expect(unbound).toBe(true);
  });

  it('sends one cancel while retiring, including registration races, then closes and reopens an empty shared channel', async () => {
    let receive!: (frame: ChangeFrame) => void;
    let subscriptionId = '';
    let registrations = 0;
    let resolveRegister!: () => void;
    let opens = 0;
    let closes = 0;
    const commands: ChangeCommand[] = [];
    const source = {
      openFileChangeChannel: async (onFrame: (frame: ChangeFrame) => void) => {
        opens++;
        receive = onFrame;
        return {
          generation: 'test',
          request(command: ChangeCommand): Promise<ChangeReply> {
            if (command.type === 'register') {
              subscriptionId = command.subscriptionId;
              registrations++;
              if (registrations > 1) {
                return new Promise((resolve) => {
                  resolveRegister = () => resolve({ type: 'registered', subscriptionId });
                });
              }
              return Promise.resolve({ type: 'registered', subscriptionId });
            }
            commands.push(command);
            return Promise.resolve({ type: 'ok' });
          },
          close() {
            closes++;
          },
        };
      },
    };
    const handle = await subscribe(source, { path: '/', scope: 'directory', onError() {} }, () => {});
    handle.unsubscribe();
    handle.unsubscribe();
    expect(commands.filter((command) => command.type === 'cancel')).toHaveLength(1);
    receive({ type: 'closed', subscriptionId });
    await handle.closed;
    expect(closes).toBe(1);
    const beforeReply = new AbortController();
    subscriptionId = '';
    const abortedBeforeReply = subscribe(
      source,
      { path: '/', scope: 'directory', signal: beforeReply.signal, onError() {} },
      () => {},
    );
    while (!subscriptionId) await new Promise((resolve) => setTimeout(resolve, 0));
    const beforeReplyId = subscriptionId;
    beforeReply.abort();
    resolveRegister();
    receive({ type: 'closed', subscriptionId: beforeReplyId });
    await expect(abortedBeforeReply).rejects.toMatchObject({ name: 'AbortError' });
    expect(
      commands.filter((command) => command.type === 'cancel' && command.subscriptionId === beforeReplyId),
    ).toHaveLength(1);

    const afterReply = new AbortController();
    subscriptionId = '';
    const abortedAfterReply = subscribe(
      source,
      { path: '/', scope: 'directory', signal: afterReply.signal, onError() {} },
      () => {},
    );
    while (!subscriptionId) await new Promise((resolve) => setTimeout(resolve, 0));
    const afterReplyId = subscriptionId;
    resolveRegister();
    afterReply.abort();
    receive({ type: 'closed', subscriptionId: afterReplyId });
    await expect(abortedAfterReply).rejects.toMatchObject({ name: 'AbortError' });
    expect(
      commands.filter((command) => command.type === 'cancel' && command.subscriptionId === afterReplyId),
    ).toHaveLength(1);
    // Each confirmed retirement leaves the shared channel unused, so the next setup reopens it.
    expect(opens).toBe(3);
  });

  it('drops an aborted setup after its registration is definitely rejected', async () => {
    let receive!: (frame: ChangeFrame) => void;
    let subscriptionId = '';
    let rejectRegister!: () => void;
    const commands: ChangeCommand[] = [];
    const source = {
      openFileChangeChannel: async (onFrame: (frame: ChangeFrame) => void) => {
        receive = onFrame;
        return {
          generation: 'test',
          request(command: ChangeCommand): Promise<ChangeReply> {
            if (command.type === 'register') {
              subscriptionId = command.subscriptionId;
              return new Promise((_resolve, reject) => {
                rejectRegister = () => reject(new Error('registration elided'));
              });
            }
            commands.push(command);
            return Promise.resolve({ type: 'ok' });
          },
          close() {},
        };
      },
    };
    const controller = new AbortController();
    const pending = subscribe(
      source,
      { path: '/', scope: 'directory', signal: controller.signal, onError() {} },
      () => {},
    );
    while (!subscriptionId) await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    rejectRegister();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    receive({ type: 'terminal', subscriptionId, code: 'SUBSCRIPTION_OVERFLOW' });
    expect(commands.map((command) => command.type)).toEqual(['cancel']);
  });

  it('silently retires unsubscribe but reports callback failure once before terminal acknowledgement', async () => {
    let receive!: (frame: ChangeFrame) => void;
    let subscriptionId = '';
    const commands: ChangeCommand[] = [];
    const source = {
      openFileChangeChannel: async (onFrame: (frame: ChangeFrame) => void) => {
        receive = onFrame;
        return {
          generation: 'test',
          request(command: ChangeCommand): Promise<ChangeReply> {
            if (command.type === 'register') {
              subscriptionId = command.subscriptionId;
              return Promise.resolve({ type: 'registered', subscriptionId });
            }
            commands.push(command);
            return Promise.resolve({ type: 'ok' });
          },
          close() {},
        };
      },
    };
    const reported: string[] = [];
    const handle = await subscribe(
      source,
      { path: '/', scope: 'directory', onError: (cause) => reported.push(cause.code) },
      () => {
        throw new Error('listener failure');
      },
    );
    handle.unsubscribe();
    receive({ type: 'terminal', subscriptionId, code: 'SUBSCRIPTION_INTERRUPTED' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reported).toEqual([]);

    const failed = await subscribe(
      source,
      { path: '/failed', scope: 'file', onError: (cause) => reported.push(cause.code) },
      () => {
        throw new Error('listener failure');
      },
    );
    const failureId = subscriptionId;
    receive({
      type: 'event',
      subscriptionId: failureId,
      deliveryId: 1,
      change: {
        type: 'update',
        path: '/failed',
        kind: 'file',
        cursor: { generation: 'test', sequence: 1 },
        content: { status: 'omitted', reason: 'disabled' },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    receive({ type: 'terminal', subscriptionId: failureId, code: 'SUBSCRIPTION_CALLBACK_FAILED' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    failed.unsubscribe();
    expect(reported).toEqual(['SUBSCRIPTION_CALLBACK_FAILED']);
    expect(commands.map((command) => command.type)).toContain('terminal-ack');
  });

  it('discards an interrupted channel so a fresh subscription opens a fresh channel', async () => {
    let interrupted!: (code: 'SUBSCRIPTION_INTERRUPTED') => void;
    let opens = 0;
    const source = {
      openFileChangeChannel: async (
        _receive: (frame: ChangeFrame) => void,
        onInterrupted: (code: 'SUBSCRIPTION_INTERRUPTED') => void,
      ) => {
        opens++;
        interrupted = onInterrupted;
        return {
          generation: `test-${opens}`,
          request(command: ChangeCommand): Promise<ChangeReply> {
            return Promise.resolve(
              command.type === 'register'
                ? { type: 'registered', subscriptionId: command.subscriptionId }
                : { type: 'ok' },
            );
          },
          close() {},
        };
      },
    };
    const errors: string[] = [];
    await subscribe(source, { path: '/', scope: 'directory', onError: (cause) => errors.push(cause.code) }, () => {});
    interrupted('SUBSCRIPTION_INTERRUPTED');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await subscribe(source, { path: '/', scope: 'directory', onError() {} }, () => {});
    expect(opens).toBe(2);
    expect(errors).toEqual(['SUBSCRIPTION_INTERRUPTED']);
  });

  it('withholds an acknowledgement while a listener is pending, without blocking another subscription', async () => {
    let receive!: (frame: ChangeFrame) => void;
    const commands: ChangeCommand[] = [];
    const registrations: string[] = [];
    const source = {
      openFileChangeChannel: async (onFrame: (frame: ChangeFrame) => void) => {
        receive = onFrame;
        return {
          generation: 'test',
          request(command: ChangeCommand): Promise<ChangeReply> {
            if (command.type === 'register') {
              registrations.push(command.subscriptionId);
              return Promise.resolve({ type: 'registered', subscriptionId: command.subscriptionId });
            }
            commands.push(command);
            return Promise.resolve({ type: 'ok' });
          },
          close() {},
        };
      },
    };
    let startFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => (startFirst = resolve));
    let settleFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => (settleFirst = resolve));
    let startSecond!: () => void;
    const secondStarted = new Promise<void>((resolve) => (startSecond = resolve));
    const first = await subscribe(source, { path: '/first', scope: 'file', onError() {} }, async () => {
      startFirst();
      await firstPending;
    });
    const second = await subscribe(source, { path: '/second', scope: 'file', onError() {} }, () => startSecond());
    receive({
      type: 'event',
      subscriptionId: registrations[0]!,
      deliveryId: 1,
      change: {
        type: 'update',
        path: '/first',
        kind: 'file',
        cursor: { generation: 'test', sequence: 1 },
        content: { status: 'omitted', reason: 'disabled' },
      },
    });
    await firstStarted;
    expect(commands.filter((command) => command.type === 'ack')).toHaveLength(0);
    receive({
      type: 'event',
      subscriptionId: registrations[1]!,
      deliveryId: 1,
      change: {
        type: 'update',
        path: '/second',
        kind: 'file',
        cursor: { generation: 'test', sequence: 2 },
        content: { status: 'omitted', reason: 'disabled' },
      },
    });
    await secondStarted;
    await Promise.resolve();
    expect(commands).toContainEqual({ type: 'ack', subscriptionId: registrations[1], deliveryId: 1 });
    receive({ type: 'terminal', subscriptionId: registrations[0]!, code: 'SUBSCRIPTION_INTERRUPTED' });
    expect(commands).toContainEqual({ type: 'terminal-ack', subscriptionId: registrations[0] });
    settleFirst();
    await Promise.resolve();
    expect(commands).not.toContainEqual({ type: 'ack', subscriptionId: registrations[0], deliveryId: 1 });
    first.unsubscribe();
    second.unsubscribe();
  });

  it('interrupts a live channel when a control request fails, while preserving silent cancellation', async () => {
    let receive!: (frame: ChangeFrame) => void;
    let firstId = '';
    let normalClose!: () => void;
    let closed = 0;
    let reported!: (value: string) => void;
    const errorReported = new Promise<string>((resolve) => (reported = resolve));
    const source = {
      openFileChangeChannel: async (
        onFrame: (frame: ChangeFrame) => void,
        _interrupted: (code: 'SUBSCRIPTION_INTERRUPTED' | 'SUBSCRIPTION_RESYNC_REQUIRED') => void,
        onClosed: () => void,
      ) => {
        receive = onFrame;
        normalClose = onClosed;
        return {
          generation: 'test',
          request(command: ChangeCommand): Promise<ChangeReply> {
            if (command.type === 'register') {
              if (!firstId) firstId = command.subscriptionId;
              return Promise.resolve({ type: 'registered', subscriptionId: command.subscriptionId });
            }
            if (command.type === 'ack') return Promise.reject(new Error('lost lane'));
            return Promise.resolve({ type: 'ok' });
          },
          close() {
            closed++;
          },
        };
      },
    };
    await subscribe(source, { path: '/', scope: 'directory', onError: (cause) => reported(cause.code) }, () => {});
    const cancelledErrors: string[] = [];
    const cancelled = await subscribe(
      source,
      { path: '/cancelled', scope: 'file', onError: (cause) => cancelledErrors.push(cause.code) },
      () => {},
    );
    cancelled.unsubscribe();
    receive({
      type: 'event',
      subscriptionId: firstId,
      deliveryId: 1,
      change: {
        type: 'update',
        path: '/file',
        kind: 'file',
        cursor: { generation: 'test', sequence: 1 },
        content: { status: 'omitted', reason: 'disabled' },
      },
    });
    await expect(errorReported).resolves.toBe('SUBSCRIPTION_INTERRUPTED');
    normalClose();
    expect(closed).toBe(1);
    expect(cancelledErrors).toEqual([]);
  });

  it('lets an aborted caller leave a shared opening while another caller completes it', async () => {
    let resolveOpen!: (channel: {
      generation: string;
      request(command: ChangeCommand): Promise<ChangeReply>;
      close(): void;
    }) => void;
    const source = {
      openFileChangeChannel: () =>
        new Promise<{ generation: string; request(command: ChangeCommand): Promise<ChangeReply>; close(): void }>(
          (resolve) => {
            resolveOpen = resolve;
          },
        ),
    };
    const controller = new AbortController();
    const aborted = subscribe(
      source,
      { path: '/', scope: 'directory', signal: controller.signal, onError() {} },
      () => {},
    );
    const other = subscribe(source, { path: '/', scope: 'directory', onError() {} }, () => {});
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    resolveOpen({
      generation: 'test',
      request(command) {
        return Promise.resolve(
          command.type === 'register' ? { type: 'registered', subscriptionId: command.subscriptionId } : { type: 'ok' },
        );
      },
      close() {},
    });
    await expect(other).resolves.toHaveProperty('unsubscribe');
  });

  it('keeps a channel open for a subscriber awaiting a cached context', async () => {
    let receive!: (frame: ChangeFrame) => void;
    let subscriptionId = '';
    let opens = 0;
    let closes = 0;
    const source = {
      openFileChangeChannel: async (onFrame: (frame: ChangeFrame) => void) => {
        opens++;
        receive = onFrame;
        return {
          generation: 'test',
          request(command: ChangeCommand): Promise<ChangeReply> {
            if (command.type === 'register') {
              subscriptionId = command.subscriptionId;
              return Promise.resolve({ type: 'registered', subscriptionId });
            }
            return Promise.resolve({ type: 'ok' });
          },
          close() {
            closes++;
          },
        };
      },
    };
    const first = await subscribe(source, { path: '/', scope: 'directory', onError() {} }, () => {});
    const firstId = subscriptionId;
    first.unsubscribe();
    const second = subscribe(source, { path: '/', scope: 'directory', onError() {} }, () => {});
    receive({ type: 'closed', subscriptionId: firstId });
    const handle = await second;
    expect(opens).toBe(1);
    expect(closes).toBe(0);
    handle.unsubscribe();
  });

  it('closes an opening abandoned by every waiting subscriber', async () => {
    let resolveOpen!: (channel: {
      generation: string;
      request(command: ChangeCommand): Promise<ChangeReply>;
      close(): void;
    }) => void;
    let opens = 0;
    let closes = 0;
    const source = {
      openFileChangeChannel: () => {
        opens++;
        if (opens === 1)
          return new Promise<{
            generation: string;
            request(command: ChangeCommand): Promise<ChangeReply>;
            close(): void;
          }>((resolve) => {
            resolveOpen = resolve;
          });
        return Promise.resolve({
          generation: 'fresh',
          request(command: ChangeCommand): Promise<ChangeReply> {
            return Promise.resolve(
              command.type === 'register'
                ? { type: 'registered', subscriptionId: command.subscriptionId }
                : { type: 'ok' },
            );
          },
          close() {
            closes++;
          },
        });
      },
    };
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = subscribe(
      source,
      { path: '/', scope: 'directory', signal: firstController.signal, onError() {} },
      () => {},
    );
    const second = subscribe(
      source,
      { path: '/', scope: 'directory', signal: secondController.signal, onError() {} },
      () => {},
    );
    firstController.abort();
    secondController.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    resolveOpen({
      generation: 'abandoned',
      request: () => Promise.resolve({ type: 'ok' }),
      close() {
        closes++;
      },
    });
    await Promise.resolve();
    expect(closes).toBe(1);
    await expect(subscribe(source, { path: '/', scope: 'directory', onError() {} }, () => {})).resolves.toHaveProperty(
      'unsubscribe',
    );
    expect(opens).toBe(2);
  });

  it('rejects a pending registration on normal close and silently releases an established subscription', async () => {
    let closePending!: () => void;
    let rejectRegistration!: (cause: Error) => void;
    let registrationStarted!: () => void;
    const registrationStartedPromise = new Promise<void>((resolve) => (registrationStarted = resolve));
    const pendingSource = {
      openFileChangeChannel: async (
        _receive: (frame: ChangeFrame) => void,
        _interrupted: (code: 'SUBSCRIPTION_INTERRUPTED' | 'SUBSCRIPTION_RESYNC_REQUIRED') => void,
        closed: () => void,
      ) => {
        closePending = closed;
        return {
          generation: 'test',
          request(command: ChangeCommand): Promise<ChangeReply> {
            if (command.type === 'register')
              return new Promise((_resolve, reject) => {
                rejectRegistration = reject;
                registrationStarted();
              });
            return Promise.resolve({ type: 'ok' });
          },
          close() {},
        };
      },
    };
    const pending = subscribe(pendingSource, { path: '/', scope: 'directory', onError() {} }, () => {});
    await registrationStartedPromise;
    closePending();
    await expect(pending).rejects.toMatchObject({ code: 'EBADF' });
    rejectRegistration(new Error('late rejection'));

    let closeEstablished!: () => void;
    const commands: ChangeCommand[] = [];
    const errors: string[] = [];
    const establishedSource = {
      openFileChangeChannel: async (
        _receive: (frame: ChangeFrame) => void,
        _interrupted: (code: 'SUBSCRIPTION_INTERRUPTED' | 'SUBSCRIPTION_RESYNC_REQUIRED') => void,
        closed: () => void,
      ) => {
        closeEstablished = closed;
        return {
          generation: 'test',
          request(command: ChangeCommand): Promise<ChangeReply> {
            if (command.type === 'register')
              return Promise.resolve({ type: 'registered', subscriptionId: command.subscriptionId });
            commands.push(command);
            return Promise.resolve({ type: 'ok' });
          },
          close() {},
        };
      },
    };
    const controller = new AbortController();
    await subscribe(
      establishedSource,
      { path: '/', scope: 'directory', signal: controller.signal, onError: (cause) => errors.push(cause.code) },
      () => {},
    );
    closeEstablished();
    controller.abort();
    await Promise.resolve();
    expect(errors).toEqual([]);
    expect(commands.filter((command) => command.type === 'cancel')).toHaveLength(0);
  });

  it('waits for terminal acknowledgement before releasing and closing an unused channel', async () => {
    let receive!: (frame: ChangeFrame) => void;
    let id = '';
    let resolveAck!: () => void;
    let closes = 0;
    const commands: ChangeCommand[] = [];
    const source = {
      openFileChangeChannel: async (onFrame: (frame: ChangeFrame) => void) => {
        receive = onFrame;
        return {
          generation: 'test',
          request(command: ChangeCommand): Promise<ChangeReply> {
            if (command.type === 'register') {
              id = command.subscriptionId;
              return Promise.resolve({ type: 'registered', subscriptionId: id });
            }
            commands.push(command);
            if (command.type === 'terminal-ack')
              return new Promise((resolve) => (resolveAck = () => resolve({ type: 'ok' })));
            return Promise.resolve({ type: 'ok' });
          },
          close() {
            closes++;
          },
        };
      },
    };
    const subscription = await subscribe(source, { path: '/', scope: 'directory', onError() {} }, () => {});
    subscription.unsubscribe();
    await flush();
    expect(await state(subscription.closed)).toBe('pending');
    expect(closes).toBe(0);
    receive({ type: 'closed', subscriptionId: id });
    expect(commands.filter((command) => command.type === 'terminal-ack')).toHaveLength(1);
    expect(await state(subscription.closed)).toBe('pending');
    expect(closes).toBe(0);
    resolveAck();
    await expect(subscription.closed).resolves.toEqual({ status: 'released' });
    expect(closes).toBe(1);
  });

  it('does not release while a cancel acknowledgement is held', async () => {
    let receive!: (frame: ChangeFrame) => void;
    let id = '';
    let resolveCancel!: () => void;
    let resolveAck!: () => void;
    const source = {
      openFileChangeChannel: async (onFrame: (frame: ChangeFrame) => void) => {
        receive = onFrame;
        return {
          generation: 'test',
          request(command: ChangeCommand): Promise<ChangeReply> {
            if (command.type === 'register') {
              id = command.subscriptionId;
              return Promise.resolve({ type: 'registered', subscriptionId: id });
            }
            if (command.type === 'cancel')
              return new Promise((resolve) => (resolveCancel = () => resolve({ type: 'ok' })));
            if (command.type === 'terminal-ack')
              return new Promise((resolve) => (resolveAck = () => resolve({ type: 'ok' })));
            return Promise.resolve({ type: 'ok' });
          },
          close() {},
        };
      },
    };
    const subscription = await subscribe(source, { path: '/', scope: 'directory', onError() {} }, () => {});
    subscription.unsubscribe();
    expect(await state(subscription.closed)).toBe('pending');
    resolveCancel();
    receive({ type: 'closed', subscriptionId: id });
    expect(await state(subscription.closed)).toBe('pending');
    resolveAck();
    await expect(subscription.closed).resolves.toEqual({ status: 'released' });
  });

  it('settles every handle unknown when terminal acknowledgement fails without an unhandled rejection', async () => {
    let receive!: (frame: ChangeFrame) => void;
    const ids: string[] = [];
    const lost = new Error('lost acknowledgement');
    const unhandled: PromiseRejectionEvent[] = [];
    const onUnhandled = (event: PromiseRejectionEvent) => unhandled.push(event);
    window.addEventListener('unhandledrejection', onUnhandled);
    try {
      const source = {
        openFileChangeChannel: async (onFrame: (frame: ChangeFrame) => void) => {
          receive = onFrame;
          return {
            generation: 'test',
            request(command: ChangeCommand): Promise<ChangeReply> {
              if (command.type === 'register') {
                ids.push(command.subscriptionId);
                return Promise.resolve({ type: 'registered', subscriptionId: command.subscriptionId });
              }
              if (command.type === 'terminal-ack') return Promise.reject(lost);
              return Promise.resolve({ type: 'ok' });
            },
            close() {},
          };
        },
      };
      const first = await subscribe(source, { path: '/first', scope: 'file', onError() {} }, () => {});
      const second = await subscribe(source, { path: '/second', scope: 'file', onError() {} }, () => {});
      receive({ type: 'closed', subscriptionId: ids[0]! });
      await expect(first.closed).resolves.toMatchObject({
        status: 'unknown',
        error: { code: 'SUBSCRIPTION_INTERRUPTED', cause: lost },
      });
      await expect(second.closed).resolves.toMatchObject({
        status: 'unknown',
        error: { code: 'SUBSCRIPTION_INTERRUPTED' },
      });
      await flush();
      expect(unhandled).toEqual([]);
    } finally {
      window.removeEventListener('unhandledrejection', onUnhandled);
    }
  });

  it('uses an interrupted channel code when a terminal acknowledgement is lost', async () => {
    let receive!: (frame: ChangeFrame) => void;
    let interrupted!: (code: 'SUBSCRIPTION_INTERRUPTED' | 'SUBSCRIPTION_RESYNC_REQUIRED') => void;
    let id = '';
    const source = {
      openFileChangeChannel: async (
        onFrame: (frame: ChangeFrame) => void,
        onInterrupted: (code: 'SUBSCRIPTION_INTERRUPTED' | 'SUBSCRIPTION_RESYNC_REQUIRED') => void,
      ) => {
        receive = onFrame;
        interrupted = onInterrupted;
        return {
          generation: 'test',
          request(command: ChangeCommand): Promise<ChangeReply> {
            if (command.type === 'register') {
              id = command.subscriptionId;
              return Promise.resolve({ type: 'registered', subscriptionId: id });
            }
            if (command.type === 'terminal-ack') return new Promise(() => {});
            return Promise.resolve({ type: 'ok' });
          },
          close() {},
        };
      },
    };
    const subscription = await subscribe(source, { path: '/', scope: 'directory', onError() {} }, () => {});
    receive({ type: 'closed', subscriptionId: id });
    interrupted('SUBSCRIPTION_RESYNC_REQUIRED');
    await expect(subscription.closed).resolves.toMatchObject({
      status: 'unknown',
      error: { code: 'SUBSCRIPTION_RESYNC_REQUIRED' },
    });
  });

  it('releases active and retiring handles when the owner generation ends', async () => {
    let receive!: (frame: ChangeFrame) => void;
    let closed!: () => void;
    let rejectRegistration!: (cause: Error) => void;
    const ids: string[] = [];
    const source = {
      openFileChangeChannel: async (
        onFrame: (frame: ChangeFrame) => void,
        _interrupted: (code: 'SUBSCRIPTION_INTERRUPTED' | 'SUBSCRIPTION_RESYNC_REQUIRED') => void,
        onClosed: () => void,
      ) => {
        receive = onFrame;
        closed = onClosed;
        return {
          generation: 'test',
          request(command: ChangeCommand): Promise<ChangeReply> {
            if (command.type === 'register') {
              ids.push(command.subscriptionId);
              if (ids.length === 3) return new Promise((_resolve, reject) => (rejectRegistration = reject));
              return Promise.resolve({ type: 'registered', subscriptionId: command.subscriptionId });
            }
            if (command.type === 'terminal-ack') return new Promise(() => {});
            return Promise.resolve({ type: 'ok' });
          },
          close() {},
        };
      },
    };
    const active = await subscribe(source, { path: '/active', scope: 'file', onError() {} }, () => {});
    const retiring = await subscribe(source, { path: '/retiring', scope: 'file', onError() {} }, () => {});
    receive({ type: 'closed', subscriptionId: ids[1]! });
    const pending = subscribe(source, { path: '/pending', scope: 'file', onError() {} }, () => {});
    while (ids.length < 3) await flush();
    closed();
    await expect(active.closed).resolves.toEqual({ status: 'released' });
    await expect(retiring.closed).resolves.toEqual({ status: 'released' });
    await expect(pending).rejects.toMatchObject({ code: 'EBADF' });
    rejectRegistration(new Error('late'));
  });

  it('reports terminal frames and releases only after terminal acknowledgement', async () => {
    let receive!: (frame: ChangeFrame) => void;
    let id = '';
    let resolveAck!: () => void;
    const reported: string[] = [];
    const commands: ChangeCommand[] = [];
    let closes = 0;
    const source = {
      openFileChangeChannel: async (onFrame: (frame: ChangeFrame) => void) => {
        receive = onFrame;
        return {
          generation: 'test',
          request(command: ChangeCommand): Promise<ChangeReply> {
            if (command.type === 'register') {
              id = command.subscriptionId;
              return Promise.resolve({ type: 'registered', subscriptionId: id });
            }
            commands.push(command);
            if (command.type === 'terminal-ack')
              return new Promise((resolve) => (resolveAck = () => resolve({ type: 'ok' })));
            return Promise.resolve({ type: 'ok' });
          },
          close() {
            closes++;
          },
        };
      },
    };
    const subscription = await subscribe(
      source,
      { path: '/', scope: 'directory', onError: (cause) => reported.push(cause.code) },
      () => {},
    );
    receive({ type: 'terminal', subscriptionId: id, code: 'SUBSCRIPTION_OVERFLOW' });
    await flush();
    expect(reported).toEqual(['SUBSCRIPTION_OVERFLOW']);
    subscription.unsubscribe();
    expect(commands.filter((command) => command.type === 'cancel')).toHaveLength(0);
    expect(await state(subscription.closed)).toBe('pending');
    expect(closes).toBe(0);
    resolveAck();
    await expect(subscription.closed).resolves.toEqual({ status: 'released' });
    expect(closes).toBe(1);
  });

  it('marks callback failure retired only after closed and terminal acknowledgement', async () => {
    let receive!: (frame: ChangeFrame) => void;
    let id = '';
    let resolveAck!: () => void;
    const source = {
      openFileChangeChannel: async (onFrame: (frame: ChangeFrame) => void) => {
        receive = onFrame;
        return {
          generation: 'test',
          request(command: ChangeCommand): Promise<ChangeReply> {
            if (command.type === 'register') {
              id = command.subscriptionId;
              return Promise.resolve({ type: 'registered', subscriptionId: id });
            }
            if (command.type === 'terminal-ack')
              return new Promise((resolve) => (resolveAck = () => resolve({ type: 'ok' })));
            return Promise.resolve({ type: 'ok' });
          },
          close() {},
        };
      },
    };
    const subscription = await subscribe(source, { path: '/', scope: 'directory', onError() {} }, () => {
      throw new Error('callback');
    });
    receive({
      type: 'event',
      subscriptionId: id,
      deliveryId: 1,
      change: {
        type: 'update',
        path: '/file',
        kind: 'file',
        cursor: { generation: 'test', sequence: 1 },
        content: { status: 'omitted', reason: 'disabled' },
      },
    });
    await flush();
    receive({ type: 'closed', subscriptionId: id });
    expect(await state(subscription.closed)).toBe('pending');
    resolveAck();
    await expect(subscription.closed).resolves.toEqual({ status: 'released' });
  });

  it('settles deferred activation failures as unknown', async () => {
    const errors: string[] = [];
    const source = {
      openFileChangeChannel: async () => ({
        generation: 'test',
        request(command: ChangeCommand): Promise<ChangeReply> {
          if (command.type === 'register')
            return Promise.resolve({ type: 'registered', subscriptionId: command.subscriptionId });
          if (command.type === 'activate') return Promise.reject(new Error('activation lost'));
          return Promise.resolve({ type: 'ok' });
        },
        close() {},
      }),
    };
    const subscription = await subscribe(
      source,
      { path: '/', scope: 'directory', onError: (cause) => errors.push(cause.code) },
      () => {},
    );
    await expect(subscription.closed).resolves.toMatchObject({
      status: 'unknown',
      error: { code: 'SUBSCRIPTION_INTERRUPTED' },
    });
    await flush();
    expect(errors).toEqual(['SUBSCRIPTION_INTERRUPTED']);
  });

  it('serializes setup cleanup before registering the next subscription', async () => {
    let receive!: (frame: ChangeFrame) => void;
    let firstId = '';
    let resolveRegister!: () => void;
    let resolveAck!: () => void;
    let registrations = 0;
    const source = {
      openFileChangeChannel: async (onFrame: (frame: ChangeFrame) => void) => {
        receive = onFrame;
        return {
          generation: 'test',
          request(command: ChangeCommand): Promise<ChangeReply> {
            if (command.type === 'register') {
              registrations++;
              if (registrations === 1) {
                firstId = command.subscriptionId;
                return new Promise(
                  (resolve) => (resolveRegister = () => resolve({ type: 'registered', subscriptionId: firstId })),
                );
              }
              return Promise.resolve({ type: 'registered', subscriptionId: command.subscriptionId });
            }
            if (command.type === 'terminal-ack')
              return new Promise((resolve) => (resolveAck = () => resolve({ type: 'ok' })));
            return Promise.resolve({ type: 'ok' });
          },
          close() {},
        };
      },
    };
    const first = subscribe(source, { path: '/', scope: 'directory', onError() {} }, () => {});
    while (!firstId) await flush();
    receive({ type: 'terminal', subscriptionId: firstId, code: 'SUBSCRIPTION_OVERFLOW' });
    resolveRegister();
    await expect(first).rejects.toMatchObject({ code: 'SUBSCRIPTION_OVERFLOW' });
    const second = subscribe(source, { path: '/second', scope: 'file', onError() {} }, () => {});
    await flush();
    expect(registrations).toBe(1);
    resolveAck();
    await expect(second).resolves.toHaveProperty('closed');
    expect(registrations).toBe(2);
  });

  it('blocks same-generation setup after unknown retirement but permits a new generation', async () => {
    let interrupted!: (code: 'SUBSCRIPTION_INTERRUPTED' | 'SUBSCRIPTION_RESYNC_REQUIRED') => void;
    let generation = 'same';
    let registrations = 0;
    const source = {
      openFileChangeChannel: async (
        _receive: (frame: ChangeFrame) => void,
        onInterrupted: (code: 'SUBSCRIPTION_INTERRUPTED' | 'SUBSCRIPTION_RESYNC_REQUIRED') => void,
      ) => {
        interrupted = onInterrupted;
        return {
          generation,
          request(command: ChangeCommand): Promise<ChangeReply> {
            if (command.type === 'register') {
              registrations++;
              if (generation === 'new')
                return Promise.resolve({ type: 'registered', subscriptionId: command.subscriptionId });
              return new Promise(() => {});
            }
            return Promise.resolve({ type: 'ok' });
          },
          close() {},
        };
      },
    };
    const first = subscribe(source, { path: '/', scope: 'directory', onError() {} }, () => {});
    await flush();
    interrupted('SUBSCRIPTION_INTERRUPTED');
    await expect(first).rejects.toMatchObject({ code: 'SUBSCRIPTION_INTERRUPTED' });
    await expect(subscribe(source, { path: '/', scope: 'directory', onError() {} }, () => {})).rejects.toMatchObject({
      code: 'SUBSCRIPTION_RETIREMENT_UNKNOWN',
      cause: { code: 'SUBSCRIPTION_INTERRUPTED' },
    });
    expect(registrations).toBe(1);
    generation = 'new';
    await expect(subscribe(source, { path: '/', scope: 'directory', onError() {} }, () => {})).resolves.toHaveProperty(
      'unsubscribe',
    );
    expect(registrations).toBe(2);
  });

  it('does not block a later registration after owner rejection', async () => {
    let registrations = 0;
    const commands: ChangeCommand[] = [];
    const source = {
      openFileChangeChannel: async () => ({
        generation: 'test',
        request(command: ChangeCommand): Promise<ChangeReply> {
          if (command.type === 'register') {
            registrations++;
            if (registrations === 1) return Promise.reject(Object.assign(new Error('full'), { code: 'ENOSPC' }));
            return Promise.resolve({ type: 'registered', subscriptionId: command.subscriptionId });
          }
          commands.push(command);
          return Promise.resolve({ type: 'ok' });
        },
        close() {},
      }),
    };
    await expect(subscribe(source, { path: '/', scope: 'directory', onError() {} }, () => {})).rejects.toMatchObject({
      code: 'ENOSPC',
    });
    await expect(subscribe(source, { path: '/', scope: 'directory', onError() {} }, () => {})).resolves.toHaveProperty(
      'unsubscribe',
    );
    expect(commands).toEqual([]);
  });

  it('aborts promptly while setup cleanup blocks registration', async () => {
    let receive!: (frame: ChangeFrame) => void;
    let id = '';
    let resolveRegister!: () => void;
    let resolveAck!: () => void;
    let registrations = 0;
    const source = {
      openFileChangeChannel: async (onFrame: (frame: ChangeFrame) => void) => {
        receive = onFrame;
        return {
          generation: 'test',
          request(command: ChangeCommand): Promise<ChangeReply> {
            if (command.type === 'register') {
              registrations++;
              id = command.subscriptionId;
              if (registrations === 1)
                return new Promise(
                  (resolve) => (resolveRegister = () => resolve({ type: 'registered', subscriptionId: id })),
                );
              return Promise.resolve({ type: 'registered', subscriptionId: id });
            }
            if (command.type === 'terminal-ack')
              return new Promise((resolve) => (resolveAck = () => resolve({ type: 'ok' })));
            return Promise.resolve({ type: 'ok' });
          },
          close() {},
        };
      },
    };
    const first = subscribe(source, { path: '/', scope: 'directory', onError() {} }, () => {});
    while (!id) await flush();
    receive({ type: 'terminal', subscriptionId: id, code: 'SUBSCRIPTION_OVERFLOW' });
    resolveRegister();
    await expect(first).rejects.toMatchObject({ code: 'SUBSCRIPTION_OVERFLOW' });
    const controller = new AbortController();
    const waiting = subscribe(
      source,
      { path: '/', scope: 'directory', signal: controller.signal, onError() {} },
      () => {},
    );
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(registrations).toBe(1);
    resolveAck();
  });

  it('returns a frozen handle with synchronous idempotent unsubscribe and a stable closed promise', async () => {
    let id = '';
    const commands: ChangeCommand[] = [];
    const source = {
      openFileChangeChannel: async () => ({
        generation: 'test',
        request(command: ChangeCommand): Promise<ChangeReply> {
          if (command.type === 'register') {
            id = command.subscriptionId;
            return Promise.resolve({ type: 'registered', subscriptionId: id });
          }
          commands.push(command);
          return Promise.resolve({ type: 'ok' });
        },
        close() {},
      }),
    };
    const subscription = await subscribe(source, { path: '/', scope: 'directory', onError() {} }, () => {});
    const closed = subscription.closed;
    expect(Object.isFrozen(subscription)).toBe(true);
    subscription.unsubscribe();
    subscription.unsubscribe();
    expect(subscription.closed).toBe(closed);
    expect(commands.filter((command) => command.type === 'cancel')).toHaveLength(1);
  });

  it('delivers held metadata after the handle resolves', async () => {
    const worker = new Worker(new URL('./subscription-worker.ts', import.meta.url), { type: 'module' });
    try {
      const result = await new Promise<{ seen?: string[]; error?: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('subscription worker timed out')), 30000);
        worker.onmessage = ({ data }) => {
          clearTimeout(timer);
          resolve(data);
        };
        worker.onerror = (event) => {
          clearTimeout(timer);
          reject(new Error(event.message));
        };
        worker.postMessage({});
      });
      expect(result.error).toBeUndefined();
      expect(result.seen).toEqual(['create:/created.txt:omitted']);
    } finally {
      worker.terminate();
    }
  }, 60000);
});
