import { describe, expect, it, vi } from 'vitest';
import { OpfsVfsWorker } from '../index_internal';
import { peekVolume } from '../peek-volume';
import { inspectWorker, OpfsVfsWorkerClient } from '../worker-client';

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const name = () => `observer-${crypto.randomUUID()}.bin`;
const maxBytes = 16 * 1024 * 1024;
const internals = (client: OpfsVfsWorkerClient) =>
  client as unknown as {
    worker: Worker | null;
    channel: BroadcastChannel;
    pendingRequests: Map<number, unknown>;
    resourcesDisposed: boolean;
  };

async function attach(fileName: string) {
  const owner = await inspectWorker(fileName);
  expect(owner).not.toBeNull();
  const client = new OpfsVfsWorker(fileName, { attachTo: owner!.generation });
  await client.ready;
  return client;
}

function nextMessage(channel: BroadcastChannel, type: string) {
  return new Promise<MessageEvent['data']>((resolve, reject) => {
    const timer = setTimeout(() => {
      channel.removeEventListener('message', listener);
      reject(new Error(`Missing ${type}`));
    }, 2000);
    const listener = (event: MessageEvent) => {
      if (event.data?.type !== type) return;
      clearTimeout(timer);
      channel.removeEventListener('message', listener);
      resolve(event.data);
    };
    channel.addEventListener('message', listener);
  });
}

