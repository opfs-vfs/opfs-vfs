import { expect, it, vi } from 'vitest';
import { OpfsVfsWorker } from '../index_internal';
import { inspectWorker } from '../worker-client';
import { peekVolume } from '../peek-volume';
import { registryTestRequest } from './registry-test-plugin';

const name = () => `plugin-client-${crypto.randomUUID()}.bin`;
const factory = () => new Worker(new URL('./registry-test-worker.ts', import.meta.url), { type: 'module' });
const state = (client: OpfsVfsWorker) =>
  client as unknown as {
    worker: Worker | null;
    channel: BroadcastChannel;
    leaderReady: boolean;
    generation: string;
    pluginRequests: unknown[];
  };
async function until(predicate: () => boolean) {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Worker state did not settle');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

it('validates plugin requests before worker construction or ownership election, even with an owner', async () => {
  const fileName = name();
  const owner = new OpfsVfsWorker(fileName, { worker: factory, plugins: [registryTestRequest({})] });
  await owner.ready;
  const worker = vi.fn(factory);
  const locks = vi.spyOn(navigator.locks, 'request');
  try {
    for (const openMode of [undefined, 'open-existing'] as const) {
      expect(
        () => new OpfsVfsWorker(fileName, { worker, openMode, plugins: [registryTestRequest({ createOnly: true })] }),
      ).toThrowError(expect.objectContaining({ code: 'EINVAL' }));
    }
    expect(() => new OpfsVfsWorker(fileName, { plugins: [registryTestRequest({})] })).toThrowError(
      expect.objectContaining({ code: 'EINVAL' }),
    );
    expect(worker).not.toHaveBeenCalled();
    expect(locks).not.toHaveBeenCalled();
  } finally {
    locks.mockRestore();
    await owner.closeVfs();
  }
  const freshName = name();
  const created = new OpfsVfsWorker(freshName, {
    worker,
    openMode: 'create-new',
    plugins: [registryTestRequest({ createOnly: true })],
  });
  await created.ready;
  const duplicate = new OpfsVfsWorker(freshName, {
    worker,
    openMode: 'create-new',
    plugins: [registryTestRequest({ createOnly: true })],
  });
  try {
    await expect(duplicate.ready).rejects.toMatchObject({ code: 'EEXIST' });
    expect(worker).toHaveBeenCalledTimes(1);
  } finally {
    duplicate.dispose();
    await created.closeVfs();
  }
});

for (const bufferMode of ['disk', 'memory'] as const) {
  it(`${bufferMode}: custom registry mounts and reopens while keeping observer support disabled`, async () => {
    const fileName = name();
    const worker = vi.fn(factory);
    const request = registryTestRequest({ variant: 'a', secret: 'never-broadcast-this' });
    const client = new OpfsVfsWorker(fileName, { worker, bufferMode, plugins: [request] });
    const post = vi.spyOn(state(client).channel, 'postMessage');
    // Fixed configuration is copied before any async work.
    request.options.variant = 'b';
    try {
      await client.ready;
      await client.writeFileBuffer('/file', new Uint8Array([42]));
      await client.sync();
      expect(await inspectWorker(fileName, { timeout: 30 })).toBeNull();
      expect(JSON.stringify(post.mock.calls)).not.toContain('never-broadcast-this');
      expect(JSON.stringify(post.mock.calls)).not.toContain('options');
      expect(
        post.mock.calls.some(
          ([message]) =>
            message.type === 'LEADER_READY' && message.profile.plugins[0].compatibilityKey === 'registry-test:a',
        ),
      ).toBe(true);
    } finally {
      post.mockRestore();
      await client.closeVfs();
    }
    expect(state(client).pluginRequests).toEqual([]);
    const reopened = new OpfsVfsWorker(fileName, {
      worker,
      bufferMode,
      openMode: 'open-existing',
      plugins: [registryTestRequest({})],
    });
    try {
      await reopened.ready;
      expect(await reopened.readFileBuffer('/file')).toEqual(new Uint8Array([42]));
      expect(worker).toHaveBeenCalledTimes(2);
    } finally {
      await reopened.closeVfs();
    }
  });
}

it('shares the empty profile between the bundled worker and an unused custom registry', async () => {
  const fileName = name();
  const owner = new OpfsVfsWorker(fileName, { worker: factory, plugins: [] });
  await owner.ready;
  const follower = new OpfsVfsWorker(fileName);
  try {
    await follower.ready;
    expect(state(follower).worker).toBeNull();
    await follower.mkdir('/plain');
    expect(await owner.exists('/plain')).toBe(true);
    expect(await inspectWorker(fileName, { timeout: 30 })).toBeNull();
    await owner.closeVfs();
    await until(() => state(follower).worker !== null && state(follower).leaderReady);
    expect(await follower.exists('/plain')).toBe(true);
    expect(await inspectWorker(fileName, { timeout: 30 })).not.toBeNull();
  } finally {
    owner.dispose();
    await follower.closeVfs();
  }
});

it('preserves typed worker errors through the leader and follower relay', async () => {
  const fileName = name();
  const owner = new OpfsVfsWorker(fileName, { worker: factory, plugins: [registryTestRequest({})] });
  await owner.ready;
  const follower = new OpfsVfsWorker(fileName, { worker: factory, plugins: [registryTestRequest({})] });
  try {
    await follower.ready;
    for (const client of [owner, follower]) {
      await expect(client.stat('/missing')).rejects.toMatchObject({ code: 'ENOENT', errno: 2, name: 'VfsError' });
    }
  } finally {
    follower.dispose();
    await owner.closeVfs();
  }
});

it('keeps typed INIT failures in the failed status', async () => {
  const client = new OpfsVfsWorker(name(), {
    worker: factory,
    plugins: [registryTestRequest({ failCorruption: true })],
  });
  try {
    await expect(client.ready).rejects.toMatchObject({
      message: expect.stringMatching(/^VFS init failed: /),
      category: 'meta-snapshot',
      offset: 128,
    });
    expect(client.getStatus()).toMatchObject({
      state: 'failed',
      error: { category: 'meta-snapshot', offset: 128 },
    });
  } finally {
    client.dispose();
  }
});

for (const ownerPlugin of [false, true]) {
  it(`rejects a conflicting profile when owner plugin=${ownerPlugin}`, async () => {
    const fileName = name();
    const owner = new OpfsVfsWorker(
      fileName,
      ownerPlugin ? { worker: factory, plugins: [registryTestRequest({})] } : {},
    );
    await owner.ready;
    const follower = new OpfsVfsWorker(
      fileName,
      ownerPlugin ? {} : { worker: factory, plugins: [registryTestRequest({})] },
    );
    try {
      await expect(follower.ready).rejects.toMatchObject({ code: 'VFS_PLUGIN_MISMATCH' });
      expect(state(follower).worker).toBeNull();
      expect(await owner.exists('/')).toBe(true);
    } finally {
      follower.dispose();
      await owner.closeVfs();
    }
  });
}

async function expectProtocolProfile(profile: unknown) {
  const fileName = name();
  const owner = new OpfsVfsWorker(fileName);
  await owner.ready;
  const channel = state(owner).channel;
  const post = channel.postMessage.bind(channel);
  const replacement = vi.spyOn(channel, 'postMessage').mockImplementation((message) => {
    post(message.type === 'LEADER_READY' ? { ...message, profile } : message);
  });
  const started = Date.now();
  const follower = new OpfsVfsWorker(fileName, { initTimeout: 15_000 });
  try {
    await expect(follower.ready).rejects.toMatchObject({ code: 'VFS_PROTOCOL_MISMATCH' });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(follower.disposed).toBe(true);
  } finally {
    replacement.mockRestore();
    follower.dispose();
    await owner.closeVfs();
  }
}

it('rejects a missing owner profile explicitly', () => expectProtocolProfile(undefined));
it('rejects a legacy owner profile explicitly', () => expectProtocolProfile({ version: 1, plugins: [] }));
it('rejects an owner profile without capabilities explicitly', () =>
  expectProtocolProfile({ version: 2, plugins: [] }));
it('rejects an unknown owner profile version explicitly', () =>
  expectProtocolProfile({ version: 3, capabilities: ['error-details'], plugins: [] }));

it('rejects create-new against a legacy owner as a protocol mismatch', async () => {
  const fileName = name();
  const owner = new OpfsVfsWorker(fileName);
  await owner.ready;
  const channel = state(owner).channel;
  const post = channel.postMessage.bind(channel);
  const replacement = vi.spyOn(channel, 'postMessage').mockImplementation((message) => {
    post(message.type === 'LEADER_READY' ? { ...message, profile: { version: 1, plugins: [] } } : message);
  });
  const client = new OpfsVfsWorker(fileName, { openMode: 'create-new' });
  try {
    await expect(client.ready).rejects.toMatchObject({ code: 'VFS_PROTOCOL_MISMATCH' });
    expect(client.getStatus()).toMatchObject({ state: 'failed', error: { code: 'VFS_PROTOCOL_MISMATCH' } });
  } finally {
    replacement.mockRestore();
    client.dispose();
    await owner.closeVfs();
  }
});

it('negotiates each replacement owner and never replays an in-flight mutation', async () => {
  const fileName = name();
  const owner = new OpfsVfsWorker(fileName, { worker: factory, plugins: [registryTestRequest({})] });
  await owner.ready;
  const follower = new OpfsVfsWorker(fileName, { worker: factory, plugins: [registryTestRequest({})] });
  await follower.ready;
  const channel = state(owner).channel;
  const post = channel.postMessage.bind(channel);
  let observed!: () => void;
  const mutated = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const hold = vi.spyOn(channel, 'postMessage').mockImplementation((message) => {
    if (message.type === 'RESPONSE') observed();
    else post(message);
  });
  const workerPost = vi.spyOn(state(owner).worker!, 'postMessage');
  try {
    const mutation = follower.mkdir('/once').catch((error: unknown) => error);
    await mutated;
    state(follower).channel.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'LEADER_READY',
          generation: 'replacement',
          profile: {
            version: 2,
            capabilities: ['error-details', 'persistence-status'],
            plugins: [{ id: 'registry-test', contractVersion: 1, compatibilityKey: 'registry-test:b' }],
          },
        },
      }),
    );
    expect(await mutation).toMatchObject({ code: 'VFS_ATTACHMENT_LOST' });
    expect(follower.disposed).toBe(true);
    await expect(follower.mkdir('/must-not-route')).rejects.toThrow();
    expect(await owner.exists('/once')).toBe(true);
    expect(workerPost.mock.calls.filter(([message]) => message.type === 'MKDIR')).toHaveLength(1);
  } finally {
    hold.mockRestore();
    workerPost.mockRestore();
    follower.dispose();
    await owner.closeVfs();
  }
});

