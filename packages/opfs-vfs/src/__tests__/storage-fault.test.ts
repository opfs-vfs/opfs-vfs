import { describe, expect, it } from 'vitest';

function run(payload: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./storage-fault-worker.ts', import.meta.url), { type: 'module' });
    const finish = (error?: string) => {
      clearTimeout(timeout);
      worker.terminate();
      if (error) reject(new Error(error));
      else resolve();
    };
    const timeout = setTimeout(() => finish('storage fault worker timed out'), 20000);
    worker.onerror = (event) => finish(event.message);
    worker.onmessage = ({ data }) => finish(data.error ?? (data.ok ? undefined : 'missing worker result'));
    worker.postMessage(payload);
  });
}

describe('OPFS persistence failure boundaries', () => {
  const failures = [
    { phase: 'payload', operation: 'write' },
    { phase: 'padding', operation: 'write' },
    { phase: 'metadata', operation: 'write' },
    { phase: 'payload', operation: 'flush' },
    { phase: 'metadata', operation: 'flush' },
    { phase: 'checkpoint', operation: 'flush' },
  ];
  for (const failure of failures) {
    it(`${failure.phase} ${failure.operation}: preserves recovery data and retries to exact latest bytes`, async () => {
      await expect(run(failure)).resolves.toBeUndefined();
    }, 25000);
  }
  it('retries a failed transformed payload without losing its pending data', async () => {
    await expect(run({ blockSize: 16384, failPayload: true })).resolves.toBeUndefined();
  }, 25000);
  for (const blockSize of [16384, 65536]) {
    it(`materialized ${blockSize}-byte blocks need no redundant tail write`, async () => {
      await expect(run({ blockSize })).resolves.toBeUndefined();
    }, 25000);
  }
});
