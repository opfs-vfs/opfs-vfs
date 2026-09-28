import { expect, it } from 'vitest';

for (const bufferMode of ['disk', 'memory']) {
  for (const scenario of ['io', 'links', 'identity']) {
    it(`live Wasmer adapter ${scenario} with real ${bufferMode} OPFS storage`, async () => {
      await expect(
        new Promise<void>((resolve, reject) => {
          const worker = new Worker(new URL('./wasmer-sync-adapter-worker.ts', import.meta.url), { type: 'module' });
          const finish = (error?: string) => {
            clearTimeout(timer);
            worker.terminate();
            if (error) reject(new Error(error));
            else resolve();
          };
          const timer = setTimeout(() => finish('adapter worker timed out'), 20_000);
          worker.onerror = (event) => finish(event.message);
          worker.onmessage = ({ data }) => finish(data.error);
          worker.postMessage({ scenario, bufferMode });
        }),
      ).resolves.toBeUndefined();
    }, 25_000);
  }
}
