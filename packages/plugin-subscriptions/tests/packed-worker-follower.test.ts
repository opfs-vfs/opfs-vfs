import { expect, it } from 'vitest';

const modulePath = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_PACKED_SUBSCRIPTIONS_CONSUMER;
if (!modulePath?.startsWith('/.packed/')) throw new Error('Packed consumer module is required');

it('relays installed subscriptions to a follower through the public API', async () => {
  const consumer = (await import(/* @vite-ignore */ modulePath)) as typeof import('./packed-consumer');
  await expect(consumer.runWorkerFollower()).resolves.toEqual([
    'update:/worker.txt:1',
    'update:/worker.txt:2',
    'delete:/worker.txt:deleted',
    'create:/worker.txt:3',
  ]);
}, 60000);
