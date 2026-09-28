import { expect, test } from '@playwright/test';

const route = '/demos/react/?transport=dedicated';
const notesName = 'Dedicated notes';

test.beforeEach(({ browserName }) => {
  test.skip(browserName === 'webkit', 'WebKit OPFS requires a persistent browser context');
});

test('the default demo uses separate auto volumes and reports the selected transport', async ({ page }) => {
  await page.goto('/demos/react/');
  const notes = page
    .locator('.react-sdk-volume')
    .filter({ has: page.getByRole('heading', { name: 'Auto notes', exact: true }) });
  await expect(notes.getByText(/^Auto notes: ready/)).toBeVisible({ timeout: 30_000 });
  await expect(notes.getByText(/^Transport: requested auto; selected (dedicated|shared-worker)/)).toBeVisible();
});

test('the second client updates the note and releases it during cleanup', async ({ page }) => {
  await page.goto(route);
  const notes = page.locator('.react-sdk-volume').filter({ has: page.getByRole('heading', { name: notesName }) });
  await expect(notes.getByText(/^Dedicated notes: ready/)).toBeVisible({ timeout: 30_000 });
  await notes.getByRole('button', { name: 'Update from second client' }).click();
  await expect(notes.getByRole('status')).toContainText('A compatible second client synchronized', { timeout: 30_000 });
  await expect(notes.getByText(/Current file:.*Updated by the compatible second client/)).toBeVisible();
  await notes.getByRole('button', { name: 'Close and delete this volume' }).click();
  await expect(notes.getByRole('status')).toContainText('Closed and removed this demo volume');
});

test('unmounting the demo releases its second client', async ({ page }) => {
  await page.goto(route);
  const notes = page.locator('.react-sdk-volume').filter({ has: page.getByRole('heading', { name: notesName }) });
  await expect(notes.getByText(/^Dedicated notes: ready/)).toBeVisible({ timeout: 30_000 });
  await notes.getByRole('button', { name: 'Update from second client' }).click();
  await expect(notes.getByRole('status')).toContainText('A compatible second client synchronized');
  const secondClientLocks = () =>
    page.evaluate(
      async () =>
        (await navigator.locks.query()).held?.filter((lock) =>
          lock.name?.startsWith('opfs-vfs-client-opfs-vfs-react-dedicated-notes.bin-'),
        ).length ?? 0,
    );
  await expect.poll(secondClientLocks).toBeGreaterThan(0);
  await page
    .locator('astro-island[component-url*="ReactSdkDemo"]')
    .evaluate((island) => island.dispatchEvent(new Event('astro:unmount')));
  await expect.poll(secondClientLocks).toBe(0);
});

test('the diagnostic query enables payload-free traces without changing the forced dedicated demo', async ({
  page,
  context,
}) => {
  const ordinaryTraces: string[] = [];
  page.on('console', (message) => {
    if (message.text().startsWith('[opfs-vfs:diag] ')) ordinaryTraces.push(message.text());
  });
  await page.goto(route);
  await expect(page.getByText('Diagnostics are active.')).toHaveCount(0);
  await expect(page.getByText(/^Dedicated notes: ready/)).toBeVisible({ timeout: 30_000 });
  expect(ordinaryTraces).toEqual([]);

  const diagnostic = await context.newPage();
  const traces: string[] = [];
  diagnostic.on('console', (message) => {
    if (message.text().startsWith('[opfs-vfs:diag] ')) traces.push(message.text());
  });
  try {
    await diagnostic.goto(`${route}&opfsDebug=1`);
    await expect(diagnostic.getByText('Diagnostics are active.')).toBeVisible();
    await expect(diagnostic.getByText(/^Dedicated notes: ready/)).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => traces.length).toBeGreaterThan(0);
    const records = traces.map((line) => JSON.parse(line.slice('[opfs-vfs:diag] '.length)) as Record<string, unknown>);
    expect(records).toEqual(expect.arrayContaining([expect.objectContaining({ event: 'client-created' })]));
    expect(JSON.stringify(records)).not.toContain('opfs-vfs-react-dedicated-notes.bin');
  } finally {
    await diagnostic.close();
  }
});

