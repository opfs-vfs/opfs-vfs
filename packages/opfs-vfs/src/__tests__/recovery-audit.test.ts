import { describe, it } from 'vitest';

function run(payload: Record<string, unknown>) {
  return new Promise<void>((resolve, reject) => {
    const worker = new Worker(new URL('./recovery-audit-worker.ts', import.meta.url), { type: 'module' });
    const finish = (error?: string) => {
      clearTimeout(timer);
      worker.terminate();
      if (error) reject(new Error(error));
      else resolve();
    };
    const timer = setTimeout(() => finish('recovery worker timed out'), 15000);
    worker.onerror = (event) => finish(event.message);
    worker.onmessage = ({ data }) => finish(data.error);
    worker.postMessage(payload);
  });
}

describe('Recovery audit regressions', () => {
  it(
    'preserves existing mappings, size and cursor when a later data run fails',
    () => run({ scenario: 'existingGrowth' }),
    20000,
  );
  for (const checkpoint of [false, true]) {
    it(
      `fragmented allocation, checkpoint=${checkpoint}: never persists provisional mappings`,
      () => run({ scenario: 'fragmented', checkpoint }),
      20000,
    );
  }
  it('completes memory tails without rewriting full physical blocks', () => run({ scenario: 'memoryTail' }), 20000);
  for (const torn of [false, true]) {
    it(
      `torn=${torn}: repairs log before new commits and a second crash`,
      () => run({ scenario: 'logTail', torn }),
      20000,
    );
  }
  for (const failure of ['truncate', 'flush']) {
    it(`failed log repair ${failure} releases mount locks`, () => run({ scenario: 'logTail', failure }), 20000);
  }
  it('preserves pending WAL before switching memory to disk', () => run({ scenario: 'modeSwitch' }), 20000);
  it(
    'retains the memory WAL and retries a failed tail-padding write',
    () => run({ scenario: 'memoryTail', failPadding: true }),
    20000,
  );
  it('rejects a short junk WAL without mutating it', () => run({ scenario: 'modeSwitch', junk: true }), 20000);
  for (const phase of ['tail', 'gap', 'incoming', 'truncate']) {
    for (const quota of [false, true]) {
      it(
        `${phase}, quota=${quota}: rolls back failed allocation and safely retries`,
        () => run({ scenario: 'allocation', phase, quota }),
        20000,
      );
    }
  }
});
