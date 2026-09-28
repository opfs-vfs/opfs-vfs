import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareSummaries,
  comparisonExitCode,
  DEFAULTS,
  isGateEligible,
  nearestRank,
  summarizeAcrossRuns,
} from './benchmark-worker-client.mjs';

void test('nearestRank uses one-based nearest rank', () => {
  assert.equal(nearestRank([7], 95), 7);
  assert.equal(
    nearestRank(
      Array.from({ length: 20 }, (_, i) => i + 1),
      95,
    ),
    19,
  );
  assert.equal(
    nearestRank(
      Array.from({ length: 1000 }, (_, i) => i),
      95,
    ),
    949,
  );
  assert.equal(nearestRank([1, 2, 3, 4], 50), 2);
});

void test('across-run p95 ratio marks unstable cases inconclusive', () => {
  const stable = summarizeAcrossRuns(
    [
      { median: 1, p95: 2 },
      { median: 2, p95: 3 },
    ],
    1.5,
  );
  const unstable = summarizeAcrossRuns(
    [
      { median: 1, p95: 2 },
      { median: 2, p95: 4 },
    ],
    1.5,
  );
  assert.equal(stable.inconclusive, false);
  assert.equal(unstable.inconclusive, true);
});

void test('gate eligibility requires a completed run', () => {
  const config = {
    runs: 5,
    ops: 1000,
    warmup: 1,
    largeOps: 256,
    largeWarmup: 1,
    modes: ['disk', 'memory'],
    transports: ['leader', 'follower', 'sab'],
    workloads: ['read', 'write', 'metadata', 'sync', 'large-read', 'large-write'],
  };
  assert.equal(isGateEligible({ complete: true, config }), true);
  assert.equal(isGateEligible({ complete: false, config }), false);
  assert.equal(isGateEligible({ complete: true, config: { ...config, noCold: true } }), false);
  assert.equal(isGateEligible({ complete: true, config: { ...config, workloads: ['read'] } }), false);
  assert.equal(isGateEligible({ complete: true, config: { ...config, largeOps: 50 } }), false);
  assert.equal(DEFAULTS.largeOps, 256);
});

void test('cold phases require more than 50 microseconds of regression', () => {
  const summary = (latency) => ({
    gateEligible: true,
    config: { runs: 5 },
    meta: { harnessSha256: {}, os: {}, browser: { name: 'chromium', version: '1' } },
    cases: [],
    cold: [
      {
        transport: 'follower',
        mode: 'disk',
        ...Object.fromEntries(
          ['ready', 'close'].map((phase) => [
            phase,
            {
              perRun: Array.from({ length: 5 }, () => ({ median: latency, p95: latency })),
              acrossRuns: { medianOfRunMedians: latency, medianOfRunP95: latency, inconclusive: false },
            },
          ]),
        ),
      },
    ],
  });
  assert.ok(compareSummaries(summary(0.15), summary(0.17)).cases.every((entry) => entry.status === 'pass'));
  assert.ok(compareSummaries(summary(0.15), summary(0.21)).cases.every((entry) => entry.status === 'regressed'));
});

void test('compareSummaries classifies pass, regression, overlapping ranges, and mismatches', () => {
  const machine = { platform: 'darwin', release: '1', arch: 'arm64', cpuModel: 'test', cpus: 8, totalMemBytes: 1 };
  const summary = (medians, harnessSha256 = { workloads: 'same' }, os = machine) => ({
    complete: true,
    gateEligible: true,
    config: { runs: 5, label: 'ignored', out: 'ignored', headed: false },
    meta: { harnessSha256, os, browser: { name: 'chromium', version: '1' } },
    cases: [
      {
        transport: 'leader',
        mode: 'disk',
        workload: 'read',
        perRun: medians.map((median) => ({ median, p95: 20, throughputOpsPerSec: 100 })),
        acrossRuns: {
          medianOfRunMedians: [...medians].sort((a, b) => a - b)[Math.ceil(medians.length / 2) - 1],
          medianOfRunP95: 20,
          medianOfRunThroughput: 100,
          inconclusive: false,
        },
      },
    ],
    cold: [],
  });
  const baseline = summary([10, 11, 11]);
  assert.equal(compareSummaries(baseline, summary([10, 11, 11])).cases[0].status, 'pass');
  assert.equal(compareSummaries(baseline, summary([12, 13, 13])).cases[0].status, 'regressed');
  assert.equal(compareSummaries(baseline, summary([10.5, 12, 12])).cases[0].status, 'inconclusive');
  assert.equal(
    compareSummaries(baseline, summary([10, 11, 11], { workloads: 'changed' })).cases[0].status,
    'inconclusive',
  );
  assert.equal(
    compareSummaries(baseline, summary([12, 13, 13], { workloads: 'changed' })).cases[0].status,
    'inconclusive',
  );
  assert.equal(
    compareSummaries(baseline, summary([12, 13, 13], { workloads: 'changed' })).cases[0].metrics.median.status,
    'inconclusive',
  );
  const unstable = summary([10, 11, 11]);
  unstable.cases[0].perRun = unstable.cases[0].perRun.map((run) => ({ ...run, p95: 40 }));
  unstable.cases[0].acrossRuns = { ...unstable.cases[0].acrossRuns, medianOfRunP95: 40, inconclusive: true };
  assert.equal(compareSummaries(baseline, unstable).cases[0].metrics.p95.status, 'inconclusive');
  assert.equal(compareSummaries(baseline, unstable).cases[0].status, 'inconclusive');
  const headed = summary([10, 11, 11]);
  headed.config.headed = true;
  assert.equal(compareSummaries(baseline, headed).cases[0].status, 'inconclusive');
  assert.equal(
    compareSummaries(baseline, summary([10, 11, 11], undefined, { ...machine, cpus: 16 })).cases[0].status,
    'inconclusive',
  );
});

void test('comparison exit code reserves 2 for inconclusive-only results', () => {
  assert.equal(comparisonExitCode({ cases: [{ status: 'inconclusive' }] }), 2);
});
