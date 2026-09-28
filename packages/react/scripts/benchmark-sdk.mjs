import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer, searchForWorkspaceRoot } from 'vite';

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = resolve(packageRoot, '../..');
const pageFixture = resolve(packageRoot, 'src/__tests__/benchmark-sdk-page.tsx');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1
    ? fallback
    : (args[index + 1] ??
        (() => {
          throw new Error(`${name} needs a value`);
        })());
};
const integer = (name, fallback) => {
  const value = Number(option(name, String(fallback)));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
};
const smoke = args.includes('--smoke');
const runs = integer('--runs', smoke ? 1 : 5);
const warmups = integer('--warmups', smoke ? 0 : 1);
const selectedCase = option('--case', undefined);
const setupModuleArgument = option('--setup-module', undefined);
const setupModule = setupModuleArgument && resolve(setupModuleArgument);
if (setupModule && !existsSync(setupModule)) throw new Error(`Setup module does not exist: ${setupModule}`);
const aliases = [];
for (let index = 0; index < args.length; index++) {
  if (args[index] !== '--alias') continue;
  const entry = args[++index];
  const separator = entry?.indexOf('=') ?? -1;
  if (separator < 1) throw new Error('--alias needs specifier=absolute-module-path');
  const specifier = entry.slice(0, separator);
  const file = resolve(entry.slice(separator + 1));
  if (!existsSync(file)) throw new Error(`Alias module does not exist: ${specifier}`);
  aliases.push({ specifier, file });
}
const out = resolve(
  root,
  option(
    '--out',
    `docs/benchmarks/react-sdk/${new Date().toISOString().replace(/[-:.]/g, '').replace('Z', 'Z')}-${randomUUID().slice(0, 12)}-sdk`,
  ),
);
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const sha256Tree = (directory) => {
  const hash = createHash('sha256');
  for (const file of readdirSync(directory, { recursive: true }).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    const path = resolve(directory, file);
    if (!statSync(path).isFile()) continue;
    hash.update(file);
    hash.update('\0');
    hash.update(readFileSync(path));
    hash.update('\0');
  }
  return { sha256: hash.digest('hex') };
};
const packageArtifact = (specifier) => {
  const entry = fileURLToPath(import.meta.resolve(specifier));
  const manifest = resolve(dirname(entry), 'package.json');
  const { version } = JSON.parse(readFileSync(manifest, 'utf8'));
  return {
    version,
    entry: { sha256: sha256(entry) },
    manifest: { sha256: sha256(manifest) },
  };
};
const workspaceArtifacts = {
  scope: aliases.length ? 'reference-only; private aliases are recorded in setup' : 'public bare imports',
  react: sha256Tree(resolve(packageRoot, 'dist')),
  core: sha256Tree(resolve(packageRoot, '../opfs-vfs/dist')),
  subscriptions: sha256Tree(resolve(packageRoot, '../plugin-subscriptions/dist')),
  reactRuntime: packageArtifact('react'),
  reactDomRuntime: packageArtifact('react-dom/client'),
};
const git = (arguments_) => execFileSync('git', arguments_, { cwd: root, encoding: 'utf8' }).trim();
const source = { commit: git(['rev-parse', 'HEAD']), dirty: Boolean(git(['status', '--porcelain'])) };
const availableCases = smoke
  ? [{ name: 'smoke', resourceCount: 1, entryCount: 10, contentSize: 1024, writes: 2 }]
  : [
      { name: 'one-1KiB', resourceCount: 1, entryCount: 10_000, contentSize: 1024, writes: 16 },
      { name: 'one-1MiB', resourceCount: 1, entryCount: 10_000, contentSize: 1024 * 1024, writes: 16 },
      { name: 'one-16MiB', resourceCount: 1, entryCount: 10_000, contentSize: 16 * 1024 * 1024, writes: 2 },
      { name: 'hundred-1MiB', resourceCount: 100, entryCount: 10_000, contentSize: 1024 * 1024, writes: 16 },
    ];
const cases = selectedCase ? availableCases.filter(({ name }) => name === selectedCase) : availableCases;
if (!cases.length) throw new Error(`Unknown benchmark case: ${selectedCase}`);
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const allowedFiles = [
  searchForWorkspaceRoot(packageRoot),
  ...(setupModule ? [dirname(setupModule)] : []),
  ...aliases.map(({ file }) => dirname(file)),
];

