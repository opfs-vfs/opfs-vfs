import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { DebugPanel } from './DebugPanel';
import { FileActions, type FileAction } from './FileActions';

test('file action menus portal into the panel and support disabled actions, Escape, and selection', async () => {
  await page.viewport(800, 500);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const actions: FileAction[] = [];
  root.render(
    createElement(FileActions, {
      children: createElement('button', { type: 'button', 'aria-label': 'note.txt' }, 'note.txt'),
      name: '/note.txt',
      directory: false,
      writable: true,
      pasteable: false,
      editable: false,
      onAction: (action) => actions.push(action),
      container: host,
    }),
  );

  try {
    const dropdown = page.getByRole('button', { name: 'Actions for /note.txt', exact: true });
    await dropdown.click();
    const menu = host.querySelector<HTMLElement>('.file-action-menu');
    expect(menu).not.toBeNull();
    expect(host.contains(menu)).toBe(true);
    const disabledEdit = page.getByRole('menuitem', { name: 'Open in editor', exact: true });
    expect(disabledEdit.element().getAttribute('aria-disabled')).toBe('true');
    (disabledEdit.element() as HTMLElement).click();
    expect(actions).toEqual([]);
    await userEvent.keyboard('{Escape}');
    await expect.poll(() => document.activeElement?.getAttribute('aria-label')).toBe('Actions for /note.txt');

    const entry = page.getByRole('button', { name: 'note.txt', exact: true });
    await entry.click({ button: 'right' });
    expect(host.querySelector('.file-action-menu')).not.toBeNull();
    expect(host.contains(host.querySelector('.file-action-menu'))).toBe(true);
    const disabledPaste = page.getByRole('menuitem', { name: 'Paste here', exact: true });
    expect(disabledPaste.element().getAttribute('aria-disabled')).toBe('true');
    (disabledPaste.element() as HTMLElement).click();
    expect(actions).toEqual([]);
    await userEvent.keyboard('{Escape}');
    await expect.poll(() => document.activeElement?.getAttribute('aria-label')).toBe('note.txt');

    await entry.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Open preview', exact: true }).click();
    expect(actions).toEqual(['preview']);
  } finally {
    root.unmount();
    host.remove();
  }
});

test('Escape closes an explorer context menu without closing the explorer', async () => {
  await page.viewport(1200, 900);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  root.render(
    createElement(DebugPanel, {
      initialOpen: true,
      initialVolumes: [
        {
          name: 'workspace.bin',
          state: 'available',
          connection: 'owned',
          files: [{ path: '/note.txt', content: 'note', modified: 0 }],
        },
      ],
    }),
  );
  try {
    const explorer = page.getByRole('dialog', { name: 'OPFS VFS Volume Explorer' });
    await expect.element(explorer).toBeVisible();
    await page.getByRole('button', { name: 'note.txt', exact: true }).click({ button: 'right' });
    const contextAction = page.getByRole('menuitem', { name: 'Open preview', exact: true });
    await expect.element(contextAction).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await expect.poll(() => host.querySelector('[role="menu"]')).toBeNull();
    await expect.element(explorer).toBeVisible();
  } finally {
    root.unmount();
    host.remove();
  }
});
