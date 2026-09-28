import { expect, test } from '@playwright/test';

type Report = { readonly lock: string | null; readonly ownerId: string | null; readonly responseMs: number | null };

async function report(page: import('@playwright/test').Page) {
  return JSON.parse(
    await page.locator('[data-report]').evaluate((element: HTMLOutputElement) => element.value),
  ) as Report;
}

async function challengeOwner(page: import('@playwright/test').Page) {
  const button = page.getByRole('button', { name: 'Check lock and challenge owner' });
  await button.click();
  await expect(button).toBeEnabled({ timeout: 7_000 });
}

test('a second tab observes a dedicated owner lock and matching nonce until it closes', async ({
  page,
  context,
  browserName,
}) => {
  const session = `dedicated-${crypto.randomUUID()}`;
  await page.goto(`/demos/dedicated-owner-probe/?session=${session}`);
  await expect(page.locator('[data-state]')).toHaveText('owner-ready');
  const owner = await report(page);
  expect(owner.ownerId).toEqual(expect.any(String));

  const follower = await context.newPage();
  try {
    await follower.goto(`/demos/dedicated-owner-probe/?session=${session}&role=challenge`);
    await challengeOwner(follower);
    await expect(follower.locator('[data-state]')).toHaveText('owner-responsive');
    expect(await report(follower)).toMatchObject({
      lock: 'held-by-owner',
      ownerId: owner.ownerId,
      responseMs: expect.any(Number),
    });

    if (browserName === 'chromium') {
      const cdp = await context.newCDPSession(page);
      const timerEvents: string[] = [];
      let pagePaused = false;
      page.on('console', (message) => {
        if (message.text() === 'dedicated-owner-probe-page-timer') timerEvents.push(message.text());
      });
      try {
        await page.evaluate(() => {
          setTimeout(() => console.log('dedicated-owner-probe-page-timer'), 100);
        });
        await cdp.send('Debugger.enable');
        const paused = new Promise<void>((resolve) => cdp.once('Debugger.paused', () => resolve()));
        await cdp.send('Debugger.pause');
        await paused;
        pagePaused = true;
        await follower.waitForTimeout(250);
        expect(timerEvents).toHaveLength(0);
        await challengeOwner(follower);
        await expect(follower.locator('[data-state]')).toHaveText('owner-responsive');
        expect(await report(follower)).toMatchObject({ lock: 'held-by-owner', ownerId: owner.ownerId });
        await cdp.send('Debugger.resume');
        pagePaused = false;
        await expect.poll(() => timerEvents.length).toBe(1);
      } finally {
        if (pagePaused) await cdp.send('Debugger.resume');
        await cdp.detach();
      }
    }

    await page.getByRole('button', { name: 'Close dedicated owner' }).click();
    await expect(page.locator('[data-state]')).toHaveText('owner-closed');
    await challengeOwner(follower);
    await expect(follower.locator('[data-state]')).toHaveText('owner-no-response');
    expect(await report(follower)).toMatchObject({ lock: 'available', ownerId: null, responseMs: null });

    const fakeOwner = await context.newPage();
    try {
      await fakeOwner.goto(`/demos/dedicated-owner-probe/?session=${session}&role=challenge`);
      await fakeOwner.evaluate((name) => {
        const channel = new BroadcastChannel(name);
        channel.onmessage = ({ data }: MessageEvent<{ readonly type?: unknown; readonly nonce?: unknown }>) => {
          if (data?.type === 'challenge' && typeof data.nonce === 'string')
            channel.postMessage({ type: 'response', nonce: data.nonce, ownerId: 'fake-owner' });
        };
        (globalThis as typeof globalThis & { fakeOwnerChannel?: BroadcastChannel }).fakeOwnerChannel = channel;
      }, `opfs-vfs:dedicated-owner-probe:${session}:nonce`);
      await challengeOwner(follower);
      await expect(follower.locator('[data-state]')).toHaveText('owner-no-response');
      expect(await report(follower)).toMatchObject({ lock: 'available', ownerId: 'fake-owner' });
    } finally {
      await fakeOwner.evaluate(() => {
        const global = globalThis as typeof globalThis & { fakeOwnerChannel?: BroadcastChannel };
        global.fakeOwnerChannel?.close();
        delete global.fakeOwnerChannel;
      });
      await fakeOwner.close();
    }

    await follower.evaluate(() => {
      const locks = navigator.locks as unknown as { request: unknown };
      const original = Object.getOwnPropertyDescriptor(locks, 'request');
      Object.defineProperty(locks, 'request', {
        configurable: true,
        value: () => new Promise<never>(() => {}),
      });
      (
        globalThis as typeof globalThis & { restoreDedicatedProbeLockRequest?: () => void }
      ).restoreDedicatedProbeLockRequest = () => {
        if (original) Object.defineProperty(locks, 'request', original);
        else delete (locks as { request?: unknown }).request;
      };
    });
    try {
      await challengeOwner(follower);
      await expect(follower.locator('[data-state]')).toHaveText('lock-query-timeout');
      expect(await report(follower)).toMatchObject({ lock: null, ownerId: null, responseMs: null });
    } finally {
      await follower.evaluate(() => {
        const global = globalThis as typeof globalThis & { restoreDedicatedProbeLockRequest?: () => void };
        global.restoreDedicatedProbeLockRequest?.();
        delete global.restoreDedicatedProbeLockRequest;
      });
    }
  } finally {
    await follower.close();
  }
});
