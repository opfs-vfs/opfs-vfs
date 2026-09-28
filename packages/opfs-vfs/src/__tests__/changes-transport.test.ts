import { afterEach, expect, it, vi } from 'vitest';
import type { ChangeCommand, ChangeFrame, FileChangeChannel, WireSubscribeOptions } from '../changes';
import { OpfsVfsWorker } from '../index_internal';
import { deleteVolume } from '../volume-files';
import { inspectWorker } from '../worker-client';
import { changesTransportRequest } from './changes-transport-plugin';

const clients: OpfsVfsWorker[] = [];
const owners = new Map<string, OpfsVfsWorker>();
const names: string[] = [];
const name = () => {
  const value = `changes-transport-${crypto.randomUUID()}.bin`;
  names.push(value);
  return value;
};
const factory = () => new Worker(new URL('./changes-transport-worker.ts', import.meta.url), { type: 'module' });
const options: WireSubscribeOptions = {
  path: '/',
  scope: 'directory',
  recursive: true,
  events: ['create', 'update', 'delete'],
  content: false,
};

function client(fileName: string) {
  const vfs = new OpfsVfsWorker(fileName, { worker: factory, plugins: [changesTransportRequest()] });
  clients.push(vfs);
  owners.set(fileName, owners.get(fileName) ?? vfs);
  return vfs;
}

function recordingClient(fileName: string, recordingProbe: string, maxFiles?: number) {
  const vfs = new OpfsVfsWorker(fileName, {
    worker: factory,
    plugins: [changesTransportRequest({ recordingProbe })],
    maxFiles,
  });
  clients.push(vfs);
  owners.set(fileName, owners.get(fileName) ?? vfs);
  return vfs;
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Expected transport barrier');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function channel(vfs: OpfsVfsWorker) {
  const frames: ChangeFrame[] = [];
  const interruptions: string[] = [];
  let wake: (() => void) | undefined;
  let interruptWake: ((code: string) => void) | undefined;
  let closeWake: (() => void) | undefined;
  let closed = 0;
  const next = async <Type extends ChangeFrame['type']>(type: Type) => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const index = frames.findIndex((frame) => frame.type === type);
      if (index >= 0) return frames.splice(index, 1)[0] as Extract<ChangeFrame, { type: Type }>;
      if (Date.now() >= deadline) throw new Error(`Missing ${type} frame`);
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, Math.max(0, deadline - Date.now()));
      });
      wake = undefined;
    }
  };
  const interrupted = () =>
    interruptions.length
      ? Promise.resolve(interruptions[0]!)
      : new Promise<string>((resolve, reject) => {
          interruptWake = resolve;
          setTimeout(() => reject(new Error('Missing interruption')), 5_000);
        });
  const normalClose = () =>
    closed > 0
      ? Promise.resolve()
      : new Promise<void>((resolve, reject) => {
          closeWake = resolve;
          setTimeout(() => reject(new Error('Missing normal close')), 5_000);
        });
  const open = vfs.openFileChangeChannel(
    (frame) => {
      frames.push(frame);
      wake?.();
    },
    (code) => {
      interruptions.push(code);
      interruptWake?.(code);
    },
    () => {
      closed++;
      closeWake?.();
      wake?.();
    },
  );
  return { open, next, interrupted, normalClose, frames, interruptions, closed: () => closed };
}

async function register(channel: FileChangeChannel, subscriptionId: string, subscriptionOptions = options) {
  await expect(channel.request({ type: 'register', subscriptionId, options: subscriptionOptions })).resolves.toEqual({
    type: 'registered',
    subscriptionId,
  });
  await expect(channel.request({ type: 'activate', subscriptionId })).resolves.toEqual({ type: 'ok' });
}

afterEach(async () => {
  for (const vfs of clients.splice(0)) await vfs.closeVfs().catch(() => vfs.dispose());
  owners.clear();
  await Promise.all(names.splice(0).map(deleteVolume));
});

it('delivers owner and two follower registrations over isolated recipient lanes', async () => {
  const originalPost = BroadcastChannel.prototype.postMessage;
  const relayedContent: Uint8Array[] = [];
  const post = vi.spyOn(BroadcastChannel.prototype, 'postMessage').mockImplementation(function (
    this: BroadcastChannel,
    message,
  ) {
    const frame = (message as { type?: unknown; frame?: { type?: unknown; change?: { content?: unknown } } }).frame;
    const content = frame?.type === 'event' ? frame.change?.content : undefined;
    if (
      (message as { type?: unknown }).type === 'CHANGE_FRAME' &&
      content &&
      typeof content === 'object' &&
      (content as { status?: unknown }).status === 'included' &&
      (content as { bytes?: unknown }).bytes instanceof Uint8Array
    ) {
      const bytes = (content as { bytes: Uint8Array }).bytes;
      relayedContent.push(bytes);
      originalPost.call(this, message);
      bytes.set([9]);
      return;
    }
    originalPost.call(this, message);
  });
  const fileName = name();
  const owner = client(fileName);
  await owner.ready;
  const first = client(fileName);
  const second = client(fileName);
  await Promise.all([first.ready, second.ready]);
  const discovery = new BroadcastChannel(`opfs-vfs-${fileName}`);
  const leaked: unknown[] = [];
  discovery.onmessage = ({ data }) => {
    if (data?.type === 'event' || data?.type === 'terminal' || data?.type === 'closed' || data?.frame)
      leaked.push(data);
  };
  try {
    const ownerChannel = channel(owner);
    const firstChannel = channel(first);
    const secondChannel = channel(second);
    const [ownerOpen, firstOpen, secondOpen] = await Promise.all([
      ownerChannel.open,
      firstChannel.open,
      secondChannel.open,
    ]);
    const content = { ...options, content: { maxBytes: 16 * 1024 * 1024 } };
    await Promise.all([
      register(ownerOpen, 'local-owner', content),
      register(firstOpen, 'follower-one', content),
      register(secondOpen, 'follower-two', content),
    ]);
    await owner.writeFileBuffer('/shared', new Uint8Array([1]));
    const events = await Promise.all([
      ownerChannel.next('event'),
      firstChannel.next('event'),
      secondChannel.next('event'),
    ]);
    expect(events.map((frame) => frame.change.path)).toEqual(['/shared', '/shared', '/shared']);
    expect(events.map((frame) => frame.subscriptionId)).toEqual(['local-owner', 'follower-one', 'follower-two']);
    for (const event of events) {
      if (event.change.content.status !== 'included') throw new Error('Expected included content');
      expect(event.change.content.bytes).toEqual(new Uint8Array([1]));
    }
    expect(relayedContent).toHaveLength(2);
    for (const event of events.slice(1)) {
      if (event.change.content.status !== 'included') throw new Error('Expected included content');
      const bytes = event.change.content.bytes;
      expect(relayedContent.some((source) => source.buffer === bytes.buffer)).toBe(false);
    }
    await Promise.all(
      events.map((frame, index) =>
        [ownerOpen, firstOpen, secondOpen][index]!.request({
          type: 'ack',
          subscriptionId: frame.subscriptionId,
          deliveryId: frame.deliveryId,
        }),
      ),
    );
    expect(leaked).toEqual([]);
    ownerOpen.close();
    firstOpen.close();
    secondOpen.close();
  } finally {
    post.mockRestore();
    discovery.close();
  }
});

