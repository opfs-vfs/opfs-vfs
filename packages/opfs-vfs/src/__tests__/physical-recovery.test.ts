import { expect, it } from 'vitest';

const BLOCK = 4096;
// Literal expectations: preserve only complete logical pages before the first hole.
const cases = [
  ['tail', 3 * BLOCK - 1, 0],
  ['tail', 3 * BLOCK, 0],
  ['tail', 3 * BLOCK + 1, 0],
  ['tail', 4 * BLOCK - 1, 0],
  ['tail', 4 * BLOCK, 8192],
  ['tail', 4 * BLOCK + 1, 8192],
  ['tail', 5 * BLOCK - 1, 8192],
  ['tail', 5 * BLOCK, 8199],
  ['middle', 4 * BLOCK - 1, 0],
  ['middle', 4 * BLOCK, 4096],
  ['middle', 5 * BLOCK - 1, 4096],
  ['middle', 5 * BLOCK, 4096],
  ['middle', 5 * BLOCK + 1, 4096],
  ['middle', 6 * BLOCK - 1, 4096],
  ['middle', 6 * BLOCK, 8199],
] as const;

for (const [layout, cut, expectedSize] of cases) {
  it(`recovers ${layout} mapping cut at ${cut} to ${expectedSize} bytes`, async () => {
    const worker = new Worker(new URL('./physical-recovery-worker.ts', import.meta.url), { type: 'module' });
    try {
      const result = await new Promise<{ ok: boolean }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('physical recovery worker timed out')), 15000);
        worker.onerror = (event) => {
          clearTimeout(timeout);
          reject(new Error(event.message));
        };
        worker.onmessage = ({ data }) => {
          clearTimeout(timeout);
          if (data.error) reject(new Error(data.error));
          else resolve(data);
        };
        worker.postMessage({ layout, cut, expectedSize });
      });
      expect(result.ok).toBe(true);
    } finally {
      worker.terminate();
    }
  }, 20000);
}
