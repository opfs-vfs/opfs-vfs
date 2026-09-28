import { expect, it } from 'vitest';

const modulePath = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_PACKED_SUBSCRIPTIONS_CONSUMER;
if (!modulePath?.startsWith('/.packed/')) throw new Error('Packed consumer module is required');

it('runs installed direct subscriptions through the public API', async () => {
  const consumer = (await import(/* @vite-ignore */ modulePath)) as typeof import('./packed-consumer');
  await expect(consumer.runDirect()).resolves.toEqual([
    'create:/direct.txt:1',
    'update:/direct.txt:2',
    'delete:/direct.txt:deleted',
    'create:/direct.txt:3',
  ]);
}, 60000);