it('records only while a change registration is admitted', async () => {
  const recordingProbe = `changes-transport-recording-${crypto.randomUUID()}`;
  const vfs = recordingClient(name(), recordingProbe, 5);
  await vfs.ready;
  await vfs.writeFileBuffer('/idle', new Uint8Array([1]));
  const subscription = channel(vfs);
  const open = await subscription.open;
  await register(open, 'local-recording');
  await vfs.writeFileBuffer('/recorded', new Uint8Array([1]));
  await vfs.writeFileBuffer('/terminal', new Uint8Array([1]));
  await subscription.next('terminal');
  await expect(vfs.mkdir('/partial/deep', { recursive: true })).rejects.toMatchObject({ code: 'ENOSPC' });
  await open.request({ type: 'terminal-ack', subscriptionId: 'local-recording' });
  await subscription.next('closed');
  await vfs.writeFileBuffer('/idle', new Uint8Array([2]));
  const probe = channel(vfs);
  const probeOpen = await probe.open;
  await expect(
    probeOpen.request({ type: 'register', subscriptionId: 'local-recording-probe-3', options }),
  ).resolves.toEqual({
    type: 'registered',
    subscriptionId: 'local-recording-probe-3',
  });
  await probeOpen.request({ type: 'cancel', subscriptionId: 'local-recording-probe-3' });
  await probe.next('closed');
});

it('keeps a terminal subscription until terminal acknowledgement and closes it normally', async () => {
  const vfs = client(name());
  await vfs.ready;
  const subscription = channel(vfs);
  const open = await subscription.open;
  await register(open, 'local-terminal');
  await vfs.writeFileBuffer('/terminal', new Uint8Array([1]));
  await expect(subscription.next('terminal')).resolves.toMatchObject({ subscriptionId: 'local-terminal' });
  await open.request({ type: 'terminal-ack', subscriptionId: 'local-terminal' });
  await expect(subscription.next('closed')).resolves.toMatchObject({ subscriptionId: 'local-terminal' });
  expect(subscription.closed()).toBe(0);
  open.close();
});

it('shares a follower recipient lane across channels and distinguishes owner close from owner loss', async () => {
  const fileName = name();
  const owner = client(fileName);
  await owner.ready;
  const follower = client(fileName);
  await follower.ready;
  const first = channel(follower);
  const second = channel(follower);
  const [firstOpen, secondOpen] = await Promise.all([first.open, second.open]);
  await Promise.all([register(firstOpen, 'follower-one'), register(secondOpen, 'follower-two')]);
  await owner.writeFileBuffer('/two-channels', new Uint8Array([1]));
  await Promise.all([first.next('event'), second.next('event')]);
  await owner.closeVfs();
  await expect(first.interrupted()).resolves.toBe('SUBSCRIPTION_INTERRUPTED');
  await expect(second.interrupted()).resolves.toBe('SUBSCRIPTION_INTERRUPTED');

  const direct = client(name());
  await direct.ready;
  const local = channel(direct);
  await local.open;
  await direct.closeVfs();
  await local.normalClose();
});

it('interrupts local subscriptions when a follower takes over', async () => {
  const fileName = name();
  const owner = client(fileName);
  await owner.ready;
  const follower = client(fileName);
  await follower.ready;
  const subscription = channel(owner);
  const open = await subscription.open;
  await register(open, 'local-takeover');
  await follower.shutdownSharedVfs();
  await expect(subscription.interrupted()).resolves.toBe('SUBSCRIPTION_INTERRUPTED');
  expect(subscription.closed()).toBe(0);
});

