import { deleteVolume, OpenFlags } from '@opfs-vfs/opfs-vfs';
import { OpfsVfsWorker } from '@opfs-vfs/opfs-vfs/worker';
import { subscribe } from '../client';
import { subscriptionsRequest } from '../config';

type Result =
  | { first: number[][]; second: number[][]; firstHeld: number[]; secondHeld: number[]; current: number[] }
  | { error: string };
const worker = () => new Worker(new URL('./subscription-content-worker.ts', import.meta.url), { type: 'module' });

self.onmessage = async ({ data }: MessageEvent<{ bufferMode: 'memory' | 'disk' }>) => {
  const name = `subscription-content-sab-${crypto.randomUUID()}.bin`;
  const fs = new OpfsVfsWorker(name, {
    bufferMode: data.bufferMode,
    forceLeader: true,
    worker,
    plugins: [subscriptionsRequest()],
  });
  let result: Result = { error: 'SAB content worker did not finish' };
  try {
    await fs.ready;
    await fs.writeFileBuffer('/document', new Uint8Array());
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let firstStarted!: () => void;
    let secondStarted!: () => void;
    let firstSecond!: () => void;
    let secondSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    const secondGate = new Promise<void>((resolve) => (releaseSecond = resolve));
    const firstA = new Promise<void>((resolve) => (firstStarted = resolve));
    const secondA = new Promise<void>((resolve) => (secondStarted = resolve));
    const firstB = new Promise<void>((resolve) => (firstSecond = resolve));
    const secondB = new Promise<void>((resolve) => (secondSecond = resolve));
    const first: number[][] = [];
    const second: number[][] = [];
    let firstHeld: Uint8Array | undefined;
    let secondHeld: Uint8Array | undefined;
    const options = {
      path: '/document',
      scope: 'file' as const,
      events: ['update'] as const,
      content: { maxBytes: 16 * 1024 * 1024 },
      onError(error: Error) {
        throw error;
      },
    };
    const firstSubscription = await subscribe(fs, options, async (change) => {
      if (change.content.status !== 'included') throw new Error('Missing SAB content');
      first.push([...change.content.bytes]);
      if (first.length === 1) {
        firstHeld = change.content.bytes;
        change.content.bytes[0] = 9;
        firstStarted();
        await firstGate;
      } else firstSecond();
    });
    const secondSubscription = await subscribe(fs, options, async (change) => {
      if (change.content.status !== 'included') throw new Error('Missing SAB content');
      second.push([...change.content.bytes]);
      if (second.length === 1) {
        secondHeld = change.content.bytes;
        secondStarted();
        await secondGate;
      } else secondSecond();
    });
    const fd = fs.openSync('/document', OpenFlags.O_RDWR);
    fs.writeSync(fd, new Uint8Array([1]), 0);
    await Promise.all([firstA, secondA]);
    fs.writeSync(fd, new Uint8Array([2]), 0);
    fs.closeSync(fd);
    await fs.unlink('/document');
    await fs.writeFileBuffer('/document', new Uint8Array([3]));
    const current = [...(await fs.readFileBuffer('/document'))];
    releaseFirst();
    releaseSecond();
    await Promise.all([firstB, secondB]);
    firstSubscription.unsubscribe();
    secondSubscription.unsubscribe();
    if (!firstHeld || !secondHeld) throw new Error('Missing held SAB content');
    result = { first, second, firstHeld: [...firstHeld], secondHeld: [...secondHeld], current };
  } catch (error) {
    result = { error: error instanceof Error ? error.message : String(error) };
  } finally {
    try {
      await fs.closeVfs();
      await deleteVolume(name);
    } catch (error) {
      result = {
        error: `${'error' in result ? result.error : 'SAB content completed'}; cleanup failed: ${String(error)}`,
      };
    }
    self.postMessage(result);
  }
};
