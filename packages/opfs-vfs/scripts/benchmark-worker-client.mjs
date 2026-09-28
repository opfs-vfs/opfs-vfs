/**
 * Run: pnpm --filter @opfs-vfs/opfs-vfs benchmark:worker-client [options]
 * Compare: node scripts/benchmark-worker-client.mjs compare <baseline-dir-or-summary.json> <candidate-dir-or-summary.json>
 * Output: samples.json contains raw samples; summary.json contains pretty-printed aggregate results.
 * Gate: a metric regresses only when it exceeds its budget and every candidate run is worse than the baseline range.
 * Compare exits 0 only when every case passes, 1 on a regression, and 2 for missing or inconclusive cases.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const DEFAULTS = {
  browser: 'chromium',
  runs: 5,
  ops: 1000,
  warmup: 100,
  largeOps: 256,
  largeWarmup: 5,
  cold: 20,
  coldWarmup: 2,
  modes: ['disk', 'memory'],
  transports: ['leader', 'follower', 'sab'],
  workloads: ['read', 'write', 'metadata', 'sync', 'large-read', 'large-write'],
  tailRatio: 1.5,
  label: 'baseline',
  headed: false,
  noCold: false,
};

const scriptPath = fileURLToPath(import.meta.url);
const packageRoot = resolve(dirname(scriptPath), '..');
const repoRoot = resolve(packageRoot, '../..');
const fixturePaths = [
  scriptPath,
  resolve(packageRoot, 'src/__tests__/benchmark-worker-client-page.ts'),
  resolve(packageRoot, 'src/__tests__/benchmark-worker-client-sab-worker.ts'),
  resolve(packageRoot, 'src/__tests__/benchmark-worker-client-workloads.ts'),
];

const round = (value) => Math.round(value * 10000) / 10000;
const mean = (values) => values.reduce((total, value) => total + value, 0) / values.length;

export function nearestRank(sortedAscending, p) {
  if (!sortedAscending.length) return undefined;
  const index = Math.max(0, Math.min(sortedAscending.length - 1, Math.ceil((p / 100) * sortedAscending.length) - 1));
  return sortedAscending[index];
}

export const median = (sortedAscending) => nearestRank(sortedAscending, 50);

export function summarizeRun(samplesMs, wallMs) {
  const values = [...samplesMs].sort((a, b) => a - b);
  return {
    n: values.length,
    median: median(values),
    p95: nearestRank(values, 95),
    min: values[0],
    max: values.at(-1),
    mean: values.length ? mean(values) : undefined,
    throughputOpsPerSec: wallMs > 0 ? values.length / (wallMs / 1000) : undefined,
  };
}

export function summarizeAcrossRuns(perRun, tailRatio) {
  const medians = perRun.map((run) => run.median).filter((value) => value !== undefined);
  const p95s = perRun.map((run) => run.p95).filter((value) => value !== undefined);
  const throughputs = perRun.map((run) => run.throughputOpsPerSec).filter((value) => value !== undefined);
  const medianMean = medians.length ? mean(medians) : undefined;
  const variance = medianMean === undefined ? undefined : mean(medians.map((value) => (value - medianMean) ** 2));
  const minRunP95 = p95s.length ? Math.min(...p95s) : undefined;
  const maxRunP95 = p95s.length ? Math.max(...p95s) : undefined;
  const p95Ratio = minRunP95 !== undefined && maxRunP95 !== undefined ? maxRunP95 / minRunP95 : undefined;
  return {
    runs: perRun.length,
    medianOfRunMedians: medians.length ? median([...medians].sort((a, b) => a - b)) : undefined,
    medianOfRunP95: p95s.length ? median([...p95s].sort((a, b) => a - b)) : undefined,
    medianOfRunThroughput: throughputs.length ? median([...throughputs].sort((a, b) => a - b)) : undefined,
    minRunP95,
    maxRunP95,
    p95Ratio,
    cvOfRunMedians: medianMean ? Math.sqrt(variance) / medianMean : undefined,
    inconclusive: p95Ratio !== undefined && p95Ratio > tailRatio,
  };
}

const defaultValue = (value) => (Array.isArray(value) ? value.join(',') : String(value));
const HELP = `Usage:
  benchmark-worker-client [options]
  benchmark-worker-client compare <baseline-dir-or-summary.json> <candidate-dir-or-summary.json>

Options:
  --browser <name>          default: ${defaultValue(DEFAULTS.browser)}
  --runs <count>            default: ${defaultValue(DEFAULTS.runs)}
  --ops <count>             default: ${defaultValue(DEFAULTS.ops)}
  --warmup <count>          default: ${defaultValue(DEFAULTS.warmup)}
  --large-ops <count>       default: ${defaultValue(DEFAULTS.largeOps)}
  --large-warmup <count>    default: ${defaultValue(DEFAULTS.largeWarmup)}
  --cold <count>            default: ${defaultValue(DEFAULTS.cold)}
  --cold-warmup <count>     default: ${defaultValue(DEFAULTS.coldWarmup)}
  --no-cold                 default: ${defaultValue(DEFAULTS.noCold)}
  --modes <list>            default: ${defaultValue(DEFAULTS.modes)}
  --transports <list>       default: ${defaultValue(DEFAULTS.transports)}
  --workloads <list>        default: ${defaultValue(DEFAULTS.workloads)}
  --tail-ratio <ratio>      default: ${defaultValue(DEFAULTS.tailRatio)}
  --label <label>           default: ${defaultValue(DEFAULTS.label)}
  --headed                  default: ${defaultValue(DEFAULTS.headed)}
  --out <directory>
  --help

Compare exits 0 only when every case passes, 1 on a regression, and 2 for missing or inconclusive cases.`;

const parseList = (value, allowed, name) => {
  const values = value.split(',').filter(Boolean);
  if (!values.length || values.some((item) => !allowed.includes(item))) throw new Error(`Invalid --${name}: ${value}`);
  return values;
};

const positiveInt = (value, name, allowZero = false) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < (allowZero ? 0 : 1)) throw new Error(`--${name} must be an integer`);
  return parsed;
};

function parseConfig(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      browser: { type: 'string', default: DEFAULTS.browser },
      runs: { type: 'string', default: String(DEFAULTS.runs) },
      ops: { type: 'string', default: String(DEFAULTS.ops) },
      warmup: { type: 'string', default: String(DEFAULTS.warmup) },
      'large-ops': { type: 'string', default: String(DEFAULTS.largeOps) },
      'large-warmup': { type: 'string', default: String(DEFAULTS.largeWarmup) },
      cold: { type: 'string', default: String(DEFAULTS.cold) },
      'cold-warmup': { type: 'string', default: String(DEFAULTS.coldWarmup) },
      modes: { type: 'string', default: DEFAULTS.modes.join(',') },
      transports: { type: 'string', default: DEFAULTS.transports.join(',') },
      workloads: { type: 'string', default: DEFAULTS.workloads.join(',') },
      'tail-ratio': { type: 'string', default: String(DEFAULTS.tailRatio) },
      label: { type: 'string', default: DEFAULTS.label },
      out: { type: 'string' },
      headed: { type: 'boolean', default: DEFAULTS.headed },
      'no-cold': { type: 'boolean', default: DEFAULTS.noCold },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) return { help: true };
  const browser = values.browser;
  if (!['chromium', 'firefox', 'webkit'].includes(browser)) throw new Error(`Invalid --browser: ${browser}`);
  const tailRatio = Number(values['tail-ratio']);
  if (!Number.isFinite(tailRatio) || tailRatio <= 0) throw new Error('--tail-ratio must be positive');
  return {
    browser,
    runs: positiveInt(values.runs, 'runs'),
    ops: positiveInt(values.ops, 'ops'),
    warmup: positiveInt(values.warmup, 'warmup', true),
    largeOps: positiveInt(values['large-ops'], 'large-ops'),
    largeWarmup: positiveInt(values['large-warmup'], 'large-warmup', true),
    cold: positiveInt(values.cold, 'cold'),
    coldWarmup: positiveInt(values['cold-warmup'], 'cold-warmup', true),
    noCold: values['no-cold'],
    modes: parseList(values.modes, ['disk', 'memory'], 'modes'),
    transports: parseList(values.transports, ['leader', 'follower', 'sab'], 'transports'),
    workloads: parseList(
      values.workloads,
      ['read', 'write', 'metadata', 'sync', 'large-read', 'large-write'],
      'workloads',
    ),
    tailRatio,
    label: values.label,
    out: values.out,
    headed: values.headed,
  };
}

const git = (args) => {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
};

const source = () => ({
  commit: git(['rev-parse', 'HEAD']),
  dirty: git(['status', '--porcelain']) !== '',
  branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
});

async function harnessSha256() {
  return Object.fromEntries(
    await Promise.all(
      fixturePaths.map(async (path) => [
        relative(repoRoot, path),
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      ]),
    ),
  );
}

const caseKey = (value) => `${value.transport}/${value.mode}/${value.workload}`;
const coldKey = (value) => `${value.transport}/${value.mode}`;
const isLargeWorkload = (workload) => workload === 'large-read' || workload === 'large-write';

export function isGateEligible({ complete, config }) {
  return (
    complete === true &&
    !config.noCold &&
    ['modes', 'transports', 'workloads'].every((key) => DEFAULTS[key].every((item) => config[key].includes(item))) &&
    config.runs >= 5 &&
    config.workloads.every((workload) =>
      isLargeWorkload(workload)
        ? config.largeOps >= 256 && config.largeWarmup >= 1
        : config.ops >= 1000 && config.warmup >= 1,
    )
  );
}

const roundedCase = (value) => ({
  ...value,
  warmupMs: value.warmupMs.map(round),
  samplesMs: value.samplesMs.map(round),
  wallMs: round(value.wallMs),
});
const roundedCold = (value) => ({
  ...value,
  warmupReadyMs: value.warmupReadyMs.map(round),
  warmupCloseMs: value.warmupCloseMs.map(round),
  readyMs: value.readyMs.map(round),
  closeMs: value.closeMs.map(round),
});
const roundStats = (stats) =>
  Object.fromEntries(
    Object.entries(stats).map(([key, value]) => [
      key,
      typeof value === 'number' && key !== 'n' && key !== 'runs' ? round(value) : value,
    ]),
  );

function buildSummary(runs, config) {
  const cases = new Map();
  const cold = new Map();
  for (const run of runs) {
    for (const value of run.cases)
      (cases.get(caseKey(value)) ?? cases.set(caseKey(value), []).get(caseKey(value))).push({ run: run.run, value });
    for (const value of run.cold)
      (cold.get(coldKey(value)) ?? cold.set(coldKey(value), []).get(coldKey(value))).push({ run: run.run, value });
  }
  return {
    cases: [...cases.values()].map((entries) => {
      const first = entries[0].value;
      const perRun = entries.map(({ run, value }) => ({ run, ...summarizeRun(value.samplesMs, value.wallMs) }));
      return {
        transport: first.transport,
        mode: first.mode,
        workload: first.workload,
        perRun: perRun.map(roundStats),
        acrossRuns: roundStats(summarizeAcrossRuns(perRun, config.tailRatio)),
      };
    }),
    cold: [...cold.values()].map((entries) => {
      const first = entries[0].value;
      const ready = entries.map(({ run, value }) => ({
        run,
        ...summarizeRun(
          value.readyMs,
          value.readyMs.reduce((sum, item) => sum + item, 0),
        ),
      }));
      const close = entries.map(({ run, value }) => ({
        run,
        ...summarizeRun(
          value.closeMs,
          value.closeMs.reduce((sum, item) => sum + item, 0),
        ),
      }));
      return {
        transport: first.transport,
        mode: first.mode,
        ready: {
          count: first.readyMs.length,
          perRun: ready.map(roundStats),
          acrossRuns: roundStats(summarizeAcrossRuns(ready, config.tailRatio)),
        },
        close: {
          count: first.closeMs.length,
          perRun: close.map(roundStats),
          acrossRuns: roundStats(summarizeAcrossRuns(close, config.tailRatio)),
        },
      };
    }),
  };
}

// Compare matching warm transport/mode/workload cases and cold transport/mode ready/close cases. A case missing on
// either side is missing. Candidate/baseline ratios regress only beyond their budgets when every candidate run lies
// beyond the baseline range in the worse direction; overlapping ranges are inconclusive. Unstable cases are
// inconclusive unless another metric regresses. Differing eligibility, harness, config, machine, or browser makes
// every case inconclusive, including apparent regressions.
export function compareSummaries(baseline, candidate, budgets = { median: 1.05, p95: 1.1, throughput: 0.95 }) {
  const stableJson = (value) => {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object')
      return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
        .join(',')}}`;
    return JSON.stringify(value);
  };
  const comparableConfig = (summary) => {
    const { label: _label, out: _out, ...config } = summary.config ?? {};
    return config;
  };
  const entries = (summary) => [
    ...(summary.cases ?? []).map((value) => ({
      key: `warm/${value.transport}/${value.mode}/${value.workload}`,
      label: `${value.transport}/${value.mode}/${value.workload}`,
      cold: false,
      ...value,
    })),
    ...(summary.cold ?? []).flatMap((value) =>
      ['ready', 'close'].map((phase) => ({
        key: `cold/${value.transport}/${value.mode}/${phase}`,
        label: `${value.transport}/${value.mode}/${phase}`,
        cold: true,
        transport: value.transport,
        mode: value.mode,
        phase,
        ...value[phase],
      })),
    ),
  ];
  const comparisonMetric = (baselineEntry, candidateEntry, name, budget, worse, minDeltaMs = 0) => {
    const baselineValue = baselineEntry.acrossRuns[name];
    const candidateValue = candidateEntry.acrossRuns[name];
    const perRunName =
      name === 'medianOfRunMedians' ? 'median' : name === 'medianOfRunP95' ? 'p95' : 'throughputOpsPerSec';
    const baselineRuns = baselineEntry.perRun.map((run) => run[perRunName]).filter(Number.isFinite);
    const candidateRuns = candidateEntry.perRun.map((run) => run[perRunName]).filter(Number.isFinite);
    if (
      !Number.isFinite(baselineValue) ||
      !Number.isFinite(candidateValue) ||
      !baselineRuns.length ||
      !candidateRuns.length
    )
      return { status: 'inconclusive' };
    const ratio = candidateValue / baselineValue;
    const exceedsBudget =
      worse === 'higher'
        ? ratio > budget && candidateValue - baselineValue > minDeltaMs
        : ratio < budget && baselineValue - candidateValue > minDeltaMs;
    const outsideRange =
      worse === 'higher'
        ? candidateRuns.every((value) => value > Math.max(...baselineRuns))
        : candidateRuns.every((value) => value < Math.min(...baselineRuns));
    return { ratio, status: exceedsBudget ? (outsideRange ? 'regressed' : 'inconclusive') : 'pass' };
  };
  const sameHarness = stableJson(baseline.meta?.harnessSha256) === stableJson(candidate.meta?.harnessSha256);
  const sameConfig = stableJson(comparableConfig(baseline)) === stableJson(comparableConfig(candidate));
  const sameBrowser =
    baseline.meta?.browser?.name === candidate.meta?.browser?.name &&
    baseline.meta?.browser?.version === candidate.meta?.browser?.version;
  const sameMachine = stableJson(baseline.meta?.os) === stableJson(candidate.meta?.os);
  const eligible = Boolean(baseline.gateEligible) && Boolean(candidate.gateEligible);
  const compatible = eligible && sameHarness && sameConfig && sameMachine && sameBrowser;
  const mismatchReasons = [
    ...(eligible ? [] : ['both summaries must be gate-eligible']),
    ...(sameHarness ? [] : ['harnessSha256 differs']),
    ...(sameConfig ? [] : ['config differs']),
    ...(sameMachine ? [] : ['machine os differs']),
    ...(sameBrowser ? [] : ['browser name or version differs']),
  ];
  const baselineEntries = new Map(entries(baseline).map((value) => [value.key, value]));
  const candidateEntries = new Map(entries(candidate).map((value) => [value.key, value]));
  const cases = [...new Set([...baselineEntries.keys(), ...candidateEntries.keys()])]
    .sort((a, b) => a.localeCompare(b))
    .map((key) => {
      const baselineEntry = baselineEntries.get(key);
      const candidateEntry = candidateEntries.get(key);
      if (!baselineEntry || !candidateEntry)
        return {
          key,
          label: baselineEntry?.label ?? candidateEntry.label,
          status: 'missing',
          cold: baselineEntry?.cold ?? candidateEntry.cold,
        };
      const metrics = {
        median: comparisonMetric(
          baselineEntry,
          candidateEntry,
          'medianOfRunMedians',
          budgets.median,
          'higher',
          baselineEntry.cold ? 0.05 : 0,
        ),
        p95: comparisonMetric(
          baselineEntry,
          candidateEntry,
          'medianOfRunP95',
          budgets.p95,
          'higher',
          baselineEntry.cold ? 0.05 : 0,
        ),
        ...(baselineEntry.cold
          ? {}
          : {
              throughput: comparisonMetric(
                baselineEntry,
                candidateEntry,
                'medianOfRunThroughput',
                budgets.throughput,
                'lower',
              ),
            }),
      };
      if (!compatible) for (const metric of Object.values(metrics)) metric.status = 'inconclusive';
      // An unstable tail on either side cannot establish a p95 regression; other metrics still can.
      if (baselineEntry.acrossRuns.inconclusive || candidateEntry.acrossRuns.inconclusive)
        metrics.p95.status = 'inconclusive';
      const regressed = Object.values(metrics).some((metric) => metric.status === 'regressed');
      const inconclusive =
        baselineEntry.acrossRuns.inconclusive ||
        candidateEntry.acrossRuns.inconclusive ||
        Object.values(metrics).some((metric) => metric.status === 'inconclusive');
      return {
        key,
        label: baselineEntry.label,
        cold: baselineEntry.cold,
        metrics,
        status: !compatible ? 'inconclusive' : regressed ? 'regressed' : inconclusive ? 'inconclusive' : 'pass',
      };
    });
  return {
    compatible,
    baseline: { gateEligible: Boolean(baseline.gateEligible) },
    candidate: { gateEligible: Boolean(candidate.gateEligible) },
    sameHarness,
    sameConfig,
    sameMachine,
    sameBrowser,
    mismatchReasons,
    cases,
  };
}

const metricText = (metric) => (metric ? `${metric.ratio?.toFixed(3) ?? '-'} (${metric.status})` : '-');

function printComparison(comparison) {
  console.log('# Benchmark comparison');
  console.log(
    `gateEligible: baseline=${comparison.baseline.gateEligible}, candidate=${comparison.candidate.gateEligible}`,
  );
  console.log(
    `harnessSha256 identical: ${comparison.sameHarness}; config identical: ${comparison.sameConfig}; browser name+version identical: ${comparison.sameBrowser}`,
  );
  console.log(`machine os identical: ${comparison.sameMachine}`);
  if (!comparison.compatible)
    console.log(`WARNING: ${comparison.mismatchReasons.join('; ')}; every case is inconclusive.`);
  console.log('| case | median ratio | p95 ratio | throughput ratio | status |');
  console.log('| - | -: | -: | -: | - |');
  for (const value of comparison.cases)
    console.log(
      `| ${value.label} | ${metricText(value.metrics?.median)} | ${metricText(value.metrics?.p95)} | ${metricText(value.metrics?.throughput)} | ${value.status} |`,
    );
}

export function comparisonExitCode(comparison) {
  if (comparison.cases.some((value) => value.status === 'regressed')) return 1;
  return comparison.cases.length && comparison.cases.every((value) => value.status === 'pass') ? 0 : 2;
}

async function readSummary(input) {
  const path = resolve(repoRoot, input); // same base as --out
  const summaryPath = (await stat(path)).isDirectory() ? resolve(path, 'summary.json') : path;
  return JSON.parse(await readFile(summaryPath, 'utf8'));
}

async function compare(argv) {
  if (argv.length !== 2)
    throw new Error(
      'Usage: benchmark-worker-client compare <baseline-dir-or-summary.json> <candidate-dir-or-summary.json>',
    );
  const [baseline, candidate] = await Promise.all(argv.map(readSummary));
  const comparison = compareSummaries(baseline, candidate);
  printComparison(comparison);
  return comparisonExitCode(comparison);
}

const table = (title, rows) => {
  console.log(`\n${title}`);
  console.log('| transport | mode | workload | median ms | p95 ms | p95 ratio | status |');
  console.log('| - | - | - | -: | -: | -: | - |');
  for (const row of rows) {
    const stats = row.acrossRuns ?? row;
    console.log(
      `| ${row.transport} | ${row.mode} | ${row.workload ?? ''} | ${stats.medianOfRunMedians ?? ''} | ${stats.medianOfRunP95 ?? ''} | ${stats.p95Ratio ?? ''} | ${stats.inconclusive ? 'inconclusive' : 'ok'} |`,
    );
  }
};

async function main(argv = process.argv.slice(2)) {
  if (argv[0] === '--') argv = argv.slice(1); // pnpm forwards a literal separator
  if (argv[0] === 'compare') return compare(argv.slice(1));
  const config = parseConfig(argv);
  if (config.help) {
    console.log(HELP);
    return 0;
  }
  const startedAt = new Date().toISOString();
  const sourceMeta = source();
  const shortSha = sourceMeta.commit.slice(0, 12);
  const runId = `${startedAt.replace(/[-:]/g, '').replace(/\.\d{3}/, '')}-${shortSha}${sourceMeta.dirty ? '-dirty' : ''}-${config.browser}-${config.label}`;
  const out = resolve(repoRoot, config.out ?? `docs/benchmarks/react-sdk/${runId}`);
  const runRecords = [];
  let browser;
  let server;
  let pageEnv;
  let firstFailure;
  let browserVersion = 'unknown';
  try {
    const { createServer } = await import('vite');
    const { chromium, firefox, webkit } = await import('playwright');
    server = await createServer({
      configFile: false,
      root: packageRoot,
      server: {
        host: '127.0.0.1',
        headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
      },
      plugins: [
        {
          name: 'worker-client-benchmark-page',
          configureServer(instance) {
            instance.middlewares.use('/benchmark.html', (_request, response) => {
              response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
              response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
              response.end(
                '<!doctype html><script type="module" src="/src/__tests__/benchmark-worker-client-page.ts"></script>',
              );
            });
          },
        },
      ],
    });
    await server.listen();
    const launch = { chromium, firefox, webkit }[config.browser];
    browser = await launch.launch({ headless: !config.headed });
    browserVersion = browser.version();
    const address = server.resolvedUrls.local[0];
    for (let run = 1; run <= config.runs; run++) {
      const context = await browser.newContext();
      let pageA;
      let pageB;
      const volumes = [];
      const record = { run, cases: [], cold: [] };
      runRecords.push(record);
      try {
        pageA = await context.newPage();
        pageB = await context.newPage();
        pageA.setDefaultTimeout(300000);
        pageB.setDefaultTimeout(300000);
        await Promise.all([pageA.goto(`${address}benchmark.html`), pageB.goto(`${address}benchmark.html`)]);
        pageEnv ??= await pageA.evaluate(() => window.workerClientBenchmark.env());
        for (const mode of config.modes) {
          const volume = `react-sdk-bench-${crypto.randomUUID()}-${mode}.bin`;
          const sabVolume = `react-sdk-bench-${crypto.randomUUID()}-sab-${mode}.bin`;
          volumes.push(volume, sabVolume);
          if (config.transports.includes('leader') || config.transports.includes('follower')) {
            await pageA.evaluate(
              ([name, selectedMode]) => window.workerClientBenchmark.openLeader(name, selectedMode),
              [volume, mode],
            );
            if (config.transports.includes('leader')) {
              for (const workload of config.workloads) {
                const [warmup, ops] = isLargeWorkload(workload)
                  ? [config.largeWarmup, config.largeOps]
                  : [config.warmup, config.ops];
                const value = await pageA.evaluate(
                  ([selected, warmup, ops]) => window.workerClientBenchmark.measure(selected, warmup, ops),
                  [workload, warmup, ops],
                );
                record.cases.push({ transport: 'leader', mode, workload, warmup, ops, ...value });
                if (value.mismatches) throw new Error(`leader/${mode}/${workload} had ${value.mismatches} mismatches`);
              }
            }
            if (config.transports.includes('follower')) {
              await pageB.evaluate(
                ([name, selectedMode]) => window.workerClientBenchmark.openFollower(name, selectedMode),
                [volume, mode],
              );
              for (const workload of config.workloads) {
                const [warmup, ops] = isLargeWorkload(workload)
                  ? [config.largeWarmup, config.largeOps]
                  : [config.warmup, config.ops];
                const value = await pageB.evaluate(
                  ([selected, warmup, ops]) => window.workerClientBenchmark.measure(selected, warmup, ops),
                  [workload, warmup, ops],
                );
                record.cases.push({ transport: 'follower', mode, workload, warmup, ops, ...value });
                if (value.mismatches)
                  throw new Error(`follower/${mode}/${workload} had ${value.mismatches} mismatches`);
              }
              await pageB.evaluate(() => window.workerClientBenchmark.close());
            }
            if (!config.noCold && config.transports.includes('follower')) {
              const value = await pageB.evaluate(
                ([name, selectedMode, warmup, count]) =>
                  window.workerClientBenchmark.coldFollower(name, selectedMode, warmup, count),
                [volume, mode, config.coldWarmup, config.cold],
              );
              record.cold.push({ transport: 'follower', mode, ...value });
            }
            await pageA.evaluate(() => window.workerClientBenchmark.close());
            if (!config.noCold && config.transports.includes('leader')) {
              const value = await pageA.evaluate(
                ([name, selectedMode, warmup, count]) =>
                  window.workerClientBenchmark.coldLeader(name, selectedMode, warmup, count),
                [volume, mode, config.coldWarmup, config.cold],
              );
              record.cold.push({ transport: 'leader', mode, ...value });
            }
          }
          if (config.transports.includes('sab')) {
            await pageA.evaluate(
              ([name, selectedMode]) => window.workerClientBenchmark.sab.open(name, selectedMode),
              [sabVolume, mode],
            );
            for (const workload of config.workloads) {
              const [warmup, ops] = isLargeWorkload(workload)
                ? [config.largeWarmup, config.largeOps]
                : [config.warmup, config.ops];
              const value = await pageA.evaluate(
                ([selected, warmup, ops]) => window.workerClientBenchmark.sab.measure(selected, warmup, ops),
                [workload, warmup, ops],
              );
              record.cases.push({ transport: 'sab', mode, workload, warmup, ops, ...value });
              if (value.mismatches) throw new Error(`sab/${mode}/${workload} had ${value.mismatches} mismatches`);
            }
            await pageA.evaluate(() => window.workerClientBenchmark.sab.close());
            if (!config.noCold) {
              const value = await pageA.evaluate(
                ([name, selectedMode, warmup, count]) =>
                  window.workerClientBenchmark.sab.coldLeader(name, selectedMode, warmup, count),
                [sabVolume, mode, config.coldWarmup, config.cold],
              );
              record.cold.push({ transport: 'sab', mode, ...value });
            }
          }
        }
      } catch (error) {
        firstFailure ??= error;
      } finally {
        const cleanup = async (action) => {
          try {
            await action();
          } catch (error) {
            firstFailure ??= error;
          }
        };
        if (pageB) await cleanup(() => pageB.evaluate(() => window.workerClientBenchmark.close()));
        if (pageA) await cleanup(() => pageA.evaluate(() => window.workerClientBenchmark.close()));
        if (pageA) await cleanup(() => pageA.evaluate(() => window.workerClientBenchmark.sab.close()));
        for (const volume of volumes)
          if (pageA) await cleanup(() => pageA.evaluate((name) => window.workerClientBenchmark.remove(name), volume));
        if (pageB) await cleanup(() => pageB.close());
        if (pageA) await cleanup(() => pageA.close());
        await cleanup(() => context.close());
      }
      if (firstFailure) throw firstFailure;
    }
  } catch (error) {
    firstFailure ??= error;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (error) {
        firstFailure ??= error;
      }
    }
    if (server) {
      try {
        await server.close();
      } catch (error) {
        firstFailure ??= error;
      }
    }
  }
  const finishedAt = new Date().toISOString();
  const require = createRequire(import.meta.url);
  const playwrightVersion = require('playwright/package.json').version;
  const meta = {
    startedAt,
    finishedAt,
    source: sourceMeta,
    harnessSha256: await harnessSha256(),
    node: process.version,
    os: {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpuModel: os.cpus()[0]?.model ?? 'unknown',
      cpus: os.cpus().length,
      totalMemBytes: os.totalmem(),
    },
    browser: { name: config.browser, version: browserVersion },
    playwright: playwrightVersion,
    page: pageEnv,
  };
  const samples = {
    schema: 'opfs-vfs/worker-client-benchmark/v1',
    meta,
    config,
    complete: !firstFailure,
    runs: runRecords.map((run) => ({ ...run, cases: run.cases.map(roundedCase), cold: run.cold.map(roundedCold) })),
  };
  const built = buildSummary(runRecords, config);
  const summary = {
    schema: 'opfs-vfs/worker-client-benchmark/v1',
    meta,
    config,
    complete: !firstFailure,
    gateEligible: isGateEligible({ complete: !firstFailure, config }),
    ...built,
  };
  await mkdir(out, { recursive: true });
  await writeFile(resolve(out, 'samples.json'), `${JSON.stringify(samples)}\n`);
  await writeFile(resolve(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  table('Warm cases', summary.cases);
  table('Cold cases', [
    ...summary.cold.map((value) => ({ ...value, workload: 'ready', acrossRuns: value.ready.acrossRuns })),
    ...summary.cold.map((value) => ({ ...value, workload: 'close', acrossRuns: value.close.acrossRuns })),
  ]);
  console.log(`\n${out}`);
  if (firstFailure) throw firstFailure;
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