it('opens one recipient lane for a follower with multiple channels', async () => {
  const NativeBroadcastChannel = BroadcastChannel;
  const created: string[] = [];
  vi.stubGlobal(
    'BroadcastChannel',
    class extends NativeBroadcastChannel {
      constructor(channelName: string) {
        created.push(channelName);
        super(channelName);
      }
    },
  );
  try {
    const fileName = name();
    const owner = client(fileName);
    await owner.ready;
    const follower = client(fileName);
    await follower.ready;
    const first = channel(follower);
    const second = channel(follower);
    await Promise.all([first.open, second.open]);
    const lanes = created.filter((channelName) => channelName.startsWith(`opfs-vfs-changes-${fileName}-`));
    expect(new Set(lanes)).toHaveLength(1);
    expect(lanes).toHaveLength(2);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('keeps a follower recipient lane open while another channel open is pending', async () => {
  const originalPost = Worker.prototype.postMessage;
  const held: Array<(invalid?: boolean) => void> = [];
  const post = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: Worker, message, transfer) {
    if (message.type === 'FILE_CHANGES_OPEN' && held.length < 2) {
      held.push((invalid = false) =>
        originalPost.call(
          this,
          invalid ? { ...message, payload: { ...message.payload, version: 0 } } : message,
          transfer as StructuredSerializeOptions,
        ),
      );
      return;
    }
    originalPost.call(this, message, transfer as StructuredSerializeOptions);
  });
  try {
    const fileName = name();
    const owner = client(fileName);
    await owner.ready;
    const follower = client(fileName);
    await follower.ready;
    const first = channel(follower);
    const second = channel(follower);
    const firstResult = first.open.then(
      (open) => ({ open }),
      (error) => ({ error }),
    );
    const secondResult = second.open.then(
      (open) => ({ open }),
      (error) => ({ error }),
    );
    const openings = Promise.all([firstResult, secondResult]);
    await until(() => held.length === 2);
    const firstMessage = held.shift()!;
    const secondMessage = held.shift()!;
    firstMessage(true);
    await expect(firstResult).resolves.toMatchObject({ error: { code: 'EINVAL' } });
    secondMessage();
    const [, result] = await openings;
    if (!('open' in result)) throw result.error;
    await register(result.open, 'follower-survives');
    await owner.writeFileBuffer('/survives-open-race', new Uint8Array([1]));
    await expect(second.next('event')).resolves.toMatchObject({
      subscriptionId: 'follower-survives',
      change: { path: '/survives-open-race' },
    });
    result.open.close();
  } finally {
    post.mockRestore();
    for (const release of held) release();
  }
});

it('closes a timed-out follower open after the owner finishes it', async () => {
  const originalPost = Worker.prototype.postMessage;
  let releaseOpen: (() => void) | undefined;
  let released = false;
  let ownerClosed = false;
  const post = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: Worker, message, transfer) {
    if (message.type === 'FILE_CHANGES_OPEN' && !releaseOpen) {
      releaseOpen = () => originalPost.call(this, message, transfer as StructuredSerializeOptions);
      return;
    }
    if (message.type === 'FILE_CHANGES_CLOSE' && message.payload?.route === 'follower-relay') ownerClosed = true;
    originalPost.call(this, message, transfer as StructuredSerializeOptions);
  });
  const nativeSetTimeout = globalThis.setTimeout;
  const timeouts: Array<() => void> = [];
  let restoreTimers: (() => void) | undefined;
  const fileName = name();
  const discovery = new BroadcastChannel(`opfs-vfs-${fileName}`);
  const opens: Array<{ clientId: string; channelId: string }> = [];
  const closes: Array<{ clientId: string; channelId: string }> = [];
  discovery.onmessage = ({ data }) => {
    if (data?.type === 'CHANGE_OPEN') opens.push(data);
    if (data?.type === 'CHANGE_CLOSE') closes.push(data);
  };
  try {
    const owner = client(fileName);
    await owner.ready;
    const follower = client(fileName);
    await follower.ready;
    // Let the follower's persistence snapshot request settle, so only the change-open deadlines are counted.
    await until(() => follower.getStatus().persistence !== null);
    const timers = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
      if (delay === 30_000 && typeof callback === 'function') timeouts.push(() => callback(...args));
      return nativeSetTimeout(callback, delay, ...args);
    });
    restoreTimers = () => timers.mockRestore();
    const timedOut = channel(follower).open.catch((error) => error);
    await until(() => releaseOpen !== undefined && timeouts.length === 2);
    timers.mockRestore();
    restoreTimers = undefined;
    timeouts[0]!();
    await expect(timedOut).resolves.toMatchObject({ code: 'LEADER_RESPONSE_TIMEOUT' });
    await until(() => closes.length === 1);
    expect(closes[0]).toMatchObject({
      clientId: opens[0]!.clientId,
      channelId: opens[0]!.channelId,
    });
    releaseOpen!();
    released = true;
    await until(() => ownerClosed);
    await owner.exists('/timeout-close-barrier');
    const fresh = Array.from({ length: 32 }, () => channel(follower));
    const channels = await Promise.all(fresh.map(({ open }) => open));
    expect(channels).toHaveLength(32);
    for (const open of channels) open.close();
  } finally {
    restoreTimers?.();
    post.mockRestore();
    if (!released) releaseOpen?.();
    discovery.close();
  }
});

it('keeps an active subscription after a sibling directory registration fails', async () => {
  const fileName = name();
  const owner = client(fileName);
  await owner.ready;
  const follower = client(fileName);
  await follower.ready;
  for (const [prefix, vfs] of [
    ['local', owner],
    ['follower', follower],
  ] as const) {
    const subscription = channel(vfs);
    const open = await subscription.open;
    const activeId = `${prefix}-active`;
    const existing = `/${prefix}-existing`;
    await register(open, activeId);
    await owner.writeFileBuffer(existing, new Uint8Array([1]));
    const initial = await subscription.next('event');
    await open.request({ type: 'ack', subscriptionId: activeId, deliveryId: initial.deliveryId });
    await expect(
      open.request({
        type: 'register',
        subscriptionId: `${prefix}-invalid-directory`,
        options: { ...options, path: existing, scope: 'directory' },
      }),
    ).rejects.toMatchObject({ code: 'EINVAL' });
    await owner.writeFileBuffer(`/${prefix}-still-active`, new Uint8Array([2]));
    await expect(subscription.next('event')).resolves.toMatchObject({
      subscriptionId: activeId,
      change: { path: `/${prefix}-still-active` },
    });
    expect(subscription.interruptions).toEqual([]);
    open.close();
  }
});

it('keeps a follower lane open when its active channel closes during another open', async () => {
  const fileName = name();
  const owner = client(fileName);
  await owner.ready;
  const follower = client(fileName);
  await follower.ready;
  const first = channel(follower);
  const firstOpen = await first.open;
  await register(firstOpen, 'follower-first');
  const originalPost = Worker.prototype.postMessage;
  let releaseOpen: (() => void) | undefined;
  let released = false;
  const post = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: Worker, message, transfer) {
    if (message.type === 'FILE_CHANGES_OPEN' && !releaseOpen) {
      releaseOpen = () => originalPost.call(this, message, transfer as StructuredSerializeOptions);
      return;
    }
    originalPost.call(this, message, transfer as StructuredSerializeOptions);
  });
  try {
    const second = channel(follower);
    const secondResult = second.open.then(
      (open) => ({ open }),
      (error) => ({ error }),
    );
    await until(() => releaseOpen !== undefined);
    firstOpen.close();
    releaseOpen!();
    released = true;
    const result = await secondResult;
    if (!('open' in result)) throw result.error;
    await register(result.open, 'follower-second');
    await owner.writeFileBuffer('/follower-second-event', new Uint8Array([1]));
    await expect(second.next('event')).resolves.toMatchObject({
      subscriptionId: 'follower-second',
      change: { path: '/follower-second-event' },
    });
    result.open.close();
  } finally {
    post.mockRestore();
    if (!released) releaseOpen?.();
  }
});

