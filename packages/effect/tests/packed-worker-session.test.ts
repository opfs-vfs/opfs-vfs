import { expect, it } from 'vitest';
import { deleteVolume } from '@opfs-vfs/opfs-vfs';

const modulePath = '/.packed/examples/worker-session.ts';

it('runs the packed worker session example', async () => {
  const fileName = `effect-packed-${crypto.randomUUID()}.bin`;
  try {
    const example = (await import(/* @vite-ignore */ modulePath)) as typeof import('../examples/worker-session');
    const result = await example.runWorkerSession(fileName);
    expect(result.content).toBe('saved by a worker');
    expect(['clean', 'dirty']).toContain(result.persistence.state);
    expect(result.persistence.error).toBeNull();
  } finally {
    await deleteVolume(fileName);
  }
}, 30_000);
