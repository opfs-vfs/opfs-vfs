import { expect, it, vi } from 'vitest';
import { OpfsVfsWorker } from '../index_internal';

const name = () => `status-${crypto.randomUUID()}.bin`;
const state = (client: OpfsVfsWorker) =>
  client as unknown as { worker: Worker | null; channel: BroadcastChannel; generation: string; leaderReady: boolean };
async function until(predicate: () => boolean) {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Worker state did not settle');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

it('reports opening then a stable ready leader snapshot without file commands', async () => {
  const fileName = name();
  const client = new OpfsVfsWorker(fileName);
  const seen: string[] = [];
  const unsubscribe = client.subscribeStatus(() => seen.push(client.getStatus().state));
  try {
    expect(client.getStatus()).toMatchObject({ fileName, state: 'opening', role: null });
    await client.ready;
    await until(() => seen.includes('ready'));
    const status = client.getStatus();
    expect(status).toMatchObject({
      fileName,
      state: 'ready',
      role: 'leader',
      ownerGeneration: state(client).generation,
      persistence: { state: 'clean', failureRevision: 0, lastError: null, lastSalvage: null },
    });
    expect(Object.isFrozen(status)).toBe(true);
    expect(client.getStatus()).toBe(status);
    const post = vi.spyOn(state(client).worker!, 'postMessage');
    client.subscribeStatus(() => {})();
    client.getStatus();
    expect(post).not.toHaveBeenCalled();
    post.mockRestore();
  } finally {
    unsubscribe();
    await client.closeVfs();
  }
});

it('reports a follower and idle takeover without issuing a file read', async () => {
  const fileName = name();
  const owner = new OpfsVfsWorker(fileName);
  const follower = new OpfsVfsWorker(fileName);
  const seen: ReturnType<typeof follower.getStatus>[] = [];
  const unsubscribe = follower.subscribeStatus(() => seen.push(follower.getStatus()));
  try {
    await Promise.all([owner.ready, follower.ready]);
    expect(follower.getStatus()).toMatchObject({
      state: 'ready',
      role: 'follower',
      ownerGeneration: state(owner).generation,
    });
    const oldGeneration = state(owner).generation;
    await owner.closeVfs();
    await until(() => follower.getStatus().state === 'ready' && follower.getStatus().role === 'leader');
    expect(follower.getStatus().ownerGeneration).not.toBe(oldGeneration);
    expect(seen.some((status) => status.state === 'recovering')).toBe(true);
    expect(seen.at(-1)).toMatchObject({ state: 'ready', role: 'leader' });
    expect(seen.filter((status) => status.state === 'ready').at(-1)?.ownerGeneration).toBe(
      follower.getStatus().ownerGeneration,
    );
  } finally {
    unsubscribe();
    owner.dispose();
    await follower.closeVfs();
  }
});

it('reports a profile refusal and a worker crash as failures', async () => {
  const fileName = name();
  const owner = new OpfsVfsWorker(fileName);
  await owner.ready;
  const post = state(owner).channel.postMessage.bind(state(owner).channel);
  const override = vi.spyOn(state(owner).channel, 'postMessage').mockImplementation((message) => {
    post(message.type === 'LEADER_READY' ? { ...message, profile: { version: 1, plugins: [] } } : message);
  });
  const refused = new OpfsVfsWorker(fileName);
  try {
    await expect(refused.ready).rejects.toMatchObject({ code: 'VFS_PROTOCOL_MISMATCH' });
    expect(refused.getStatus()).toMatchObject({ state: 'failed', error: { code: 'VFS_PROTOCOL_MISMATCH' } });
  } finally {
    override.mockRestore();
    refused.dispose();
    await owner.closeVfs();
  }

  const crashed = new OpfsVfsWorker(name());
  try {
    await crashed.ready;
    state(crashed).worker!.dispatchEvent(new ErrorEvent('error', { error: new Error('crash') }));
    await until(() => crashed.getStatus().state === 'failed');
    expect(crashed.getStatus()).toMatchObject({ state: 'failed', error: { code: 'VFS_WORKER_FAILED' } });
  } finally {
    crashed.dispose();
  }
});

it('closes on disposal and isolates status listeners', async () => {
  const client = new OpfsVfsWorker(name());
  let unsubscribedCalls = 0;
  let delivered = 0;
  const unsubscribe = client.subscribeStatus(() => unsubscribedCalls++);
  client.subscribeStatus(() => {
    throw new Error('listener failure');
  });
  client.subscribeStatus(() => delivered++);
  unsubscribe();
  try {
    await client.ready;
    await until(() => delivered > 0);
    expect(unsubscribedCalls).toBe(0);
    client.dispose();
    expect(client.getStatus()).toEqual({
      fileName: expect.any(String),
      transport: 'dedicated',
      fallbackReason: null,
      state: 'closed',
      role: null,
      ownerGeneration: null,
      error: null,
      persistence: null,
    });
  } finally {
    client.dispose();
  }
});

it('allocates the messenger before opening its channel and closes a valid channel on disposal', () => {
  const NativeBroadcastChannel = BroadcastChannel;
  let opened = 0;
  let closed = 0;
  vi.stubGlobal(
    'BroadcastChannel',
    class extends NativeBroadcastChannel {
      constructor(channelName: string) {
        opened++;
        super(channelName);
      }

      override close() {
        closed++;
        super.close();
      }
    },
  );
  try {
    expect(() => new OpfsVfsWorker(name(), { sabSize: -65 })).toThrow();
    expect(opened).toBe(0);
    const client = new OpfsVfsWorker(name());
    expect(opened).toBe(1);
    client.dispose();
    expect(closed).toBe(1);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('publishes the latest snapshot to a subscriber added during opening and closes through closeVfs', async () => {
  const client = new OpfsVfsWorker(name());
  const states: string[] = [];
  await new Promise<void>((resolve) => {
    queueMicrotask(() => {
      client.subscribeStatus(() => states.push(client.getStatus().state));
      resolve();
    });
  });
  try {
    await client.ready;
    await until(() => states.includes('ready'));
    expect(client.getStatus()).toMatchObject({ state: 'ready', role: 'leader' });
    const worker = state(client).worker!;
    const original = worker.postMessage.bind(worker);
    let held: { message: unknown; options: StructuredSerializeOptions } | undefined;
    const post = vi.spyOn(worker, 'postMessage').mockImplementation((message, postOptions) => {
      if ((message as { type?: string }).type === 'CLOSE_VFS')
        held = { message, options: postOptions as StructuredSerializeOptions };
      else original(message, postOptions as StructuredSerializeOptions);
    });
    try {
      const close = client.closeVfs();
      await until(() => held !== undefined);
      expect(client.getStatus()).toMatchObject({
        state: 'closing',
        role: 'leader',
        ownerGeneration: state(client).generation,
        error: null,
      });
      await until(() => states.includes('closing'));
      original(held!.message, held!.options);
      await close;
    } finally {
      post.mockRestore();
    }
    await until(() => states.includes('closed'));
    expect(client.getStatus()).toMatchObject({ state: 'closed', error: null });
  } finally {
    client.dispose();
  }
});

it('rejects pending ready with an Error on plain disposal', async () => {
  const client = new OpfsVfsWorker(name());
  const ready = client.ready.then(
    () => undefined,
    (error: unknown) => error,
  );
  client.dispose();
  expect(await ready).toBeInstanceOf(Error);
});

it('reports recovering while a follower renegotiates after a reply from another generation', async () => {
  const fileName = name();
  const owner = new OpfsVfsWorker(fileName);
  const follower = new OpfsVfsWorker(fileName);
  try {
    await Promise.all([owner.ready, follower.ready]);
    const generation = follower.getStatus().ownerGeneration;
    const channel = state(owner).channel;
    const post = channel.postMessage.bind(channel);
    const held: unknown[] = [];
    const intercept = vi.spyOn(channel, 'postMessage').mockImplementation((message) => {
      if (message.type === 'LEADER_READY') held.push(message);
      else post(message.type === 'RESPONSE' ? { ...message, generation: 'other' } : message);
    });
    await expect(follower.stat('/')).rejects.toMatchObject({ code: 'VFS_ATTACHMENT_LOST' });
    expect(follower.getStatus()).toMatchObject({ state: 'recovering', role: 'follower', ownerGeneration: null });
    intercept.mockRestore();
    // The owner answers the follower's LEADER_PING either while held or after the restore.
    for (const message of held) post(message);
    await until(() => follower.getStatus().state === 'ready');
    expect(follower.getStatus().ownerGeneration).toBe(generation);
  } finally {
    follower.dispose();
    await owner.closeVfs();
  }
});

it('keeps each subscription of the same listener independent', async () => {
  const client = new OpfsVfsWorker(name());
  let calls = 0;
  const listener = () => calls++;
  const first = client.subscribeStatus(listener);
  client.subscribeStatus(listener);
  first();
  first();
  try {
    await client.ready;
    await until(() => calls > 0);
    const before = calls;
    client.dispose();
    await until(() => calls > before);
    expect(client.getStatus().state).toBe('closed');
  } finally {
    client.dispose();
  }
});

it('does not call a listener unsubscribed earlier in the same notification', async () => {
  const client = new OpfsVfsWorker(name());
  let removedCalls = 0;
  let unsubscribeSecond = () => {};
  client.subscribeStatus(() => unsubscribeSecond());
  unsubscribeSecond = client.subscribeStatus(() => removedCalls++);
  try {
    await client.ready;
    client.dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.getStatus().state).toBe('closed');
    expect(removedCalls).toBe(0);
  } finally {
    client.dispose();
  }
});

it('keeps a failed shared shutdown in the closed status', async () => {
  const client = new OpfsVfsWorker(name());
  try {
    await client.ready;
    const worker = state(client).worker!;
    const onmessage = worker.onmessage!;
    worker.onmessage = (event) => {
      const data = event.data as { id: number; type: string };
      onmessage.call(
        worker,
        data.type === 'CLOSE_VFS'
          ? new MessageEvent('message', {
              data: { id: data.id, type: 'ERROR', result: { error: 'close failed', code: 'EIO' } },
            })
          : event,
      );
    };
    await expect(client.shutdownSharedVfs()).rejects.toMatchObject({ code: 'EIO' });
    expect(client.getStatus()).toMatchObject({ state: 'closed', error: { code: 'EIO', message: 'close failed' } });
  } finally {
    client.dispose();
  }
});

it('keeps a failed follower-requested shutdown in the owner closed status', async () => {
  const fileName = name();
  const owner = new OpfsVfsWorker(fileName);
  const follower = new OpfsVfsWorker(fileName);
  try {
    await Promise.all([owner.ready, follower.ready]);
    const worker = state(owner).worker!;
    const onmessage = worker.onmessage!;
    worker.onmessage = (event) => {
      const data = event.data as { id: number; type: string };
      onmessage.call(
        worker,
        data.type === 'CLOSE_VFS'
          ? new MessageEvent('message', {
              data: { id: data.id, type: 'ERROR', result: { error: 'close failed', code: 'EIO' } },
            })
          : event,
      );
    };
    await expect(follower.shutdownSharedVfs()).rejects.toMatchObject({ code: 'EIO' });
    await until(() => owner.getStatus().state === 'closed');
    expect(owner.getStatus()).toMatchObject({ error: { code: 'EIO', message: 'close failed' } });
  } finally {
    follower.dispose();
    owner.dispose();
  }
});

it('rejects ready with an incompatible announcement that arrives during the storage preflight', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const getDirectory = navigator.storage.getDirectory.bind(navigator.storage);
  const paused = vi.spyOn(navigator.storage, 'getDirectory').mockImplementation(() => gate.then(getDirectory));
  const client = new OpfsVfsWorker(name());
  try {
    state(client).channel.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'LEADER_READY', generation: 'legacy-owner', profile: { version: 1, plugins: [] } },
      }),
    );
    await expect(client.ready).rejects.toMatchObject({ code: 'VFS_PROTOCOL_MISMATCH' });
    expect(client.getStatus()).toMatchObject({ state: 'failed', error: { code: 'VFS_PROTOCOL_MISMATCH' } });
  } finally {
    paused.mockRestore();
    release();
    client.dispose();
  }
});
