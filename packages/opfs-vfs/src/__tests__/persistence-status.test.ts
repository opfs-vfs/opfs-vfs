import { expect, it, vi } from 'vitest';
import { deleteVolume } from '../index';
import { OpfsVfsWorker } from '../index_internal';
import { persistenceFaultRequest } from './persistence-fault-plugin';

const name = () => `persistence-status-${crypto.randomUUID()}.bin`;
const factory = () => new Worker(new URL('./persistence-status-worker.ts', import.meta.url), { type: 'module' });
const state = (client: OpfsVfsWorker) =>
  client as unknown as {
    worker: Worker | null;
    channel: BroadcastChannel;
    generation: string;
    leaderGeneration?: string;
    leaderReady: boolean;
    ownerPersistence?: { generation: string; sequence: number };
  };
const frame = (generation: string, sequence: number, overrides: Record<string, unknown> = {}) => ({
  version: 1,
  generation,
  sequence,
  state: 'clean',
  failureRevision: 0,
  lastError: null,
  lastSalvage: null,
  ...overrides,
});

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Expected persistence status to settle');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fault(fileName: string, message: { type: 'fail'; count: number } | { type: 'pagehide-twice' }) {
  const channel = new BroadcastChannel(`persistence-fault-${fileName}`);
  try {
    const reply = new Promise<void>((resolve) => (channel.onmessage = () => resolve()));
    channel.postMessage(message);
    await reply;
  } finally {
    channel.close();
  }
}

const close = async (...clients: OpfsVfsWorker[]) => {
  for (const client of clients.reverse()) await client.closeVfs().catch(() => client.dispose());
};

it('reports a frozen, stable idle leader persistence snapshot', async () => {
  const fileName = name();
  const client = new OpfsVfsWorker(fileName);
  const unsubscribe = client.subscribeStatus(() => {});
  try {
    await client.ready;
    await until(() => client.getStatus().persistence !== null);
    const snapshot = client.getStatus();
    expect(snapshot).toMatchObject({
      state: 'ready',
      role: 'leader',
      ownerGeneration: state(client).generation,
      persistence: { state: 'clean', failureRevision: 0, lastError: null, lastSalvage: null },
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.persistence)).toBe(true);
    expect(client.getStatus()).toBe(snapshot);
  } finally {
    unsubscribe();
    await close(client);
    await deleteVolume(fileName);
  }
});

it('forwards idle, dirty, and clean persistence to a follower without follower commands', async () => {
  const fileName = name();
  const owner = new OpfsVfsWorker(fileName);
  const follower = new OpfsVfsWorker(fileName);
  const post = vi.spyOn(state(follower).channel, 'postMessage');
  const unsubscribe = follower.subscribeStatus(() => {});
  try {
    await Promise.all([owner.ready, follower.ready]);
    await until(() => follower.getStatus().persistence !== null);
    expect(follower.getStatus()).toMatchObject({
      ownerGeneration: state(owner).generation,
      persistence: { state: 'clean' },
    });
    expect(post.mock.calls.map(([message]) => (message as { type?: string }).type)).not.toContain('COMMAND');
    expect(
      post.mock.calls
        .map(([message]) => (message as { type?: string }).type)
        .every((type) => type === 'LEADER_PING' || type === 'PERSISTENCE_REQUEST'),
    ).toBe(true);
    await owner.writeFileBuffer('/write', new Uint8Array([1]));
    await until(() => follower.getStatus().persistence?.state === 'dirty');
    await until(() => follower.getStatus().persistence?.state === 'clean');
  } finally {
    unsubscribe();
    post.mockRestore();
    await close(follower, owner);
    await deleteVolume(fileName);
  }
});

it('retains a timer-flush failure for leaders and followers after a later clean flush', async () => {
  const fileName = name();
  const owner = new OpfsVfsWorker(fileName, { worker: factory, plugins: [persistenceFaultRequest()] });
  const follower = new OpfsVfsWorker(fileName, { worker: factory, plugins: [persistenceFaultRequest()] });
  try {
    await Promise.all([owner.ready, follower.ready]);
    await until(() => follower.getStatus().persistence !== null);
    await fault(fileName, { type: 'fail', count: 1 });
    await owner.writeFileBuffer('/first', new Uint8Array([1]));
    await until(() => [owner, follower].every((client) => client.getStatus().persistence?.state === 'error'));
    for (const client of [owner, follower])
      expect(client.getStatus().persistence).toMatchObject({
        failureRevision: 1,
        lastError: { code: 'EIO', message: 'Injected commit failure' },
      });
    await owner.writeFileBuffer('/second', new Uint8Array([2]));
    await until(() => [owner, follower].every((client) => client.getStatus().persistence?.state === 'clean'));
    for (const client of [owner, follower])
      expect(client.getStatus().persistence).toMatchObject({ failureRevision: 1, lastError: { code: 'EIO' } });
  } finally {
    await close(follower, owner);
    await deleteVolume(fileName);
  }
});

