import { expect, it } from 'vitest';

it('reserves imports across ordinary and owner mounts without changing refused volumes', async () => {
  const worker = new Worker(new URL('./import-lifecycle-worker.ts', import.meta.url), { type: 'module' });
  try {
    const result = await new Promise<{ ok?: boolean; error?: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('import lifecycle worker timed out')), 15_000);
      worker.onerror = (event) => {
        clearTimeout(timer);
        reject(new Error(event.message));
      };
      worker.onmessage = ({ data }) => {
        clearTimeout(timer);
        resolve(data);
      };
      worker.postMessage({ name: `import-lifecycle-${crypto.randomUUID()}.bin` });
    });
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
  } finally {
    worker.terminate();
  }
}, 20_000);
