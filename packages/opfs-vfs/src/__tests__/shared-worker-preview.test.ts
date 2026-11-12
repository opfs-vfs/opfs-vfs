import { expect, it, vi } from 'vitest';
import { createSharedWorkerFollower, probeSharedWorker, startVfsSharedWorker } from '../shared-worker.js';
import { OpfsVfsWorker, openOpfsVfsWorker } from '../index_internal.js';
import { deleteVolume } from '../volume-files.js';
import { OpfsVfsWorkerClient } from '../worker-client.js';
import { changesTransportRequest } from './changes-transport-plugin.js';
import {
  announcedSharedProfile,
  announcesOwnerLiveness,
  createMountProfile,
  createSharedMountProfile,
  mountProfileMismatch,
  OWNER_LIVENESS_CAPABILITY,
  sharedMountProfileMismatch,
  type SharedMountProfile,
} from '../worker-plugins.js';

class FakePort {
  onmessage: ((event: MessageEvent) => unknown) | null = null;
  onmessageerror: ((event: MessageEvent) => unknown) | null = null;
  closed = false;

  constructor(private readonly send: (message: unknown) => void) {}

  start() {}
  close() {
    this.closed = true;
  }
  postMessage(message: unknown) {
    this.send(message);
  }
}

const worker = (port: FakePort) => () => ({ port, onerror: null }) as unknown as SharedWorker;

it('rejects malformed SharedWorker admission before starting an owner', async () => {
  const sent: unknown[] = [];
  const port = new FakePort((message) => sent.push(message));
  const scope: { onconnect?: (event: { ports: MessagePort[] }) => void; close: () => void } = { close: vi.fn() };
  vi.stubGlobal('self', scope);
  try {
    startVfsSharedWorker();
    scope.onconnect?.({ ports: [port as unknown as MessagePort] });
    port.onmessage?.({ data: { type: 'ATTACH', version: 1 } } as MessageEvent);
    expect(sent).toContainEqual(
      expect.objectContaining({ type: 'ERROR', error: expect.objectContaining({ code: 'EINVAL' }) }),
    );
    expect(port.closed).toBe(true);
    expect(scope.close).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
const realWorker = (fileName: string) =>
  new SharedWorker(new URL('./shared-worker-test-worker.ts', import.meta.url), {
    type: 'module',
    name: `opfs-vfs-core-shared-${fileName}`,
  });
const canRunSharedWorker = /AppleWebKit/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean | Promise<boolean>, timeout = 2_000) {
  const end = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() >= end) throw new Error('condition did not become true');
    await sleep(5);
  }
}

async function nextPortMessage(port: MessagePort, type: string) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Missing ${type} message`)), 5_000);
    port.onmessage = ({ data }) => {
      if (!data || typeof data !== 'object' || (data as { type?: unknown }).type !== type) return;
      clearTimeout(timeout);
      resolve(data as Record<string, unknown>);
    };
  });
}

async function nextControl(channel: BroadcastChannel, value: string) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      channel.removeEventListener('message', receive);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Missing ${value} control signal`));
    }, 5_000);
    const receive = ({ data }: MessageEvent) => {
      if (data !== value) return;
      cleanup();
      resolve();
    };
    channel.addEventListener('message', receive);
  });
}

it('closes a SharedWorker port when ATTACH cannot post', async () => {
  const port = new FakePort(() => {
    throw new Error('attach failed');
  });

  await expect(createSharedWorkerFollower('preview.bin', {}, worker(port))).rejects.toThrow('attach failed');
  expect(port.closed).toBe(true);
});

it('probes a fresh SharedWorker port with the selected volume name and closes it', async () => {
  const port = new FakePort((message) => {
    queueMicrotask(() =>
      port.onmessage?.({
        data: { type: 'PROBE_RESULT', id: (message as { id: string }).id, supported: true },
      } as MessageEvent),
    );
  });
  let fileName = '';
  await expect(
    probeSharedWorker('selected.bin', (name) => {
      fileName = name;
      return { port, onerror: null } as unknown as SharedWorker;
    }),
  ).resolves.toBe(true);
  expect(fileName).toBe('selected.bin');
  expect(port.closed).toBe(true);
});