it('closes local and relayed channels after malformed register replies', async () => {
  const NativeWorker = Worker;
  let malformedReplyId: number | undefined;
  let malformedReply: 'success' | 'error' | undefined;
  let mutateNextRegister = false;
  vi.stubGlobal(
    'Worker',
    class extends NativeWorker {
      set onmessage(listener: ((this: Worker, event: MessageEvent) => unknown) | null) {
        super.onmessage = listener
          ? (event) => {
              const data = event.data;
              if (data?.type === 'FILE_CHANGES_COMMAND' && data.id === malformedReplyId) {
                malformedReplyId = undefined;
                const reply = malformedReply;
                malformedReply = undefined;
                listener.call(
                  this,
                  new MessageEvent('message', {
                    data:
                      reply === 'error'
                        ? { ...data, type: 'ERROR', result: { error: 42, code: 'ECANCELED' } }
                        : { ...data, result: { type: 'registered' } },
                  }),
                );
              } else listener.call(this, event);
            }
          : null;
      }
    },
  );
  const originalPost = Worker.prototype.postMessage;
  const closes: Array<{ route: string; channelId: string }> = [];
  const post = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: Worker, message, transfer) {
    if (
      mutateNextRegister &&
      message.type === 'FILE_CHANGES_COMMAND' &&
      message.payload?.command?.subscriptionId?.endsWith('-broken')
    ) {
      mutateNextRegister = false;
      malformedReplyId = message.id;
    }
    if (message.type === 'FILE_CHANGES_CLOSE') closes.push(message.payload);
    originalPost.call(this, message, transfer as StructuredSerializeOptions);
  });
  try {
    const fileName = name();
    const owner = client(fileName);
    await owner.ready;
    const follower = client(fileName);
    await follower.ready;
    for (const [prefix, vfs, route, reply] of [
      ['local-success', owner, 'local', 'success'],
      ['follower-success', follower, 'follower-relay', 'success'],
      ['local-error', owner, 'local', 'error'],
      ['follower-error', follower, 'follower-relay', 'error'],
    ] as const) {
      const subscription = channel(vfs);
      const open = await subscription.open;
      await register(open, `${prefix}-active`);
      const broken = `${prefix}-broken`;
      const closeCount = closes.length;
      malformedReply = reply;
      mutateNextRegister = true;
      const registering = open.request({ type: 'register', subscriptionId: broken, options });
      await expect(registering).rejects.toBeDefined();
      await expect(subscription.interrupted()).resolves.toMatch(/SUBSCRIPTION_/);
      expect(subscription.interruptions).toHaveLength(1);
      await until(() => closes.slice(closeCount).some((close) => close.route === route));
      const replacement = channel(vfs);
      const replacementOpen = await replacement.open;
      for (let slot = 0; slot < 32; slot++) {
        const subscriptionId = `${prefix}-replacement-${slot}`;
        await expect(replacementOpen.request({ type: 'register', subscriptionId, options })).resolves.toEqual({
          type: 'registered',
          subscriptionId,
        });
      }
      replacementOpen.close();
    }
  } finally {
    post.mockRestore();
    vi.unstubAllGlobals();
  }
});

it('drops stale and malformed unsolicited recipient frames', async () => {
  const NativeBroadcastChannel = BroadcastChannel;
  const created: string[] = [];
  vi.stubGlobal(
    'BroadcastChannel',
    class extends NativeBroadcastChannel {
      constructor(channelName: string) {
        created.push(channelName);
        super(channelName);
      }
    },
  );
  try {
    const fileName = name();
    const owner = client(fileName);
    await owner.ready;
    const follower = client(fileName);
    await follower.ready;
    const subscription = channel(follower);
    const open = await subscription.open;
    await register(open, 'follower-fenced');
    const state = follower as unknown as {
      attachmentId: string;
      leaderGeneration: string;
      changeChannels: Map<string, unknown>;
    };
    const channelId = state.changeChannels.keys().next().value as string;
    const laneName = created.find((channelName) => channelName.startsWith(`opfs-vfs-changes-${fileName}-`));
    expect(laneName).toBeTruthy();
    const forged = new NativeBroadcastChannel(laneName!);
    const frame = {
      type: 'event',
      subscriptionId: 'follower-fenced',
      deliveryId: 99,
      change: {
        type: 'update',
        path: '/forged',
        kind: 'file',
        cursor: { generation: state.leaderGeneration, sequence: 99 },
        content: { status: 'omitted', reason: 'disabled' },
      },
    };
    forged.postMessage({
      type: 'CHANGE_FRAME',
      version: 1,
      generation: 'stale',
      clientId: state.attachmentId,
      channelId,
      frame,
    });
    forged.postMessage({
      type: 'CHANGE_FRAME',
      version: 1,
      generation: state.leaderGeneration,
      clientId: state.attachmentId,
      channelId,
      frame: { ...frame, change: { ...frame.change, cursor: { ...frame.change.cursor, generation: 'stale' } } },
    });
    forged.postMessage({
      type: 'CHANGE_FRAME',
      version: 1,
      generation: state.leaderGeneration,
      clientId: state.attachmentId,
      channelId,
      frame,
      extra: true,
    });
    forged.postMessage({
      type: 'CHANGE_FRAME',
      version: 1,
      generation: state.leaderGeneration,
      clientId: state.attachmentId,
      channelId,
      frame: {
        ...frame,
        change: { ...frame.change, extra: true },
      },
    });
    forged.postMessage({
      type: 'CHANGE_FRAME',
      version: 1,
      generation: state.leaderGeneration,
      clientId: state.attachmentId,
      channelId,
      frame: { ...frame, deliveryId: 100, change: { ...frame.change, path: '/causal-barrier' } },
    });
    await expect(subscription.next('event')).resolves.toMatchObject({ change: { path: '/causal-barrier' } });
    await owner.writeFileBuffer('/actual', new Uint8Array([1]));
    await expect(subscription.next('event')).resolves.toMatchObject({ change: { path: '/actual' } });
    forged.close();
    open.close();
  } finally {
    vi.unstubAllGlobals();
  }
});

