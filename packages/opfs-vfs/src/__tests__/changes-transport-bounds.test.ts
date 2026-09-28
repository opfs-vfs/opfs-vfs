import { afterEach, expect, it, vi } from 'vitest';
import type { ChangeFrame, WireSubscribeOptions } from '../changes';
import { snapshotChangeCommand } from '../change-protocol';
import { OpfsVfsWorker } from '../index_internal';
import { deleteVolume } from '../volume-files';
import { changesTransportRequest } from './changes-transport-plugin';

const clients: OpfsVfsWorker[] = [];
const names: string[] = [];
const fileName = () => {
  const value = `changes-transport-bounds-${crypto.randomUUID()}.bin`;
  names.push(value);
  return value;
};
const option = (source: string): WireSubscribeOptions => ({
  path: '/',
  scope: 'directory',
  recursive: true,
  events: ['create'],
  match: { source, flags: '' },
  content: false,
});

function heldWorkerFactory() {
  const held: (() => void)[] = [];
  const posts = vi.fn();
  let holding = true;
  const factory = () => {
    const worker = new Worker(new URL('./changes-transport-worker.ts', import.meta.url), { type: 'module' });
    const postMessage = worker.postMessage.bind(worker) as (message: unknown, transfer?: Transferable[]) => void;
    return new Proxy(worker, {
      get(target, key) {
        if (key === 'postMessage')
          return (message: unknown, transfer?: Transferable[]) => {
            const command = (message as { type?: unknown; payload?: { command?: { type?: unknown } } })?.payload
              ?.command;
            if (
              holding &&
              (message as { type?: unknown })?.type === 'FILE_CHANGES_COMMAND' &&
              command?.type === 'register'
            ) {
              posts(message);
              held.push(() => postMessage(message, transfer));
            } else postMessage(message, transfer);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
      set(target, key, value) {
        return Reflect.set(target, key, value, target);
      },
    }) as Worker;
  };
  return { factory, held, posts, release: () => held.shift()?.(), stopHolding: () => (holding = false) };
}

function client(file: string, factory: () => Worker) {
  const vfs = new OpfsVfsWorker(file, { worker: factory, plugins: [changesTransportRequest()] });
  clients.push(vfs);
  return vfs;
}

function channel(vfs: OpfsVfsWorker) {
  const frames: ChangeFrame[] = [];
  const open = vfs.openFileChangeChannel(
    (frame) => frames.push(frame),
    () => {},
    () => {},
  );
  return { open, frames };
}

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error) => (error as { code?: string }).code,
  );
