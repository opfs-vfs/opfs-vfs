import { deleteVolume } from '@opfs-vfs/opfs-vfs';
import { expect, it } from 'vitest';

const modulePath = (import.meta as unknown as { env?: Record<string, string> }).env
  ?.VITE_PACKED_EFFECT_SUBSCRIPTIONS_EXAMPLE;

it.skipIf(!modulePath)(
  'runs the packed Effect subscription example',
  async () => {
    const fileName = `effect-packed-subscriptions-${crypto.randomUUID()}.bin`;
    try {
      const example = (await import(/* @vite-ignore */ modulePath!)) as typeof import('../examples/subscriptions');
      const result = await example.observeOneChange(fileName);
      expect(result.change).toMatchObject({
        _tag: 'Some',
        value: { type: 'create', path: '/observed.txt' },
      });
      expect(result.retired).toEqual({ status: 'released' });
    } finally {
      await deleteVolume(fileName);
    }
  },
  30_000,
);
