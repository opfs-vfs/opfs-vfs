import { expect, it } from 'vitest';

it('enforces the storage contract in a dedicated OPFS worker', async () => {
  const worker = new Worker(new URL('./storage-contract-worker.ts', import.meta.url), { type: 'module' });
  try {
    const checks = await new Promise<{ pass: boolean; detail: string }[]>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('storage contract worker timed out')), 15000);
      worker.onerror = (event) => {
        clearTimeout(timeout);
        reject(new Error(event.message));
      };
      worker.onmessage = (event) => {
        clearTimeout(timeout);
        if (event.data.error) reject(new Error(event.data.error));
        else resolve(event.data);
      };
      worker.postMessage(null);
    });
    for (const check of checks) expect(check.pass, check.detail).toBe(true);
  } finally {
    worker.terminate();
  }
});