it('coalesces swallowed pagehide failure and cleanup into one clean frame', async () => {
  const fileName = name();
  const owner = new OpfsVfsWorker(fileName, { worker: factory, plugins: [persistenceFaultRequest()] });
  const follower = new OpfsVfsWorker(fileName, { worker: factory, plugins: [persistenceFaultRequest()] });
  const seen: ReturnType<typeof owner.getStatus>[] = [];
  const unsubscribe = owner.subscribeStatus(() => seen.push(owner.getStatus()));
  try {
    await Promise.all([owner.ready, follower.ready]);
    await until(() => owner.getStatus().persistence !== null && follower.getStatus().persistence !== null);
    const worker = state(owner).worker!;
    const onmessage = worker.onmessage!;
    const frames: Record<string, unknown>[] = [];
    worker.onmessage = (event) => {
      if (event.data?.type === 'PERSISTENCE_FRAME') frames.push(event.data.payload);
      onmessage.call(worker, event);
    };
    await owner.writeFileBuffer('/pagehide', new Uint8Array([1]));
    await until(() => owner.getStatus().persistence?.state === 'dirty');
    const before = frames.length;
    await fault(fileName, { type: 'pagehide-twice' });
    await until(
      () =>
        owner.getStatus().persistence?.failureRevision === 1 && follower.getStatus().persistence?.failureRevision === 1,
    );
    expect(frames.slice(before)).toHaveLength(1);
    expect(frames.at(-1)).toMatchObject({ state: 'clean', failureRevision: 1, lastError: { code: 'EIO' } });
    expect(seen.some((snapshot) => snapshot.persistence?.state === 'error')).toBe(false);
  } finally {
    unsubscribe();
    await close(follower, owner);
    await deleteVolume(fileName);
  }
});

it('reports an asynchronous command failure through persistence', async () => {
  const fileName = name();
  const client = new OpfsVfsWorker(fileName, { worker: factory, plugins: [persistenceFaultRequest()] });
  try {
    await client.ready;
    await fault(fileName, { type: 'fail', count: 1 });
    await client.writeFileBuffer('/fault', new Uint8Array([1]));
    await expect(client.sync()).rejects.toMatchObject({ code: 'EIO' });
    await until(() => client.getStatus().persistence?.state === 'error');
    expect(client.getStatus().persistence).toMatchObject({ failureRevision: 1, lastError: { code: 'EIO' } });
  } finally {
    await close(client);
    await deleteVolume(fileName);
  }
});

it('piggybacks command persistence on leader and relayed sync replies', async () => {
  const fileName = name();
  const owner = new OpfsVfsWorker(fileName);
  const follower = new OpfsVfsWorker(fileName);
  const replies = new BroadcastChannel(`opfs-vfs-${fileName}`);
  const relayed: Record<string, unknown>[] = [];
  const broadcasts: Record<string, unknown>[] = [];
  replies.onmessage = (event) => {
    if (event.data?.type === 'RESPONSE') relayed.push(event.data);
    if (event.data?.type === 'PERSISTENCE_FRAME' && !Object.hasOwn(event.data, 'request')) broadcasts.push(event.data);
  };
  try {
    await Promise.all([owner.ready, follower.ready]);
    await until(() => follower.getStatus().persistence !== null);
    const worker = state(owner).worker!;
    const onmessage = worker.onmessage!;
    const messages: Record<string, unknown>[] = [];
    worker.onmessage = (event) => {
      messages.push(event.data);
      onmessage.call(worker, event);
    };

    await owner.writeFileBuffer('/reply', new Uint8Array([1]));
    await until(() => owner.getStatus().persistence?.state === 'dirty');
    messages.length = 0;
    await owner.sync();
    await until(() => owner.getStatus().persistence?.state === 'clean');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const syncReply = messages.find((message) => message.type === 'SYNC' && Object.hasOwn(message, 'persistence'));
    expect(syncReply).toMatchObject({ persistence: { state: 'clean' } });
    expect(messages.some((message) => message.type === 'PERSISTENCE_FRAME')).toBe(false);

    await owner.writeFileBuffer('/relay', new Uint8Array([2]));
    await until(() => follower.getStatus().persistence?.state === 'dirty');
    relayed.length = 0;
    broadcasts.length = 0;
    await follower.sync();
    await until(() => relayed.some((message) => Object.hasOwn(message, 'persistence')));
    expect(relayed.find((message) => Object.hasOwn(message, 'persistence'))).toMatchObject({
      persistence: { state: 'clean' },
    });
    await until(() => follower.getStatus().persistence?.state === 'clean');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(broadcasts).toHaveLength(0);
  } finally {
    replies.close();
    await close(follower, owner);
    await deleteVolume(fileName);
  }
});

