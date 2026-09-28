import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { DebugPanel } from './DebugPanel';

test('editor tabs, dirty save control, clean file actions and lazy highlighting', async () => {
  await page.viewport(1200, 900);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const original = '# configuration\nport = 5432\n';
  root.render(
    createElement(DebugPanel, {
      initialOpen: true,
      initialPath: '/settings.conf',
      initialVolumes: [
        {
          name: 'workspace.bin',
          state: 'available',
          connection: 'owned',
          files: [
            { path: '/settings.conf', content: original, modified: 0 },
            { path: '/.env', content: '# environment\nMODE="development"\n', modified: 0 },
            { path: '/main.ts', content: 'const answer: number = 42;\n', modified: 0 },
            { path: '/data.bin', content: '', bytes: new Uint8Array([255]), modified: 0 },
          ],
        },
      ],
    }),
  );
  try {
    const preview = page.getByRole('tab', { name: 'Preview', exact: true });
    const source = page.getByRole('tab', { name: 'Editor', exact: true });
    await expect
      .poll(() => host.querySelector('.opfs-text-preview .tok-comment')?.textContent)
      .toContain('configuration');
    expect(host.querySelector('.opfs-text-preview .cm-gutters')).toBeNull();
    expect(host.querySelector('.opfs-text-preview .cm-activeLine')).toBeNull();
    const readingView = host.querySelector<HTMLElement>('.opfs-text-preview .cm-content')!;
    expect(readingView.isContentEditable).toBe(false);
    expect(readingView.tabIndex).toBe(0);
    expect(['pre-wrap', 'break-spaces']).toContain(getComputedStyle(readingView).whiteSpace);
    expect(getComputedStyle(readingView).padding).toBe('18px 20px');
    expect(
      parseFloat(getComputedStyle(readingView).lineHeight) / parseFloat(getComputedStyle(readingView).fontSize),
    ).toBeCloseTo(1.85);
    preview.element().focus();
    await userEvent.keyboard('{ArrowRight}');
    await expect.poll(() => host.querySelector('[role=tab][data-active]')?.textContent).toBe('Editor');
    await userEvent.keyboard('{ArrowLeft}');
    await expect.poll(() => host.querySelector('[role=tab][data-active]')?.textContent).toBe('Preview');
    await source.click();
    const editor = page.getByRole('textbox', { name: 'Edit /settings.conf', exact: true });
    await expect.poll(() => host.querySelector('.source-editor .tok-comment')?.textContent).toContain('configuration');
    expect(host.querySelector('.source-editor .cm-gutters')).not.toBeNull();
    expect(host.querySelector('.source-editor .cm-activeLine')).not.toBeNull();
    expect(host.querySelector('.preview-save')).toBeNull();
    expect(host.querySelector('.save-status')?.textContent).toBe('No changes');
    expect(getComputedStyle(host.querySelector('.source-editor')!).padding).toBe('0px');
    await editor.fill('port = 5433');
    await expect.poll(() => host.querySelector('.preview-save')?.textContent).toBe('Save');
    await editor.fill(original);
    await expect.poll(() => host.querySelector('.preview-save')).toBeNull();
    await page.getByRole('button', { name: 'Actions for /settings.conf', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    await page.getByRole('textbox', { name: 'Entry name' }).fill('server.conf');
    await page.getByRole('button', { name: 'Save entry', exact: true }).click();
    const renamed = page.getByRole('textbox', { name: 'Edit /server.conf', exact: true });
    await renamed.fill('port = 5433');
    await preview.click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => host.querySelector('.save-status')?.textContent).toBe('No changes');
    await source.click();
    await expect.poll(() => host.querySelector('.source-editor .cm-content')?.textContent).toBe('port = 5433');
    for (const [name, token] of [
      ['.env', '.tok-comment'],
      ['main.ts', '.tok-keyword'],
    ]) {
      await page.getByRole('button', { name, exact: true }).click();
      await source.click();
      await expect.poll(() => host.querySelector(`.source-editor ${token}`)).not.toBeNull();
    }
    await page.getByRole('button', { name: 'data.bin', exact: true }).click();
    await expect.poll(() => host.querySelector('[role=tab][data-active]')?.textContent).toBe('Preview');
    await expect.element(source).toHaveAttribute('aria-disabled', 'true');
    expect(getComputedStyle(source.element()).opacity).toBe('0.4');
  } finally {
    root.unmount();
    host.remove();
  }
});
