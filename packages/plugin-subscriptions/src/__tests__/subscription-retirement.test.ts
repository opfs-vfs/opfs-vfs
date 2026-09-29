import type {
  ChangeClient,
  ChangeCommand,
  ChangeFrame,
  ChangeReply,
  FileChangeChannel,
  FileChangeSource,
  WireSubscribeOptions,
} from '@opfs-vfs/opfs-vfs/changes';
import { deleteVolume } from '@opfs-vfs/opfs-vfs';
import { OpfsVfsWorker } from '@opfs-vfs/opfs-vfs/worker';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { subscribe, type SubscribeOptions, type Subscription, type SubscriptionRetirement } from '../client';
import { subscriptionsRequest } from '../config';
import { subscriptions } from '../owner';

const wire: WireSubscribeOptions = {
  path: '/',
  scope: 'directory',
  recursive: true,
  events: ['create', 'update', 'delete'],
  content: false,
};
const options: SubscribeOptions = {
  path: '/',
  scope: 'directory',
  recursive: true,
  events: ['create', 'update', 'delete'],
  content: false,
  onError() {},
};
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const settled = <T>(promise: Promise<T>) => Promise.race([promise, flush().then(() => 'pending' as const)]);
const coded = (code: string) => Object.assign(new Error(code), { code });
const worker = () => new Worker(new URL('./subscription-registration-worker.ts', import.meta.url), { type: 'module' });

type Channel = {
  client: ChangeClient;
  receive: (frame: ChangeFrame) => void;
  interrupted: (code: 'SUBSCRIPTION_INTERRUPTED' | 'SUBSCRIPTION_RESYNC_REQUIRED') => void;
  closed: () => void;
  isClosed: boolean;
  clientClosed: boolean;
};
type Held = {
  channel: Channel;
  command: ChangeCommand;
  resolve: (reply: ChangeReply) => void;
  reject: (cause: unknown) => void;
};

class OwnerHarness {
  generation = crypto.randomUUID();
  validateTarget: (target: Pick<WireSubscribeOptions, 'path' | 'scope' | 'recursive'>) => void = () => {};
  readonly channels = new Map<string, Channel>();
  readonly closes: ChangeClient[] = [];
  session = this.createSession();
  private ended = false;
  private channelNumber = 0;

  source(clientId: string): HarnessSource {
    return new HarnessSource(this, clientId);
  }

  clientCount(clientId: string): number {
    let successes = 0;
    const client = { clientId, channelId: `probe-${crypto.randomUUID()}`, route: 'local' as const };
    try {
      for (; successes < 32; successes++)
        this.session.control(client, { type: 'register', subscriptionId: crypto.randomUUID(), options: wire });
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOSPC') throw error;
    } finally {
      this.session.clientClosed(client);
    }
    return 32 - successes;
  }

  mountCount(): number {
    let successes = 0;
    const clients: ChangeClient[] = [];
    try {
      for (let index = 0; index < 128; index++) {
        const client = { clientId: `probe-client-${index}`, channelId: `probe-${index}`, route: 'local' as const };
        clients.push(client);
        this.session.control(client, { type: 'register', subscriptionId: crypto.randomUUID(), options: wire });
        successes++;
      }
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOSPC') throw error;
    } finally {
      for (const client of clients) this.session.clientClosed(client);
    }
    return 128 - successes;
  }

  nextGeneration(): void {
    const open = [...this.channels.values()].filter((channel) => !channel.isClosed);
    for (const channel of open) channel.isClosed = true;
    this.session.close('replacement');
    for (const channel of open) queueMicrotask(() => channel.interrupted('SUBSCRIPTION_INTERRUPTED'));
    this.generation = crypto.randomUUID();
    this.session = this.createSession();
  }

  endGeneration(): void {
    if (this.ended) return;
    this.ended = true;
    for (const channel of this.channels.values()) channel.isClosed = true;
    this.session.close('close');
    for (const channel of this.channels.values()) queueMicrotask(channel.closed);
  }

  interrupt(channel: Channel, code: 'SUBSCRIPTION_INTERRUPTED' | 'SUBSCRIPTION_RESYNC_REQUIRED'): void {
    if (channel.isClosed) return;
    channel.isClosed = true;
    channel.interrupted(code);
  }

