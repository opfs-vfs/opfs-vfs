import { deleteVolume, OpfsVfs } from '@opfs-vfs/opfs-vfs';
import { subscribe, type Subscription } from '../client';
import { subscriptions } from '../index';

self.onmessage = async () => {
  const name = `subscriptions-load-direct-${crypto.randomUUID()}.bin`;
  const fs = new OpfsVfs(name, { plugins: [subscriptions()] });
  let subscription: Subscription | undefined;
  let result: { delivered?: number; streamMs?: number; terminal?: string; error?: string } = {};
  try {
    await fs.ready;
    let delivered = 0;
    let terminal: string | undefined;
    let done!: () => void;
    const drained = new Promise<void>((resolve) => (done = resolve));
    subscription = await subscribe(
      fs,
      {
        path: '/',
        scope: 'directory',
        recursive: true,
        onError(error) {
          terminal = error.code;
          done();
        },
      },
      () => {
        if (++delivered === 10000) done();
      },
    );
    const started = performance.now();
    for (let i = 0; i < 10000; i++) fs.writeFileBufferSync(`/direct-${i}`, new Uint8Array([i & 255]));
    await Promise.race([
      drained,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('direct load delivery timed out')), 30000)),
    ]);
    result = { delivered, streamMs: performance.now() - started, terminal };
  } catch (error) {
    result = { error: error instanceof Error ? error.message : String(error) };
  } finally {
    subscription?.unsubscribe();
    try {
      await fs.closeVfs();
      await deleteVolume(name);
    } catch (error) {
      result = { error: `${result.error ?? 'direct load completed'}; cleanup failed: ${String(error)}` };
    }
    self.postMessage(result);
  }
};
