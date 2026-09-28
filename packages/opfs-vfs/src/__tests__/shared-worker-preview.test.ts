import { expect, it, vi } from 'vitest';
import { createSharedWorkerFollower, probeSharedWorker, startVfsSharedWorker } from '../shared-worker';
import { OpfsVfsWorker, openOpfsVfsWorker } from '../index_internal';
import { deleteVolume } from '../volume-files';
import { OpfsVfsWorkerClient } from '../worker-client';
import { changesTransportRequest } from './changes-transport-plugin';
import {
  createMountProfile,
  createSharedMountProfile,
  mountProfileMismatch,
  sharedMountProfileMismatch,
} from '../worker-plugins';

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
      await ready;
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
