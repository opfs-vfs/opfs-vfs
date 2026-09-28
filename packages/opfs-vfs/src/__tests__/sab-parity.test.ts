import { describe, expect, it } from 'vitest';

interface WorkerCheckResult {
  check: string;
  pass: boolean;
  detail?: string;
}

interface WorkerResultEnvelope {
  results: WorkerCheckResult[];
}

function runWorkerTest(type: string, timeoutMs = 60000): Promise<WorkerResultEnvelope> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./sab-parity-worker.ts', import.meta.url), { type: 'module' });
    const logs: string[] = [];
    const timeout = setTimeout(() => {
      logs.forEach((l) => console.log(l));
      worker.terminate();
      reject(new Error(`${type} timeout (${timeoutMs}ms)`));
    }, timeoutMs);
    worker.onerror = (e) => {
      clearTimeout(timeout);
      logs.forEach((l) => console.log(l));
      worker.terminate();
      reject(new Error(`Worker error: ${e.message}`));
    };
    worker.onmessage = (event) => {
      if (event.data.type === 'LOG') {
        logs.push(event.data.msg);
        return;
      }
      clearTimeout(timeout);
      if (event.data.type === 'ERROR') logs.forEach((l) => console.log(l));
      worker.terminate();
      if (event.data.type === 'RESULT') resolve(event.data.result);
      if (event.data.type === 'ERROR') reject(new Error(event.data.error));
    };
    worker.postMessage({ type });
  });
}

// §6.5 — cross-worker behavioral parity. Runs a representative set of POSIX
// semantics over BOTH the same-worker (OpfsVfs) and cross-worker (OpfsVfsWorker
// SAB bridge) transports and asserts identical errno/behavior for each.
describe('cross-worker behavioral parity (§6.5)', () => {
  it('same-worker and cross-worker transports agree on errno + round-trip semantics', async () => {
    const result = await runWorkerTest('RUN_PARITY_MATRIX_TEST', 30000);

    // Guard against a silently empty matrix.
    expect(result.results.length).toBeGreaterThanOrEqual(12);
    for (const r of result.results) {
      expect(r.pass, `${r.check}${r.detail ? `: ${r.detail}` : ''}`).toBe(true);
    }
  }, 60000);
});