it('delivers change callbacks after a worker-owned synchronous mutation returns', async () => {
  const fileName = name();
  const worker = new Worker(new URL('./changes-transport-sab-worker.ts', import.meta.url), { type: 'module' });
  const order: string[] = [];
  const frames: Extract<ChangeFrame, { type: 'event' }>[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SAB change worker timed out')), 10_000);
      worker.onerror = (event) => {
        clearTimeout(timer);
        reject(new Error(event.message));
      };
      worker.onmessage = ({ data }) => {
        if (data.type === 'ERROR') {
          clearTimeout(timer);
          reject(new Error(data.message));
        }
        if (data.type === 'SYNC_RETURNED' || data.type === 'FRAME') order.push(data.type);
        if (data.type === 'FRAME') {
          frames.push(data.frame as Extract<ChangeFrame, { type: 'event' }>);
          if (frames.length === 3) worker.postMessage({ type: 'CLOSE' });
        }
        if (data.type === 'CLOSED') {
          clearTimeout(timer);
          resolve();
        }
      };
      worker.postMessage({ type: 'RUN', fileName });
    });
    expect(order[0]).toBe('SYNC_RETURNED');
    expect(order.slice(1)).toEqual(['FRAME', 'FRAME', 'FRAME']);
    expect(frames.map((frame) => frame.change.content)).toEqual([
      { status: 'included', bytes: new Uint8Array() },
      { status: 'included', bytes: new Uint8Array([1]) },
      { status: 'included', bytes: new Uint8Array([2]) },
    ]);
  } finally {
    worker.terminate();
  }
});

it('captures versions in the worker before later asynchronous writes', async () => {
  const owner = client(name());
  await owner.ready;
  const subscription = channel(owner);
  const open = await subscription.open;
  await register(open, 'local-content', { ...options, content: { maxBytes: 16 * 1024 * 1024 } });
  await owner.writeFileBuffer('/content', new Uint8Array([1]));
  await owner.writeFileBuffer('/content', new Uint8Array([2]));
  const frames = [await subscription.next('event'), await subscription.next('event')];
  expect(frames.map((frame) => frame.change.content)).toEqual([
    { status: 'included', bytes: new Uint8Array([1]) },
    { status: 'included', bytes: new Uint8Array([2]) },
  ]);
  open.close();
});

it('does not share worker-client included delivery arrays between recipients', async () => {
  const owner = client(name());
  await owner.ready;
  const first = channel(owner);
  const second = channel(owner);
  const [firstOpen, secondOpen] = await Promise.all([first.open, second.open]);
  const content = { ...options, content: { maxBytes: 16 * 1024 * 1024 } };
  await register(firstOpen, 'local-content-one', content);
  await register(secondOpen, 'local-content-two', content);
  await owner.writeFileBuffer('/isolated', new Uint8Array([1]));
  const [one, two] = await Promise.all([first.next('event'), second.next('event')]);
  if (one.change.content.status !== 'included' || two.change.content.status !== 'included')
    throw new Error('Expected included content');
  one.change.content.bytes[0] = 9;
  expect(two.change.content.bytes).toEqual(new Uint8Array([1]));
  firstOpen.close();
  secondOpen.close();
});

it('does not share direct OpfsVfs included delivery arrays with channels or the filesystem', async () => {
  const worker = new Worker(new URL('./changes-transport-direct-worker.ts', import.meta.url), { type: 'module' });
  try {
    const result = await new Promise<{ first?: number[]; second?: number[]; current?: number[]; error?: string }>(
      (resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('direct transport worker timed out')), 5_000);
        worker.onerror = (event) => {
          clearTimeout(timer);
          reject(new Error(event.message));
        };
        worker.onmessage = ({ data }) => {
          clearTimeout(timer);
          if (data.error) reject(new Error(data.error));
          else resolve(data);
        };
        worker.postMessage(null);
      },
    );
    expect(result).toEqual({ first: [9], second: [1], current: [1] });
  } finally {
    worker.terminate();
  }
});

it('transfers isolated worker deliveries without detaching the shared capture', async () => {
  const fileName = name();
  const owner = client(fileName);
  await owner.ready;
  const follower = client(fileName);
  await follower.ready;
  const first = channel(owner);
  const second = channel(follower);
  const [firstOpen, secondOpen] = await Promise.all([first.open, second.open]);
  const content = { ...options, content: { maxBytes: 16 * 1024 * 1024 } };
  await register(firstOpen, 'local-ownership-probe-one', content);
  await register(secondOpen, 'follower-ownership-probe-two', content);
  for (const bytes of [new Uint8Array([1]), new Uint8Array([2])]) {
    await owner.writeFileBuffer('/ownership', bytes);
    const [one, two] = await Promise.all([first.next('event'), second.next('event')]);
    for (const frame of [one, two]) {
      if (frame.change.content.status !== 'included') throw new Error('Expected included content');
      expect(frame.change.path).toBe('/ownership');
      expect(frame.change.content.bytes).toEqual(bytes);
    }
    const [oneProbe, twoProbe] = await Promise.all([first.next('event'), second.next('event')]);
    expect([oneProbe.change.path, twoProbe.change.path]).toEqual([
      '/.ownership-probe-ok-local-ownership-probe-one',
      '/.ownership-probe-ok-follower-ownership-probe-two',
    ]);
  }
  firstOpen.close();
  secondOpen.close();
});

it.each(['subarray', 'sab', 'detached'])(
  'interrupts a %s included delivery without failing its mutation',
  async (kind) => {
    const owner = client(name());
    await owner.ready;
    const subscription = channel(owner);
    const open = await subscription.open;
    await register(open, `local-invalid-buffer-${kind}`, { ...options, content: { maxBytes: 16 * 1024 * 1024 } });
    await expect(owner.writeFileBuffer('/invalid-delivery', new Uint8Array([1]))).resolves.toBeUndefined();
    await expect(subscription.interrupted()).resolves.toBe('SUBSCRIPTION_RESYNC_REQUIRED');
  },
);

it.each(['borrowed-buffer', 'reused-buffer'])('interrupts an included delivery that uses a %s', async (kind) => {
  const owner = client(name());
  await owner.ready;
  const subscription = channel(owner);
  const open = await subscription.open;
  await register(open, `local-invalid-buffer-${kind}`, { ...options, content: { maxBytes: 16 * 1024 * 1024 } });
  await expect(owner.writeFileBuffer('/invalid-delivery', new Uint8Array([1]))).resolves.toBeUndefined();
  await expect(subscription.interrupted()).resolves.toBe('SUBSCRIPTION_RESYNC_REQUIRED');
});