  open(
    clientId: string,
    receive: Channel['receive'],
    interrupted: Channel['interrupted'],
    closed: Channel['closed'],
  ): Channel {
    if (this.ended) throw coded('EBADF');
    const channel: Channel = {
      client: { clientId, channelId: `channel-${++this.channelNumber}`, route: 'local' },
      receive,
      interrupted,
      closed,
      isClosed: false,
      clientClosed: false,
    };
    this.channels.set(channel.client.channelId, channel);
    return channel;
  }

  close(channel: Channel): void {
    if (channel.clientClosed) return;
    channel.isClosed = true;
    channel.clientClosed = true;
    this.closes.push(channel.client);
    this.session.clientClosed(channel.client);
  }

  private createSession() {
    return subscriptions().logicalChanges!.create({
      generation: this.generation,
      validateTarget: (target) => this.validateTarget(target),
      send: (client, frame) => {
        queueMicrotask(() => {
          const channel = this.channels.get(client.channelId);
          if (channel && !channel.isClosed) channel.receive(frame);
        });
      },
    });
  }
}

class HarnessSource implements FileChangeSource {
  readonly commands: ChangeCommand[] = [];
  onRequest?: (command: ChangeCommand) => void;
  private readonly interceptors = new Map<
    ChangeCommand['type'],
    { kind: 'hold'; held: Held[] } | { kind: 'reject'; error: unknown } | { kind: 'drop' }
  >();
  private readonly synchronousFailures = new Map<ChangeCommand['type'], unknown>();
  private current?: Channel;

  constructor(
    private readonly harness: OwnerHarness,
    private readonly clientId: string,
  ) {}

  hold(type: ChangeCommand['type']): () => void {
    const held: Held[] = [];
    this.interceptors.set(type, { kind: 'hold', held });
    return () => {
      if (this.interceptors.get(type)?.kind === 'hold') this.interceptors.delete(type);
      for (const item of held) {
        if (item.channel.isClosed) {
          setTimeout(() => item.reject(coded('EBADF')), 0);
          continue;
        }
        try {
          const reply = this.harness.session.control(item.channel.client, item.command);
          setTimeout(() => item.resolve(reply), 0);
        } catch (error) {
          setTimeout(() => item.reject(error), 0);
        }
      }
    };
  }

  reject(type: ChangeCommand['type'], error: unknown): void {
    this.interceptors.set(type, { kind: 'reject', error });
  }

  drop(type: ChangeCommand['type']): void {
    this.interceptors.set(type, { kind: 'drop' });
  }

  throwSynchronously(type: ChangeCommand['type'], cause: unknown): void {
    this.synchronousFailures.set(type, cause);
  }

  interrupt(code: 'SUBSCRIPTION_INTERRUPTED' | 'SUBSCRIPTION_RESYNC_REQUIRED'): void {
    if (this.current) this.harness.interrupt(this.current, code);
  }

  openFileChangeChannel(
    receive: Channel['receive'],
    interrupted: Channel['interrupted'],
    closed: Channel['closed'],
  ): Promise<FileChangeChannel> {
    const channel = (this.current = this.harness.open(this.clientId, receive, interrupted, closed));
    return Promise.resolve({
      generation: this.harness.generation,
      request: (command) => {
        const synchronousFailure = this.synchronousFailures.get(command.type);
        if (synchronousFailure !== undefined) {
          this.synchronousFailures.delete(command.type);
          this.commands.push(command);
          throw synchronousFailure;
        }
        this.onRequest?.(command);
        return Promise.resolve().then(() => {
          if (channel.isClosed) throw coded('EBADF');
          this.commands.push(command);
          const interceptor = this.interceptors.get(command.type);
          if (interceptor?.kind === 'hold')
            return new Promise<ChangeReply>((resolve, reject) =>
              interceptor.held.push({ channel, command, resolve, reject }),
            );
          if (interceptor?.kind === 'reject') throw interceptor.error;
          if (interceptor?.kind === 'drop') return new Promise<ChangeReply>(() => {});
          return this.harness.session.control(channel.client, command);
        });
      },
      close: () => this.harness.close(channel),
    });
  }
}

let harness: OwnerHarness;
let unhandled: PromiseRejectionEvent[];
let onUnhandled: (event: PromiseRejectionEvent) => void;

beforeEach(() => {
  harness = new OwnerHarness();
  unhandled = [];
  onUnhandled = (event) => {
    event.preventDefault();
    unhandled.push(event);
  };
  window.addEventListener('unhandledrejection', onUnhandled);
});