it('uses fresh registration state for takeover and validates private options only when becoming owner', async () => {
  const fileName = name();
  const owner = new OpfsVfsWorker(fileName, { worker: factory, plugins: [registryTestRequest({})] });
  await owner.ready;
  const nextFactory = vi.fn(factory);
  const next = new OpfsVfsWorker(fileName, { worker: nextFactory, plugins: [registryTestRequest({})] });
  const badFactory = vi.fn(factory);
  const bad = new OpfsVfsWorker(fileName, { worker: badFactory, plugins: [registryTestRequest({ failMount: true })] });
  try {
    await Promise.all([next.ready, bad.ready]);
    expect(nextFactory).not.toHaveBeenCalled();
    expect(badFactory).not.toHaveBeenCalled();
    await owner.writeFileBuffer('/kept', new Uint8Array([9]));
    await owner.closeVfs();
    await until(() => state(next).leaderReady && state(next).worker !== null);
    expect(await next.readFileBuffer('/kept')).toEqual(new Uint8Array([9]));
    expect(nextFactory).toHaveBeenCalledTimes(1);
    // The third follower must negotiate the new owner's same profile before routing.
    await until(() => (bad as unknown as { leaderGeneration?: string }).leaderGeneration === state(next).generation);
    expect(await bad.readFileBuffer('/kept')).toEqual(new Uint8Array([9]));
    await next.closeVfs();
    await until(() => bad.disposed);
    expect(badFactory).toHaveBeenCalledTimes(1);
    await expect(bad.readFileBuffer('/kept')).rejects.toThrow();
    const fresh = new OpfsVfsWorker(fileName, { worker: factory, plugins: [registryTestRequest({})] });
    try {
      await fresh.ready;
      expect(await fresh.readFileBuffer('/kept')).toEqual(new Uint8Array([9]));
    } finally {
      await fresh.closeVfs();
    }
  } finally {
    bad.dispose();
    next.dispose();
    owner.dispose();
  }
});

