import { describe, expect, it } from 'vitest';

function run(payload: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./storage-audit-worker.ts', import.meta.url), { type: 'module' });
    const finish = (error?: string, result?: unknown) => {
      clearTimeout(timeout);
      worker.terminate();
      if (error) reject(new Error(error));
      else resolve(result);
    };
    const timeout = setTimeout(() => finish('storage audit worker timed out'), 15000);
    worker.onerror = (event) => finish(event.message);
    worker.onmessage = ({ data }) => finish(data.error, data.result);
    worker.postMessage(payload);
  });
}

describe('Storage audit regressions', () => {
  for (const mode of ['memory', 'disk']) {
    for (const operation of ['read', 'write']) {
      it(`${mode}: completes partial ${operation}s across remount`, async () => {
        await expect(run({ scenario: 'shortIo', mode, operation })).resolves.toBeDefined();
      }, 20000);
    }
  }

  for (const count of [0, -1, 0.5, 4097, Number.NaN]) {
    it(`rejects a raw write count of ${count} without spinning`, async () => {
      await run({ scenario: 'invalidWriteCount', count });
    }, 20000);
  }

  it('retries contributed short I/O through disk reads, hydration, sparse writes, and dirty persistence', async () => {
    await run({ scenario: 'contributedShortIo' });
  }, 20000);

  for (const count of [0, -1, 0.5, 2, Number.NaN]) {
    it(`rejects contributed data count ${count} without spinning`, async () => {
      await run({ scenario: 'contributedInvalidCount', count });
    }, 20000);
  }

  it('preserves a contributed partial-write exception', async () => {
    await run({ scenario: 'contributedPartialThrow' });
  }, 20000);

  it('rejects an early EOF from contributed and raw storage for reads and hydration', async () => {
    await run({ scenario: 'contributedEarlyEof' });
  }, 20000);

  it('hydrates hard links once and keeps already-open descriptors coherent', async () => {
    await expect(run({ scenario: 'hardLinks' })).resolves.toEqual({ dataReads: 1 });
  }, 20000);
});