it('reports a SharedWorker probe transport fault without treating it as unsupported', async () => {
  const port = new FakePort(() => queueMicrotask(() => port.onmessageerror?.(new MessageEvent('messageerror'))));
  await expect(probeSharedWorker('fault.bin', worker(port))).rejects.toMatchObject({ code: 'VFS_WORKER_FAILED' });
  expect(port.closed).toBe(true);
});

it('explains a SharedWorker script that cannot be loaded and still rejects without falling back', async () => {
  for (const transport of ['auto', 'shared-worker'] as const) {
    const port = new FakePort(() => {});
    const opening = openOpfsVfsWorker(`script-load-${crypto.randomUUID()}.bin`, {
      transport,
      sharedWorker: () => {
        const endpoint = { port, onerror: null as ((event: ErrorEvent) => unknown) | null };
        // What a browser reports when the worker script URL returns 404 or is blocked.
        setTimeout(() => endpoint.onerror?.(new ErrorEvent('error')), 0);
        return endpoint as unknown as SharedWorker;
      },
    });
    const error = await opening.then(
      () => undefined,
      (reason: unknown) => reason as Error & { code?: string },
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.code).toBe('VFS_WORKER_FAILED');
    expect(error?.message).toMatch(/^The SharedWorker script could not be loaded\./);
    expect(error?.message).toContain('pre-bundling');
    expect(error?.message).toContain('Content-Security-Policy');
    expect(error?.message).toContain('optimizeDeps.exclude');
    expect(error?.message).toContain("`transport: 'dedicated'`");
    expect(port.closed).toBe(true);
  }
});

it('explains a SharedWorker that cannot be created while keeping the thrown error', async () => {
  const refused = new DOMException('Refused to create a worker.', 'SecurityError');
  const error = await openOpfsVfsWorker(`factory-throw-${crypto.randomUUID()}.bin`, {
    sharedWorker: () => {
      throw refused;
    },
  }).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  // Same object, class and name; only the message gains the explanation.
  expect(error).toBe(refused);
  expect(refused).toBeInstanceOf(DOMException);
  expect(refused.name).toBe('SecurityError');
  expect(refused.message).toMatch(/^The SharedWorker could not be created: Refused to create a worker\. Usual causes:/);
  expect(refused.message).toContain('optimizeDeps.exclude');
});

it('uses the requested initialization timeout for the SharedWorker probe', async () => {
  const port = new FakePort(() => {});
  await expect(
    openOpfsVfsWorker('probe-timeout.bin', {
      transport: 'shared-worker',
      initTimeout: 5,
      sharedWorker: worker(port),
    }),
  ).rejects.toMatchObject({ code: 'VFS_INITIALIZATION_TIMEOUT' });
  expect(port.closed).toBe(true);
});

it('aborts automatic probing without retaining its port', async () => {
  const port = new FakePort(() => {});
  const controller = new AbortController();
  const opening = openOpfsVfsWorker('abort-probe.bin', {
    transport: 'shared-worker',
    sharedWorker: () => ({ port, onerror: null }) as unknown as SharedWorker,
    signal: controller.signal,
  });
  controller.abort();
  await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
  expect(port.closed).toBe(true);
});

it('bounds and cancels automatic discovery while the lock query is pending', async () => {
  const query = vi.spyOn(navigator.locks, 'query').mockImplementation(() => new Promise(() => {}));
  try {
    await expect(openOpfsVfsWorker('query-timeout.bin', { initTimeout: 5 })).rejects.toMatchObject({
      code: 'VFS_INITIALIZATION_TIMEOUT',
    });

    const controller = new AbortController();
    const opening = openOpfsVfsWorker('query-abort.bin', { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    expect(query).toHaveBeenCalledTimes(2);
  } finally {
    query.mockRestore();
  }
});

it('uses a no-signal ifAvailable lock probe when LockManager.query is unavailable', async () => {
  const own = Object.getOwnPropertyDescriptor(navigator, 'locks');
  const request = vi.fn((_name: string, _options: LockOptions, callback: LockGrantedCallback<Lock>) =>
    Promise.resolve(callback({ name: 'available' } as Lock)),
  );
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } });
  expect(navigator.locks.query).toBeUndefined();
  expect(navigator.locks.request).toBe(request);
  vi.stubGlobal('SharedWorker', undefined);
  try {
    const client = await openOpfsVfsWorker('no-query.bin', {
      initTimeout: 10,
    });
    expect(request).toHaveBeenCalledWith('opfs-vfs-lock-no-query.bin', { ifAvailable: true }, expect.any(Function));
    expect(request.mock.calls[0]?.[1]).not.toHaveProperty('signal');
    client.dispose();
  } finally {
    vi.unstubAllGlobals();
    if (own) Object.defineProperty(navigator, 'locks', own);
    else delete (navigator as unknown as { locks?: unknown }).locks;
  }
});