it('rejects reserved or noncloneable requests without touching storage', async () => {
  for (const options of [
    { worker: factory, fileName: 'override.bin' },
    { worker: factory, sab: new SharedArrayBuffer(64) },
    { worker: factory, plugins: [{ ...registryTestRequest({}), importOwner: 'forged' }] },
    { worker: factory, plugins: [{ ...registryTestRequest({}), options: { callback() {} } }] },
  ]) {
    const fileName = name();
    expect(() => new OpfsVfsWorker(fileName, options)).toThrow();
    expect((await peekVolume(fileName)).exists).toBe(false);
  }
});

it('snapshots worker and request getters before choosing observer support', async () => {
  const fileName = name();
  let workerReads = 0;
  let pluginReads = 0;
  const client = new OpfsVfsWorker(fileName, {
    get worker() {
      return ++workerReads <= 4 ? factory : undefined;
    },
    get plugins() {
      pluginReads++;
      return [];
    },
  });
  try {
    await client.ready;
    expect(workerReads).toBe(1);
    expect(pluginReads).toBe(1);
    expect(await inspectWorker(fileName, { timeout: 30 })).toBeNull();
  } finally {
    await client.closeVfs();
  }
});

it('rejects a worker INIT response with a different actual profile', async () => {
  const client = new OpfsVfsWorker(name(), {
    worker: () => {
      const worker = factory();
      worker.addEventListener('message', ({ data }) => {
        if (data.type === 'INIT')
          data.result.profile = {
            version: 2,
            capabilities: ['error-details', 'persistence-status'],
            plugins: [{ id: 'other', contractVersion: 1, compatibilityKey: 'other' }],
          };
      });
      return worker;
    },
  });
  await expect(client.ready).rejects.toMatchObject({ code: 'VFS_PLUGIN_MISMATCH' });
  expect(client.disposed).toBe(true);
});

it('rejects a worker INIT response with a legacy profile', async () => {
  const client = new OpfsVfsWorker(name(), {
    worker: () => {
      const worker = factory();
      worker.addEventListener('message', ({ data }) => {
        if (data.type === 'INIT') data.result.profile = { version: 1, plugins: [] };
      });
      return worker;
    },
  });
  await expect(client.ready).rejects.toMatchObject({ code: 'VFS_PROTOCOL_MISMATCH' });
  expect(client.disposed).toBe(true);
});