afterEach(async () => {
  harness.endGeneration();
  await flush();
  window.removeEventListener('unhandledrejection', onUnhandled);
  expect(unhandled).toEqual([]);
});

describe('acknowledged subscription retirement', () => {
  it('keeps all 32 client reservations until held terminal acknowledgements settle', async () => {
    const source = harness.source('client');
    const release = source.hold('terminal-ack');
    const handles = await Promise.all(Array.from({ length: 32 }, () => subscribe(source, options, () => {})));
    expect(harness.clientCount('client')).toBe(32);
    handles.forEach((handle) => handle.unsubscribe());
    await flush();
    expect(await Promise.all(handles.map((handle) => settled(handle.closed)))).toEqual(Array(32).fill('pending'));
    expect(harness.clientCount('client')).toBe(32);
    await expect(subscribe(source, options, () => {})).rejects.toMatchObject({ code: 'ENOSPC' });
    release();
    await expect(Promise.all(handles.map((handle) => handle.closed))).resolves.toEqual(
      Array(32).fill({ status: 'released' }),
    );
    expect(harness.clientCount('client')).toBe(0);
    const replacements = Array.from({ length: 32 }, () => subscribe(source, options, () => {}));
    await expect(Promise.all(replacements)).resolves.toHaveLength(32);
  });

  it('reports lost terminal acknowledgements as unknown, never released', async () => {
    const dropped = harness.source('dropped');
    const droppedHandle = await subscribe(dropped, options, () => {});
    dropped.drop('terminal-ack');
    droppedHandle.unsubscribe();
    await flush();
    expect(await settled(droppedHandle.closed)).toBe('pending');
    expect(harness.clientCount('dropped')).toBe(1);
    dropped.interrupt('SUBSCRIPTION_INTERRUPTED');
    await expect(droppedHandle.closed).resolves.toMatchObject({
      status: 'unknown',
      error: { code: 'SUBSCRIPTION_INTERRUPTED' },
    });

    const rejected = harness.source('rejected');
    const rejection = new Error('terminal acknowledgement lost');
    const rejectedHandle = await subscribe(rejected, options, () => {});
    rejected.reject('terminal-ack', rejection);
    rejectedHandle.unsubscribe();
    await expect(rejectedHandle.closed).resolves.toMatchObject({
      status: 'unknown',
      error: { code: 'SUBSCRIPTION_INTERRUPTED', cause: rejection },
    });
  });

  it('does not release after cancellation until the terminal acknowledgement reply', async () => {
    const source = harness.source('client');
    const releaseCancel = source.hold('cancel');
    const handles = await Promise.all(Array.from({ length: 3 }, () => subscribe(source, options, () => {})));
    handles.forEach((handle) => handle.unsubscribe());
    expect(await Promise.all(handles.map((handle) => settled(handle.closed)))).toEqual([
      'pending',
      'pending',
      'pending',
    ]);
    expect(harness.clientCount('client')).toBe(3);
    releaseCancel();
    const releaseAck = source.hold('terminal-ack');
    await flush();
    expect(await Promise.all(handles.map((handle) => settled(handle.closed)))).toEqual([
      'pending',
      'pending',
      'pending',
    ]);
    expect(harness.clientCount('client')).toBe(3);
    releaseAck();
    await expect(Promise.all(handles.map((handle) => handle.closed))).resolves.toEqual(
      Array(3).fill({ status: 'released' }),
    );
    expect(harness.clientCount('client')).toBe(0);
  });

  it('reuses capacity only after callers await closed', async () => {
    const source = harness.source('client');
    for (let index = 0; index < 200; index++) {
      const handle = await subscribe(source, options, () => {});
      expect(harness.clientCount('client')).toBeLessThanOrEqual(1);
      handle.unsubscribe();
      await expect(handle.closed).resolves.toEqual({ status: 'released' });
      expect(harness.clientCount('client')).toBe(0);
    }
    const release = source.hold('terminal-ack');
    const handles: Subscription[] = [];
    for (let index = 0; index < 32; index++) {
      const handle = await subscribe(source, options, () => {});
      handle.unsubscribe();
      handles.push(handle);
    }
    await expect(subscribe(source, options, () => {})).rejects.toMatchObject({ code: 'ENOSPC' });
    release();
    await expect(Promise.all(handles.map((handle) => handle.closed))).resolves.toEqual(
      Array(32).fill({ status: 'released' }),
    );
    expect(harness.clientCount('client')).toBe(0);
  });

  it('holds the mount-wide 128 reservations until their owners acknowledge retirement', async () => {
    const sources = Array.from({ length: 5 }, (_, index) => harness.source(`client-${index}`));
    const releases = sources.slice(0, 4).map((source) => source.hold('terminal-ack'));
    const handles = await Promise.all(
      sources.slice(0, 4).flatMap((source) => Array.from({ length: 32 }, () => subscribe(source, options, () => {}))),
    );
    handles.forEach((handle) => handle.unsubscribe());
    await flush();
    expect(harness.mountCount()).toBe(128);
    await expect(subscribe(sources[4]!, options, () => {})).rejects.toMatchObject({ code: 'ENOSPC' });
    releases[0]!();
    await expect(Promise.all(handles.slice(0, 32).map((handle) => handle.closed))).resolves.toEqual(
      Array(32).fill({ status: 'released' }),
    );
    expect(harness.mountCount()).toBe(96);
    const fifthClient = Array.from({ length: 32 }, () => subscribe(sources[4]!, options, () => {}));
    await expect(Promise.all(fifthClient)).resolves.toHaveLength(32);
  });

  it('releases every reservation when the owner generation ends', async () => {
    const source = harness.source('client');
    const active = await subscribe(source, options, () => {});
    const releaseAck = source.hold('terminal-ack');
    const retiring = await subscribe(source, options, () => {});
    retiring.unsubscribe();
    const releaseRegister = source.hold('register');
    const pending = subscribe(source, options, () => {});
    await flush();
    harness.endGeneration();
    releaseRegister();
    releaseAck();
    await expect(active.closed).resolves.toEqual({ status: 'released' });
    await expect(retiring.closed).resolves.toEqual({ status: 'released' });
    await expect(pending).rejects.toMatchObject({ code: 'EBADF' });
    expect(harness.mountCount()).toBe(0);
  });

  it('does not retire a registration rejected before owner admission', async () => {
    const source = harness.source('client');
    harness.validateTarget = (target) => {
      if (target.path === '/missing') throw coded('ENOENT');
    };
    await expect(subscribe(source, { ...options, path: '/missing' }, () => {})).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(harness.clientCount('client')).toBe(0);
    expect(source.commands.filter((command) => command.type !== 'register')).toEqual([]);
    await expect(subscribe(source, options, () => {})).resolves.toHaveProperty('closed');
  });

  it('serializes a failed replacement setup until its terminal acknowledgement retires it', async () => {
    const source = harness.source('client');
    const releaseA = source.hold('terminal-ack');
    const first = await subscribe(source, options, () => {});
    first.unsubscribe();
    const releaseB = source.hold('register');
    const second = subscribe(source, options, () => {});
    await flush();
    releaseB();
    harness.session.invalidated({ kind: 'all' }, 'partial-mutation');
    await expect(second).rejects.toMatchObject({ code: 'SUBSCRIPTION_RESYNC_REQUIRED' });
    const before = source.commands.filter((command) => command.type === 'register').length;
    const third = subscribe(source, options, () => {});
    await flush();
    expect(source.commands.filter((command) => command.type === 'register')).toHaveLength(before);
    releaseA();
    await expect(third).resolves.toHaveProperty('closed');
    expect(harness.clientCount('client')).toBe(1);
  });

  it('blocks a generation after interrupted setup cleanup but permits a fresh generation', async () => {
    const source = harness.source('client');
    const releaseRegister = source.hold('register');
    const first = subscribe(source, options, () => {});
    await flush();
    source.interrupt('SUBSCRIPTION_INTERRUPTED');
    await expect(first).rejects.toMatchObject({ code: 'SUBSCRIPTION_INTERRUPTED' });
    const registers = source.commands.filter((command) => command.type === 'register').length;
    await expect(subscribe(source, options, () => {})).rejects.toMatchObject({
      code: 'SUBSCRIPTION_RETIREMENT_UNKNOWN',
      cause: { code: 'SUBSCRIPTION_INTERRUPTED' },
    });
    expect(source.commands.filter((command) => command.type === 'register')).toHaveLength(registers);
    releaseRegister();
    harness.nextGeneration();
    await expect(subscribe(source, options, () => {})).resolves.toHaveProperty('closed');
    expect(harness.clientCount('client')).toBe(1);
  });

  it('calls the failed-setup wait bridge only for matching-generation pending setups', async () => {
    const source = harness.source('client');
    let waitCalls = 0;
    const lifecycle = {
      awaitSetupRetirements: async (wait: (signal?: AbortSignal) => Promise<void>) => {
        waitCalls++;
        await wait();
      },
    };
    const first = await subscribe(source, options, () => {}, lifecycle);
    expect(waitCalls).toBe(0);
    first.unsubscribe();
    await first.closed;

    const releaseRegister = source.hold('register');
    const controller = new AbortController();
    const setup = subscribe(source, { ...options, signal: controller.signal }, () => {});
    await flush();
    controller.abort();
    await expect(setup).rejects.toMatchObject({ name: 'AbortError' });
    const waiting = new Promise<void>((resolve) => {
      void (async () => {
        while (waitCalls === 0) await flush();
        resolve();
      })();
    });
    const retry = subscribe(source, options, () => {}, lifecycle);
    await waiting;
    expect(waitCalls).toBe(1);
    source.interrupt('SUBSCRIPTION_INTERRUPTED');
    releaseRegister();
    await expect(retry).rejects.toMatchObject({ code: 'SUBSCRIPTION_RETIREMENT_UNKNOWN' });

    harness.nextGeneration();
    await expect(subscribe(source, options, () => {}, lifecycle)).resolves.toHaveProperty('closed');
    expect(waitCalls).toBe(1);
  });

  it('releases a preparing setup locally when registration aborts or its hook throws', async () => {
    const source = harness.source('client');
    const controller = new AbortController();
    let abortedSetup!: import('../types').SubscriptionSetup;
    const aborting = subscribe(source, { ...options, signal: controller.signal }, () => {}, {
      registering(setup) {
        abortedSetup = setup;
        controller.abort();
      },
    });
    await expect(aborting).rejects.toMatchObject({ name: 'AbortError' });
    await expect(abortedSetup.closed).resolves.toEqual({ status: 'released' });
    expect(source.commands).toEqual([]);

    const hookFailure = new Error('registration hook failed');
    let failedSetup!: import('../types').SubscriptionSetup;
    await expect(
      subscribe(source, options, () => {}, {
        registering(setup) {
          failedSetup = setup;
          throw hookFailure;
        },
        retiring() {
          throw new Error('observer failure');
        },
      }),
    ).rejects.toBe(hookFailure);
    await expect(failedSetup.closed).resolves.toEqual({ status: 'released' });
    expect(source.commands).toEqual([]);
  });

  it('observes registration in the same turn as the register request', async () => {
    const source = harness.source('client');
    const order: string[] = [];
    source.onRequest = (command) => {
      if (command.type === 'register') order.push('request');
    };
    const handle = await subscribe(source, options, () => {}, {
      registering() {
        order.push('registering');
      },
    });
    expect(order).toEqual(['registering', 'request']);
    handle.unsubscribe();
    await handle.closed;
  });

  it('treats a synchronous register request throw as unknown for that generation', async () => {
    const source = harness.source('client');
    const failure = new Error('synchronous request failure');
    source.throwSynchronously('register', failure);
    let setup!: import('../types').SubscriptionSetup;
    await expect(subscribe(source, options, () => {}, { registering: (value) => (setup = value) })).rejects.toBe(
      failure,
    );
    await expect(setup.closed).resolves.toMatchObject({ status: 'unknown' });
    const registrations = source.commands.filter(({ type }) => type === 'register').length;
    await expect(subscribe(source, options, () => {})).rejects.toMatchObject({
      code: 'SUBSCRIPTION_RETIREMENT_UNKNOWN',
    });
    expect(source.commands.filter(({ type }) => type === 'register')).toHaveLength(registrations);

    harness.nextGeneration();
    await expect(subscribe(source, options, () => {})).resolves.toHaveProperty('closed');
  });

  it('swallows retiring-observer failures and still completes remote cleanup', async () => {
    const source = harness.source('client');
    const handle = await subscribe(source, options, () => {}, {
      retiring() {
        throw new Error('retiring observer failed');
      },
    });
    handle.unsubscribe();
    await expect(handle.closed).resolves.toEqual({ status: 'released' });
    expect(source.commands.map(({ type }) => type)).toContain('cancel');
  });

  it('sends one cancellation when a retiring observer re-enters', async () => {
    const source = harness.source('client');
    const controller = new AbortController();
    let retirements = 0;
    const handle = await subscribe(source, { ...options, signal: controller.signal }, () => {}, {
      retiring() {
        retirements++;
        controller.abort();
      },
    });
    handle.unsubscribe();
    await expect(handle.closed).resolves.toEqual({ status: 'released' });
    expect(retirements).toBe(1);
    expect(source.commands.filter(({ type }) => type === 'cancel')).toHaveLength(1);
  });

  for (const frameType of ['terminal', 'closed'] as const)
    it(`${frameType} observer re-entry sends one acknowledgement without cancellation`, async () => {
      const source = harness.source(`client-${frameType}`);
      const controller = new AbortController();
      const handle = await subscribe(source, { ...options, signal: controller.signal }, () => {}, {
        retiring() {
          controller.abort();
        },
      });
      const registration = source.commands.find(({ type }) => type === 'register')!;
      const channel = [...harness.channels.values()][0]!;
      if (frameType === 'terminal')
        channel.receive({
          type: 'terminal',
          subscriptionId: registration.subscriptionId,
          code: 'SUBSCRIPTION_OVERFLOW',
        });
      else channel.receive({ type: 'closed', subscriptionId: registration.subscriptionId });
      await expect(handle.closed).resolves.toEqual({ status: 'released' });
      expect(source.commands.filter(({ type }) => type === 'cancel')).toHaveLength(0);
      expect(source.commands.filter(({ type }) => type === 'terminal-ack')).toHaveLength(1);
    });

  it('does not cancel from a retiring observer after known setup rejection', async () => {
    const source = harness.source('client');
    const controller = new AbortController();
    source.reject('register', coded('EACCES'));
    let setup!: import('../types').SubscriptionSetup;
    await expect(
      subscribe(source, { ...options, signal: controller.signal }, () => {}, {
        registering(value) {
          setup = value;
        },
        retiring() {
          controller.abort();
        },
      }),
    ).rejects.toMatchObject({ code: 'EACCES' });
    await expect(setup.closed).resolves.toEqual({ status: 'released' });
    expect(source.commands.filter(({ type }) => type === 'cancel')).toHaveLength(0);
  });

  it('does not dispatch from a retiring observer after a preparing hook veto', async () => {
    const source = harness.source('client');
    const controller = new AbortController();
    const veto = new Error('veto');
    let setup!: import('../types').SubscriptionSetup;
    await expect(
      subscribe(source, { ...options, signal: controller.signal }, () => {}, {
        registering(value) {
          setup = value;
          throw veto;
        },
        retiring() {
          controller.abort();
        },
      }),
    ).rejects.toBe(veto);
    await expect(setup.closed).resolves.toEqual({ status: 'released' });
    expect(source.commands).toEqual([]);
  });

  for (const frameType of ['terminal', 'closed'] as const)
    it(`acknowledges repeated ${frameType} frames once`, async () => {
      const source = harness.source(`client-repeat-${frameType}`);
      const handle = await subscribe(source, options, () => {});
      const registration = source.commands.find(({ type }) => type === 'register')!;
      const channel = [...harness.channels.values()][0]!;
      const frame =
        frameType === 'terminal'
          ? {
              type: 'terminal' as const,
              subscriptionId: registration.subscriptionId,
              code: 'SUBSCRIPTION_OVERFLOW' as const,
            }
          : { type: 'closed' as const, subscriptionId: registration.subscriptionId };
      channel.receive(frame);
      channel.receive(frame);
      await expect(handle.closed).resolves.toEqual({ status: 'released' });
      expect(source.commands.filter(({ type }) => type === 'terminal-ack')).toHaveLength(1);
    });

  it('settles a deferred activation failure as unknown', async () => {
    const source = harness.source('client');
    const errors: string[] = [];
    source.reject('activate', new Error('activation failed'));
    const handle = await subscribe(source, { ...options, onError: (error) => errors.push(error.code) }, () => {});
    await expect(handle.closed).resolves.toMatchObject({
      status: 'unknown',
      error: { code: 'SUBSCRIPTION_INTERRUPTED' },
    });
    expect(harness.clientCount('client')).toBe(0);
    await flush();
    expect(errors).toEqual(['SUBSCRIPTION_INTERRUPTED']);
  });
});