const snapshotCode = (command: unknown, optionBudget: number) => {
  try {
    snapshotChangeCommand(command, optionBudget);
  } catch (error) {
    return (error as { code?: string }).code;
  }
};
async function until(predicate: () => boolean) {
  for (let attempts = 0; !predicate(); attempts++) {
    if (attempts === 1000) throw new Error('Expected transport barrier');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(async () => {
  for (const vfs of clients.splice(0).reverse()) await vfs.closeVfs().catch(() => vfs.dispose());
  await Promise.all(names.splice(0).map(deleteVolume));
});

it('bounds local queued and executing registration option bytes before forwarding a third control', async () => {
  const held = heldWorkerFactory();
  const vfs = client(fileName(), held.factory);
  await vfs.ready;
  const [first, second, third] = await Promise.all([channel(vfs).open, channel(vfs).open, channel(vfs).open]);
  const large = option('x'.repeat(6 * 1024 * 1024));
  const one = first.request({ type: 'register', subscriptionId: 'local-one', options: large });
  const two = second.request({ type: 'register', subscriptionId: 'local-two', options: large });
  void one.catch(() => {});
  void two.catch(() => {});
  await until(() => held.posts.mock.calls.length === 2);
  const rejected = third.request({ type: 'register', subscriptionId: 'local-three', options: large });
  void rejected.catch(() => {});
  await Promise.resolve();
  expect(held.posts).toHaveBeenCalledTimes(2);
  await expect(code(rejected)).resolves.toBe('ENOSPC');
  held.release();
  held.release();
  await expect(one).resolves.toMatchObject({ subscriptionId: 'local-one' });
  await expect(two).resolves.toMatchObject({ subscriptionId: 'local-two' });
});

it('rejects unadmitted change commands without cloning their payloads', () => {
  const clone = vi.spyOn(globalThis, 'structuredClone');
  try {
    expect(
      snapshotCode(
        { type: 'cancel', subscriptionId: 'extra-payload', extra: new ArrayBuffer(32 * 1024 * 1024) },
        16 * 1024 * 1024,
      ),
    ).toBe('EINVAL');
    expect(
      snapshotCode(
        {
          type: 'register',
          subscriptionId: 'too-large',
          options: { path: '/'.repeat(1024), scope: 'file', recursive: false, events: ['create'], content: false },
        },
        768,
      ),
    ).toBe('ENOSPC');
    expect(clone).not.toHaveBeenCalled();
  } finally {
    clone.mockRestore();
  }
});

it('rejects hostile change command proxies from their first observed shape', () => {
  let invalidLengthReads = 0;
  const invalidFirstLength = new Proxy(['create', 'update', 'delete', 'create'], {
    get(target, key, receiver) {
      if (key === 'length') return ++invalidLengthReads === 1 ? 4 : 1;
      return Reflect.get(target, key, receiver);
    },
  });
  let validLengthReads = 0;
  const validFirstLength = new Proxy(['create', 'update', 'delete', 'create'], {
    get(target, key, receiver) {
      if (key === 'length') return ++validLengthReads === 1 ? 3 : 4;
      return Reflect.get(target, key, receiver);
    },
  });
  let ownKeysCalls = 0;
  const changingKeys = new Proxy(
    { type: 'cancel', subscriptionId: 'changing-keys', deliveryId: 1 },
    {
      ownKeys(target) {
        return ++ownKeysCalls === 1 ? Reflect.ownKeys(target) : ['type', 'subscriptionId'];
      },
    },
  );
  expect(
    snapshotCode(
      {
        type: 'register',
        subscriptionId: 'changing-length',
        options: { path: '/', scope: 'file', recursive: false, events: invalidFirstLength, content: false },
      },
      16 * 1024 * 1024,
    ),
  ).toBe('EINVAL');
  expect(invalidLengthReads).toBe(1);
  expect(
    snapshotChangeCommand(
      {
        type: 'register',
        subscriptionId: 'valid-first-length',
        options: { path: '/', scope: 'file', recursive: false, events: validFirstLength, content: false },
      },
      16 * 1024 * 1024,
    ).command,
  ).toMatchObject({ options: { events: ['create', 'update', 'delete'] } });
  expect(validLengthReads).toBe(1);
  expect(snapshotCode(changingKeys, 16 * 1024 * 1024)).toBe('EINVAL');
  expect(ownKeysCalls).toBe(1);
});

it('bounds owner relay controls across follower clients, including executing controls', async () => {
  const held = heldWorkerFactory();
  const file = fileName();
  const owner = client(file, held.factory);
  await owner.ready;
  const [firstClient, secondClient, thirdClient] = [
    client(file, held.factory),
    client(file, held.factory),
    client(file, held.factory),
  ];
  await Promise.all([firstClient.ready, secondClient.ready, thirdClient.ready]);
  const [first, second, third] = await Promise.all([
    channel(firstClient).open,
    channel(secondClient).open,
    channel(thirdClient).open,
  ]);
  const large = option('y'.repeat(6 * 1024 * 1024));
  const one = first.request({ type: 'register', subscriptionId: 'follower-one', options: large });
  const two = second.request({ type: 'register', subscriptionId: 'follower-two', options: large });
  void one.catch(() => {});
  void two.catch(() => {});
  await until(() => held.posts.mock.calls.length === 2);
  await expect(
    code(third.request({ type: 'register', subscriptionId: 'follower-three', options: large })),
  ).resolves.toBe('ENOSPC');
  expect(held.posts).toHaveBeenCalledTimes(2);
  held.release();
  held.release();
  await expect(one).resolves.toMatchObject({ subscriptionId: 'follower-one' });
  await expect(two).resolves.toMatchObject({ subscriptionId: 'follower-two' });
});

it('keeps the 32 registration slots through replies and releases terminal acknowledgements', async () => {
  const held = heldWorkerFactory();
  const vfs = client(fileName(), held.factory);
  await vfs.ready;
  const states = Array.from({ length: 32 }, () => channel(vfs));
  const channels = await Promise.all(states.map((state) => state.open));
  const registered = channels
    .slice(0, 31)
    .map((open, index) => open.request({ type: 'register', subscriptionId: `local-${index}`, options: option('') }));
  for (const request of registered) void request.catch(() => {});
  await until(() => held.posts.mock.calls.length === 31);
  while (held.held.length) held.release();
  await expect(Promise.all(registered)).resolves.toHaveLength(31);
  const pending = channels[31]!.request({ type: 'register', subscriptionId: 'local-31', options: option('') });
  void pending.catch(() => {});
  await until(() => held.posts.mock.calls.length === 32);
  const rejected = channels[0]!.request({ type: 'register', subscriptionId: 'local-32', options: option('') });
  void rejected.catch(() => {});
  await Promise.resolve();
  expect(held.posts).toHaveBeenCalledTimes(32);
  await expect(code(rejected)).resolves.toBe('ENOSPC');
  held.release();
  await expect(pending).resolves.toMatchObject({ subscriptionId: 'local-31' });
  held.stopHolding();
  await expect(
    code(channels[0]!.request({ type: 'register', subscriptionId: 'local-32', options: option('') })),
  ).resolves.toBe('ENOSPC');
  await Promise.all(
    channels.slice(0, 32).map((open, index) => open.request({ type: 'activate', subscriptionId: `local-${index}` })),
  );
  await vfs.writeFileBuffer('/terminal', new Uint8Array([1]));
  await until(() => states.every((state) => state.frames.some((frame) => frame.type === 'terminal')));
  await Promise.all(
    channels.slice(0, 32).map(async (open, index) => {
      await open.request({ type: 'terminal-ack', subscriptionId: `local-${index}` });
    }),
  );
  await expect(
    channels[0]!.request({ type: 'register', subscriptionId: 'local-32', options: option('') }),
  ).resolves.toMatchObject({ subscriptionId: 'local-32' });
});