it('does not fall back after a successful probe whose fresh ATTACH port times out', async () => {
  const ports: FakePort[] = [];
  const attached: unknown[] = [];
  const opening = openOpfsVfsWorker('attach-timeout.bin', {
    transport: 'shared-worker',
    initTimeout: 1,
    sharedWorker: () => {
      const port = new FakePort((message) => {
        if (ports.length === 1)
          queueMicrotask(() =>
            port.onmessage?.({
              data: { type: 'PROBE_RESULT', id: (message as { id: string }).id, supported: true },
            } as MessageEvent),
          );
        else attached.push(message);
      });
      ports.push(port);
      return { port, onerror: null } as unknown as SharedWorker;
    },
  });
  await expect(opening).rejects.toMatchObject({ code: 'VFS_INITIALIZATION_TIMEOUT' });
  expect(ports).toHaveLength(2);
  expect(ports[0]?.closed).toBe(true);
  expect(ports[1]?.closed).toBe(true);
  expect(attached).toContainEqual(expect.objectContaining({ type: 'CANCEL' }));
});

it('asks the shared owner for a persistence snapshot as soon as a lone follower is ready', async () => {
  const fileName = `shared-persistence-${crypto.randomUUID()}.bin`;
  const generation = crypto.randomUUID();
  const client = new OpfsVfsWorkerClient(
    fileName,
    { followerOnly: { generation, profile: createSharedMountProfile([]) } },
    () => {
      throw new Error('shared followers never spawn workers');
    },
  );
  const channel = (client as unknown as { channel: BroadcastChannel }).channel;
  const posted: Record<string, unknown>[] = [];
  const post = vi.spyOn(channel, 'postMessage').mockImplementation((message) => void posted.push(message));
  try {
    await client.ready;
    expect(client.getStatus()).toMatchObject({ state: 'ready', persistence: null });
    // No other page pings and no owner announcement reaches this channel: the follower must ask by itself.
    await waitFor(() => posted.some(({ type }) => type === 'PERSISTENCE_REQUEST'));
    const request = posted.find(({ type }) => type === 'PERSISTENCE_REQUEST')!;
    expect(request).toMatchObject({ version: 1, generation });
    channel.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'PERSISTENCE_FRAME',
          request: request.request,
          payload: {
            version: 1,
            generation,
            sequence: 1,
            state: 'clean',
            failureRevision: 0,
            lastError: null,
            lastSalvage: null,
          },
        },
      }),
    );
    expect(client.getStatus().persistence).toMatchObject({ state: 'clean', failureRevision: 0 });
  } finally {
    post.mockRestore();
    client.dispose();
  }
});

const lockNames = async (state: 'held' | 'pending') =>
  ((await navigator.locks.query())[state] ?? []).map((lock) => lock.name);

it('keeps the liveness capability optional so pages and hosts of different builds still attach', () => {
  const required = createSharedMountProfile([]);
  const announced = announcedSharedProfile(required);

  expect(announced.capabilities).toContain(OWNER_LIVENESS_CAPABILITY);
  expect(required.capabilities).not.toContain(OWNER_LIVENESS_CAPABILITY);
  // An older follower validates a newer owner's announcement against its own required profile.
  expect(sharedMountProfileMismatch(announced, required)).toBeUndefined();
  // A newer follower validates an older owner's announcement the same way, and learns there is no liveness lock.
  expect(sharedMountProfileMismatch(required, required)).toBeUndefined();
  expect(announcesOwnerLiveness(required)).toBe(false);
  expect(announcesOwnerLiveness(announced)).toBe(true);
});