it('flushes persistence after a relayed command ends without replying', async () => {
  const fileName = name();
  const owner = new OpfsVfsWorker(fileName);
  const follower = new OpfsVfsWorker(fileName);
  const ownerState = state(owner) as ReturnType<typeof state> & {
    sendToWorker: (type: string, ...args: unknown[]) => Promise<unknown>;
    postRelayResponse: (message: Record<string, unknown>) => void;
  };
  let releaseSync!: () => void;
  const syncGate = new Promise<void>((resolve) => (releaseSync = resolve));
  let syncStarted!: () => void;
  const started = new Promise<void>((resolve) => (syncStarted = resolve));
  const sendToWorker = ownerState.sendToWorker.bind(owner);
  const send = vi.spyOn(ownerState, 'sendToWorker').mockImplementation(async (type, ...args) => {
    if (type === 'SYNC') {
      syncStarted();
      await syncGate;
    }
    return sendToWorker(type, ...args);
  });
  const reply = vi.spyOn(ownerState, 'postRelayResponse').mockImplementation(() => {});
  try {
    await Promise.all([owner.ready, follower.ready]);
    await until(() => follower.getStatus().persistence !== null);
    const before = state(follower).ownerPersistence!.sequence;
    void follower.sync().catch(() => {});
    await started;
    await owner.writeFileBuffer('/while-relayed', new Uint8Array([1]));
    await until(() => owner.getStatus().persistence?.state === 'dirty');
    releaseSync();
    await until(() => state(follower).ownerPersistence!.sequence > before);
    expect(follower.getStatus()).toMatchObject({ persistence: { state: 'clean' } });
    expect(state(follower).ownerPersistence!.sequence).toBe(state(owner).ownerPersistence!.sequence);
  } finally {
    releaseSync();
    reply.mockRestore();
    send.mockRestore();
    await close(follower, owner);
    await deleteVolume(fileName);
  }
});

it('reports a synchronous SAB failure through persistence', async () => {
  const fileName = name();
  const worker = new Worker(new URL('./persistence-status-sab-worker.ts', import.meta.url), { type: 'module' });
  try {
    const result = await new Promise<{
      syncError?: { code?: string };
      persistence?: { state: string; failureRevision: number; lastError: { code?: string } | null };
    }>((resolve) => {
      worker.onmessage = (event) => resolve(event.data);
      worker.postMessage({ fileName });
    });
    expect(result).toMatchObject({
      syncError: { code: 'EIO' },
      persistence: { state: 'error', lastError: { code: 'EIO' } },
    });
    expect(result.persistence!.failureRevision).toBeGreaterThanOrEqual(1);
  } finally {
    worker.terminate();
    await deleteVolume(fileName);
  }
});

it('gives a late subscriber only changed, final transition snapshots', async () => {
  const fileName = name();
  const client = new OpfsVfsWorker(fileName);
  try {
    await client.ready;
    await client.writeFileBuffer('/transition', new Uint8Array([1]));
    await until(() => client.getStatus().persistence?.state === 'dirty');
    const seen: ReturnType<typeof client.getStatus>[] = [];
    const unsubscribe = client.subscribeStatus(() => seen.push(client.getStatus()));
    const initial = client.getStatus();
    expect(initial.persistence?.state).toBe('dirty');
    await client.sync();
    await until(() => client.getStatus().persistence?.state === 'clean' && seen.length > 0);
    expect(seen.at(-1)).toBe(client.getStatus());
    expect(seen.at(-1)?.persistence).toMatchObject({ state: 'clean' });
    expect(seen.every((snapshot, index) => index === 0 || snapshot !== seen[index - 1])).toBe(true);
    unsubscribe();
  } finally {
    await close(client);
    await deleteVolume(fileName);
  }
});