it('delivers an owned capture slice', async () => {
  const owner = client(name());
  await owner.ready;
  const subscription = channel(owner);
  const open = await subscription.open;
  await register(open, 'local-owned-slice', { ...options, content: { maxBytes: 16 * 1024 * 1024 } });
  await owner.writeFileBuffer('/owned-slice', new Uint8Array([1]));
  await expect(subscription.next('event')).resolves.toMatchObject({
    change: { path: '/owned-slice', content: { status: 'included', bytes: new Uint8Array([1]) } },
  });
  open.close();
});

it('releases its runtime and client slots when an included post failure reports an interruption', async () => {
  const owner = client(name());
  await owner.ready;
  const failed = channel(owner);
  const healthy = channel(owner);
  const [failedOpen, healthyOpen] = await Promise.all([failed.open, healthy.open]);
  const content = { ...options, content: { maxBytes: 16 * 1024 * 1024 } };
  await register(failedOpen, 'local-post-failure-report', content);
  await register(healthyOpen, 'local-cleanup-probe', content);
  await expect(owner.writeFileBuffer('/post-failure', new Uint8Array([1]))).resolves.toBeUndefined();
  await expect(failed.interrupted()).resolves.toBe('SUBSCRIPTION_INTERRUPTED');
  await expect(healthy.next('event')).resolves.toMatchObject({ subscriptionId: 'local-cleanup-probe' });
  await expect(healthy.next('event')).resolves.toMatchObject({ change: { path: '/.post-cleanup-client-closed-1' } });
  const replacements = Array.from({ length: 31 }, () => channel(owner));
  const replacementOpens = await Promise.all(replacements.map(({ open }) => open));
  for (const [index, replacement] of replacementOpens.entries()) {
    const subscriptionId = `local-released-${index}`;
    await expect(replacement.request({ type: 'register', subscriptionId, options })).resolves.toEqual({
      type: 'registered',
      subscriptionId,
    });
  }
  healthyOpen.close();
  for (const replacement of replacementOpens) replacement.close();
});

it('releases the core client after an included post and interruption both fail', async () => {
  const owner = client(name());
  await owner.ready;
  const failed = channel(owner);
  const healthy = channel(owner);
  const [failedOpen, healthyOpen] = await Promise.all([failed.open, healthy.open]);
  const content = { ...options, content: { maxBytes: 16 * 1024 * 1024 } };
  await register(failedOpen, 'local-post-failure-both', content);
  await register(healthyOpen, 'local-cleanup-probe', content);
  await expect(owner.writeFileBuffer('/post-failure-both', new Uint8Array([1]))).resolves.toBeUndefined();
  await expect(healthy.next('event')).resolves.toMatchObject({ subscriptionId: 'local-cleanup-probe' });
  await expect(healthy.next('event')).resolves.toMatchObject({ change: { path: '/.post-cleanup-client-closed-1' } });
  healthyOpen.close();
});

it('holds 32 registered IDs across channels until terminal acknowledgement releases one', async () => {
  const vfs = client(name());
  await vfs.ready;
  const first = channel(vfs);
  const second = channel(vfs);
  const [firstOpen, secondOpen] = await Promise.all([first.open, second.open]);
  const held = Array.from({ length: 32 }, (_, index) => `local-held-${index}`);
  for (const [index, subscriptionId] of held.entries()) {
    await expect(
      (index < 16 ? firstOpen : secondOpen).request({ type: 'register', subscriptionId, options }),
    ).resolves.toEqual({
      type: 'registered',
      subscriptionId,
    });
  }
  await expect(
    firstOpen.request({ type: 'register', subscriptionId: 'local-over-limit', options }),
  ).rejects.toBeDefined();
  await firstOpen.request({ type: 'activate', subscriptionId: held[0]! });
  await vfs.writeFileBuffer('/terminal', new Uint8Array([1]));
  await expect(first.next('terminal')).resolves.toMatchObject({ subscriptionId: held[0] });
  await firstOpen.request({ type: 'terminal-ack', subscriptionId: held[0]! });
  await expect(first.next('closed')).resolves.toMatchObject({ subscriptionId: held[0] });
  await expect(firstOpen.request({ type: 'register', subscriptionId: 'local-released', options })).resolves.toEqual({
    type: 'registered',
    subscriptionId: 'local-released',
  });
});

it('caps owner admission at 128 IDs across normal clients', async () => {
  const fileName = name();
  const owner = client(fileName);
  await owner.ready;
  const followers = [client(fileName), client(fileName), client(fileName), client(fileName)];
  await Promise.all(followers.map((follower) => follower.ready));
  const channels = await Promise.all([channel(owner), ...followers.slice(0, 3).map(channel)].map(({ open }) => open));
  for (const [clientIndex, open] of channels.entries()) {
    for (let slot = 0; slot < 32; slot++) {
      const subscriptionId = clientIndex === 0 ? `local-${slot}` : `follower-${clientIndex}-${slot}`;
      await expect(open.request({ type: 'register', subscriptionId, options })).resolves.toEqual({
        type: 'registered',
        subscriptionId,
      });
    }
  }
  const extra = channel(followers[3]!);
  const extraOpen = await extra.open;
  await expect(
    extraOpen.request({ type: 'register', subscriptionId: 'follower-over-mount', options }),
  ).rejects.toBeDefined();
});

it('rejects unavailable and passive change sources', async () => {
  const fileName = name();
  const owner = new OpfsVfsWorker(fileName);
  clients.push(owner);
  owners.set(fileName, owner);
  await owner.ready;
  await expect(
    owner.openFileChangeChannel(
      () => {},
      () => {},
      () => {},
    ),
  ).rejects.toMatchObject({ code: 'ENOTSUP' });
  const inspected = await inspectWorker(fileName);
  expect(inspected).not.toBeNull();
  const passive = new OpfsVfsWorker(fileName, { attachTo: inspected!.generation });
  clients.push(passive);
  await passive.ready;
  await expect(
    passive.openFileChangeChannel(
      () => {},
      () => {},
      () => {},
    ),
  ).rejects.toMatchObject({ code: 'EPERM' });
});

