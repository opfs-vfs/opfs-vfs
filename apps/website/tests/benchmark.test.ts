import assert from 'node:assert/strict';
import { test } from 'node:test';
import { timingRank, median, reportCsv, validateBenchmarkConfig, type BenchmarkReport } from '../src/lib/benchmark.ts';
void test('benchmark summaries and exports preserve raw failures', () => {
  assert.equal(median([9, 1, 5, 3]), 4);
  assert.equal(median([]), null);
  const report: BenchmarkReport = {
    schemaVersion: 2,
    createdAt: '2026-09-20T00:00:00Z',
    userAgent: 'test',
    crossOriginIsolated: true,
    config: {
      backends: ['opfs-vfs'],
      rows: 100,
      repetitions: 1,
      bufferMode: 'memory',
      durability: 'balanced',
      workload: 'insert-query',
      relaxedDurability: false,
    },
    metadata: {
      workloadRevision: 'pglite-sql-v2',
      workloadSource: null,
      sourceCommit: 'test',
      opfsVfsVersion: '1.0.1',
      pgliteVersion: '0.5.4',
      interrupted: false,
      environmentNote: 'test machine',
      preparationMs: 12,
    },
    samples: [
      {
        backend: 'opfs-vfs',
        repetition: 1,
        status: 'failed',
        error: 'quoted, "error"',
        stages: [{ id: 1, durationMs: 12.34 }],
        initMs: 1,
        workloadMs: 0,
        persistenceMs: null,
        reopenMs: null,
        expectedRows: 100,
        actualRows: 0,
      },
    ],
  };
  assert.match(reportCsv(report), /"quoted, ""error"""/);
  assert.match(reportCsv(report), /speedTest16Ms/);
  assert.match(reportCsv(report), /"12.34"/);
  assert.doesNotThrow(() => validateBenchmarkConfig(report.config));
  assert.throws(() => validateBenchmarkConfig({ ...report.config, rows: 99 }));
  assert.doesNotThrow(() => validateBenchmarkConfig({ ...report.config, workload: 'pglite-speedtest', rows: null }));
  assert.throws(() => validateBenchmarkConfig({ ...report.config, workload: 'pglite-speedtest' }));
  assert.throws(() => validateBenchmarkConfig({ ...report.config, workload: 'invalid' as never }));
  assert.throws(() => validateBenchmarkConfig({ ...report.config, backends: ['invalid' as never] }));
  assert.throws(() => validateBenchmarkConfig({ ...report.config, relaxedDurability: undefined as never }));
});

void test('timing ranks show the first three places, share ties, and exclude unavailable values', () => {
  const timings = [4, 1, 3, 2];
  assert.deepEqual(
    timings.map((value) => timingRank(value, timings)),
    [null, 1, 3, 2],
  );
  const ties = [0, 0, 2, null];
  assert.deepEqual(
    ties.map((value) => timingRank(value, ties)),
    [1, 1, 3, null],
  );
  assert.equal(timingRank(2, [null, Number.NaN, Infinity, -1, 2]), null);
  assert.equal(timingRank(null, [null, null]), null);
  assert.equal(timingRank(1, []), null);
  assert.equal(timingRank(1, [2, 3]), null);
});
