import { expect, it } from 'vitest';
import { deleteVolume } from '../volume-files';

it('runs the public live adapter with the downloadable host, preserving data across fresh runtimes', async () => {
  const name = `edgejs-live-${crypto.randomUUID()}.bin`;
  const worker = new Worker(new URL('./edgejs-live-worker.ts', import.meta.url), { type: 'module' });
  try {
    const result = await new Promise<{ exit: number; reopened: string; live: string; descriptors: number }>(
      (resolve, reject) => {
        worker.onerror = (event) => reject(new Error(event.message));
        worker.onmessage = ({ data }) => (data.error ? reject(new Error(data.error)) : resolve(data));
        worker.postMessage(name);
      },
    );
    expect(result).toEqual({ exit: 0, reopened: 'HOST-UPDATED-LONGER', live: 'guest output', descriptors: 0 });
  } finally {
    worker.terminate();
    await navigator.locks.request(`opfs-vfs-volume-${name}`, { signal: AbortSignal.timeout(10000) }, () => {});
    await deleteVolume(name);
  }
});