it('releases every failed unavailable channel open', async () => {
  const vfs = new OpfsVfsWorker(name());
  clients.push(vfs);
  await vfs.ready;
  for (let attempt = 0; attempt < 33; attempt++) {
    await expect(
      vfs.openFileChangeChannel(
        () => {},
        () => {},
        () => {},
      ),
    ).rejects.toMatchObject({ code: 'ENOTSUP' });
  }
});

it('redacts relayed change control errors', async () => {
  const fileName = name();
  const owner = client(fileName);
  await owner.ready;
  const follower = client(fileName);
  await follower.ready;
  const local = await channel(owner).open;
  await expect(
    local.request({ type: 'register', subscriptionId: 'local-error-detail', options }),
  ).rejects.toMatchObject({
    code: 'EINVAL',
    message: 'File change control failed: EINVAL',
  });
  const worker = owner as unknown as {
    requestWorker: (...args: unknown[]) => Promise<unknown>;
    remoteErrors: WeakSet<object>;
  };
  const requestWorker = worker.requestWorker;
  const relayError = Object.assign(new Error('Rejected /private/path by /secret.*/'), { code: 'EINVAL' });
  worker.remoteErrors.add(relayError);
  const workerError = vi
    .spyOn(worker, 'requestWorker')
    .mockImplementation((type, ...args) =>
      type === 'FILE_CHANGES_COMMAND' ? Promise.reject(relayError) : requestWorker.call(owner, type, ...args),
    );
  const open = await channel(follower).open;
  try {
    await expect(
      open.request({ type: 'register', subscriptionId: 'follower-error-detail', options }),
    ).rejects.toMatchObject({
      code: 'EINVAL',
      message: 'File change control failed: EINVAL',
    });
  } finally {
    workerError.mockRestore();
    open.close();
  }
});

it('reports a disconnected follower change channel with its transport diagnostic', async () => {
  const fileName = name();
  const owner = client(fileName);
  await owner.ready;
  const follower = client(fileName);
  await follower.ready;
  const open = await channel(follower).open;
  const followerId = (follower as unknown as { attachmentId: string }).attachmentId;
  (owner as unknown as { deadClients: Set<string> }).deadClients.add(followerId);
  await expect(
    open.request({ type: 'register', subscriptionId: 'follower-disconnected', options }),
  ).rejects.toMatchObject({
    code: 'VFS_ATTACHMENT_LOST',
    message: 'The follower disconnected. Reconnect to use this volume.',
  });
  open.close();
});

it('reports a follower channel rejected during its liveness check with its transport diagnostic', async () => {
  const fileName = name();
  const owner = client(fileName);
  await owner.ready;
  const follower = client(fileName);
  await follower.ready;
  const followerId = (follower as unknown as { attachmentId: string }).attachmentId;
  const leader = owner as unknown as {
    watchClient: (clientId: string) => Promise<boolean>;
    clientChecks: Map<string, Promise<boolean>>;
  };
  leader.clientChecks.delete(followerId);
  const watchClient = vi.spyOn(leader, 'watchClient').mockResolvedValue(false);
  try {
    await expect(channel(follower).open).rejects.toMatchObject({
      code: 'VFS_ATTACHMENT_LOST',
      message: 'The follower disconnected. Reconnect to use this volume.',
    });
    expect(watchClient).toHaveBeenCalledWith(followerId);
  } finally {
    watchClient.mockRestore();
  }
});

it('does not accept a follower route forged inside a control command', async () => {
  const fileName = name();
  const owner = client(fileName);
  await owner.ready;
  const follower = client(fileName);
  await follower.ready;
  const subscription = channel(follower);
  const open = await subscription.open;
  await expect(
    open.request({
      type: 'register',
      subscriptionId: 'local-forged',
      options,
      route: 'local',
    } as unknown as ChangeCommand),
  ).rejects.toMatchObject({ code: 'EINVAL' });
  open.close();
});

it('rejects feature commands forged through the ordinary shared command route', async () => {
  const fileName = name();
  const owner = client(fileName);
  await owner.ready;
  const follower = client(fileName);
  await follower.ready;
  const state = follower as unknown as { attachmentId: string; leaderGeneration: string };
  const discovery = new BroadcastChannel(`opfs-vfs-${fileName}`);
  const id = 991;
  const tabId = 'forged-change-route';
  try {
    const response = new Promise<{ type: string; result?: { code?: string } }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Missing forged-route response')), 5_000);
      discovery.onmessage = ({ data }) => {
        if (data.id !== id || data.tabId !== tabId) return;
        clearTimeout(timer);
        resolve(data);
      };
    });
    discovery.postMessage({
      type: 'COMMAND',
      id,
      tabId,
      clientId: state.attachmentId,
      generation: state.leaderGeneration,
      payload: {
        type: 'FILE_CHANGES_OPEN',
        payload: { clientId: 'forged-client', channelId: 'forged-channel', route: 'local' },
      },
    });
    await expect(response).resolves.toMatchObject({ type: 'RESPONSE_ERROR', result: { code: 'EPERM' } });
    const subscription = channel(follower);
    const open = await subscription.open;
    await register(open, 'follower-after-forgery');
    await owner.writeFileBuffer('/unaffected', new Uint8Array([1]));
    await expect(subscription.next('event')).resolves.toMatchObject({ change: { path: '/unaffected' } });
    open.close();
  } finally {
    discovery.close();
  }
});

it('cannot revive a channel closed while its register control is in flight', async () => {
  const originalPost = Worker.prototype.postMessage;
  let release: (() => void) | undefined;
  const post = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: Worker, message, transfer) {
    if (message.type === 'FILE_CHANGES_COMMAND' && message.payload?.command?.type === 'register' && !release) {
      release = () => originalPost.call(this, message, transfer as StructuredSerializeOptions);
      return;
    }
    originalPost.call(this, message, transfer as StructuredSerializeOptions);
  });
  try {
    const vfs = client(name());
    await vfs.ready;
    const first = channel(vfs);
    const open = await first.open;
    const registering = open.request({ type: 'register', subscriptionId: 'local-racing', options });
    await until(() => release !== undefined);
    open.close();
    release!();
    await registering.catch(() => {});
    const replacement = channel(vfs);
    const replacementOpen = await replacement.open;
    await expect(
      replacementOpen.request({ type: 'register', subscriptionId: 'local-racing', options }),
    ).resolves.toEqual({
      type: 'registered',
      subscriptionId: 'local-racing',
    });
    replacementOpen.close();
  } finally {
    post.mockRestore();
    release?.();
  }
});

