import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const root = resolve(process.cwd(), 'packages/opfs-vfs');
const require = createRequire(resolve(root, 'package.json'));
const { chromium } = require('playwright');
const { createServer } = require('vite');
const server = await createServer({
  configFile: false,
  root,
  server: { host: '127.0.0.1', headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } },
  plugins: [{ name: 'relay-probe', configureServer(vite) {
    vite.middlewares.use('/relay-probe.html', (_request, response) => { response.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp'); response.end('<!doctype html><title>relay probe</title>'); });
  } }],
});
await server.listen();
const browser = await chromium.launch();
const context = await browser.newContext();
const [owner, reader, idle] = await Promise.all([context.newPage(), context.newPage(), context.newPage()]);
for (const page of [owner, reader, idle]) {
  page.setDefaultTimeout(120000);
  await page.goto(`${server.resolvedUrls.local[0]}relay-probe.html`);
}
const name = `issue89-relay-${crypto.randomUUID()}.bin`;
const open = async (page) => page.evaluate(async (volume) => {
  const { OpfsVfsWorker } = await import('/src/index_internal.ts');
  const client = new OpfsVfsWorker(volume, { bufferMode: 'memory' });
  globalThis.probeClient = client;
  await client.ready;
  return client.getStatus().role;
}, name);
try {
  const roles = [await open(owner), await open(reader), await open(idle)];
  await owner.evaluate(async () => {
    await globalThis.probeClient.writeFileBuffer('/large', new Uint8Array(16 * 1024 * 1024));
  });
  const cdp = await context.newCDPSession(idle);
  await cdp.send('HeapProfiler.enable');
  const heap = () => cdp.send('Runtime.getHeapUsage');
  await idle.evaluate(() => {
    globalThis.probeTasks = [];
    globalThis.probeResponses = 0;
    globalThis.probeClient.channel.addEventListener('message', ({ data }) => {
      if (data?.type === 'RESPONSE' && data.data?.byteLength === 16 * 1024 * 1024) globalThis.probeResponses++;
    });
    new PerformanceObserver((list) => globalThis.probeTasks.push(...list.getEntries().map((entry) => entry.duration)))
      .observe({ type: 'longtask', buffered: false });
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const baselineTasks = await idle.evaluate(() => globalThis.probeTasks.splice(0));
  await cdp.send('HeapProfiler.collectGarbage');
  const before = await heap();
  const start = Date.now();
  const reads = await reader.evaluate(async () => {
    const timings = [];
    for (let i = 0; i < 12; i++) {
      const t = performance.now();
      const bytes = await globalThis.probeClient.readFileBuffer('/large');
      if (bytes.length !== 16 * 1024 * 1024) throw new Error('short read');
      timings.push(performance.now() - t);
    }
    return timings;
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const after = await heap();
  const { tasks, responses } = await idle.evaluate(() => ({ tasks: globalThis.probeTasks, responses: globalThis.probeResponses }));
  console.log(JSON.stringify({ roles, browser: browser.version(), reads: reads.length, readerMs: reads, wallMs: Date.now() - start, idleBaselineLongTasksMs: baselineTasks, idleLongTasksMs: tasks, idleBroadcastResponses: responses, idleHeapBefore: before, idleHeapAfter: after }, null, 2));
} finally {
  for (const page of [idle, reader, owner]) await page.evaluate(() => globalThis.probeClient?.closeVfs()).catch(() => {});
  await owner.evaluate(async (volume) => {
    const { deleteVolume } = await import('/src/index.ts');
    await deleteVolume(volume);
  }, name).catch(() => {});
  await context.close();
  await browser.close();
  await server.close();
}
