import { deleteVolume, OpenFlags, OpfsVfs } from '@opfs-vfs/opfs-vfs';
import { subscribe } from '../client';
import { subscriptions } from '../index';

type Result =
  | { first: number[][]; second: number[][]; firstHeld: number[]; secondHeld: number[]; current: number[] }
  | { error: string };

self.onmessage = async ({ data }: MessageEvent<{ bufferMode: 'memory' | 'disk' }>) => {
  const name = `subscription-content-direct-${crypto.randomUUID()}.bin`;
  const fs = new OpfsVfs(name, { bufferMode: data.bufferMode, plugins: [subscriptions()] });
  let result: Result = { error: 'Direct content worker did not finish' };
  try {
    await fs.ready;
    fs.writeFileBufferSync('/document', new Uint8Array());
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
      if (change.content.status !== 'included') throw new Error('Missing direct content');
      first.push([...change.content.bytes]);
      if (first.length === 1) {
        firstHeld = change.content.bytes;
        change.content.bytes[0] = 9;
        firstStarted();
        await firstGate;
      } else firstSecond();
    });
    const secondSubscription = await subscribe(fs, options, async (change) => {
      if (change.content.status !== 'included') throw new Error('Missing direct content');
      second.push([...change.content.bytes]);
      if (second.length === 1) {
        secondHeld = change.content.bytes;
        secondStarted();
        await secondGate;
      } else secondSecond();
    });
    fs.writeFileBufferSync('/document', new Uint8Array([1]));
    await Promise.all([firstA, secondA]);
    fs.writeFileBufferSync('/document', new Uint8Array([2]));
    fs.unlinkSync('/document');
    fs.writeFileBufferSync('/document', new Uint8Array([3]));
    const fd = fs.openSync('/document', OpenFlags.O_RDONLY);
    const current = [...fs.readSync(fd, 1, 0).buffer];
    fs.closeSync(fd);
    releaseFirst();
    releaseSecond();
    await Promise.all([firstB, secondB]);
    firstSubscription.unsubscribe();
    secondSubscription.unsubscribe();
    if (!firstHeld || !secondHeld) throw new Error('Missing held direct content');
    result = { first, second, firstHeld: [...firstHeld], secondHeld: [...secondHeld], current };
  } catch (error) {
    result = { error: error instanceof Error ? error.message : String(error) };
  } finally {
    try {
      await fs.closeVfs();
      await deleteVolume(name);
    } catch (error) {
      result = {
        error: `${'error' in result ? result.error : 'Direct content completed'}; cleanup failed: ${String(error)}`,
      };
    }
    self.postMessage(result);
  }
};
