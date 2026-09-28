import { deleteVolume } from '@opfs-vfs/opfs-vfs';
import { OpfsVfsWorker } from '@opfs-vfs/opfs-vfs/worker';
import { subscribe, type Subscription } from '@opfs-vfs/plugin-subscriptions/client';
import { subscriptionsRequest } from '@opfs-vfs/plugin-subscriptions/config';

const waitFor = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('subscription delivery timed out');
};

const worker = () => new Worker(new URL('./packed-consumer-worker.ts', import.meta.url), { type: 'module' });

export async function runDirect(): Promise<string[]> {
  const direct = new Worker(new URL('./packed-consumer-direct-worker.ts', import.meta.url), { type: 'module' });
  return await new Promise<string[]>((resolve, reject) => {
    direct.onmessage = ({ data }: MessageEvent<{ seen?: string[]; error?: string }>) => {
      direct.terminate();
      if (data.seen) resolve(data.seen);
      else reject(new Error(data.error ?? 'direct consumer returned no result'));
    };
    direct.onerror = (event) => {
      direct.terminate();
      reject(new Error(event.message));
    };
    direct.postMessage({});
  });
}

export async function runWorkerFollower(): Promise<string[]> {
  const name = `packed-subscriptions-worker-${crypto.randomUUID()}.bin`;
  const plugins = [subscriptionsRequest()];
  const owner = new OpfsVfsWorker(name, { worker, plugins });
  let follower: OpfsVfsWorker | undefined;
  let handle: Subscription | undefined;
  try {
    await owner.ready;
    follower = new OpfsVfsWorker(name, { worker, plugins });
    await follower.ready;
    await owner.writeFileBuffer('/worker.txt', new Uint8Array());
    const seen: string[] = [];
    let releaseFirst!: () => void;
    let firstSeen!: () => void;
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    const first = new Promise<void>((resolve) => (firstSeen = resolve));
    handle = await subscribe(
      follower,
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
    await owner.writeFileBuffer('/worker.txt', new Uint8Array([1]));
    await first;
    await owner.writeFileBuffer('/worker.txt', new Uint8Array([2]));
    await owner.unlink('/worker.txt');
    await owner.writeFileBuffer('/worker.txt', new Uint8Array([3]));
    releaseFirst();
    await waitFor(() => seen.length === 4);
    return seen;
  } finally {
    handle?.unsubscribe();
    try {
      await owner.closeVfs();
    } finally {
      owner.dispose();
      follower?.dispose();
      await deleteVolume(name);
    }
  }
}
