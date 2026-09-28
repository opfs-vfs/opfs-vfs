import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { DebugPanel } from './DebugPanel';

test('volume menu stays outside its trigger, fits the viewport, and supports keyboard selection', async () => {
  await page.viewport(1000, 800);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const names = [
    'workspace.bin',
    `${'long-volume-name-'.repeat(10)}.bin`,
    ...Array.from({ length: 20 }, (_, i) => `volume-${i}.bin`),
  ];
  root.render(
    createElement(DebugPanel, {
      initialOpen: true,
      initialVolumes: names.map((name) => ({
        name,
        state: 'available' as const,
        connection: 'none' as const,
        files: [],
      })),
    }),
  );
  try {
    const trigger = page.getByRole('combobox', { name: 'Active volume' });
    await trigger.click();
    await page.getByRole('option', { name: 'workspace.bin', exact: true }).click();
    await expect.element(page.getByRole('button', { name: 'Connect to volume', exact: true })).toBeVisible();
    for (const theme of ['dark', 'light']) {
      if (theme === 'light') await page.getByRole('button', { name: 'Toggle panel theme' }).click();
      for (const [width, height] of [
        [1000, 800],
        [390, 800],
        [390, 360],
      ]) {
        await page.viewport(width, height);
        await trigger.click();
        await expect.element(page.getByRole('listbox')).toBeVisible();
        if (height === 800)
          await expect
            .poll(() => document.querySelector('.volume-select-menu')?.getAttribute('data-side'))
            .toBe('bottom');
        const menu = document.querySelector<HTMLElement>('.volume-select-menu')!;
        const bounds = menu.getBoundingClientRect();
        const control = host.querySelector('[role="combobox"]')!.getBoundingClientRect();
        if (menu.dataset.side === 'bottom') expect(bounds.top).toBeGreaterThanOrEqual(control.bottom + 5);
        else expect(bounds.bottom).toBeLessThanOrEqual(control.top - 5);
        expect(bounds.left).toBeGreaterThanOrEqual(0);
        expect(bounds.right).toBeLessThanOrEqual(window.innerWidth);
        expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight);
        expect(menu.scrollWidth).toBeLessThanOrEqual(menu.clientWidth);
        expect(menu.dataset.theme).toBe(theme);
        await expect
          .element(page.getByRole('option', { name: 'workspace.bin', exact: true }))
          .toHaveAccessibleDescription('Closed');
        const viewport = menu.querySelector<HTMLElement>('.volume-select-list')!;
        expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
        await userEvent.keyboard('{Escape}');
        await expect.element(trigger).toHaveAttribute('aria-expanded', 'false');
        expect(document.activeElement).toBe(host.querySelector('[role="combobox"]'));
        await expect.element(page.getByRole('dialog', { name: 'OPFS VFS Volume Explorer' })).toBeVisible();
      }
    }
    await trigger.click();
    await page.getByRole('listbox').getByText(names[1], { exact: true }).click();
    await expect.element(trigger).toHaveTextContent(names[1]);
    await userEvent.keyboard('{ArrowDown}');
    await expect.element(page.getByRole('listbox')).toBeVisible();
    await userEvent.keyboard('{End}');
    await expect.poll(() => document.activeElement?.textContent).toContain(names.at(-1)!);
    await userEvent.keyboard('{Enter}');
    await expect.element(trigger).toHaveTextContent(names.at(-1)!);
    root.render(createElement(DebugPanel, { key: 'empty', initialOpen: true, initialScenario: 'empty' }));
    await expect.element(trigger).toBeDisabled();
    await expect.element(trigger).toHaveTextContent('No volumes discovered');
    root.render(
      createElement(DebugPanel, {
        key: 'missing',
        initialOpen: true,
        initialVolumes: [{ name: 'other.bin', state: 'available', connection: 'none', files: [] }],
      }),
    );
    await expect.element(trigger).toBeEnabled();
    await expect.element(trigger).toHaveTextContent('Select a volume');
  } finally {
    root.unmount();
    host.remove();
  }
});