for (const hostAnnouncesLiveness of [true, false]) {
  it(`watches the ${hostAnnouncesLiveness ? 'liveness' : 'coordinator'} lock when the host ${
    hostAnnouncesLiveness ? 'announces' : 'does not announce'
  } owner liveness`, async () => {
    const fileName = `shared-watch-${crypto.randomUUID()}.bin`;
    const generation = crypto.randomUUID();
    const coordinator = `opfs-vfs-lock-${fileName}`;
    const liveness = `opfs-vfs-owner-${fileName}-${generation}`;
    const watched = hostAnnouncesLiveness ? liveness : coordinator;
    let releaseOwner!: () => void;
    const ownerGone = new Promise<void>((resolve) => (releaseOwner = resolve));
    // The test stands in for the owner and holds what an owner of that build holds.
    const owned = [coordinator, ...(hostAnnouncesLiveness ? [liveness] : [])].map((name) =>
      navigator.locks.request(name, () => ownerGone),
    );
    await waitFor(async () => (await lockNames('held')).includes(watched));
    const port: FakePort = new FakePort((message) => {
      const { type, profile } = message as { type: string; profile: SharedMountProfile };
      if (type !== 'ATTACH') return;
      queueMicrotask(() =>
        port.onmessage?.({
          data: {
            type: 'READY',
            generation,
            profile: hostAnnouncesLiveness ? announcedSharedProfile(profile) : profile,
          },
        } as MessageEvent),
      );
    });
    const client = await createSharedWorkerFollower(fileName, {}, worker(port));
    try {
      await client.ready;
      await waitFor(async () => (await lockNames('pending')).includes(watched));
      // With a liveness lock, a follower never queues on the lock the next owner has to claim.
      expect((await lockNames('pending')).includes(coordinator)).toBe(!hostAnnouncesLiveness);
      expect(client.getStatus().state).toBe('ready');

      releaseOwner();
      await waitFor(() => client.disposed);
      expect(client.getStatus()).toMatchObject({ state: 'failed', error: { code: 'VFS_ATTACHMENT_LOST' } });
    } finally {
      releaseOwner();
      await Promise.all(owned);
      client.dispose();
    }
  });
}

it('holds the liveness lock for a shared owner generation before announcing it', async () => {
  const fileName = `shared-owner-liveness-${crypto.randomUUID()}.bin`;
  const coordinator = `opfs-vfs-lock-${fileName}`;
  // The owner client is the one a SharedWorker host creates; a dedicated worker stands in for its runtime
  // so the mount also works where SharedWorkers cannot open sync access handles.
  const owner = new OpfsVfsWorkerClient(
    fileName,
    { sharedHost: true },
    () => new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' }),
  );
  const tap = new BroadcastChannel(`opfs-vfs-${fileName}`);
  let follower: OpfsVfsWorkerClient | undefined;
  try {
    await owner.ready;
    const generation = owner.getStatus().ownerGeneration!;
    const liveness = `opfs-vfs-owner-${fileName}-${generation}`;
    expect(await lockNames('held')).toEqual(expect.arrayContaining([coordinator, liveness]));

    const announced = new Promise<{ profile: SharedMountProfile }>((resolve) => {
      tap.onmessage = ({ data }) => data?.type === 'LEADER_READY' && resolve(data);
    });
    tap.postMessage({ type: 'LEADER_PING' });
    const { profile } = await announced;
    expect(announcesOwnerLiveness(profile)).toBe(true);

    follower = new OpfsVfsWorkerClient(
      fileName,
      { followerOnly: { generation, profile: createSharedMountProfile([]), ownerLiveness: true } },
      () => {
        throw new Error('shared followers never spawn workers');
      },
    );
    await follower.ready;
    expect((await follower.stat('/')).is_dir).toBe(true);
    await waitFor(async () => (await lockNames('pending')).includes(liveness));
    expect(await lockNames('pending')).not.toContain(coordinator);
    expect(follower.getStatus().state).toBe('ready');

    await owner.closeVfs();
    await waitFor(() => follower!.disposed);
    expect(follower.getStatus().error).toMatchObject({ code: 'VFS_ATTACHMENT_LOST' });
    expect(await lockNames('held')).not.toContain(liveness);
  } finally {
    tap.close();
    follower?.dispose();
    owner.dispose();
    await sleep(20);
    await deleteVolume(fileName).catch(() => {});
  }
});