describe('passive worker attachment', () => {
  it('probes ready standard workers and never advertises a generic worker factory', async () => {
    const fileName = name();
    expect(await inspectWorker(fileName, { timeout: 50 })).toBeNull();
    class CustomWorker extends Worker {
      constructor() {
        super(new URL('../worker.ts', import.meta.url), { type: 'module' });
      }
    }
    const custom = new OpfsVfsWorkerClient(fileName, { forceLeader: true }, () => new CustomWorker());
    try {
      await custom.ready;
      expect(await inspectWorker(fileName, { timeout: 50 })).toBeNull();
    } finally {
      await custom.closeVfs();
    }
    const owner = new OpfsVfsWorker(fileName, { forceLeader: true, openMode: 'open-existing' });
    try {
      await owner.ready;
      expect(await inspectWorker(fileName)).toMatchObject({ protocol: 1, generation: expect.any(String) });
    } finally {
      await owner.closeVfs();
    }
  });

  it('attaches without election or descriptors and detaches without flushing or closing the application', async () => {
    const fileName = name();
    const owner = new OpfsVfsWorker(fileName);
    await owner.ready;
    const requests = vi.spyOn(navigator.locks, 'request');
    const observer = await attach(fileName);
    const electionRequests = requests.mock.calls.length;
    requests.mockRestore();
    try {
      expect(electionRequests).toBe(0);
      expect(internals(observer).worker).toBeNull();
      await owner.writeFileBuffer('/app', encode('application'), { exclusive: true });
      const fd = await owner.open('/app');
      expect(decode(await observer.readFileBuffer('/app'))).toBe('application');
      await expect(observer.open('/app')).rejects.toMatchObject({ code: 'EPERM' });
      await expect(observer.close(fd)).rejects.toMatchObject({ code: 'EPERM' });
      await expect(observer.shutdownSharedVfs()).rejects.toMatchObject({ code: 'EPERM' });
      const messages = vi.spyOn(internals(owner).worker!, 'postMessage');
      const applicationRead = owner.read(fd, 11);
      await observer.closeVfs();
      expect(decode((await applicationRead).buffer)).toBe('application');
      expect(messages.mock.calls.some(([message]) => ['FLUSH', 'CLOSE_VFS'].includes(message.type))).toBe(false);
      messages.mockRestore();
      expect((await owner.fstat(fd)).size).toBe(11);
      await owner.close(fd);
    } finally {
      observer.dispose();
      await owner.closeVfs();
    }
  });

  it('refuses stale generations and descriptor commands at the serving side', async () => {
    const fileName = name();
    const first = new OpfsVfsWorker(fileName, { forceLeader: true });
    await first.ready;
    const previous = (await inspectWorker(fileName))!;
    await first.writeFileBuffer('/file', encode('original'));
    await first.closeVfs();
    const owner = new OpfsVfsWorker(fileName, { forceLeader: true, openMode: 'open-existing' });
    const channel = new BroadcastChannel(`opfs-vfs-${fileName}`);
    try {
      await owner.ready;
      const current = (await inspectWorker(fileName))!;
      expect(current.generation).not.toBe(previous.generation);
      const stale = new OpfsVfsWorker(fileName, { attachTo: previous.generation });
      await expect(stale.ready).rejects.toMatchObject({ code: 'VFS_ATTACHMENT_LOST' });
      stale.dispose();
      for (const [generation, command, expectedCode] of [
        [previous.generation, 'WRITE_FILE_BUFFER', 'VFS_ATTACHMENT_LOST'],
        [current.generation, 'OPEN', 'EPERM'],
        [current.generation, 'CLOSE_VFS', 'EPERM'],
        [current.generation, 'SHUTDOWN_LEADER', 'EPERM'],
      ]) {
        const response = nextMessage(channel, 'OBSERVER_RESPONSE_ERROR');
        channel.postMessage({
          id: 42,
          tabId: 'test-attachment',
          generation,
          type: 'OBSERVER_COMMAND',
          payload: { type: command, payload: { path: '/file' } },
          data: encode('replacement'),
        });
        expect(await response).toMatchObject({
          id: 42,
          tabId: 'test-attachment',
          generation,
          result: { code: expectedCode },
        });
      }
      expect(decode(await owner.readFileBuffer('/file'))).toBe('original');
    } finally {
      channel.close();
      await owner.closeVfs();
    }
  });

  it('uses the separate envelope, checks reply correlation, and never retries an uncertain write', async () => {
    const fileName = name();
    const owner = new OpfsVfsWorker(fileName, { forceLeader: true });
    await owner.ready;
    const observer = await attach(fileName);
    const channel = new BroadcastChannel(`opfs-vfs-${fileName}`);
    const ownerChannel = internals(owner).channel;
    const post = ownerChannel.postMessage.bind(ownerChannel);
    const drop = vi.spyOn(ownerChannel, 'postMessage').mockImplementation((message) => {
      if (message.type !== 'OBSERVER_RESPONSE') post(message);
    });
    try {
      const received = nextMessage(channel, 'OBSERVER_COMMAND');
      const result = observer
        .writeFileBuffer('/once', encode('one'), { append: true })
        .catch((error: unknown) => error);
      const command = await received;
      expect(command.generation).toBeTypeOf('string');
      expect(command.tabId).toBeTypeOf('string');
      for (const fields of [{ generation: 'old' }, { tabId: 'other' }, { id: command.id + 1 }, { type: 'RESPONSE' }])
        channel.postMessage({
          id: command.id,
          tabId: command.tabId,
          generation: command.generation,
          type: 'OBSERVER_RESPONSE',
          result: 'OK',
          ...fields,
        });
      const error = await result;
      expect(error).toMatchObject({ code: 'LEADER_RESPONSE_TIMEOUT' });
      expect((error as Error).message).toContain('unknown');
      expect(internals(observer).pendingRequests.size).toBe(0);
      expect(internals(observer).resourcesDisposed).toBe(true);
      expect(observer.disposed).toBe(true);
      await expect(observer.writeFileBuffer('/once', encode('two'), { append: true })).rejects.toThrow();
      expect(decode(await owner.readFileBuffer('/once'))).toBe('one');
    } finally {
      drop.mockRestore();
      observer.dispose();
      channel.close();
      await owner.closeVfs();
    }
  }, 10000);

  it('invalidates an attachment when its owner closes without joining the election', async () => {
    const fileName = name();
    const owner = new OpfsVfsWorker(fileName);
    await owner.ready;
    const observer = await attach(fileName);
    try {
      await owner.closeVfs();
      await vi.waitFor(() => expect(internals(observer).resourcesDisposed).toBe(true));
      await expect(observer.stat('/')).rejects.toThrow();
      expect(internals(observer).worker).toBeNull();
      expect(
        (await navigator.locks.query()).pending?.filter((lock) => lock.name === `opfs-vfs-lock-${fileName}`),
      ).toHaveLength(0);
    } finally {
      observer.dispose();
      owner.dispose();
    }
  });

  it('fails an idle claim immediately without later promotion and leaves ordinary followers working', async () => {
    const fileName = name();
    const owner = new OpfsVfsWorker(fileName);
    await owner.ready;
    const claim = new OpfsVfsWorker(fileName, { claimIfAvailable: true, openMode: 'open-existing' });
    const follower = new OpfsVfsWorker(fileName);
    try {
      await expect(claim.ready).rejects.toMatchObject({ code: 'EBUSY' });
      await follower.ready;
      expect((await follower.stat('/')).is_dir).toBe(true);
      expect(
        (await navigator.locks.query()).pending?.filter((lock) => lock.name === `opfs-vfs-lock-${fileName}`),
      ).toHaveLength(1);
      follower.dispose();
      await owner.closeVfs();
      // Client disposal signals Web Lock release; the browser acknowledges it later.
      await navigator.locks.request(`opfs-vfs-lock-${fileName}`, () => {});
      const next = new OpfsVfsWorker(fileName, { claimIfAvailable: true, openMode: 'open-existing' });
      try {
        await next.ready;
        expect((await next.stat('/')).is_dir).toBe(true);
      } finally {
        await next.closeVfs();
      }
      expect(internals(claim).worker).toBeNull();
      expect(internals(claim).resourcesDisposed).toBe(true);
    } finally {
      claim.dispose();
      follower.dispose();
      owner.dispose();
    }
    expect(() => new OpfsVfsWorker(name(), { claimIfAvailable: true })).toThrow('open-existing');
    const missingName = name();
    const missing = new OpfsVfsWorker(missingName, { claimIfAvailable: true, openMode: 'open-existing' });
    await expect(missing.ready).rejects.toThrow();
    missing.dispose();
    expect((await peekVolume(missingName)).exists).toBe(false);
  });

  it('claims a new volume without queueing and never replaces an occupied or existing volume', async () => {
    const fileName = name();
    const owner = new OpfsVfsWorker(fileName, { claimIfAvailable: true, openMode: 'create-new' });
    await owner.ready;
    await owner.writeFileBuffer('/keep', encode('original'));
    const busy = new OpfsVfsWorker(fileName, { claimIfAvailable: true, openMode: 'create-new' });
    try {
      await expect(busy.ready).rejects.toMatchObject({ code: 'EBUSY' });
      expect(internals(busy).resourcesDisposed).toBe(true);
      expect(
        (await navigator.locks.query()).pending?.filter((lock) => lock.name === `opfs-vfs-lock-${fileName}`),
      ).toHaveLength(0);
      expect(decode(await owner.readFileBuffer('/keep'))).toBe('original');
      await owner.closeVfs();
      await navigator.locks.request(`opfs-vfs-lock-${fileName}`, () => {});
      const existing = new OpfsVfsWorker(fileName, { claimIfAvailable: true, openMode: 'create-new' });
      await expect(existing.ready).rejects.toMatchObject({ code: 'EEXIST' });
      expect(internals(existing).resourcesDisposed).toBe(true);
      existing.dispose();
      await navigator.locks.request(`opfs-vfs-lock-${fileName}`, () => {});
      const reopened = new OpfsVfsWorker(fileName, { claimIfAvailable: true, openMode: 'open-existing' });
      try {
        await reopened.ready;
        expect(decode(await reopened.readFileBuffer('/keep'))).toBe('original');
      } finally {
        await reopened.closeVfs();
      }
      expect(internals(busy).worker).toBeNull();
    } finally {
      busy.dispose();
      owner.dispose();
    }
    expect(() => new OpfsVfsWorker(name(), { claimIfAvailable: true, openMode: 'open-or-create' })).toThrow();
    expect(
      () => new OpfsVfsWorker(name(), { claimIfAvailable: true, attachTo: 'generation', openMode: 'create-new' }),
    ).toThrow();
  });

  it('compares editor bytes before truncation and creates or renames without replacing collisions', async () => {
    const fileName = name();
    const owner = new OpfsVfsWorker(fileName, { forceLeader: true });
    await owner.ready;
    const observer = await attach(fileName);
    try {
      const bytes = encode('draft');
      await observer.writeFileBuffer('/file', bytes, { exclusive: true });
      expect(decode(bytes)).toBe('draft');
      const competing = await Promise.allSettled([
        observer.writeFileBuffer('/new', encode('one'), { exclusive: true }),
        owner.writeFileBuffer('/new', encode('two'), { exclusive: true }),
      ]);
      expect(competing.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(competing.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: 'EEXIST' } });
      await owner.writeFileBuffer('/file', encode('external'));
      await expect(observer.writeFileBuffer('/file', encode('edited'), { expected: bytes })).rejects.toMatchObject({
        code: 'EBUSY',
      });
      expect(decode(await observer.readFileBuffer('/file'))).toBe('external');
      await owner.writeFileBuffer('/file', encode('other'));
      await expect(observer.writeFileBuffer('/file', encode('edited'), { expected: bytes })).rejects.toMatchObject({
        code: 'EBUSY',
      });
      expect(decode(await observer.readFileBuffer('/file'))).toBe('other');
      await owner.writeFileBuffer('/file', encode('external'));
      await observer.writeFileBuffer('/file', encode('edited'), { expected: encode('external') });
      await observer.writeFileBuffer('/file', encode('!'), { append: true });
      expect(decode(await observer.readFileBuffer('/file'))).toBe('edited!');
      await expect(observer.renameNoReplace('/file', '/new')).rejects.toMatchObject({ code: 'EEXIST' });
      await owner.symlink('/missing', '/dangling');
      await expect(observer.renameNoReplace('/file', '/dangling')).rejects.toMatchObject({ code: 'EEXIST' });
      await observer.renameNoReplace('/file', '/renamed');
      expect(await owner.exists('/file')).toBe(false);
      expect(decode(await owner.readFileBuffer('/renamed'))).toBe('edited!');
    } finally {
      observer.dispose();
      await owner.closeVfs();
    }
  });

  it('enforces actual size ceilings in the worker and closes descriptors on errors', async () => {
    const fileName = name();
    const owner = new OpfsVfsWorker(fileName, { forceLeader: true });
    await owner.ready;
    const observer = await attach(fileName);
    try {
      await owner.mkdir('/folder');
      await owner.writeFileBuffer('/folder/file', encode('four'));
      const previousSize = (await observer.stat('/folder/file')).size;
      await owner.writeFileBuffer('/folder/file', encode('grew since stat'));
      await expect(observer.readFileBuffer('/folder/file', previousSize)).rejects.toMatchObject({ code: 'EFBIG' });
      await expect(observer.readFileBuffer('/folder/file', maxBytes + 1)).rejects.toMatchObject({ code: 'EFBIG' });
      await expect(observer.readFileBuffer('/folder/file', -1)).rejects.toMatchObject({ code: 'EINVAL' });
      await expect(
        observer.writeFileBuffer('/folder/file', encode('x'), { append: 'yes' } as never),
      ).rejects.toMatchObject({ code: 'EINVAL' });
      await expect(observer.writeFileBuffer('/folder/file', new Uint8Array(maxBytes + 1))).rejects.toMatchObject({
        code: 'EFBIG',
      });
      expect(decode(await owner.readFileBuffer('/folder/file'))).toBe('grew since stat');
      await owner.truncate('/folder/file', maxBytes);
      await expect(observer.writeFileBuffer('/folder/file', encode('!'), { append: true })).rejects.toMatchObject({
        code: 'EFBIG',
      });
      expect((await owner.stat('/folder/file')).size).toBe(maxBytes);
      // The core refuses recursive removal while descendants have open fds.
      // This succeeds only if failed whole-file commands closed their own fds.
      await owner.remove('/folder');
      expect(await owner.exists('/folder')).toBe(false);
    } finally {
      observer.dispose();
      await owner.closeVfs();
    }
  });

  for (const [limits, code, replacement] of [
    [{ maxFileSize: 4 }, 'EFBIG', encode('longer')],
    [{ maxTotalBytes: 8192 }, 'ENOSPC', new Uint8Array(4097).fill(1)],
  ] as const) {
    it(`preserves existing contents when the owner's quota rejects replacement with ${code}`, async () => {
      class LimitedWorker extends Worker {
        constructor() {
          super(new URL('./observer-quota-worker.ts', import.meta.url), { type: 'module' });
        }
      }
      const owner = new OpfsVfsWorkerClient(name(), { forceLeader: true, ...limits }, () => new LimitedWorker());
      try {
        await owner.ready;
        await owner.writeFileBuffer('/file', encode('old'));
        await owner.writeFileBuffer('/other', encode('xx'));
        await expect(owner.writeFileBuffer('/file', replacement, { expected: encode('old') })).rejects.toMatchObject({
          code,
        });
        expect(decode(await owner.readFileBuffer('/file'))).toBe('old');
        await owner.writeFileBuffer('/file', encode('ok'), { expected: encode('old') });
        expect(decode(await owner.readFileBuffer('/file'))).toBe('ok');
        await owner.writeFileBuffer('/file', new Uint8Array());
        expect((await owner.readFileBuffer('/file')).byteLength).toBe(0);
      } finally {
        await owner.closeVfs();
      }
    });
  }
});
