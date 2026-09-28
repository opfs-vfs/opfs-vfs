import { deleteVolume, OpfsVfs } from '@opfs-vfs/opfs-vfs';
import { subscriptions } from '@opfs-vfs/plugin-subscriptions';
import { subscribe, type Subscription } from '@opfs-vfs/plugin-subscriptions/client';

const waitFor = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('subscription delivery timed out');
};

self.onmessage = async () => {
  const name = `packed-subscriptions-direct-${crypto.randomUUID()}.bin`;
  const fs = new OpfsVfs(name, { plugins: [subscriptions()] });
  let handle: Subscription | undefined;
  let result: { seen?: string[]; error?: string };
  try {
    await fs.ready;
    const seen: string[] = [];
    let releaseFirst!: () => void;
    let firstSeen!: () => void;
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    const first = new Promise<void>((resolve) => (firstSeen = resolve));
    handle = await subscribe(
      fs,
      {
        path: '/',
        scope: 'directory',
        recursive: true,
        events: ['create', 'update', 'delete'],
        content: { maxBytes: 8 },
        onError() {},
      },
      async (change) => {
        if (change.content.status === 'included') {
          if (seen.length === 0) {
            firstSeen();
            await firstGate;
          }
          seen.push(`${change.type}:${change.path}:${change.content.bytes[0]}`);
        } else seen.push(`${change.type}:${change.path}:${change.content.reason}`);
      },
    );
    fs.writeFileBufferSync('/direct.txt', new Uint8Array([1]));
    await first;
    fs.writeFileBufferSync('/direct.txt', new Uint8Array([2]));
    fs.unlinkSync('/direct.txt');
    fs.writeFileBufferSync('/direct.txt', new Uint8Array([3]));
    releaseFirst();
    await waitFor(() => seen.length === 4);
    result = { seen };
  } catch (cause) {
    result = { error: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause) };
  } finally {
    handle?.unsubscribe();
    try {
      await fs.closeVfs();
      await deleteVolume(name);
    } catch (cause) {
      result = { error: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause) };
    }
  }
  self.postMessage(result!);
};