it('admits a lone page follower through the host with liveness and a first persistence snapshot', async () => {
  const fileName = `shared-host-bridge-${crypto.randomUUID()}.bin`;
  const coordinator = `opfs-vfs-lock-${fileName}`;
  const NativeChannel = MessageChannel;
  const scope: { onconnect?: (event: { ports: MessagePort[] }) => void; close: ReturnType<typeof vi.fn> } = {
    close: vi.fn(),
  };
  vi.stubGlobal('self', scope);
  try {
    startVfsSharedWorker();
  } finally {
    vi.unstubAllGlobals();
  }
  // The host code runs in this page. Its private runtime channel is bridged to a dedicated worker, so the
  // mount also works where a SharedWorker cannot open sync access handles. Only the channel the host creates
  // while it handles ATTACH is bridged; every other MessageChannel stays native.
  const runtime = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' });
  let hostStarting = false;
  class HostChannel {
    constructor() {
      if (!hostStarting) return new NativeChannel();
      return {
        port1: { onmessage: null, postMessage() {} },
        port2: Object.assign(runtime, { start() {}, close: () => runtime.terminate() }),
      };
    }
  }
  const handles = FileSystemFileHandle.prototype as { createSyncAccessHandle?: unknown };
  const pretendSyncHandles = typeof handles.createSyncAccessHandle !== 'function';
  if (pretendSyncHandles) handles.createSyncAccessHandle = () => {};
  vi.stubGlobal('MessageChannel', HostChannel);
  const connect = () => {
    const link = new NativeChannel();
    scope.onconnect!({ ports: [link.port2] });
    const receive = link.port2.onmessage!;
    link.port2.onmessage = (event) => {
      hostStarting = true;
      try {
        return receive.call(link.port2, event);
      } finally {
        hostStarting = false;
      }
    };
    return { port: link.port1, onerror: null };
  };
  let follower: OpfsVfsWorkerClient | undefined;
  try {
    follower = await createSharedWorkerFollower(fileName, {}, connect);
    await follower.ready;
    const generation = follower.getStatus().ownerGeneration!;
    expect(follower.getStatus()).toMatchObject({ transport: 'shared-worker', role: 'follower', state: 'ready' });
    expect((await follower.stat('/')).is_dir).toBe(true);

    // No second page pings the owner, yet the follower learns the owner's persistence state.
    await waitFor(() => follower!.getStatus().persistence !== null);

    // The host announced the liveness lock it holds, so the follower watches that and stays off the
    // coordinator lock the next owner has to claim.
    await waitFor(async () => (await lockNames('pending')).includes(`opfs-vfs-owner-${fileName}-${generation}`));
    expect(await lockNames('pending')).not.toContain(coordinator);

    await follower.shutdownSharedVfs();
    await waitFor(() => scope.close.mock.calls.length > 0);
    await waitFor(async () => !(await lockNames('held')).includes(coordinator));
  } finally {
    vi.unstubAllGlobals();
    if (pretendSyncHandles) delete handles.createSyncAccessHandle;
    follower?.dispose();
    runtime.terminate();
    await sleep(20);
    await deleteVolume(fileName).catch(() => {});
  }
});

it.skipIf(!canRunSharedWorker)('releases a mounted owner when the last ATTACH cancels after host READY', async () => {
  const fileName = `shared-cancel-${crypto.randomUUID()}.bin`;
  const real = realWorker(fileName);
  const bridge = new MessageChannel();
  let hostReady!: () => void;
  const ready = new Promise<void>((resolve) => (hostReady = resolve));
  bridge.port2.onmessage = ({ data }) => real.port.postMessage(data);
  real.port.onmessage = ({ data }) => {
    if (data?.type === 'READY') hostReady();
    else bridge.port2.postMessage(data);
  };
  bridge.port2.start();
  real.port.start();
  const controller = new AbortController();
  let dedicated: OpfsVfsWorker | undefined;
  try {
    const opening = createSharedWorkerFollower(
      fileName,
      { initTimeout: 2_000 },
      () => ({ port: bridge.port1, onerror: null }),
      controller.signal,
    );
    await ready;
    controller.abort();
    await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    await waitFor(async () =>
      navigator.locks.request(`opfs-vfs-lock-${fileName}`, { ifAvailable: true }, (lock) => lock !== null),
    );
    dedicated = new OpfsVfsWorker(fileName);
    await dedicated.ready;
  } finally {
    if (dedicated) await dedicated.closeVfs().catch(() => dedicated!.dispose());
    bridge.port1.close();
    bridge.port2.close();
    real.port.close();
    await deleteVolume(fileName).catch(() => {});
  }
});