it('rejects malformed, duplicate, reversed, and old-generation persistence frames', async () => {
  const fileName = name();
  const leader = new OpfsVfsWorker(fileName);
  try {
    await leader.ready;
    await until(() => leader.getStatus().persistence !== null);
    const worker = state(leader).worker!;
    const onmessage = worker.onmessage!;
    const accepted = frame(state(leader).generation, state(leader).ownerPersistence!.sequence);
    const stable = leader.getStatus();
    const malformed = (overrides: Record<string, unknown>) => ({
      ...accepted,
      sequence: accepted.sequence + 1,
      ...overrides,
    });
    const invalid = [
      malformed({ extra: true }),
      malformed({ version: 2 }),
      malformed({ sequence: accepted.sequence + 0.5 }),
      { ...accepted, sequence: Number.POSITIVE_INFINITY },
      malformed({ state: 'unknown' }),
      malformed({ failureRevision: 1, lastError: null }),
      malformed({ failureRevision: 0, lastError: { error: 'bad', code: 'EIO' } }),
      malformed({ failureRevision: 1, lastError: { error: 'bad', code: 'not-code' } }),
      malformed({ lastSalvage: { reason: 'bad' } }),
      { ...accepted, state: 'dirty' },
      { ...accepted, sequence: (accepted.sequence as number) - 1, state: 'dirty' },
      malformed({ generation: 'other' }),
    ];
    for (const payload of invalid) {
      onmessage.call(worker, new MessageEvent('message', { data: { type: 'PERSISTENCE_FRAME', payload } }));
      expect(leader.getStatus()).toBe(stable);
    }

    const follower = new OpfsVfsWorker(fileName);
    try {
      await follower.ready;
      await until(() => follower.getStatus().persistence !== null);
      const followerStable = follower.getStatus();
      const followerAccepted = frame(state(follower).leaderGeneration!, state(follower).ownerPersistence!.sequence);
      const followerMalformed = (overrides: Record<string, unknown>) => ({
        ...followerAccepted,
        sequence: followerAccepted.sequence + 1,
        ...overrides,
      });
      const forged = new BroadcastChannel(`opfs-vfs-${fileName}`);
      try {
        for (const payload of [
          followerMalformed({ extra: true }),
          followerMalformed({ version: 2 }),
          { ...followerAccepted, sequence: Number.POSITIVE_INFINITY },
          followerMalformed({ state: 'unknown' }),
          followerMalformed({ failureRevision: 1, lastError: null }),
          followerMalformed({ failureRevision: 0, lastError: { error: 'bad', code: 'EIO' } }),
          followerMalformed({ lastSalvage: { reason: 'bad' } }),
          followerMalformed({ generation: 'old' }),
          { ...followerAccepted, state: 'clean' },
        ]) {
          forged.postMessage({ type: 'PERSISTENCE_FRAME', payload });
          await new Promise((resolve) => setTimeout(resolve, 50)); // BroadcastChannel delivery must get a turn before asserting rejection.
          expect(follower.getStatus()).toBe(followerStable);
        }
        forged.postMessage({
          type: 'PERSISTENCE_FRAME',
          payload: { ...followerAccepted, sequence: followerAccepted.sequence + 1 },
          outer: true,
        });
        await new Promise((resolve) => setTimeout(resolve, 50)); // The outer envelope also has an exact-key contract.
        expect(follower.getStatus()).toBe(followerStable);
        forged.postMessage({
          type: 'PERSISTENCE_FRAME',
          payload: { ...followerAccepted, sequence: followerAccepted.sequence + 2, state: 'dirty' },
        });
        await until(() => follower.getStatus().persistence?.state === 'dirty');
      } finally {
        forged.close();
      }
    } finally {
      await close(follower);
    }
    onmessage.call(
      worker,
      new MessageEvent('message', {
        data: {
          type: 'PERSISTENCE_FRAME',
          payload: { ...accepted, sequence: (accepted.sequence as number) + 100, state: 'dirty' },
        },
      }),
    );
    expect(leader.getStatus().persistence?.state).toBe('dirty');
    const deliver = (payload: Record<string, unknown>) =>
      onmessage.call(worker, new MessageEvent('message', { data: { type: 'PERSISTENCE_FRAME', payload } }));
    const base = (accepted.sequence as number) + 100;
    // An error state always carries a recorded failure.
    deliver({ ...accepted, sequence: base + 1, state: 'error' });
    expect(leader.getStatus().persistence?.state).toBe('dirty');
    deliver({ ...accepted, sequence: base + 2, state: 'error', failureRevision: 2, lastError: { error: 'failed' } });
    expect(leader.getStatus().persistence).toMatchObject({ state: 'error', failureRevision: 2 });
    const retained = leader.getStatus();
    // A later frame cannot lower the failure history of the same generation.
    deliver({ ...accepted, sequence: base + 3, state: 'clean', failureRevision: 1, lastError: { error: 'older' } });
    expect(leader.getStatus()).toBe(retained);
  } finally {
    await close(leader);
    await deleteVolume(fileName);
  }
});

