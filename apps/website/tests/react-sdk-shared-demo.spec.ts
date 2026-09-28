import { expect, test, webkit, type Page } from '@playwright/test';

const route = '/demos/react/?transport=shared-worker';

function volume(page: Page, label: string) {
  return page.locator('.react-sdk-volume').filter({ has: page.getByRole('heading', { name: label, exact: true }) });
}

async function open(page: Page, url: string) {
  await page.goto(url);
  const notes = volume(page, 'Shared preview notes');
  const ideas = volume(page, 'Shared preview ideas');
  await expect(notes.getByText(/^Shared preview notes: ready/)).toBeVisible({ timeout: 30_000 });
  await expect(ideas.getByText(/^Shared preview ideas: ready/)).toBeVisible({ timeout: 30_000 });
  return { notes, ideas };
}

async function save(panel: ReturnType<typeof volume>, text: string) {
  await panel.getByRole('textbox', { name: 'Draft' }).fill(text);
  await panel.getByRole('button', { name: 'Save and sync' }).click();
  await expect(panel.getByRole('status')).toContainText('Saved and synchronized');
}

async function settleCleanup(operation: Promise<unknown>) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation.catch(() => {}),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function closePages(
  context: Awaited<ReturnType<typeof webkit.launchPersistentContext>>,
  pages: (Page | undefined)[],
) {
  await Promise.all(
    pages.filter((page): page is Page => page !== undefined).map((page) => settleCleanup(page.close())),
  );
  await settleCleanup(context.close());
}

test('the default React demo selects the shared transport in persistent WebKit', async ({ browserName }, testInfo) => {
  test.skip(browserName !== 'webkit', 'requires WebKit SharedWorker sync access handles');
  const context = await webkit.launchPersistentContext('', { headless: true });
  const page = await context.newPage();
  try {
    await page.goto(`${testInfo.project.use.baseURL as string}/demos/react/`);
    for (const [label, fileName] of [
      ['Auto notes', 'opfs-vfs-react-auto-notes.bin'],
      ['Auto ideas', 'opfs-vfs-react-auto-ideas.bin'],
    ]) {
      const panel = volume(page, label);
      await expect(panel.getByText(`${label}: ready`)).toBeVisible({ timeout: 30_000 });
      await expect(panel.getByText('Transport: requested auto; selected shared-worker.')).toBeVisible();
      await expect(panel.getByText(fileName)).toBeVisible();
    }
  } finally {
    await closePages(context, [page]);
  }
});

test('the React shared preview shares independent volumes across pages', async ({ browserName }, testInfo) => {
  test.skip(browserName !== 'webkit', 'requires WebKit SharedWorker sync access handles');
  const context = await webkit.launchPersistentContext('', { headless: true });
  const url = `${testInfo.project.use.baseURL as string}${route}`;
  const a = await context.newPage();
  let b: Page | undefined;
  let c: Page | undefined;
  try {
    const aVolumes = await open(a, url);
    b = await context.newPage();
    const bVolumes = await open(b, url);

    const first = `note from A ${testInfo.testId}`;
    await save(aVolumes.notes, first);
    await expect(bVolumes.notes.locator('p.react-sdk-current').first()).toContainText(first, { timeout: 30_000 });

    const second = `note from B ${testInfo.testId}`;
    await save(bVolumes.notes, second);
    await expect(aVolumes.notes.locator('p.react-sdk-current').first()).toContainText(second, { timeout: 30_000 });

    await a.close();
    const afterClose = `note after A closed ${testInfo.testId}`;
    await save(bVolumes.notes, afterClose);

    c = await context.newPage();
    const cVolumes = await open(c, url);
    await expect(cVolumes.notes.locator('p.react-sdk-current').first()).toContainText(afterClose, { timeout: 30_000 });

    await bVolumes.notes.getByRole('button', { name: 'Close this volume' }).click();
    await expect(bVolumes.notes.getByText(/^Shared preview notes: closed/)).toBeVisible();
    await expect(cVolumes.notes.getByText(/^Shared preview notes: ready/)).toBeVisible();
    const cNote = `note from C ${testInfo.testId}`;
    await save(cVolumes.notes, cNote);
    await save(bVolumes.ideas, `idea from B ${testInfo.testId}`);
    await expect(cVolumes.notes.locator('p.react-sdk-current').first()).toContainText(cNote);
  } finally {
    await closePages(context, [c, b, a]);
  }
});

test('the React shared preview globally shuts down, deletes, and recreates a volume', async ({
  browserName,
}, testInfo) => {
  test.skip(browserName !== 'webkit', 'requires WebKit SharedWorker sync access handles');
  const context = await webkit.launchPersistentContext('', { headless: true });
  const url = `${testInfo.project.use.baseURL as string}${route}`;
  const a = await context.newPage();
  let b: Page | undefined;
  let reopened: Page | undefined;
  try {
    const aVolumes = await open(a, url);
    b = await context.newPage();
    const bVolumes = await open(b, url);
    await save(aVolumes.notes, `before global shutdown ${testInfo.testId}`);

    await aVolumes.notes.getByRole('button', { name: 'Close this volume' }).click();
    await expect(aVolumes.notes.getByText(/^Shared preview notes: closed/)).toBeVisible({ timeout: 30_000 });
    const cleanup = aVolumes.notes.getByRole('button', { name: 'Close and delete this volume' });
    await expect(cleanup).toBeEnabled();
    await cleanup.click();
    await expect(aVolumes.notes.getByRole('status')).toContainText('Closed and removed this demo volume.', {
      timeout: 30_000,
    });
    await expect(bVolumes.notes.getByText(/^Shared preview notes: error/)).toBeVisible({ timeout: 30_000 });

    reopened = await context.newPage();
    const reopenedVolumes = await open(reopened, url);
    await expect(reopenedVolumes.notes.locator('p.react-sdk-current').first()).toContainText('(missing)');
  } finally {
    await closePages(context, [reopened, b, a]);
  }
});

test('the React shared preview reports unsupported in Chromium', async ({ browserName, page }) => {
  test.skip(browserName !== 'chromium', 'Chromium-specific capability result');
  await page.goto(route);
  await expect(volume(page, 'Shared preview notes').getByText(/^Shared preview notes: unsupported/)).toBeVisible();
  await expect(volume(page, 'Shared preview ideas').getByText(/^Shared preview ideas: unsupported/)).toBeVisible();
});
