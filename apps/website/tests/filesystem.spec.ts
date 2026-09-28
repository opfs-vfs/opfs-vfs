import { expect, test, type Page } from '@playwright/test';
import { choose, continueDialog } from './ui';

const route = '/demos/filesystem/';
const unique = (prefix: string) => `${prefix}-${Date.now().toString(36)}`;

test('shared preview and editor follow the website theme', async ({ page }) => {
  await page.goto(route);
  for (const [mode, background, foreground] of [
    ['Dark', 'rgb(24, 34, 28)', 'rgb(229, 238, 232)'],
    ['Light', 'rgb(255, 255, 255)', 'rgb(23, 43, 34)'],
  ]) {
    await choose(page, 'Color theme', mode);
    await page.getByRole('treeitem', { name: /README\.md/ }).click();
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(page.locator('.opfs-file-preview')).toHaveCSS('background-color', background);
    await expect(page.locator('.opfs-file-preview')).toHaveCSS('color', foreground);
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    await expect(page.locator('.opfs-text-editor')).toHaveCSS('background-color', background);
    await expect(page.locator('.opfs-text-editor')).toHaveCSS('color', foreground);
    await expect(page.locator('.cm-editor')).toBeVisible();
  }
});

async function ready(page: Page) {
  await page.goto(route);
  await expect(page.getByRole('combobox', { name: 'Volume', exact: true })).toBeVisible({ timeout: 30_000 });
}

async function command(page: Page, value: string) {
  await page.getByLabel('Shell command').fill(value);
  await page.getByLabel('Shell command').press('Enter');
  await expect(page.locator('.filesystem-demo')).toHaveAttribute('aria-busy', 'false');
}

async function createVolume(page: Page, name: string) {
  await page.getByLabel('New volume name').fill(name);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Volume', exact: true })).toContainText(name);
  await expect(page.getByRole('combobox', { name: 'Volume', exact: true })).toBeEnabled();
}

test('shell runs with Enter and keeps Shift+Enter for new lines', async ({ page }) => {
  await ready(page);
  const input = page.getByLabel('Shell command');
  const output = page.locator('.shell-panel pre');
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toHaveCount(0);
  await expect(input).toHaveAccessibleDescription('Enter to run · Shift+Enter for a new line');
  await input.fill('echo first');
  await input.press('Shift+Enter');
  await input.pressSequentially('echo second');
  await expect(input).toHaveValue('echo first\necho second');
  await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  await input.dispatchEvent('keydown', { key: 'Enter', repeat: true });
  await expect(output).toHaveText('$ ls -la');
  await input.press('Enter');
  await expect(output).toHaveText('first\nsecond\n');
  await expect(input).toBeFocused();
});

test('Enter does not queue another command while one is running', async ({ page }) => {
  await ready(page);
  const input = page.getByLabel('Shell command');
  await expect(input).toBeEnabled();
  await page.evaluate(async () => {
    const lease = (await navigator.locks.query()).held!.find((lock) => lock.name.endsWith(':lease'))!;
    await new Promise<void>((held) => {
      void navigator.locks.request(lease.name.replace(/:lease$/, ':use'), async () => {
        await new Promise<void>((release) => {
          (window as unknown as { releaseCommand: () => void }).releaseCommand = release;
          held();
        });
      });
    });
  });
  await input.fill('echo once >> enter-check.txt');
  await input.press('Enter');
  await expect(page.locator('.filesystem-demo')).toHaveAttribute('aria-busy', 'true');
  await input.press('Enter');
  await page.evaluate(() => (window as unknown as { releaseCommand: () => void }).releaseCommand());
  await expect(page.locator('.filesystem-demo')).toHaveAttribute('aria-busy', 'false');
  await command(page, 'cat enter-check.txt');
  await expect(page.locator('.shell-panel pre')).toHaveText('once\n');
});

test('shell writes persist across save and reopen', async ({ page }) => {
  await ready(page);
  const name = unique('persist');
  await createVolume(page, name);
  await command(page, `printf 'kept after reopen' > persisted.txt`);
  await page.getByRole('button', { name: 'Save & reopen' }).click();
  await expect(page.getByLabel('Shell command')).toBeVisible();
  await command(page, 'cat persisted.txt');
  await expect(page.locator('.shell-panel pre')).toContainText('kept after reopen');
});

