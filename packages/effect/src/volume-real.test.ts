import { expect, it } from 'vitest';

const packedExample = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_PACKED_EFFECT_EXAMPLE;

it('inspects, writes, syncs and reopens a real direct volume in a worker', async () => {
  const worker = new Worker(new URL('./volume-smoke-worker.ts', import.meta.url), { type: 'module' });
  try {
    const result = await new Promise<{
      ok: boolean;
      before?: { exists: boolean };
      after?: { exists: boolean };
      reopened?: { content: string; persistence: { state: string } };
      example?: { state: string };
      error?: string;
    }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('direct volume worker timed out')), 20_000);
      worker.onerror = (event) => {
        clearTimeout(timeout);
        reject(event.error ?? new Error(event.message));
      };
      worker.onmessage = ({ data }) => {
        clearTimeout(timeout);
        resolve(data);
      };
      worker.postMessage({ type: 'run', example: packedExample });
    });
    expect(result.ok, result.error).toBe(true);
    expect(result.before?.exists).toBe(false);
    expect(result.after?.exists).toBe(true);
    expect(result.reopened).toMatchObject({ content: 'scoped direct volume', persistence: { state: 'clean' } });
    if (packedExample) expect(result.example).toMatchObject({ state: 'clean' });
  } finally {
    worker.terminate();
  }
}, 25_000);