it('closes a SharedWorker port when client construction rejects after READY', async () => {
  const port = new FakePort((message) => {
    queueMicrotask(() =>
      port.onmessage?.({
        data: { type: 'READY', generation: 'generation', profile: (message as { profile: unknown }).profile },
      } as MessageEvent),
    );
  });

  await expect(
    createSharedWorkerFollower('preview.bin', { unsupportedOption: true } as never, worker(port)),
  ).rejects.toThrow('Unsupported worker option');
  expect(port.closed).toBe(true);
});

it('closes and rejects a SharedWorker port with an ordinary mount profile', async () => {
  const port = new FakePort(() => {
    queueMicrotask(() =>
      port.onmessage?.({
        data: { type: 'READY', generation: 'generation', profile: createMountProfile([]) },
      } as MessageEvent),
    );
  });

  await expect(createSharedWorkerFollower('preview.bin', {}, worker(port))).rejects.toMatchObject({
    code: 'VFS_PROTOCOL_MISMATCH',
  });
  expect(port.closed).toBe(true);
});

it('keeps shared and ordinary mount profiles separate', () => {
  const ordinary = createMountProfile([]);
  const shared = createSharedMountProfile([]);

  expect(mountProfileMismatch(shared, ordinary)).toBe('VFS_PROTOCOL_MISMATCH');
  expect(sharedMountProfileMismatch(ordinary, shared)).toBe('VFS_PROTOCOL_MISMATCH');
});

it('ignores repeated owner readiness after a create-new shared follower attaches', async () => {
  const fileName = `shared-create-new-${crypto.randomUUID()}.bin`;
  const generation = crypto.randomUUID();
  const profile = createSharedMountProfile([]);
  const client = new OpfsVfsWorkerClient(
    fileName,
    { openMode: 'create-new', followerOnly: { generation, profile } },
    () => {
      throw new Error('shared followers never spawn workers');
    },
  );
  try {
    const channel = (client as unknown as { channel: BroadcastChannel }).channel;
    channel.dispatchEvent(new MessageEvent('message', { data: { type: 'LEADER_READY', generation, profile } }));
    await client.ready;
    channel.dispatchEvent(new MessageEvent('message', { data: { type: 'LEADER_READY', generation, profile } }));
    expect(client.getStatus().state).toBe('ready');
  } finally {
    client.dispose();
  }
});

it('keeps a raw SharedWorker follower alive through the shutdown acknowledgement', async () => {
  const fileName = `shared-preview-${crypto.randomUUID()}.bin`;
  const generation = crypto.randomUUID();
  const profile = createSharedMountProfile([]);
  let releaseOwner!: () => void;
  const ownerHeld = navigator.locks.request(`opfs-vfs-lock-${fileName}`, async () => {
    await new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
  });
  await waitFor(() => releaseOwner !== undefined);
  let transportClosed = 0;
  const client = new OpfsVfsWorkerClient(
    fileName,
    {
      followerOnly: { generation, profile },
      attachmentId: crypto.randomUUID(),
      transportClose: () => transportClosed++,
    },
    () => {
      throw new Error('raw shared followers never create a dedicated worker');
    },
  );
  const internals = client as unknown as { channel: BroadcastChannel; attachmentId: string };
  const post = vi.spyOn(internals.channel, 'postMessage').mockImplementation((message) => {
    const frame = message as {
      id?: number;
      tabId?: string;
      generation?: string;
      payload?: { type?: string };
    };
    if (frame.payload?.type !== 'SHUTDOWN_LEADER') return;
    releaseOwner();
    setTimeout(() => {
      internals.channel.dispatchEvent(
        new MessageEvent('message', {
          data: { id: frame.id, tabId: frame.tabId, generation: frame.generation, type: 'RESPONSE' },
        }),
      );
    }, 0);
  });
  try {
    await client.ready;
    const shutdown = client.shutdownSharedVfs();
    expect(client.getStatus().state).toBe('closing');
    await expect(client.stat('/')).rejects.toMatchObject({ code: 'VFS_SHUTTING_DOWN' });
    await shutdown;
    expect(client.getStatus().state).toBe('closed');
    expect(transportClosed).toBe(1);
  } finally {
    post.mockRestore();
    client.dispose();
    releaseOwner();
    await ownerHeld;
  }
});

