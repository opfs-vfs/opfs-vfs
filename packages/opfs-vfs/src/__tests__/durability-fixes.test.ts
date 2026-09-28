/**
 * Driver for the Phase-4 durability fixes (INT-6, INT-7, INT-8).
 *
 * The scenarios need a real `FileSystemSyncAccessHandle` (only available off the
 * main thread), so each `it()` runs one scenario in `durability-fixes-worker.ts`
 * and asserts the returned Check[] all pass — the same worker+protocol pattern
 * as crash-consistency.test.ts.
 */

import { describe, expect, it } from 'vitest';

type Check = { check: string; pass: boolean; detail?: string };

function runScenario(scenario: string, timeoutMs = 30000): Promise<Check[]> {
  return new Promise<Check[]>((resolve, reject) => {
    const worker = new Worker(new URL('./durability-fixes-worker.ts', import.meta.url), { type: 'module' });
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

describe('Durability fixes (Phase 4)', () => {
  it('fresh mount persists a crash-safe empty-root baseline before ready', async () => {
    assertAll(await runScenario('firstMountBaseline'));
  }, 35000);

  it('INT-6: flush/close error handling', async () => {
    assertAll(await runScenario('int6'));
  }, 35000);

  it('INT-7: mode-switch does not replay a stale data WAL', async () => {
    assertAll(await runScenario('int7'));
  }, 35000);

  it('INT-8: init failure releases acquired handles (clean remount)', async () => {
    assertAll(await runScenario('int8'));
  }, 35000);
});
