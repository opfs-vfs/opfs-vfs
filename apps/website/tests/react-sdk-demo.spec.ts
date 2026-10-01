import { expect, test, type Page } from '@playwright/test';

const route = '/demos/react/';

test.beforeEach(({ browserName }) => {
  test.skip(browserName === 'webkit', 'WebKit OPFS requires a persistent browser context');
});

async function openInbox(page: Page) {
  await page.goto(route);
  await expect(page.getByLabel('Add files')).toBeEnabled({ timeout: 30_000 });
}

test('adds, previews, renames, deletes, and keeps local files after reload', async ({ page }, testInfo) => {
  await openInbox(page);
  const name = `inbox-${testInfo.testId}.txt`;
  await page.getByLabel('Add files').setInputFiles({
    name,
    mimeType: 'text/plain',
    buffer: Buffer.from('hello inbox'),
  });
  const files = page.getByRole('list', { name: 'Inbox files' });
  await expect(files.getByText(name, { exact: true })).toBeVisible();
  await expect(page.getByText('hello inbox', { exact: true })).toBeVisible();
  await page.reload();
  await expect(files.getByText(name, { exact: true })).toBeVisible({
    timeout: 30_000,
  });

  const renamed = `renamed-${testInfo.testId}.txt`;
  await page.getByLabel('Rename').fill(renamed);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(files.getByText(renamed, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(files.getByText(renamed, { exact: true })).toHaveCount(0);
});

test('shows another tab additions and renames through live React subscriptions', async ({
  page,
  context,
}, testInfo) => {
  await openInbox(page);
  const second = await context.newPage();
  try {
    await openInbox(second);
    const name = `shared-${testInfo.testId}.txt`;
    await page.getByLabel('Add files').setInputFiles({
      name,
      mimeType: 'text/plain',
      buffer: Buffer.from('from the first tab'),
    });
    const secondFiles = second.getByRole('list', { name: 'Inbox files' });
    await expect(secondFiles.getByText(name, { exact: true })).toBeVisible({
      timeout: 30_000,
    });

    const renamed = `shared-renamed-${testInfo.testId}.txt`;
    await second.getByLabel('Rename').fill(renamed);
    await second.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('list', { name: 'Inbox files' }).getByText(renamed, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    await second.close();
  }
});

test('drops image files, preserves duplicate names, and rejects files above the inbox limit', async ({
  page,
}, testInfo) => {
  await openInbox(page);
  const name = `image-${testInfo.testId}.png`;
  const png = Array.from(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M/wHwAF/gL+3MxZegAAAABJRU5ErkJggg==',
      'base64',
    ),
  );
  await page.locator('.react-inbox-dropzone').evaluate(
    (element, file) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(file.bytes)], file.name, { type: 'image/png' }));
      element.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
    },
    { name, bytes: png },
  );

  const files = page.getByRole('list', { name: 'Inbox files' });
  const row = files.locator('li').filter({ hasText: name });
  await expect(row).toBeVisible();
  await row.getByText(name, { exact: true }).click();
  const thumbnail = row.locator('img.react-inbox-thumbnail');
  await expect(thumbnail).toHaveJSProperty('naturalWidth', 1);

  await page.getByLabel('Add files').setInputFiles({ name, mimeType: 'image/png', buffer: Buffer.from(png) });
  await expect(files.getByText(`${name.slice(0, -4)} (2).png`, { exact: true })).toBeVisible();

  await page.getByLabel('Add files').evaluate((input) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new ArrayBuffer(16 * 1024 * 1024 + 1)], 'too-large.bin'));
    Object.defineProperty(input, 'files', { value: transfer.files, configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.getByRole('status')).toContainText('too-large.bin is larger than the 16 MiB inbox limit.');
  await expect(files.getByText('too-large.bin', { exact: true })).toHaveCount(0);
});

async function openTodos(page: Page) {
  await page.goto(route);
  await page.getByRole('tab', { name: 'Todo lists' }).click();
  await expect(page.getByRole('button', { name: 'New list' })).toBeEnabled({ timeout: 30_000 });
}