type DirectResult = {
  pending: boolean;
  rejected: string[];
  overflow?: string;
  released: SubscriptionRetirement[];
  close: SubscriptionRetirement;
  error?: string;
};

function runDirect() {
  const direct = new Worker(new URL('./subscription-retirement-direct-worker.ts', import.meta.url), { type: 'module' });
  return new Promise<DirectResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      direct.terminate();
      reject(new Error('subscription retirement direct worker timed out'));
    }, 30000);
    direct.onerror = (event) => {
      clearTimeout(timer);
      direct.terminate();
      reject(new Error(event.message));
    };
    direct.onmessage = ({ data }: MessageEvent<DirectResult>) => {
      clearTimeout(timer);
      direct.terminate();
      if (data.error) reject(new Error(data.error));
      else resolve(data);
    };
    direct.postMessage({});
  });
}

describe('subscription retirement through core transport', () => {
  it('keeps direct-worker owner capacity reserved through terminal acknowledgement', async () => {
    const result = await runDirect();
    expect(result.pending).toBe(true);
    expect(result.rejected).toEqual(Array(40).fill('EINVAL'));
    expect(result.overflow).toBe('ENOSPC');
    expect(result.released).toEqual(Array(32).fill({ status: 'released' }));
    expect(result.close).toEqual({ status: 'released' });
  }, 30000);

  it('keeps follower retirement capacity and reports leader shutdown as an interruption', async () => {
    const name = `subscription-retirement-${crypto.randomUUID()}.bin`;
    const leader = new OpfsVfsWorker(name, { worker, plugins: [subscriptionsRequest()] });
    let follower: OpfsVfsWorker | undefined;
    let leaderHandle: Subscription | undefined;
    let followerActive: Subscription | undefined;
    try {
      await leader.ready;
      // Construct the follower only after the leader owns the volume, so the roles cannot swap.
      follower = new OpfsVfsWorker(name, { worker, plugins: [subscriptionsRequest()] });
      const joined = follower;
      await joined.ready;
      leaderHandle = await subscribe(leader, options, () => {});
      type HeldCommand = {
        command: ChangeCommand;
        resolve: (reply: ChangeReply) => void;
        reject: (cause: unknown) => void;
        channel: FileChangeChannel;
      };
      let held: HeldCommand[] = [];
      let holding = true;
      const source: FileChangeSource = {
        openFileChangeChannel(receive, interrupted, closed) {
          return joined.openFileChangeChannel(receive, interrupted, closed).then((channel) => ({
            generation: channel.generation,
            request(command) {
              if (holding && command.type === 'terminal-ack')
                return new Promise<ChangeReply>((resolve, reject) => held.push({ command, resolve, reject, channel }));
              return channel.request(command);
            },
            close() {
              channel.close();
            },
          }));
        },
      };
      const handles = await Promise.all(Array.from({ length: 32 }, () => subscribe(source, options, () => {})));
      handles.forEach((handle) => handle.unsubscribe());
      await flush();
      expect(await Promise.all(handles.map((handle) => settled(handle.closed)))).toEqual(Array(32).fill('pending'));
      await expect(subscribe(source, options, () => {})).rejects.toMatchObject({ code: 'ENOSPC' });
      holding = false;
      for (const item of held) item.channel.request(item.command).then(item.resolve, item.reject);
      held = [];
      await expect(Promise.all(handles.map((handle) => handle.closed))).resolves.toEqual(
        Array(32).fill({ status: 'released' }),
      );
      for (let index = 0; index < 50; index++) {
        const handle = await subscribe(source, options, () => {});
        handle.unsubscribe();
        await expect(handle.closed).resolves.toEqual({ status: 'released' });
      }
      followerActive = await subscribe(source, options, () => {});
      await leader.closeVfs();
      await expect(leaderHandle.closed).resolves.toEqual({ status: 'released' });
      await expect(followerActive.closed).resolves.toMatchObject({
        status: 'unknown',
        error: { code: 'SUBSCRIPTION_INTERRUPTED' },
      });
    } finally {
      await Promise.allSettled([follower?.closeVfs(), leader.closeVfs()]);
      follower?.dispose();
      leader.dispose();
      await deleteVolume(name);
    }
  }, 60000);
});