it('nulls a sleeping follower and accepts only a fresh post-resume snapshot', async () => {
  const fileName = name();
  const owner = new OpfsVfsWorker(fileName);
  const follower = new OpfsVfsWorker(fileName);
  const post = vi.spyOn(state(follower).channel, 'postMessage');
  try {
    await Promise.all([owner.ready, follower.ready]);
    await until(() => follower.getStatus().persistence !== null);
    const original = state(follower).channel.onmessage!;
    let asleep = true;
    state(follower).channel.onmessage = (event) => {
      if (asleep && event.data?.type === 'PERSISTENCE_FRAME') return;
      original.call(state(follower).channel, event);
    };
    const before = follower.getStatus().persistence!;
    const preSequence = state(follower).ownerPersistence!.sequence;
    await owner.writeFileBuffer('/sleep', new Uint8Array([1]));
    await until(() => owner.getStatus().persistence?.state === 'dirty');
    // The dropped broadcasts left the follower on its pre-sleep value.
    expect(follower.getStatus().persistence).toBe(before);
    asleep = false;
    const ownerGeneration = state(owner).generation;
    document.dispatchEvent(new Event('resume'));
    expect(follower.getStatus()).toMatchObject({ state: 'recovering', persistence: null });
    const forged = new BroadcastChannel(`opfs-vfs-${fileName}`);
    try {
      // A frame the follower accepted before sleeping must not restore the value after resume.
      forged.postMessage({
        type: 'PERSISTENCE_FRAME',
        payload: frame(state(owner).generation, preSequence, { state: before.state }),
      });
      await until(
        () =>
          follower.getStatus().state === 'ready' &&
          follower.getStatus().ownerGeneration === ownerGeneration &&
          follower.getStatus().persistence !== null,
      );
    } finally {
      forged.close();
    }
    expect(state(follower).ownerPersistence!.sequence).toBeGreaterThan(preSequence);
    expect(['dirty', 'flushing', 'clean']).toContain(follower.getStatus().persistence!.state);
    expect(follower.getStatus()).toMatchObject({ state: 'ready', ownerGeneration });
    expect(post.mock.calls.map(([message]) => (message as { type?: string }).type)).not.toContain('COMMAND');
  } finally {
    post.mockRestore();
    await close(follower, owner);
    await deleteVolume(fileName);
  }
});

it('ignores an in-flight stale worker frame while a leader resumes', async () => {
  const fileName = name();
  const leader = new OpfsVfsWorker(fileName);
  try {
    await leader.ready;
    await until(() => leader.getStatus().persistence !== null);
    const worker = state(leader).worker!;
    const onmessage = worker.onmessage!;
    let held: MessageEvent | undefined;
    worker.onmessage = (event) => {
      if (!held && event.data?.type === 'PERSISTENCE_FRAME') {
        held = event;
        return;
      }
      onmessage.call(worker, event);
    };
    await leader.writeFileBuffer('/stale', new Uint8Array([1]));
    await until(() => held !== undefined);
    document.dispatchEvent(new Event('resume'));
    expect(leader.getStatus().persistence).toBeNull();
    onmessage.call(worker, held!);
    expect(leader.getStatus().persistence).toBeNull();
    await until(() => leader.getStatus().persistence !== null);
  } finally {
    await close(leader);
    await deleteVolume(fileName);
  }
});

