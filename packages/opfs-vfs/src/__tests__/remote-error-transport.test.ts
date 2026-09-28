import { expect, it, vi } from 'vitest';
import { OpfsVfsWorker } from '../index_internal';
import { changesTransportRequest } from './changes-transport-plugin';
import { registryTestRequest } from './registry-test-plugin';

const name = () => `remote-error-transport-${crypto.randomUUID()}.bin`;
const registryFactory = () => new Worker(new URL('./registry-test-worker.ts', import.meta.url), { type: 'module' });
const changesFactory = () => new Worker(new URL('./changes-transport-worker.ts', import.meta.url), { type: 'module' });
const state = (client: OpfsVfsWorker) =>
  client as unknown as {
    worker: Worker | null;
    channel: BroadcastChannel;
    generation: string;
    attachmentId: string;
    leaderReady: boolean;
  };

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Expected transport state to settle');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const callbacks = [() => {}, () => {}, () => {}] as const;
const errorKeys = ['error', 'name', 'code', 'errno', 'category', 'offset'];

it('sanitizes plugin validation errors during initialization', async () => {
  const messages: unknown[] = [];
  const factory = () => {
    const worker = registryFactory();
    worker.addEventListener('message', (event) => messages.push(event.data));
    return worker;
  };
  const client = new OpfsVfsWorker(name(), {
    worker: factory,
    plugins: [registryTestRequest({ failCode: 'PLUGIN_OPTION_INVALID', secret: 'never-leak-this' })],
  });
  try {
    await expect(client.ready).rejects.toMatchObject({
      message: expect.stringContaining('Invalid worker plugin options: registry-test'),
      code: 'PLUGIN_OPTION_INVALID',
    });
    const status = client.getStatus();
    expect(status).toMatchObject({
      state: 'failed',
      error: {
        message: expect.stringContaining('Invalid worker plugin options: registry-test'),
        code: 'PLUGIN_OPTION_INVALID',
      },
    });
    expect(Object.keys(status.error!)).toEqual(expect.arrayContaining(['message', 'code']));
    expect(Object.keys(status.error!).every((key) => ['message', 'name', 'code', 'errno'].includes(key))).toBe(true);
    expect(JSON.stringify(status)).not.toContain('never-leak-this');
    expect(JSON.stringify(status)).not.toContain('Secret plugin options');
    expect(JSON.stringify(messages)).not.toContain('never-leak-this');
    expect(JSON.stringify(messages)).not.toContain('Secret plugin options');
  } finally {
    client.dispose();
  }
});

it('sanitizes plugin validation errors when a follower takes over', async () => {
  const fileName = name();
  const owner = new OpfsVfsWorker(fileName, { worker: registryFactory, plugins: [registryTestRequest({})] });
  await owner.ready;
  const follower = new OpfsVfsWorker(fileName, {
    worker: registryFactory,
    plugins: [registryTestRequest({ failCode: 'PLUGIN_OPTION_INVALID', secret: 'never-leak-this' })],
  });
  const post = vi.spyOn(state(follower).channel, 'postMessage');
  try {
    await follower.ready;
    expect(follower.getStatus()).toMatchObject({ state: 'ready', role: 'follower' });
    await owner.closeVfs();
    await until(() => follower.getStatus().state === 'failed');
    expect(follower.getStatus()).toMatchObject({
      error: {
        message: expect.stringContaining('Invalid worker plugin options: registry-test'),
        code: 'PLUGIN_OPTION_INVALID',
      },
    });
    expect(JSON.stringify(follower.getStatus())).not.toContain('never-leak-this');
    expect(JSON.stringify(post.mock.calls)).not.toContain('never-leak-this');
    expect(JSON.stringify(post.mock.calls)).not.toContain('Secret plugin options');
  } finally {
    post.mockRestore();
    follower.dispose();
    owner.dispose();
  }
});

it('relays only the typed error envelope to followers', async () => {
  const fileName = name();
  const owner = new OpfsVfsWorker(fileName, { worker: registryFactory, plugins: [registryTestRequest({})] });
  await owner.ready;
  const follower = new OpfsVfsWorker(fileName, { worker: registryFactory, plugins: [registryTestRequest({})] });
  const replies: unknown[] = [];
  state(follower).channel.addEventListener('message', (event) => {
    if (event.data?.type === 'RESPONSE_ERROR') replies.push(event.data);
  });
  try {
    await follower.ready;
    const error = await follower.stat('/missing').catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: 'ENOENT', errno: 2, name: 'VfsError' });
    expect(
      Object.keys(error as object).every((key) => ['name', 'code', 'errno', 'category', 'offset'].includes(key)),
    ).toBe(true);
    await until(() => replies.length === 1);
    const result = (replies[0] as { result: object }).result;
    expect(Object.keys(result).every((key) => errorKeys.includes(key))).toBe(true);
    expect(result).toMatchObject({ error: expect.any(String), code: 'ENOENT', errno: 2, name: 'VfsError' });
  } finally {
    follower.dispose();
    await owner.closeVfs().catch(() => owner.dispose());
  }
});

