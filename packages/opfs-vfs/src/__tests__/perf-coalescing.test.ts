/**
 * Driver for PERF-1 (contiguous-block I/O coalescing) and PERF-5
 * (write-amplification / no-stale-data invariant). Each scenario runs in
 * perf-coalescing-worker.ts (needs a real FileSystemSyncAccessHandle) and
 * asserts the returned Check[] all pass — same pattern as durability-fixes.
 */

import { describe, expect, it } from 'vitest';

type Check = { check: string; pass: boolean; detail?: string };

function runScenario(scenario: string, timeoutMs = 30000): Promise<Check[]> {
  return new Promise<Check[]>((resolve, reject) => {
    const worker = new Worker(new URL('./perf-coalescing-worker.ts', import.meta.url), { type: 'module' });
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error(`${scenario} timeout (${timeoutMs / 1000}s)`));
    }, timeoutMs);
    worker.onerror = (e) => {
      clearTimeout(timeout);
      worker.terminate();
      reject(new Error(`Worker error: ${e.message}`));
    };
    worker.onmessage = (ev: MessageEvent<{ type: string; results?: Check[]; error?: string }>) => {
      clearTimeout(timeout);
      worker.terminate();
      if (ev.data.type === 'RESULT') resolve(ev.data.results ?? []);
      else reject(new Error(ev.data.error));
    };
    worker.postMessage({ type: 'RUN', scenario });
  });
}

function assertAll(results: Check[]) {
  expect(results.length).toBeGreaterThan(0);
  for (const r of results) {
    expect(r.pass, `${r.check}${r.detail ? ` — ${r.detail}` : ''}`).toBe(true);
  }
}

describe('PERF-1 contiguous-block coalescing', () => {
  it('reads/writes a fragmented block layout correctly (disk mode)', async () => {
    assertAll(await runScenario('perf1Fragmented'));
  }, 35000);

  it('hydrate + persist round-trip a fragmented file (memory mode)', async () => {
    assertAll(await runScenario('perf1MemoryRoundtrip'));
  }, 35000);
});

describe('PERF-3 incremental index maintenance', () => {
  it('incremental derived indexes match a full rebuild after randomized ops', async () => {
    assertAll(await runScenario('perf3IncrementalEqualsRebuild'));
  }, 35000);
});

describe('PERF-5 no-stale-data invariant', () => {
  it('partial writes never leak freed blocks; holes read as zero', async () => {
    assertAll(await runScenario('perf5NoStaleLeak'));
  }, 35000);
});