it('drops old persistence when a sleeping follower takes over', async () => {
  const fileName = name();
  const owner = new OpfsVfsWorker(fileName, { worker: factory, plugins: [persistenceFaultRequest()] });
  const follower = new OpfsVfsWorker(fileName, { worker: factory, plugins: [persistenceFaultRequest()] });
  const seen: ReturnType<typeof follower.getStatus>[] = [];
  const unsubscribe = follower.subscribeStatus(() => seen.push(follower.getStatus()));
  try {
    await Promise.all([owner.ready, follower.ready]);
    await fault(fileName, { type: 'fail', count: 1 });
    await owner.writeFileBuffer('/failed', new Uint8Array([1]));
    await until(() => follower.getStatus().persistence?.failureRevision === 1);
    const oldGeneration = state(owner).generation;
    const onmessage = state(follower).channel.onmessage!;
    let asleep = true;
    state(follower).channel.onmessage = (event) => {
      if (!asleep) onmessage.call(state(follower).channel, event);
    };
    await owner.closeVfs();
    seen.length = 0;
    asleep = false;
    document.dispatchEvent(new Event('resume'));
    await until(
      () =>
        follower.getStatus().state === 'ready' &&
        follower.getStatus().role === 'leader' &&
        follower.getStatus().persistence !== null,
    );
    expect(follower.getStatus().ownerGeneration).not.toBe(oldGeneration);
    expect(follower.getStatus().persistence).toMatchObject({ failureRevision: 0, lastError: null });
    expect(seen.some((snapshot) => snapshot.ownerGeneration === oldGeneration && snapshot.persistence !== null)).toBe(
      false,
    );
  } finally {
    unsubscribe();
    owner.dispose();
    await close(follower);
    await deleteVolume(fileName);
  }
});

it('includes mount-time WAL salvage in the initial persistence snapshot', async () => {
  const fileName = name();
  const first = new OpfsVfsWorker(fileName, { bufferMode: 'memory', localDurabilityMode: 'strict' });
  try {
    await first.ready;
    await first.writeFileBuffer('/bad', new Uint8Array([1, 2, 3]));
    first.dispose();
    const root = await navigator.storage.getDirectory();
    const log = await root.getFileHandle(fileName.replace(/\.bin$/, '.data.log'));
    const bytes = new Uint8Array(await (await log.getFile()).arrayBuffer());
    bytes[bytes.length - 1] ^= 0xff;
    const writable = await log.createWritable({ keepExistingData: true });
    await writable.write(bytes);
    await writable.close();
    const reopened = new OpfsVfsWorker(fileName, { bufferMode: 'memory', localDurabilityMode: 'strict' });
    try {
      await reopened.ready;
      await until(() => reopened.getStatus().persistence !== null);
      const persistence = reopened.getStatus().persistence!;
      expect(persistence.lastSalvage).toMatchObject({
        reason: 'corrupt-frame',
        truncatedAt: expect.any(Number),
        discardedBytes: expect.any(Number),
      });
      expect(Object.isFrozen(persistence)).toBe(true);
      expect(Object.isFrozen(persistence.lastSalvage)).toBe(true);
    } finally {
      await close(reopened);
    }
  } finally {
    first.dispose();
    await deleteVolume(fileName);
  }
});

