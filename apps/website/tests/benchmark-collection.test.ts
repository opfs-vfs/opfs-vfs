import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  collectionBrowser,
  collectionEnvironment,
  collectionOmitsAhp,
  collectionEligible,
  collectionJobs,
  collectionSchedule,
} from '../src/lib/benchmark-collection.ts';
import type { CollectionEntry } from '../src/lib/benchmark-collection.ts';

void test('collection covers both buffers and all backends, omits Safari AHP, excludes warmups and rejects incomplete results', () => {
  assert.equal(collectionBrowser('Version/26.0 Safari/605.1.15'), 'safari');
  assert.equal(collectionBrowser('Chrome/140.0 Safari/537.36'), 'chrome');
  assert.equal(collectionBrowser('Firefox/142.0'), 'firefox');
  assert.equal(collectionBrowser('Chrome/140.0 Safari/537.36 Edg/140'), null);
  for (const browser of ['chrome', 'firefox', 'safari'] as const) {
    const jobs = collectionJobs(browser);
    assert.equal(jobs.length, browser === 'safari' ? 10 : 12);
    assert.equal(
      jobs.some((j) => j.suite === 'sql' && j.config.backends.includes('opfs-ahp')),
      browser !== 'safari',
    );
    assert.deepEqual(
      jobs.filter((j) => j.suite === 'filesystem').map((j) => j.config.bufferMode),
      ['disk', 'memory'],
    );
    const schedule = collectionSchedule(jobs);
    for (const job of jobs) {
      const scheduled = schedule.filter((s) => s.job.id === job.id);
      assert.deepEqual(
        scheduled.map((s) => s.round),
        [0, 1, 2, 3, 4, 5],
      );
      assert.deepEqual(
        scheduled.map((s) => s.warmup),
        [true, false, false, false, false, false],
      );
    }
    assert.equal(schedule[jobs.length]!.job.id, jobs[1]!.id);
    const entries: CollectionEntry[] = schedule.map(({ job, round, warmup }) => ({
      jobId: job.id,
      round,
      warmup,
      startedAt: 'start',
      finishedAt: 'finish',
      samples: [{ repetition: 1, mountMs: 1, timings: {}, status: 'ok', verifiedFiles: 500 }],
    }));
    assert.equal(collectionEligible(jobs, entries, false), true);
    assert.equal(collectionEligible(jobs, entries, true), false);
    assert.equal(collectionEligible(jobs, entries.slice(1), false), false);
    const failed = structuredClone(entries);
    failed[0]!.samples[0]!.status = 'failed';
    assert.equal(collectionEligible(jobs, failed, false), false);
    const unfinished = structuredClone(entries);
    delete unfinished[1]!.finishedAt;
    assert.equal(collectionEligible(jobs, unfinished, false), false);
  }
});

void test('mobile browser identity stays separate from conservative Apple AHP omission', () => {
  for (const [ua, browser] of [
    ['iPhone CriOS/153.0 Safari/605', 'chrome'],
    ['iPhone FxiOS/156.0 Safari/605', 'firefox'],
  ] as const) {
    const detected = collectionEnvironment(ua, 'iPhone', 5);
    assert.equal(detected.browser, browser);
    assert.equal(detected.os, 'iOS');
    assert.equal(collectionJobs(browser, collectionOmitsAhp(browser, 'iOS', detected.mobileApple)).length, 10);
  }
  const ipad = collectionEnvironment('Macintosh Version/26.0 Safari/605', 'MacIntel', 5);
  assert.equal(ipad.os, 'iPadOS');
  assert.equal(collectionOmitsAhp('chrome', 'macOS', ipad.mobileApple), true);
  assert.equal(collectionOmitsAhp('firefox', 'iPadOS', false), true);
  assert.equal(collectionOmitsAhp('chrome', 'macOS', false), false);
});