test('a dirty follower draft survives explicit owner close until reload', async ({ page, context }) => {
  await page.goto(route);
  const owner = page
    .locator('.react-sdk-volume')
    .filter({ has: page.getByRole('heading', { name: notesName, exact: true }) });
  await expect(owner.getByText(/^Dedicated notes: ready/)).toBeVisible({ timeout: 30_000 });
  const followerPage = await context.newPage();
  await followerPage.goto(route);
  const follower = followerPage
    .locator('.react-sdk-volume')
    .filter({ has: followerPage.getByRole('heading', { name: notesName, exact: true }) });
  await expect(follower.getByText(/^Dedicated notes: ready/)).toBeVisible({ timeout: 30_000 });
  const draft = follower.getByRole('textbox', { name: 'Draft' });
  await draft.fill('saved before takeover');
  await follower.getByRole('button', { name: 'Save and sync' }).click();
  await expect(follower.getByRole('status')).toContainText('Saved and synchronized');
  await draft.fill('draft survives takeover');
  await owner.getByRole('button', { name: 'Close this volume' }).click();
  await expect(follower.getByRole('alert')).toContainText('Reload before saving', { timeout: 30_000 });
  await expect(draft).toHaveValue('draft survives takeover');
  await follower.getByRole('button', { name: 'Reload current file (discard draft)' }).click();
  await expect(follower.getByRole('status')).toContainText('Reloaded the current file');
  await expect(draft).not.toHaveValue('draft survives takeover');
  await expect(follower.getByRole('button', { name: 'Save and sync' })).toBeEnabled();
  await followerPage.close();
});

test('the React SDK demo observes a second page and exposes a queued conflict accessibly', async ({
  page,
  context,
}) => {
  await page.goto(route);
  const notes = page
    .locator('.react-sdk-volume')
    .filter({ has: page.getByRole('heading', { name: notesName, exact: true }) });
  await expect(notes.getByText(/^Dedicated notes: ready/)).toBeVisible({ timeout: 30_000 });

  const editor = notes.getByRole('textbox', { name: 'Draft' });
  await editor.fill('first version');
  await notes.getByRole('button', { name: 'Save and sync' }).click();
  await expect(notes.getByRole('status')).toContainText('Saved and synchronized');
  await expect(notes.getByText(/Explorer:.*note\.txt/)).toBeVisible();

  const second = await context.newPage();
  await second.goto(route);
  const secondNotes = second
    .locator('.react-sdk-volume')
    .filter({ has: second.getByRole('heading', { name: notesName, exact: true }) });
  await expect(secondNotes.getByText(/^Dedicated notes: ready/)).toBeVisible({ timeout: 30_000 });
  await secondNotes.getByRole('textbox', { name: 'Draft' }).fill('second page update');
  await secondNotes.getByRole('button', { name: 'Save and sync' }).click();
  await expect(secondNotes.getByRole('status')).toContainText('Saved and synchronized');
  await expect(secondNotes.getByText(/Current file:.*second page update/)).toBeVisible();
  await expect(notes.getByText(/Current file:.*second page update/)).toBeVisible();

  await editor.fill('editor draft');
  await notes.getByRole('button', { name: 'Queue conflict-aware save' }).click();
  await secondNotes.getByRole('textbox', { name: 'Draft' }).fill('later second page update');
  await secondNotes.getByRole('button', { name: 'Save and sync' }).click();
  await expect(notes.getByText(/Current file:.*later second page update/)).toBeVisible();
  await notes.getByRole('button', { name: 'Run queued save' }).click();
  await expect(notes.getByRole('status')).toContainText('did not reach a confirmed synchronized state');
  await notes.getByRole('button', { name: 'Reload current file (discard draft)' }).click();
  await expect(notes.getByRole('status')).toContainText('Reloaded the current file');
  await expect(notes.getByRole('textbox', { name: 'Draft' })).toHaveValue('later second page update');

  await notes.getByRole('textbox', { name: 'Draft' }).fill('write before injected sync failure');
  await notes.getByRole('button', { name: 'Simulate sync failure' }).focus();
  await page.keyboard.press('Enter');
  await expect(notes.getByRole('status')).toContainText('Demo-only injected sync failure');
  await expect(notes.getByText(/Current file:.*write before injected sync failure/)).toBeVisible();
  await expect(notes.getByRole('status')).not.toContainText('Saved and synchronized');

  await second.close();
  await notes.getByRole('button', { name: 'Close and delete this volume' }).click();
  await expect(notes.getByRole('status')).toContainText('Closed and removed');
});
