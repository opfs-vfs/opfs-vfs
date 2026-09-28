import { deleteVolume } from '@opfs-vfs/opfs-vfs';
import { OpfsVfsWorker } from '@opfs-vfs/opfs-vfs/worker';
import { describe, expect, it } from 'vitest';
import { subscribe } from '../client';
import { subscriptionsRequest } from '../config';

const enabled = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_SUBSCRIPTIONS_LOAD === '1';
const worker = () => new Worker(new URL('./subscription-registration-worker.ts', import.meta.url), { type: 'module' });

function runDirectLoad() {
  const direct = new Worker(new URL('./subscription-load-direct-worker.ts', import.meta.url), { type: 'module' });
  return new Promise<{ delivered?: number; streamMs?: number; terminal?: string; error?: string }>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        direct.terminate();
        reject(new Error('direct load worker timed out'));
      }, 45000);
      direct.onerror = (event) => {
        clearTimeout(timer);
        direct.terminate();
        reject(new Error(event.message));
      };
      direct.onmessage = ({ data }) => {
        clearTimeout(timer);
        direct.terminate();
        if (data.error) reject(new Error(data.error));
        else resolve(data);
      };
      direct.postMessage({});
    },
  );
}

async function waitFor(check: () => boolean, timeout = 30000): Promise<void> {
  const deadline = performance.now() + timeout;
  while (!check()) {
    if (performance.now() > deadline) throw new Error('subscription load timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe.skipIf(!enabled)('subscription metadata load gate', () => {
  it('measures a 4096-record rename burst and one-credit 10k owner-to-follower stream', async () => {
    const direct = await runDirectLoad();
    const name = `subscriptions-load-${crypto.randomUUID()}.bin`;
    const owner = new OpfsVfsWorker(name, { worker, plugins: [subscriptionsRequest()] });
    await owner.ready;
    await owner.mkdir('/source');
    await owner.mkdir('/stream');
    for (let i = 0; i < 2047; i++) await owner.writeFileBuffer(`/source/${i}`, new Uint8Array([i & 255]));
    const follower = new OpfsVfsWorker(name, { worker, plugins: [subscriptionsRequest()] });
    let first = 0;
    let second = 0;
    let stream = 0;
    const errors: string[] = [];
    try {
      await follower.ready;
      const hold = () => new Promise<void>(() => {});
      const rootOptions = {
        path: '/',
        scope: 'directory' as const,
        recursive: true,
        onError: (cause: { code: string }) => {
          errors.push(cause.code);
        },
      };
      const firstSub = await subscribe(follower, rootOptions, async () => {
        first++;
        await hold();
      });
      const secondSub = await subscribe(follower, rootOptions, async () => {
        second++;
        await hold();
      });
      const started = performance.now();
      await owner.rename('/source', '/destination');
      await waitFor(() => first === 1 && second === 1);
      const capacityMs = performance.now() - started;
      const capacityErrors = [...errors];
      firstSub.unsubscribe();
      secondSub.unsubscribe();
      const streamSub = await subscribe(
        follower,
        {
          path: '/stream',
          scope: 'directory',
          recursive: true,
          onError: (cause) => {
            errors.push(cause.code);
          },
        },
        () => {
          stream++;
        },
      );
      const streamStarted = performance.now();
      for (let i = 0; i < 10000; i++) await owner.writeFileBuffer(`/stream/${i}`, new Uint8Array([i & 255]));
      await waitFor(() => stream === 10000 || errors.length > 0);
      const metrics = {
        direct,
        capacityMs,
        capacityHeldCallbacks: first + second,
        expectedCapacityRecipients: 8192,
        capacityErrors,
        streamMs: performance.now() - streamStarted,
        stream,
        overflowCount: errors.filter((code) => code === 'SUBSCRIPTION_OVERFLOW').length,
        errors,
      };
      console.info('SUBSCRIPTIONS_LOAD', JSON.stringify(metrics));
      streamSub.unsubscribe();
      expect(metrics.direct.terminal === 'SUBSCRIPTION_OVERFLOW' || metrics.direct.delivered === 10000).toBe(true);
      expect(metrics.capacityHeldCallbacks).toBe(2);
      expect(metrics.capacityErrors).toEqual([]);
      expect(metrics.overflowCount).toBe(0);
      expect(metrics.stream).toBe(10000);
    } finally {
      owner.dispose();
      follower.dispose();
      await deleteVolume(name);
    }
  }, 180000);
});