it('requires the persistence capability and gates raw worker frames behind a request', async () => {
  const fileName = name();
  const owner = new OpfsVfsWorker(fileName);
  await owner.ready;
  const send = state(owner).channel.postMessage.bind(state(owner).channel);
  const profile = vi
    .spyOn(state(owner).channel, 'postMessage')
    .mockImplementation((message) =>
      send(
        message.type === 'LEADER_READY'
          ? { ...message, profile: { version: 2, plugins: [], capabilities: ['error-details'] } }
          : message,
      ),
    );
  const follower = new OpfsVfsWorker(fileName);
  const followerPost = vi.spyOn(state(follower).channel, 'postMessage');
  try {
    await expect(follower.ready).rejects.toMatchObject({ code: 'VFS_PROTOCOL_MISMATCH' });
    expect(followerPost.mock.calls.map(([message]) => (message as { type?: string }).type)).not.toContain(
      'PERSISTENCE_REQUEST',
    );
  } finally {
    profile.mockRestore();
    followerPost.mockRestore();
    follower.dispose();
    await close(owner);
    await deleteVolume(fileName);
  }

  const rawName = name();
  const raw = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' });
  const messages: Record<string, unknown>[] = [];
  raw.onmessage = (event) => messages.push(event.data);
  const generation = crypto.randomUUID();
  try {
    raw.postMessage({ id: 1, type: 'PING' });
    await until(() => messages.some((message) => message.type === 'PONG'));
    raw.postMessage({ id: 2, type: 'INIT', payload: { fileName: rawName, generation } });
    await until(() => messages.some((message) => message.id === 2 && message.type === 'INIT'));
    raw.postMessage({ id: 3, type: 'MKDIR', payload: { path: '/raw' } });
    await until(() => messages.some((message) => message.id === 3 && message.type === 'MKDIR'));
    await new Promise((resolve) => setTimeout(resolve, 50)); // No request means the worker must not emit a frame.
    expect(messages.some((message) => message.type === 'PERSISTENCE_FRAME')).toBe(false);
    raw.postMessage({ id: 4, type: 'PERSISTENCE_STATUS', payload: { version: 1, generation } });
    await until(() => messages.some((message) => message.id === 4 && message.type === 'PERSISTENCE_STATUS'));
    expect(messages.find((message) => message.id === 4)).toMatchObject({ result: { sequence: 1 } });
    expect(messages.some((message) => message.type === 'PERSISTENCE_FRAME')).toBe(false);
    // Settle to clean first (the first MKDIR may still be dirty), so the next MKDIR is a real transition.
    raw.postMessage({ id: 50, type: 'SYNC', payload: {} });
    await until(() => messages.some((message) => message.id === 50 && message.type === 'SYNC'));
    raw.postMessage({ id: 5, type: 'MKDIR', payload: { path: '/after-request' } });
    await until(() =>
      messages.some((message) => message.id === 5 && message.type === 'MKDIR' && Object.hasOwn(message, 'persistence')),
    );
    const requested = (messages.find((message) => message.id === 4) as { result: { sequence: number } }).result;
    const piggybacked = (
      messages.find((message) => message.id === 5) as { persistence: { sequence: number; state: string } }
    ).persistence;
    expect(piggybacked.state).toBe('dirty');
    expect(piggybacked.sequence).toBeGreaterThan(requested.sequence);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(messages.some((message) => message.type === 'PERSISTENCE_FRAME')).toBe(false);
    raw.postMessage({ id: 6, type: 'PERSISTENCE_STATUS', payload: { version: 1, generation: 'other' } });
    raw.postMessage({ id: 7, type: 'PERSISTENCE_STATUS', payload: { version: 1, generation, extra: true } });
    await until(
      () =>
        messages.some((message) => message.id === 6 && message.type === 'ERROR') &&
        messages.some((message) => message.id === 7 && message.type === 'ERROR'),
    );
    raw.postMessage({ id: 8, type: 'CLOSE_VFS', payload: {} });
    await until(() => messages.some((message) => message.id === 8 && message.type === 'CLOSE_VFS'));
  } finally {
    raw.terminate();
    await deleteVolume(rawName);
  }
});

it('coalesces persistence notifications and isolates throwing listeners', async () => {
  const fileName = name();
  const client = new OpfsVfsWorker(fileName);
  let calls = 0;
  client.subscribeStatus(() => {
    throw new Error('listener failure');
  });
  client.subscribeStatus(() => calls++);
  try {
    await client.ready;
    await until(() => client.getStatus().persistence !== null && calls > 0);
    const before = calls;
    const worker = state(client).worker!;
    const onmessage = worker.onmessage!;
    const sequence = state(client).ownerPersistence!.sequence;
    for (const [offset, persistence] of [
      [1, { state: 'dirty' }],
      [2, { state: 'clean' }],
    ] as const) {
      onmessage.call(
        worker,
        new MessageEvent('message', {
          data: { type: 'PERSISTENCE_FRAME', payload: frame(state(client).generation, sequence + offset, persistence) },
        }),
      );
    }
    await until(() => calls > before);
    expect(calls).toBe(before + 1);
    expect(client.getStatus().persistence?.state).toBe('clean');
  } finally {
    await close(client);
    await deleteVolume(fileName);
  }
});

