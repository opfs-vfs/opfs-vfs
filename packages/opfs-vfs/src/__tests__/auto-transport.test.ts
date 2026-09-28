import { expect, it } from 'vitest';
import { OpfsVfsWorker, openOpfsVfsWorker } from '../index_internal';
import { deleteVolume } from '../volume-files';
import { createMountProfile } from '../worker-plugins';

const name = (prefix: string) => `${prefix}-${crypto.randomUUID()}.bin`;
const supportsSharedSyncHandle = /AppleWebKit/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent);

async function remove(fileName: string) {
  await deleteVolume(fileName).catch(() => {});
}

async function close(client: Awaited<ReturnType<typeof openOpfsVfsWorker>>) {
  if (client.getStatus().transport === 'shared-worker') await client.shutdownSharedVfs();
  else await client.closeVfs();
}

it('selects SharedWorker only after its real capability probe, otherwise reports the dedicated reason', async () => {
  const fileName = name('auto-capability');
  let client: Awaited<ReturnType<typeof openOpfsVfsWorker>> | undefined;
  try {
    client = await openOpfsVfsWorker(fileName);
    await client.ready;
    const status = client.getStatus();
    if (supportsSharedSyncHandle) expect(status).toMatchObject({ transport: 'shared-worker', fallbackReason: null });
    else
      expect(status).toMatchObject({ transport: 'dedicated', fallbackReason: 'shared-worker-sync-handle-unavailable' });
  } finally {
    if (client) await close(client).catch(() => client!.dispose());
    await remove(fileName);
  }
});

it('concurrent automatic opens converge on one supported SharedWorker generation', async () => {
  const fileName = name('auto-concurrent');
  let first: Awaited<ReturnType<typeof openOpfsVfsWorker>> | undefined;
  let second: Awaited<ReturnType<typeof openOpfsVfsWorker>> | undefined;
  try {
    [first, second] = await Promise.all([openOpfsVfsWorker(fileName), openOpfsVfsWorker(fileName)]);
    await Promise.all([first.ready, second.ready]);
    if (first.getStatus().transport === 'shared-worker') {
      expect(second.getStatus()).toMatchObject({
        transport: 'shared-worker',
        fallbackReason: null,
        ownerGeneration: first.getStatus().ownerGeneration,
      });
    } else {
      expect(first.getStatus().fallbackReason).toBe('shared-worker-sync-handle-unavailable');
      expect(second.getStatus().fallbackReason).toBe('shared-worker-sync-handle-unavailable');
    }
  } finally {
    if (first) await close(first).catch(() => first!.dispose());
    second?.dispose();
    await remove(fileName);
  }
});

it('opens two distinct automatic volumes concurrently', async () => {
  const names = [name('auto-two-a'), name('auto-two-b')];
  let clients: Awaited<ReturnType<typeof openOpfsVfsWorker>>[] = [];
  try {
    clients = await Promise.all(names.map((fileName) => openOpfsVfsWorker(fileName)));
    await Promise.all(clients.map((client) => client.ready));
    for (const client of clients)
      expect(client.getStatus().transport).toBe(supportsSharedSyncHandle ? 'shared-worker' : 'dedicated');
  } finally {
    await Promise.all(clients.map((client) => close(client).catch(() => client.dispose())));
    await Promise.all(names.map(remove));
  }
});

it('keeps a positively observed compatible dedicated owner', async () => {
  const fileName = name('auto-dedicated-owner');
  const owner = new OpfsVfsWorker(fileName);
  let client: Awaited<ReturnType<typeof openOpfsVfsWorker>> | undefined;
  try {
    await owner.ready;
    client = await openOpfsVfsWorker(fileName);
    await client.ready;
    expect(client.getStatus()).toMatchObject({ transport: 'dedicated', fallbackReason: 'existing-dedicated-owner' });
  } finally {
    client?.dispose();
    await owner.closeVfs().catch(() => owner.dispose());
    await remove(fileName);
  }
});

it('waits past the old probe window for a held dedicated owner instead of trying SharedWorker', async () => {
  const fileName = name('auto-delayed-owner');
  let release!: () => void;
  const held = navigator.locks.request(`opfs-vfs-lock-${fileName}`, async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
  const channel = new BroadcastChannel(`opfs-vfs-${fileName}`);
  let client: Awaited<ReturnType<typeof openOpfsVfsWorker>> | undefined;
  channel.onmessage = ({ data }) => {
    if (data?.type !== 'LEADER_PING') return;
    setTimeout(() => {
      channel.postMessage({ type: 'LEADER_READY', generation: crypto.randomUUID(), profile: createMountProfile([]) });
      release();
    }, 600);
  };
  try {
    client = await openOpfsVfsWorker(fileName, { initTimeout: 1_000 });
    await client.ready;
    expect(client.getStatus()).toMatchObject({ transport: 'dedicated', fallbackReason: 'existing-dedicated-owner' });
  } finally {
    client?.dispose();
    release();
    await held;
    channel.close();
    await remove(fileName);
  }
});

it('rejects a positively observed malformed dedicated owner profile instead of changing transport', async () => {
  const fileName = name('auto-mismatch');
  const controller = new AbortController();
  let release!: () => void;
  const held = navigator.locks.request(`opfs-vfs-lock-${fileName}`, { signal: controller.signal }, async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
  const channel = new BroadcastChannel(`opfs-vfs-${fileName}`);
  channel.onmessage = ({ data }) => {
    if (data?.type === 'LEADER_PING')
      channel.postMessage({ type: 'LEADER_READY', generation: crypto.randomUUID(), profile: {} });
  };
  try {
    await expect(openOpfsVfsWorker(fileName)).rejects.toMatchObject({ code: 'VFS_PROTOCOL_MISMATCH' });
  } finally {
    channel.close();
    release();
    await held;
    await remove(fileName);
  }
});

it('requires explicit dedicated selection for forceLeader', async () => {
  await expect(openOpfsVfsWorker(name('auto-force-leader'), { forceLeader: true })).rejects.toMatchObject({
    code: 'EINVAL',
  });
});
