import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const workspaceRoot = resolve(root, '../..');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspaceRoot, encoding: 'utf8' }).trim();
const dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: workspaceRoot, encoding: 'utf8' }).trim());
const server = await createServer({
  root,
  server: {
    host: '127.0.0.1',
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
  },
  plugins: [
    {
      name: 'subscription-load-page',
      configureServer(instance) {
        instance.middlewares.use('/load.html', (_request, response) => {
          response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
          response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
          response.end('<script type="module" src="/src/__tests__/subscription-two-tab-page.ts"></script>');
        });
      },
    },
  ],
});
await server.listen();
const address = server.resolvedUrls.local[0];
const browser = await chromium.launch({ headless: true });
const browserVersion = browser.version();
const context = await browser.newContext();
const owner = await context.newPage();
const follower = await context.newPage();
const name = `subscriptions-two-tab-${crypto.randomUUID()}.bin`;
const wait = async (page, check) => {
  await page.waitForFunction(check, undefined, { timeout: 30000 });
};
const summary = (samples) => ({
  count: samples.length,
  meanMs: samples.length ? samples.reduce((total, value) => total + value, 0) / samples.length : null,
  maxMs: samples.length ? Math.max(...samples) : null,
});
const producer = (durationMs) => ({
  durationMs,
  commandsPerSecond: durationMs === 0 ? null : 10000 / (durationMs / 1000),
});
let mainFailure;
let cleanupFailure;
try {
  await Promise.all([owner.goto(`${address}load.html`), follower.goto(`${address}load.html`)]);
  await owner.evaluate((volume) => window.subscriptionLoad.prepare(volume), name);
  await follower.evaluate((volume) => window.subscriptionLoad.hold(volume), name);
  const capacityStarted = performance.now();
  await owner.evaluate(() => window.subscriptionLoad.rename());
  await wait(
    follower,
    () => window.subscriptionLoad.metrics().first === 1 && window.subscriptionLoad.metrics().second === 1,
  );
  const capacityMs = performance.now() - capacityStarted;
  await follower.evaluate(() => window.subscriptionLoad.releaseHeld());
  await wait(
    follower,
    () =>
      (window.subscriptionLoad.metrics().first === 4096 && window.subscriptionLoad.metrics().second === 4096) ||
      window.subscriptionLoad.metrics().errors.length > 0,
  );
  await follower.evaluate(() => window.subscriptionLoad.startStream());
  const streamToDrainStarted = performance.now();
  const streamProducerMs = await owner.evaluate(() => window.subscriptionLoad.writeStream());
  await wait(
    follower,
    () => window.subscriptionLoad.metrics().streamed === 10000 || window.subscriptionLoad.metrics().errors.length > 0,
  );
  const streamToDrainMs = performance.now() - streamToDrainStarted;
  await owner.evaluate(() => window.subscriptionLoad.startOwnerLocalStream());
  const ownerLocalToDrainStarted = performance.now();
  const ownerLocalProducerMs = await owner.evaluate(() => window.subscriptionLoad.writeOwnerLocalStream());
  await wait(
    owner,
    () => window.subscriptionLoad.metrics().ownerLocal === 10000 || window.subscriptionLoad.metrics().errors.length > 0,
  );
  const ownerLocalToDrainMs = performance.now() - ownerLocalToDrainStarted;
  await follower.evaluate(() => window.subscriptionLoad.startFollowerProducerStream());
  const followerProducerToDrainStarted = performance.now();
  const followerProducerProducerMs = await follower.evaluate(() =>
    window.subscriptionLoad.writeFollowerProducerStream(),
  );
  await wait(
    follower,
    () =>
      window.subscriptionLoad.metrics().followerProducer === 10000 ||
      window.subscriptionLoad.metrics().errors.length > 0,
  );
  const followerProducerToDrainMs = performance.now() - followerProducerToDrainStarted;
  const [ownerMetrics, followerMetrics] = await Promise.all([
    owner.evaluate(() => window.subscriptionLoad.metrics()),
    follower.evaluate(() => window.subscriptionLoad.metrics()),
  ]);
  const { ackRttMs: ownerAckRttMs, commandStartLagMs: ownerCommandStartLagMs, ...ownerCounts } = ownerMetrics;
  const {
    ackRttMs: followerAckRttMs,
    commandStartLagMs: followerCommandStartLagMs,
    ...followerCounts
  } = followerMetrics;
  const report = {
    source: { commit, dirty },
    browser: { engine: 'chromium', version: browserVersion },
    workload: { burstRecipientsPerSubscription: 4096, streamCommands: 10000 },
    capacityMs,
    expectedCapacityRecipients: 8192,
    producer: {
      ownerToFollower: producer(streamProducerMs),
      ownerLocal: producer(ownerLocalProducerMs),
      followerProducer: producer(followerProducerProducerMs),
    },
    toDrainMs: {
      ownerToFollower: streamToDrainMs,
      ownerLocal: ownerLocalToDrainMs,
      followerProducer: followerProducerToDrainMs,
    },
    ...followerCounts,
    ownerLocal: ownerCounts.ownerLocal,
    errors: [...ownerCounts.errors, ...followerCounts.errors],
    ackRtt: summary([...ownerAckRttMs, ...followerAckRttMs]),
    commandStartLag: summary([...ownerCommandStartLagMs, ...followerCommandStartLagMs]),
  };
  console.log('SUBSCRIPTIONS_TWO_TAB_LOAD', JSON.stringify(report));
  assert.equal(report.first, 4096);
  assert.equal(report.second, 4096);
  assert.equal(report.streamed, 10000);
  assert.equal(report.ownerLocal, 10000);
  assert.equal(report.followerProducer, 10000);
  assert.deepEqual(report.errors, []);
} catch (error) {
  mainFailure = error;
} finally {
  const cleanup = async (action) => {
    try {
      await action();
    } catch (error) {
      cleanupFailure ??= error;
    }
  };
  await cleanup(() => follower.evaluate(() => window.subscriptionLoad.disposeFollower()));
  await cleanup(() => owner.evaluate((volume) => window.subscriptionLoad.disposeOwner(volume), name));
  await cleanup(() => follower.close());
  await cleanup(() => owner.close());
  await cleanup(() => context.close());
  await cleanup(() => browser.close());
  await cleanup(() => server.close());
}
if (mainFailure) throw mainFailure;
if (cleanupFailure) throw cleanupFailure;