test('debounces metadata into saved Markdown and keeps numbered lists after reload', async ({ page }) => {
  await openTodos(page);
  await page.getByRole('button', { name: 'New list' }).click();
  await expect(page.getByLabel('Title')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Todo list files' }).getByText('list-001.md')).toBeVisible();
  await page.getByLabel('Title').fill('Earlier title');
  await page.waitForTimeout(250);
  await expect(page.getByLabel('Saved Markdown')).not.toContainText('Earlier title');
  await page.getByLabel('Title').fill('Launch plan');
  await page.getByLabel('Description').fill(`First line
Second line`);
  const markdown = page.getByLabel('Saved Markdown');
  await expect(markdown).toContainText('title: "Launch plan"');
  await expect(markdown).toContainText('description: "First line\\nSecond line"');
  await page.getByLabel('Add task').fill('Ship it');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByLabel('Ship it').check();
  await expect(page.getByRole('status')).toContainText('List saved locally.');
  await expect(markdown).toContainText('- [x] Ship it');

  await page.getByRole('button', { name: 'New list' }).click();
  await expect(page.getByRole('list', { name: 'Todo list files' }).getByText('list-002.md')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Todo list files' }).getByRole('button')).toHaveCount(2);
  await page.reload();
  await expect(page.getByRole('list', { name: 'Todo list files' }).getByRole('button')).toHaveCount(2, {
    timeout: 30_000,
  });
});

test('keeps an autosave-blocked draft when another tab saves first', async ({ page, context }) => {
  await page.clock.install({ time: new Date('2026-10-01T12:00:00') });
  await openTodos(page);
  await page.getByRole('button', { name: 'New list' }).click();
  await expect(page.getByLabel('Title')).toBeVisible();
  const second = await context.newPage();
  try {
    await openTodos(second);
    await expect(second.getByLabel('Title')).toBeVisible({ timeout: 30_000 });
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));
    await second.getByLabel('Title').fill('Saved elsewhere');
    await page.clock.runFor(200);
    await page.getByLabel('Title').fill('Local draft');
    await page.clock.runFor(200);
    await expect(second.getByLabel('Saved Markdown')).toContainText('Saved elsewhere');
    // Flush the deferred subscription notification without advancing the local autosave deadline.
    await page.clock.runFor(0);
    await expect(page.locator('.react-todos').getByRole('status')).toContainText('newer saved version');
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Local draft');
    await page.clock.runFor(400);
    await expect(page.locator('.react-todos').getByRole('status')).toContainText('newer saved version');
    await expect(second.getByLabel('Saved Markdown')).toContainText('Saved elsewhere');
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Local draft');
    await page.getByRole('button', { name: 'Reload saved' }).click();
    await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Saved elsewhere');
  } finally {
    await second.close();
  }
});

test('deletes a clean list in every tab without reviving a pending draft', async ({ page, context }) => {
  await openTodos(page);
  await page.getByRole('button', { name: 'New list' }).click();
  const second = await context.newPage();
  try {
    await openTodos(second);
    await expect(second.getByText('list-001.md', { exact: true })).toBeVisible({ timeout: 30_000 });
    await page.getByLabel('Title', { exact: true }).fill('Pending title');
    await expect(page.getByRole('button', { name: 'Delete list' })).toBeDisabled();
    second.once('dialog', (dialog) => dialog.accept());
    await second.getByRole('button', { name: 'Delete list' }).click();
    await expect(second.getByRole('list', { name: 'Todo list files' }).getByRole('button')).toHaveCount(0);
    await expect(page.getByRole('status')).toContainText('changed outside the editor');
    await page.getByRole('button', { name: 'Discard draft' }).click();
    await expect(page.getByRole('list', { name: 'Todo list files' }).getByRole('button')).toHaveCount(0);
  } finally {
    await second.close();
  }
});

test('opens devtools with recognizable volumes from both React examples', async ({ page }) => {
  await openInbox(page);
  const launcher = page.getByRole('button', { name: 'Open OPFS VFS Volume Explorer', exact: true });
  await expect(launcher).toBeVisible();
  await page.getByRole('tab', { name: 'File inbox', exact: true }).press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Todo lists', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Todo lists', exact: true }).press('ArrowLeft');
  await expect(page.getByRole('tab', { name: 'File inbox', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('dialog', { name: 'OPFS VFS Volume Explorer' })).not.toBeVisible();
  await openTodos(page);
  await expect(launcher).toBeVisible();
  await page.getByRole('button', { name: 'New list', exact: true }).click();
  await expect(page.getByLabel('Title')).toBeVisible();
  await launcher.click();
  const panel = page.getByRole('dialog', { name: 'OPFS VFS Volume Explorer' });
  await expect(panel).toBeVisible();
  await panel.getByRole('combobox', { name: 'Active volume' }).click();
  const options = page.getByRole('listbox');
  await expect(options.getByText('demo-file-inbox.bin', { exact: true })).toBeVisible();
  await options.getByText('demo-todo-list.bin', { exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Enable writes', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close volume explorer', exact: true }).click();
  await page.getByRole('button', { name: 'Open OPFS VFS Volume Explorer', exact: true }).click();
  await expect(panel).toBeVisible();
});