test('drop, move, edit, export, and import use logical files', async ({ page }) => {
  await ready(page);
  const name = unique('files');
  await createVolume(page, name);
  const transfer = await page.evaluateHandle(() => {
    const value = new DataTransfer();
    value.items.add(new File(['dropped'], 'dropped.txt', { type: 'text/plain' }));
    return value;
  });
  await page.locator('.filesystem-grid').dispatchEvent('drop', { dataTransfer: transfer });
  const dropped = page.getByRole('treeitem', { name: /dropped\.txt/ });
  await expect(dropped).toBeVisible();
  await command(page, 'mkdir moved');
  const moved = page.getByRole('treeitem', { name: /moved/ });
  await dropped.dragTo(moved);
  await moved.click();
  await expect(page.getByRole('treeitem', { name: /dropped\.txt/ })).toBeVisible();
  await page.getByRole('treeitem', { name: /README\.md/ }).click();
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await page.getByLabel('Edit README.md').fill('# Edited locally');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export ZIP' }).click();
  const saved = await download;
  const path = test.info().outputPath(`${unique('imported')}.zip`);
  await saved.saveAs(path);
  await page.locator('input[type=file][accept*="zip"]').setInputFiles(path);
  await expect(page.getByRole('combobox', { name: 'Volume', exact: true })).toContainText(/imported-/);
  await command(page, 'cat README.md');
  await expect(page.locator('.shell-panel pre')).toContainText('Edited locally');
});

test('a follower survives leader close and reset reports an in-use volume', async ({ browser }) => {
  const context = await browser.newContext();
  const leader = await context.newPage();
  await ready(leader);
  const name = unique('tabs');
  const follower = await context.newPage();
  await ready(follower);
  await createVolume(leader, name);
  await choose(follower, 'Volume', name);
  await follower.getByRole('button', { name: 'Reset', exact: true }).click();
  await continueDialog(follower);
  await expect(follower.getByRole('alert')).toContainText(/open|busy|use|EBUSY/i);
  await leader.close();
  await command(follower, `printf 'follower owns it' > follower.txt`);
  await expect(follower.getByRole('treeitem', { name: /follower\.txt/ })).toBeVisible();
  await context.close();
});

