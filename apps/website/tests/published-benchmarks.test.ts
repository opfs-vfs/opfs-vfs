import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

void test('published metrics independently match all five raw measurements and preserve missing values', () => {
  const summary = JSON.parse(readFileSync(new URL('../src/data/benchmark-results.json', import.meta.url), 'utf8'));
  let checked = 0;
  let measured = 0;
  for (const machine of summary.machines) {
    for (const browser of machine.browsers) {
      const bytes = readFileSync(new URL(`../public${browser.source}`, import.meta.url));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), browser.sha256);
      const raw = JSON.parse(bytes.toString());
      assert.equal(raw.status, 'complete');
      assert.equal(raw.interrupted, false);
      assert.equal(raw.eligibleForReview, true);
      assert.equal(browser.jobs.length, browser.id === 'safari' ? 10 : 12);
      assert.equal(raw.entries.length, browser.jobs.length * 6);
      const check = (published: unknown, values: (number | null)[]) => {
        assert.equal(values.length, 5);
        if (values.every((v) => v === null)) assert.equal(published, null);
        else {
          assert.ok(values.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0));
          const sorted = (values as number[]).toSorted((a, b) => a - b);
          assert.deepEqual(published, { median: sorted[2], min: sorted[0], max: sorted[4], n: 5 });
        }
        checked++;
      };
      for (const job of browser.jobs) {
        const entries = raw.entries.filter((e: { jobId: string; warmup: boolean }) => e.jobId === job.id && !e.warmup);
        assert.deepEqual(
          entries.map((e: { round: number }) => e.round),
          [1, 2, 3, 4, 5],
        );
        measured += entries.length;
        for (const key of Object.keys(job.metrics)) {
          check(
            job.metrics[key],
            entries.map((e: { preparationMs: number; samples: Record<string, any>[] }) =>
              key === 'preparationMs'
                ? e.preparationMs
                : job.suite === 'filesystem' && key !== 'mountMs'
                  ? e.samples[0]!.timings[key]
                  : e.samples[0]![key],
            ),
          );
        }
        for (const stage of job.stages)
          check(
            stage.timing,
            entries.map(
              (e: { samples: { stages: { durationMs: number }[] }[] }) =>
                e.samples[0]!.stages[stage.id - 1]!.durationMs,
            ),
          );
      }
    }
  }
  assert.equal(measured, 340);
  assert.equal(checked, 824);
});
