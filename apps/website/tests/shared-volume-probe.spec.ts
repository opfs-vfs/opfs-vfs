import { expect, test, webkit, type Page } from '@playwright/test';

type Report = {
  readonly operation: string;
  readonly state: string;
  readonly reason: string | null;
  readonly ownerId: string | null;
  readonly marker: string | null;
  readonly scratchVolume: string | null;
};

async function report(page: Page) {
  return JSON.parse(await page.locator('[data-report]').evaluate((node: HTMLOutputElement) => node.value)) as Report;
}

async function writeSyncRead(page: Page) {
  const button = page.getByRole('button', { name: 'Write, sync and read' });
  await button.click();
  await expect(button).toBeEnabled({ timeout: 12_000 });
  await expect(page.locator('[data-state]')).toHaveText('ready');
  return report(page);
}

test('keeps an initial request timeout indeterminate when a late ready reply arrives', async ({ page }) => {
  await page.addInitScript(() => {
    class FakePort extends EventTarget {
      start() {}
      postMessage(message: { readonly type?: unknown; readonly requestId?: unknown }) {
        if (message.type !== 'start' || typeof message.requestId !== 'string') return;
        setTimeout(
          () =>
            this.dispatchEvent(
              new MessageEvent('message', {
                data: {
                  type: 'result',
                  requestId: message.requestId,
                  operation: 'start',
                  state: 'ready',
                  reason: null,
                  outcome: 'known',
                  ownerId: 'late-owner',
                  marker: null,
                  scratchVolume: 'late-volume.bin',
                },
              }),
            ),
          9_000,
        );
      }
    }
    class FakeSharedWorker {
      readonly port = new FakePort();
    }
    Object.defineProperty(globalThis, 'SharedWorker', { configurable: true, value: FakeSharedWorker });
  });
  await page.clock.install();
  await page.goto('/demos/shared-volume-probe/', { waitUntil: 'domcontentloaded' });
  await page.clock.fastForward(8_001);
  await expect(page.locator('[data-state]')).toHaveText('indeterminate: page-timeout (operation may have completed)');
  expect(await report(page)).toMatchObject({
    operation: 'start',
    state: 'indeterminate',
    reason: 'page-timeout',
    outcome: 'unknown',
    scratchVolume: expect.any(String),
  });
  await expect(page.getByRole('button', { name: 'Write, sync and read' })).toBeDisabled();

  await page.clock.fastForward(1_000);
  await expect(page.locator('[data-state]')).toHaveText('indeterminate: page-timeout (operation may have completed)');
  expect(await report(page)).toMatchObject({ state: 'indeterminate', outcome: 'unknown', ownerId: null });
});

test('keeps an initial transport error indeterminate when a late ready reply arrives', async ({ page }) => {
  await page.addInitScript(() => {
    class FakePort extends EventTarget {
      start() {}
      postMessage(message: { readonly type?: unknown; readonly requestId?: unknown }) {
        if (message.type !== 'start' || typeof message.requestId !== 'string') return;
        setTimeout(
          () =>
            this.dispatchEvent(
              new MessageEvent('message', {
                data: {
                  type: 'result',
                  requestId: message.requestId,
                  operation: 'start',
                  state: 'ready',
                  reason: null,
                  outcome: 'known',
                  ownerId: 'late-owner',
                  marker: null,
                  scratchVolume: 'late-volume.bin',
                },
              }),
            ),
          500,
        );
      }
    }
    class FakeSharedWorker {
      readonly port = new FakePort();
      onerror: ((event: Event) => void) | null = null;
      constructor() {
        setTimeout(() => this.onerror?.(new Event('error')), 100);
      }
    }
    Object.defineProperty(globalThis, 'SharedWorker', { configurable: true, value: FakeSharedWorker });
  });
  await page.clock.install();
  await page.goto('/demos/shared-volume-probe/', { waitUntil: 'domcontentloaded' });
  await page.clock.fastForward(100);
  await expect(page.locator('[data-state]')).toHaveText(
    'indeterminate: shared-worker-failed (operation may have completed)',
  );
  expect(await report(page)).toMatchObject({
    operation: 'start',
    state: 'indeterminate',
    reason: 'shared-worker-failed',
    outcome: 'unknown',
    scratchVolume: expect.any(String),
  });

  await page.clock.fastForward(400);
  await expect(page.locator('[data-state]')).toHaveText(
    'indeterminate: shared-worker-failed (operation may have completed)',
  );
  expect(await report(page)).toMatchObject({ state: 'indeterminate', outcome: 'unknown', ownerId: null });
});

test('reports unsupported when a SharedWorker cannot create sync access handles', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'WebKit uses the persistent-context core probe below');
  await page.goto('/demos/shared-volume-probe/');
  await expect(page.locator('[data-state]')).toHaveText('unsupported: missing-sync-access-handle');
  expect(await report(page)).toMatchObject({
    operation: 'start',
    state: 'unsupported',
    reason: 'missing-sync-access-handle',
    ownerId: null,
    scratchVolume: expect.any(String),
  });
});

test('one persistent WebKit SharedWorker owns direct VFS operations across two pages', async ({
  browserName,
}, testInfo) => {
  test.skip(browserName !== 'webkit', 'requires WebKit persistent OPFS context');
  const baseURL = testInfo.project.use.baseURL as string;
  const context = await webkit.launchPersistentContext('', { headless: true });
  const session = `shared-volume-${crypto.randomUUID()}`;
  const url = `${baseURL}/demos/shared-volume-probe/?session=${session}`;
  const a = await context.newPage();
  let b: Page | undefined;
  try {
    await a.goto(url);
    await expect(a.locator('[data-state]')).toHaveText('ready', { timeout: 12_000 });
    const started = await report(a);
    expect(started).toMatchObject({ operation: 'start', state: 'ready', ownerId: expect.any(String) });

    b = await context.newPage();
    await b.goto(url);
    await expect(b.locator('[data-state]')).toHaveText('ready', { timeout: 12_000 });
    expect(await report(b)).toMatchObject({ operation: 'start', state: 'ready', ownerId: started.ownerId });

    const first = await writeSyncRead(a);
    expect(first).toMatchObject({
      operation: 'write-sync-read',
      ownerId: started.ownerId,
      marker: 'shared-volume-marker-1',
    });

    const second = await writeSyncRead(b);
    expect(second).toMatchObject({
      operation: 'write-sync-read',
      ownerId: started.ownerId,
      marker: 'shared-volume-marker-2',
    });

    await a.close();
    const third = await writeSyncRead(b);
    expect(third).toMatchObject({
      operation: 'write-sync-read',
      ownerId: started.ownerId,
      marker: 'shared-volume-marker-3',
    });

    const reopen = b.getByRole('button', { name: 'Close, reopen and verify' });
    await reopen.click();
    await expect(reopen).toBeEnabled({ timeout: 12_000 });
    await expect(b.locator('[data-state]')).toHaveText('ready');
    expect(await report(b)).toMatchObject({
      operation: 'close-reopen-verify',
      ownerId: started.ownerId,
      marker: 'shared-volume-marker-3',
    });

    const cleanup = b.getByRole('button', { name: 'Clean up disposable volume' });
    await cleanup.click();
    await expect(b.locator('[data-state]')).toHaveText('cleaned', { timeout: 12_000 });
    expect(await report(b)).toMatchObject({ operation: 'cleanup', state: 'cleaned', ownerId: null, marker: null });
  } finally {
    await b?.close();
    await a.close().catch(() => {});
    await context.close();
  }
});