const server = await createServer({
  root: packageRoot,
  resolve: {
    alias: aliases.map(({ specifier, file }) => ({
      find: new RegExp(`^${escapeRegex(specifier)}$`),
      replacement: file,
    })),
  },
  server: {
    host: '127.0.0.1',
    fs: { allow: [...new Set(allowedFiles)] },
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
  },
  plugins: [
    {
      name: 'react-sdk-benchmark-page',
      configureServer(instance) {
        instance.middlewares.use('/benchmark.html', (_request, response) => {
          response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
          response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
          response.end(
            `<div id="root"></div>${setupModule ? `<script>globalThis.__OPFS_VFS_BENCHMARK_REQUIRE_RUNTIME = true</script><script type="module" src="/@fs${setupModule}"></script>` : ''}<script type="module" src="/src/__tests__/benchmark-sdk-page.tsx"></script>`,
          );
        });
      },
    },
  ],
});
await server.listen();
const address = server.resolvedUrls.local[0];
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(`${address}benchmark.html`);
let captureOverlap;
await page.exposeFunction('__OPFS_VFS_BENCHMARK_CAPTURE_OVERLAP', async () => {
  if (!captureOverlap) throw new Error('Overlap heap sample was requested outside a benchmark run');
  await captureOverlap();
});
const setup = setupModule ? await page.evaluate(() => globalThis.__OPFS_VFS_BENCHMARK_SETUP) : undefined;
const hasSetupRuntime = setupModule
  ? await page.evaluate(() => {
      const runtime = globalThis.__OPFS_VFS_BENCHMARK_RUNTIME;
      return Boolean(runtime && typeof runtime.worker === 'function' && typeof runtime.plugins === 'function');
    })
  : true;
if (
  setupModule &&
  (!setup ||
    typeof setup !== 'object' ||
    typeof setup.label !== 'string' ||
    !setup.artifacts ||
    typeof setup.artifacts !== 'object')
)
  throw new Error('Setup module must set __OPFS_VFS_BENCHMARK_SETUP with label and artifact paths');
if (!hasSetupRuntime) throw new Error('Setup module must set __OPFS_VFS_BENCHMARK_RUNTIME with worker and plugins');
const setupEvidence =
  setupModule &&
  Object.freeze({
    label: setup.label,
    module: { sha256: sha256(setupModule) },
    artifacts: Object.fromEntries(
      Object.entries(setup.artifacts).map(([name, file]) => {
        if (typeof file !== 'string' || !existsSync(file)) throw new Error(`Invalid setup artifact: ${name}`);
        return [name, { sha256: sha256(file) }];
      }),
    ),
    aliases: aliases.map(({ specifier, file }) => ({ specifier, sha256: sha256(file) })),
  });