it('rejects malformed worker and follower error envelopes', async () => {
  const client = new OpfsVfsWorker(name(), { worker: registryFactory, plugins: [registryTestRequest({})] });
  await client.ready;
  const worker = state(client).worker!;
  const onmessage = worker.onmessage!;
  worker.onmessage = (event) => {
    const data = event.data;
    onmessage.call(
      worker,
      new MessageEvent('message', {
        data: data.type === 'ERROR' ? { ...data, result: 'x'.repeat(1025) } : data,
      }),
    );
  };
  try {
    const error = await client.stat('/missing').catch((reason: unknown) => reason);
    expect(error).toMatchObject({ message: 'Invalid VFS error response' });
    expect(error).not.toHaveProperty('code');
  } finally {
    await client.closeVfs().catch(() => client.dispose());
  }

  const fileName = name();
  const owner = new OpfsVfsWorker(fileName, { worker: registryFactory, plugins: [registryTestRequest({})] });
  await owner.ready;
  const follower = new OpfsVfsWorker(fileName, { worker: registryFactory, plugins: [registryTestRequest({})] });
  const send = state(owner).channel.postMessage.bind(state(owner).channel);
  const post = vi.spyOn(state(owner).channel, 'postMessage').mockImplementation((message) => {
    send(message.type === 'RESPONSE_ERROR' ? { ...message, result: { ...message.result, stack: 'x' } } : message);
  });
  try {
    await follower.ready;
    const error = await follower.stat('/missing').catch((reason: unknown) => reason);
    expect(error).toMatchObject({ message: 'Invalid VFS error response' });
    expect(error).not.toHaveProperty('code');
  } finally {
    post.mockRestore();
    follower.dispose();
    await owner.closeVfs().catch(() => owner.dispose());
  }
});

it('keeps file-change errors bounded and ignores forged control errors', async () => {
  const unavailableName = name();
  const owner = new OpfsVfsWorker(unavailableName, { worker: registryFactory, plugins: [registryTestRequest({})] });
  await owner.ready;
  const follower = new OpfsVfsWorker(unavailableName, { worker: registryFactory, plugins: [registryTestRequest({})] });
  try {
    await follower.ready;
    for (const client of [owner, follower]) {
      const error = await client.openFileChangeChannel(...callbacks).catch((reason: unknown) => reason);
      expect(error).toMatchObject({
        code: 'ENOTSUP',
        errno: 95,
        name: 'VfsError',
        message: 'File change control failed: ENOTSUP',
      });
    }
  } finally {
    follower.dispose();
    await owner.closeVfs().catch(() => owner.dispose());
  }

  const fileName = name();
  const changeOwner = new OpfsVfsWorker(fileName, {
    worker: changesFactory,
    plugins: [changesTransportRequest()],
  });
  await changeOwner.ready;
  const changeFollower = new OpfsVfsWorker(fileName, {
    worker: changesFactory,
    plugins: [changesTransportRequest()],
  });
  const send = state(changeOwner).channel.postMessage.bind(state(changeOwner).channel);
  let held: Record<string, unknown> | undefined;
  const post = vi.spyOn(state(changeOwner).channel, 'postMessage').mockImplementation((message) => {
    if ((message.type === 'CHANGE_RESPONSE' || message.type === 'CHANGE_ERROR') && !held) {
      held = message;
      return;
    }
    send(message);
  });
  try {
    await changeFollower.ready;
    let settled = false;
    const opening = changeFollower.openFileChangeChannel(...callbacks).finally(() => {
      settled = true;
    });
    await until(() => held !== undefined);
    for (const result of [{ error: 'forged', stack: 'x' }, { error: 'x'.repeat(1025) }]) {
      state(changeFollower).channel.dispatchEvent(
        new MessageEvent('message', { data: { ...held!, type: 'CHANGE_ERROR', result } }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
    }
    send(held!);
    const channel = await opening;
    channel.close();
  } finally {
    post.mockRestore();
    changeFollower.dispose();
    await changeOwner.closeVfs().catch(() => changeOwner.dispose());
  }
});

it('preserves typed errors through the synchronous SAB bridge', async () => {
  const worker = new Worker(new URL('./remote-error-sab-worker.ts', import.meta.url), { type: 'module' });
  try {
    const result = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SAB error worker timed out')), 30_000);
      worker.onerror = (event) => {
        clearTimeout(timer);
        reject(new Error(event.message));
      };
      worker.onmessage = (event) => {
        clearTimeout(timer);
        resolve(event.data);
      };
      worker.postMessage(null);
    });
    expect(result).toEqual({ code: 'ENOENT', errno: 2, name: 'VfsError' });
  } finally {
    worker.terminate();
  }
});

it('sanitizes worker crash details in status snapshots', async () => {
  const client = new OpfsVfsWorker(name(), { worker: registryFactory, plugins: [registryTestRequest({})] });
  try {
    await client.ready;
    const cause = Object.assign(new Error('x'.repeat(2_000)), { secret: 'never-leak-this' });
    state(client).worker!.dispatchEvent(new ErrorEvent('error', { error: cause }));
    await until(() => client.getStatus().state === 'failed');
    const error = client.getStatus().error!;
    expect(error).toMatchObject({ code: 'VFS_WORKER_FAILED' });
    expect(error.message.length).toBeLessThanOrEqual(1024);
    const json = JSON.stringify(error);
    expect(json).not.toContain('secret');
    expect(json).not.toContain('stack');
    expect(json).not.toContain('cause');
  } finally {
    client.dispose();
  }
});