it('keeps persistence null while a follower is still opening', async () => {
  const fileName = name();
  const owner = new OpfsVfsWorker(fileName);
  await owner.ready;
  const follower = new OpfsVfsWorker(fileName);
  const attachmentId = (follower as unknown as { attachmentId: string }).attachmentId;
  // Hold the follower's attachment lock so it stays opening after the owner answered its snapshot request.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const acquired = new Promise<void>((resolve) => {
    void navigator.locks.request(`opfs-vfs-client-${fileName}-${attachmentId}`, () => {
      resolve();
      return held;
    });
  });
  const seen: ReturnType<typeof follower.getStatus>[] = [];
  const unsubscribe = follower.subscribeStatus(() => seen.push(follower.getStatus()));
  try {
    await acquired;
    await until(() => state(follower).ownerPersistence?.generation === state(owner).generation);
    expect(follower.getStatus()).toMatchObject({ state: 'opening', ownerGeneration: null, persistence: null });
    release();
    await follower.ready;
    await until(() => follower.getStatus().persistence !== null);
    expect(seen.every((snapshot) => snapshot.state !== 'opening' || snapshot.persistence === null)).toBe(true);
  } finally {
    release();
    unsubscribe();
    await close(follower, owner);
    await deleteVolume(fileName);
  }
});

it('accepts only the reply to its own snapshot request after a follower resumes', async () => {
  const fileName = name();
  const owner = new OpfsVfsWorker(fileName);
  const follower = new OpfsVfsWorker(fileName);
  try {
    await Promise.all([owner.ready, follower.ready]);
    await until(() => follower.getStatus().persistence !== null);
    const generation = state(owner).generation;
    const preSequence = state(follower).ownerPersistence!.sequence;
    // Hold the follower's snapshot request so it renegotiates but has no fresh frame yet.
    const channel = state(follower).channel;
    const send = channel.postMessage.bind(channel);
    let held: unknown;
    const post = vi.spyOn(channel, 'postMessage').mockImplementation((message) => {
      if (message?.type === 'PERSISTENCE_REQUEST' && held === undefined) held = message;
      else send(message);
    });
    document.dispatchEvent(new Event('resume'));
    await until(() => follower.getStatus().state === 'ready' && held !== undefined);
    expect(follower.getStatus()).toMatchObject({ ownerGeneration: generation, persistence: null });
    // A frame the follower never saw, generated before its request (for example still queued on the owner's worker
    // port), is newer than its floor but cannot prove the value is current. Neither can another follower's reply.
    for (const data of [
      { type: 'PERSISTENCE_FRAME', payload: frame(generation, preSequence + 1, { state: 'recovering' }) },
      {
        type: 'PERSISTENCE_FRAME',
        payload: frame(generation, preSequence + 2, { state: 'recovering' }),
        request: 'other',
      },
      { type: 'PERSISTENCE_FRAME', payload: frame(generation, preSequence, { state: 'recovering' }) },
    ]) {
      channel.dispatchEvent(new MessageEvent('message', { data }));
      expect(follower.getStatus().persistence).toBeNull();
    }
    post.mockRestore();
    channel.postMessage(held);
    await until(() => follower.getStatus().persistence !== null);
    expect(state(follower).ownerPersistence!.sequence).toBeGreaterThan(preSequence);
  } finally {
    await close(follower, owner);
    await deleteVolume(fileName);
  }
});

for (const [source, failures] of [
  ['strict-data-wal', 1],
  ['data-wal-write', 1],
  ['strict-meta-log', 1],
  ['snapshot', 1],
  ['checkpoint-retry', 2],
] as const) {
  it(`records a ${source} failure at its source and keeps it after a clean sync`, async () => {
    const worker = new Worker(new URL('./persistence-source-worker.ts', import.meta.url), { type: 'module' });
    try {
      const result = await new Promise<Record<string, unknown>>((resolve) => {
        worker.onmessage = (event) => resolve(event.data);
        worker.postMessage({ case: source });
      });
      expect(result).toMatchObject({
        thrown: Array(failures).fill(true),
        failed: { state: 'error', failureRevision: failures, retained: true },
        recovered: { state: 'clean', failureRevision: failures, retained: true },
      });
      expect(result.notified).toBeGreaterThan(0);
    } finally {
      worker.terminate();
    }
  });
}