it('rejects a channel open released after its owning client is disposed', async () => {
  const originalPost = Worker.prototype.postMessage;
  let release: (() => void) | undefined;
  const post = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: Worker, message, transfer) {
    if (message.type === 'FILE_CHANGES_OPEN' && !release) {
      release = () => originalPost.call(this, message, transfer as StructuredSerializeOptions);
      return;
    }
    originalPost.call(this, message, transfer as StructuredSerializeOptions);
  });
  try {
    const vfs = client(name());
    await vfs.ready;
    const opening = vfs.openFileChangeChannel(
      () => {},
      () => {},
      () => {},
    );
    await until(() => release !== undefined);
    vfs.dispose();
    release!();
    await expect(opening).rejects.toBeDefined();
  } finally {
    post.mockRestore();
    release?.();
  }
});

it('bounds pending local channel opens before they reach the worker', async () => {
  const originalPost = Worker.prototype.postMessage;
  const held: (() => void)[] = [];
  const post = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: Worker, message, transfer) {
    if (message.type === 'FILE_CHANGES_OPEN') {
      held.push(() => originalPost.call(this, message, transfer as StructuredSerializeOptions));
      return;
    }
    originalPost.call(this, message, transfer as StructuredSerializeOptions);
  });
  try {
    const vfs = client(name());
    await vfs.ready;
    const opens = Array.from({ length: 32 }, () =>
      vfs
        .openFileChangeChannel(
          () => {},
          () => {},
          () => {},
        )
        .catch(() => undefined),
    );
    await until(() => held.length === 32);
    await expect(
      vfs.openFileChangeChannel(
        () => {},
        () => {},
        () => {},
      ),
    ).rejects.toMatchObject({ code: 'ENOSPC' });
    vfs.dispose();
    for (const release of held) release();
    await Promise.allSettled(opens);
  } finally {
    post.mockRestore();
    for (const release of held) release();
  }
});

it('elides a register canceled while queued behind an earlier control', async () => {
  const fileName = name();
  const owner = client(fileName);
  await owner.ready;
  const follower = client(fileName);
  await follower.ready;
  const first = channel(follower);
  const open = await first.open;
  await register(open, 'follower-blocker');
  const originalPost = Worker.prototype.postMessage;
  let release: (() => void) | undefined;
  const hold = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: Worker, message, transfer) {
    if (message.type === 'FILE_CHANGES_COMMAND' && message.payload?.command?.type === 'activate' && !release) {
      release = () => originalPost.call(this, message, transfer as StructuredSerializeOptions);
      return;
    }
    originalPost.call(this, message, transfer as StructuredSerializeOptions);
  });
  try {
    const activating = open.request({ type: 'activate', subscriptionId: 'follower-blocker' });
    await until(() => release !== undefined);
    const registering = open.request({ type: 'register', subscriptionId: 'follower-before', options });
    const cancelling = open.request({ type: 'cancel', subscriptionId: 'follower-before' });
    await cancelling;
    release!();
    await activating;
    await expect(registering).rejects.toBeDefined();
    for (let slot = 0; slot < 31; slot++)
      await expect(
        open.request({ type: 'register', subscriptionId: `follower-free-${slot}`, options }),
      ).resolves.toMatchObject({
        type: 'registered',
      });
    open.close();
  } finally {
    hold.mockRestore();
    release?.();
  }
});

it('cancels a register after owner forwarding without retaining its slot', async () => {
  const originalPost = Worker.prototype.postMessage;
  let release: (() => void) | undefined;
  const post = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: Worker, message, transfer) {
    if (message.type === 'FILE_CHANGES_COMMAND' && message.payload?.command?.type === 'register' && !release) {
      release = () => originalPost.call(this, message, transfer as StructuredSerializeOptions);
      return;
    }
    originalPost.call(this, message, transfer as StructuredSerializeOptions);
  });
  try {
    const fileName = name();
    const owner = client(fileName);
    await owner.ready;
    const follower = client(fileName);
    await follower.ready;
    const first = channel(follower);
    const open = await first.open;
    const registering = open.request({ type: 'register', subscriptionId: 'follower-after', options });
    await until(() => release !== undefined);
    const cancelling = open.request({ type: 'cancel', subscriptionId: 'follower-after' });
    release!();
    await Promise.allSettled([registering, cancelling]);
    const replacement = channel(follower);
    const replacementOpen = await replacement.open;
    await expect(
      replacementOpen.request({ type: 'register', subscriptionId: 'follower-after', options }),
    ).resolves.toEqual({
      type: 'registered',
      subscriptionId: 'follower-after',
    });
    replacementOpen.close();
  } finally {
    post.mockRestore();
    release?.();
  }
});

it('releases a departed follower’s feature slots before its held ordinary worker request settles', async () => {
  const fileName = name();
  const owner = client(fileName);
  await owner.ready;
  const departed = client(fileName);
  const live = [client(fileName), client(fileName), client(fileName)];
  await Promise.all([departed.ready, ...live.map((vfs) => vfs.ready)]);
  const all = [departed, ...live];
  for (const [clientIndex, vfs] of all.entries()) {
    const open = await channel(vfs).open;
    for (let slot = 0; slot < 32; slot++) {
      const subscriptionId = `follower-live-${clientIndex}-${slot}`;
      await open.request({ type: 'register', subscriptionId, options });
    }
  }
  const originalPost = Worker.prototype.postMessage;
  let release: (() => void) | undefined;
  const hold = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: Worker, message, transfer) {
    if (message.type === 'EXISTS' && !release) {
      release = () => originalPost.call(this, message, transfer as StructuredSerializeOptions);
      return;
    }
    originalPost.call(this, message, transfer as StructuredSerializeOptions);
  });
  try {
    const ordinary = departed.exists('/held').catch(() => false);
    await until(() => release !== undefined);
    departed.dispose();
    const replacement = client(fileName);
    await replacement.ready;
    const open = await channel(replacement).open;
    for (let slot = 0; slot < 32; slot++) {
      const subscriptionId = `follower-replacement-${slot}`;
      await expect(open.request({ type: 'register', subscriptionId, options })).resolves.toEqual({
        type: 'registered',
        subscriptionId,
      });
    }
    release!();
    await ordinary;
    open.close();
  } finally {
    hold.mockRestore();
    release?.();
  }
});
