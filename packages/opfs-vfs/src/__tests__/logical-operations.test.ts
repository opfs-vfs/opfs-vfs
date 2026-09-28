import { describe, expect, it } from 'vitest';

interface Result {
  mode: 'memory' | 'disk';
  checks: { name: string; actual: unknown; expected: unknown }[];
}

function run(mode: Result['mode']): Promise<Result> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./logical-operations-worker.ts', import.meta.url), { type: 'module' });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error(`${mode} logical operations timed out`));
    }, 60_000);
    worker.onerror = (event) => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(event.message));
    };
    worker.onmessage = ({ data }) => {
      clearTimeout(timer);
      worker.terminate();
      if (data.type === 'RESULT') resolve(data.result);
      else reject(new Error(data.error));
    };
    worker.postMessage({ mode });
  });
}

describe('logical operation records', () => {
  for (const mode of ['memory', 'disk'] as const) {
    it(`${mode} finalizes logical changes after each successful operation`, async () => {
      const result = await run(mode);
      for (const check of result.checks) expect(check.actual, check.name).toEqual(check.expected);
    }, 90_000);
  }
});
