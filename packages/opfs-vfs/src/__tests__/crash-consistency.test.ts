/**
 * Crash-consistency fault-injection sweep (spec §6.1).
 *
 * Each test drives one workload×mode through the sweep harness in a worker:
 * the VFS is killed at every OPFS-mutation boundary during the workload, then
 * remounted with a fresh un-proxied VFS and checked against integrity
 * invariants (valid historical version per file, no cross-file content bleed,
 * pre-seeded files intact, clean second remount). See
 * `crash-consistency-worker.ts` for the seam, world model, and driver.
 *
 * Runtime budget: the whole file must stay well under ~90s in CI. Workloads use
 * ~6-12 small files (1.5-9 KB) and the driver sweeps every kill point when the
 * total op count is ≤150 (it is, for these workloads).
 */

import { describe, expect, it } from 'vitest';

type Check = { check: string; pass: boolean; detail?: string };

function runCrashSweep(workload: string, timeoutMs = 75000): Promise<Check[]> {
  return new Promise<Check[]>((resolve, reject) => {
    const worker = new Worker(new URL('./crash-consistency-worker.ts', import.meta.url), { type: 'module' });
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error(`${workload} crash sweep timeout (${timeoutMs / 1000}s)`));
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
      else if (ev.data.type === 'ERROR') reject(new Error(ev.data.error));
    };
    worker.postMessage({ type: 'RUN_CRASH_SWEEP', workload });
  });
}

function assertSweep(results: Check[]) {
  // Always log the measured-op / kill-point detail lines.
  for (const r of results) {
    if (
      r.detail &&
      (r.check.includes('total mutation ops') || r.check.includes('kill points') || r.check.includes('clean'))
    ) {
      // eslint-disable-next-line no-console
      console.log(`${r.check}: ${r.detail}`);
    }
  }
  for (const r of results) {
    expect(r.pass, `${r.check}${r.detail ? `: ${r.detail}` : ''}`).toBe(true);
  }
}

/**
 * INT-3 REGRESSION GUARD — disk-mode freed-block quarantine.
 *
 * The three DISK-mode workloads that mutate existing blocks (overwrite/extend/
 * truncate, namespace rename, snapshot-rewrite) used to deterministically
 * reproduce the INT-3 corruption window: disk mode freed blocks into the
 * in-memory bitmap and the next-free-hint allocator handed those still-meta-
 * referenced blocks straight back to the rewrite, overwriting them in place
 * BEFORE the metadata recording the free was durable. A crash in that window
 * left the committed metadata pointing at blocks now holding zeros or — observed
 * in namespace churn — a DIFFERENT file's bytes (cross-bleed). Concretely:
 *   - overwrite-disk  N=1: /o0.bin read 9000 bytes of zeros (no valid version)
 *   - snapshot-disk   N=1: /s0.bin read 9000 bytes of zeros
 *   - namespace-disk  N=3: /d2/r0.bin read back /d/n6.bin's content (cross-bleed)
 * The MEMORY-mode equivalents always PASSED — the data WAL shields them.
 *
 * INT-3's fix quarantines freed disk blocks (see {@link OpfsVfs} `pendingFree` /
 * `releaseBlock` / `drainPendingFree`): a freed block keeps its bitmap bit set
 * and is returned to the allocator only after the meta write recording the free
 * has been flushed. These three disk tests now pass across every kill point and
 * stand as the regression guard for that quarantine; they turn RED the moment
 * the quarantine release ordering breaks.
 */
describe('Crash-consistency fault-injection sweep (§6.1)', () => {
  it('disk: create N unique-pattern files', async () => {
    assertSweep(await runCrashSweep('create-unique-disk'));
  }, 80000);

  it('memory: create N unique-pattern files (WAL path)', async () => {
    assertSweep(await runCrashSweep('create-unique-memory'));
  }, 80000);

  it('disk: overwrite + extend + truncate', async () => {
    assertSweep(await runCrashSweep('overwrite-extend-truncate-disk'));
  }, 80000);

  it('memory: overwrite + extend + truncate (WAL path)', async () => {
    assertSweep(await runCrashSweep('overwrite-extend-truncate-memory'));
  }, 80000);

  it('disk: namespace churn (rename/unlink/mkdir/hardlink)', async () => {
    assertSweep(await runCrashSweep('namespace-churn-disk'));
  }, 80000);

  it('disk: full snapshot rewrite via flushVfs', async () => {
    assertSweep(await runCrashSweep('snapshot-rewrite-disk'));
  }, 80000);
});