it.skipIf(!canRunSharedWorker)(
  'uses a real WebKit SharedWorker to reject repeated attaches, retire resources, and reopen after shutdown',
  async () => {
    const fileName = `shared-preview-webkit-${crypto.randomUUID()}.bin`;
    const plugins = [changesTransportRequest()];
    const profile = createSharedMountProfile(plugins);
    const raw = realWorker(fileName);
    raw.port.start();
    const attach = {
      type: 'ATTACH',
      version: 1,
      clientId: crypto.randomUUID(),
      fileName,
      options: {},
      plugins,
      profile,
    };
    let first: OpfsVfsWorkerClient | undefined;
    let second: OpfsVfsWorkerClient | undefined;
    let admin: OpfsVfsWorkerClient | undefined;
    let fresh: OpfsVfsWorkerClient | undefined;
    const control = new BroadcastChannel('opfs-vfs-shared-worker-test-control');
    try {
      const ready = nextPortMessage(raw.port, 'READY');
      raw.port.postMessage(attach);
      // The real host announces the liveness lock it holds; page followers watch that instead of the coordinator.
      expect(announcesOwnerLiveness((await ready).profile)).toBe(true);
      const repeated = nextPortMessage(raw.port, 'ERROR');
      raw.port.postMessage(attach);
      expect((await repeated).error).toMatchObject({ code: 'EINVAL' });

      first = await createSharedWorkerFollower(fileName, { plugins }, realWorker);
      second = await createSharedWorkerFollower(fileName, { plugins }, realWorker);
      await Promise.all([first.ready, second.ready]);
      const fd = await first.open('/open-before-shutdown', true);
      let interrupted = 0;
      await first.openFileChangeChannel(
        () => {},
        (code) => {
          if (code === 'SUBSCRIPTION_INTERRUPTED') interrupted++;
        },
        () => {},
      );

      const enabled = nextControl(control, 'close-hold-enabled');
      control.postMessage('hold-close');
      await enabled;
      admin = await createSharedWorkerFollower(fileName, { plugins }, realWorker);
      await admin.ready;
      const closeRequested = nextControl(control, 'close-requested');
      const held = nextControl(control, 'close-held');
      const shutdown = admin.shutdownSharedVfs();
      expect(admin.getStatus().state).toBe('closing');
      await expect(admin.stat('/')).rejects.toMatchObject({ code: 'VFS_SHUTTING_DOWN' });
      await closeRequested;
      await held;
      await expect(createSharedWorkerFollower(fileName, { plugins }, realWorker)).rejects.toMatchObject({
        code: 'VFS_SHUTTING_DOWN',
      });
      control.postMessage('release-close');
      await shutdown;

      await waitFor(() => first!.disposed && second!.disposed && interrupted === 1, 5_000);
      await expect(first.fstat(fd)).rejects.toMatchObject({ code: 'VFS_SHUTTING_DOWN' });
      await sleep(20);
      fresh = await createSharedWorkerFollower(fileName, { plugins }, realWorker);
      await fresh.ready;
      await fresh.shutdownSharedVfs();
      await deleteVolume(fileName);
    } finally {
      control.postMessage('release-close');
      control.close();
      raw.port.close();
      fresh?.dispose();
      admin?.dispose();
      second?.dispose();
      first?.dispose();
      await deleteVolume(fileName).catch(() => {});
    }
  },
);