const sampleHeap = async (session, phase) => {
  const usage = await session.send('Runtime.getHeapUsage').catch(() => null);
  return (
    usage && {
      phase,
      atMs: Date.now(),
      usedSize: usage.usedSize,
      backingStorageSize: usage.backingStorageSize,
      embedderHeapUsedSize: usage.embedderHeapUsedSize,
    }
  );
};
const measure = async (config) => {
  await page.evaluate((input) => window.reactSdkBenchmark.seed(input), config);
  const session = await context.newCDPSession(page);
  await session.send('HeapProfiler.collectGarbage').catch(() => {});
  const heap = [await sampleHeap(session, 'baseline')].filter(Boolean);
  let polling = true;
  const poll = (async () => {
    while (polling) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const next = await sampleHeap(session, 'peak');
      if (next) heap.push(next);
    }
  })();
  captureOverlap = async () => {
    const overlap = await sampleHeap(session, 'old-new-overlap');
    if (!overlap) throw new Error('CDP heap sampling is unavailable during old/new overlap');
    heap.push(overlap);
  };
  try {
    const result = await page.evaluate((input) => window.reactSdkBenchmark.run(input), config);
    return {
      ...result,
      wallMs: result.workloadMs,
      heap: {
        available: heap.length > 0,
        scope: 'calling-page-only',
        measurementPhase: 'post-seed workload only',
        cadenceMs: 50,
        samples: heap,
      },
    };
  } finally {
    captureOverlap = undefined;
    polling = false;
    await poll;
    await session.send('HeapProfiler.collectGarbage').catch(() => {});
    const retained = await sampleHeap(session, 'retained');
    if (retained) heap.push(retained);
    await session.detach();
  }
};
const twoTabs = async (mode) => {
  const owner = await context.newPage();
  const follower = await context.newPage();
  const name = `react-sdk-benchmark-two-tab-${randomUUID()}.bin`;
  let primaryError;
  let result;
  let cleanupError;
  try {
    await Promise.all([owner.goto(`${address}benchmark.html`), follower.goto(`${address}benchmark.html`)]);
    await owner.evaluate((input) => window.reactSdkBenchmark.openTab(input), { name, mode });
    await follower.evaluate((input) => window.reactSdkBenchmark.openTab(input), { name, mode });
    const started = performance.now();
    await owner.evaluate(() => window.reactSdkBenchmark.writeTab(1));
    await follower.evaluate(() => window.reactSdkBenchmark.waitTab(1));
    result = { mode, convergenceMs: performance.now() - started, assertion: 'follower observed owner write' };
  } catch (error) {
    primaryError = error;
  } finally {
    const cleanupFailures = [];
    for (const action of [
      () => owner.evaluate(() => window.reactSdkBenchmark.closeTab()),
      () => follower.evaluate(() => window.reactSdkBenchmark.closeTab()),
      () => owner.evaluate((volume) => window.reactSdkBenchmark.deleteTabVolume(volume), name),
      () => owner.close(),
      () => follower.close(),
    ])
      try {
        await action();
      } catch (error) {
        cleanupFailures.push(error);
      }
    if (cleanupFailures.length) cleanupError = new AggregateError(cleanupFailures, 'Two-tab benchmark cleanup failed');
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  return result;
};

try {
  const samples = [];
  for (const phase of ['warmup', 'measured']) {
    const count = phase === 'warmup' ? warmups : runs;
    for (let run = 0; run < count; run++)
      for (const scenario of cases)
        for (const mode of ['direct', 'sdk'])
          samples.push({
            phase,
            run,
            scenario: scenario.name,
            mode,
            result: await measure({ ...scenario, mode, name: `react-sdk-benchmark-${randomUUID()}.bin` }),
          });
  }
  const twoTab = [];
  for (const phase of ['warmup', 'measured']) {
    const count = phase === 'warmup' ? warmups : runs;
    for (let run = 0; run < count; run++) {
      for (const mode of ['direct', 'sdk']) twoTab.push({ phase, run, ...(await twoTabs(mode)) });
    }
  }
  for (const sample of samples.filter((sample) => sample.phase === 'measured')) {
    if (sample.mode === 'sdk') {
      assert.equal(sample.result.assertions.sharedInitialListing, 1);
      assert.equal(sample.result.assertions.unrelatedContentReads, 0);
      assert.equal(sample.result.assertions.broadcastDeliveriesDeduplicated, true);
      assert.equal(sample.result.assertions.oldNewOverlapObserved, true);
    } else assert.equal(sample.result.assertions.directConsumers, true);
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(
    resolve(out, 'samples.json'),
    JSON.stringify({ schemaVersion: 1, source, warmups, runs, cases, samples, twoTab }, null, 2) + '\n',
  );
  writeFileSync(
    resolve(out, 'environment.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        source,
        browser: { engine: 'chromium', version: browser.version() },
        node: process.version,
        playwright: JSON.parse(readFileSync(resolve(packageRoot, 'node_modules/playwright/package.json'), 'utf8'))
          .version,
        machine: {
          platform: process.platform,
          release: os.release(),
          arch: process.arch,
          cpus: os.cpus().map(({ model, speed }) => ({ model, speed })),
          totalMemory: os.totalmem(),
        },
        fixtureSha256: { driver: sha256(fileURLToPath(import.meta.url)), page: sha256(pageFixture) },
        artifacts: { workspace: workspaceArtifacts },
        setup: setupEvidence ?? null,
        metrics: {
          transport:
            'Observed page-boundary Worker/BroadcastChannel binary payloads only; excludes clone framing and worker-internal traffic.',
          logical: 'Application read/write Uint8Array sizes, separate from transport payloads.',
          longTasks:
            'Page PerformanceObserver longtask entries; the fixture records timestamps but cannot attribute a task to SDK code.',
          heap: 'Chromium CDP Runtime.getHeapUsage for the calling page only; baseline/retained calls request GC and peak samples run every 50 ms. It excludes worker memory and cannot attribute bytes to SDK buffers.',
        },
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`React SDK benchmark evidence: ${out}`);
} finally {
  await page.close().catch(() => {});
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
  await server.close().catch(() => {});
}