test('panel dividers resize, clamp and preserve drafts through collapse and narrow layouts', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await ready(page);
  const first = page.getByRole('separator', { name: 'Resize file tree', exact: true });
  const second = page.getByRole('separator', { name: 'Resize workspace and preview', exact: true });
  const size = async (selector: string) => (await page.locator(selector).boundingBox())!.width;
  const dragBy = async (handle: typeof first, delta: number) => {
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 100);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + delta, box.y + 100, { steps: 8 });
    await page.mouse.up();
    await expect(page.locator('.panel-drag-overlay')).toHaveCount(0);
  };
  await page.getByLabel('Shell command').fill('unsent shell draft');
  const before = await size('.explorer-panel');
  await dragBy(first, 90);
  expect(await size('.explorer-panel')).toBeCloseTo(before + 90, 0);
  const shellBefore = await size('.shell-panel');
  await dragBy(second, 60);
  expect(await size('.shell-panel')).toBeCloseTo(shellBefore + 60, 0);
  await first.press('Home');
  expect(await size('.explorer-panel')).toBeCloseTo(180, 0);
  await first.press('ArrowRight');
  expect(await size('.explorer-panel')).toBeCloseTo(200, 0);
  await second.press('End');
  expect(await size('.preview-panel')).toBeCloseTo(240, 0);
  await page.getByRole('button', { name: 'Collapse file tree', exact: true }).click();
  await expect(page.getByRole('treeitem', { name: 'notes.txt', exact: true })).toBeHidden();
  expect(await size('.explorer-panel')).toBeCloseTo(44, 0);
  await expect(first).toBeHidden();
  await second.press('Home');
  expect(await size('.shell-panel')).toBeCloseTo(240, 0);
  await page.getByRole('button', { name: 'Expand file tree', exact: true }).click();
  await expect(page.getByRole('treeitem', { name: 'notes.txt', exact: true })).toBeVisible();
  await expect(page.getByLabel('Shell command')).toHaveValue('unsent shell draft');
  await first.press('End');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(first).toBeHidden();
  await expect(second).toBeHidden();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.getByRole('button', { name: 'Collapse file tree', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Shell', exact: true })).toBeFocused();
  await expect(page.getByLabel('Shell command')).toHaveValue('unsent shell draft');
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(page.getByRole('treeitem', { name: 'notes.txt', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1050, height: 900 });
  await expect(first).toBeVisible();
  for (const selector of ['.shell-panel', '.preview-panel']) expect(await size(selector)).toBeGreaterThanOrEqual(239);
  const grid = await page.locator('.filesystem-grid').boundingBox();
  const preview = await page.locator('.preview-panel').boundingBox();
  expect(preview!.x + preview!.width).toBeLessThanOrEqual(grid!.x + grid!.width + 1);
});

test('slow mounts retain a disabled toolbar, delay the spinner, and reserve retry for failures', async ({ page }) => {
  await ready(page);
  await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeEnabled();
  const clockTime = new Date();
  await page.clock.install({ time: clockTime });
  await page.clock.pauseAt(clockTime);
  const name = 'Delayed volume';
  // Hold the real volume lock so mounting waits deterministically without mocking the filesystem.
  await page.evaluate(async () => {
    await new Promise<void>((held) => {
      void navigator.locks.request('opfs-vfs:website:website-filesystem-delayed%20volume.bin:use', async () => {
        await new Promise<void>((release) => {
          (window as unknown as { releaseMount: () => void }).releaseMount = release;
          held();
        });
      });
    });
  });
  await page.getByLabel('New volume name').fill(name);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry filesystem' })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Volume', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Volume', exact: true })).toBeDisabled();
  await expect(page.getByLabel('New volume name')).toBeDisabled();
  await expect(page.getByLabel('Shell command', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Export ZIP' })).toBeDisabled();
  await expect(page.locator('.filesystem-grid')).toHaveAttribute('inert', '');
  await page.clock.runFor(499);
  await expect(page.getByRole('status').filter({ hasText: 'Opening volume' })).toHaveCount(0);
  await page.clock.runFor(1);
  await expect(page.getByRole('status').filter({ hasText: 'Opening volume' })).toBeVisible();
  await page.evaluate(() => (window as unknown as { releaseMount: () => void }).releaseMount());
  await expect(page.getByRole('combobox', { name: 'Volume', exact: true })).toBeEnabled();
  await expect(page.getByRole('status').filter({ hasText: 'Opening volume' })).toHaveCount(0);
  await expect(page.locator('.filesystem-grid')).not.toHaveAttribute('inert');
  await expect(page.getByRole('treeitem', { name: 'README.md', exact: true })).toBeVisible();
  await page.clock.resume();
  await choose(page, 'Volume', 'Demo workspace');
  await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeEnabled();
  await page.getByLabel('New volume name').fill('invalid/name');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Use 1-40');
  await expect(page.getByRole('button', { name: 'Retry filesystem' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Opening volume' })).toHaveCount(0);
  await choose(page, 'Volume', name);
  await expect(page.getByRole('button', { name: 'Export ZIP' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Retry filesystem' })).toHaveCount(0);
});

test('registry and close failures end loading and allow recovery', async ({ page }) => {
  await page.addInitScript(() => {
    let fail = true;
    navigator.locks.request = new Proxy(navigator.locks.request.bind(navigator.locks), {
      apply(target, receiver, args) {
        if (fail && args[0] === 'opfs-vfs:website:filesystem:registry') {
          fail = false;
          return Promise.reject(new Error('Registry unavailable for test'));
        }
        return Reflect.apply(target, receiver, args);
      },
    });
  });
  await page.goto(route);
  await expect(page.getByRole('alert')).toContainText('Registry unavailable for test');
  await expect(page.locator('.filesystem-demo')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('button', { name: 'Retry filesystem' })).toBeVisible();
  await page.getByLabel('New volume name').fill('Recovery volume');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Export ZIP' })).toBeEnabled();
  await page.evaluate(() => {
    let fail = true;
    navigator.locks.request = new Proxy(navigator.locks.request.bind(navigator.locks), {
      apply(target, receiver, args) {
        if (fail && args[0] === 'opfs-vfs:website:website-filesystem-recovery%20volume.bin:use') {
          fail = false;
          return Promise.reject(new Error('Close unavailable for test'));
        }
        return Reflect.apply(target, receiver, args);
      },
    });
  });
  await page.getByRole('button', { name: 'Save & reopen' }).click();
  await expect(page.getByRole('alert')).toContainText('Close unavailable for test');
  await expect(page.locator('.filesystem-demo')).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Retry filesystem' }).click();
  await expect(page.getByRole('button', { name: 'Export ZIP' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Retry filesystem' })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
