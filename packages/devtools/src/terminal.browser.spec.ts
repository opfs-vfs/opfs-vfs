import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { DebugPanel } from './DebugPanel';

test('terminal scrolls to new output even after scrolling up', async () => {
  await page.viewport(1000, 800);
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
          files: Array.from({ length: 100 }, (_, i) => ({
            path: `/file-${i}.txt`,
            content: 'long wrapped output '.repeat(400),
            modified: 0,
          })),
        },
      ],
    }),
  );
  try {
    const command = page.getByRole('textbox', { name: 'Terminal command' });
    await command.fill('ls');
    await page.getByRole('button', { name: /Run/ }).click();
    const output = host.querySelector<HTMLPreElement>('.terminal-output')!;
    await expect.poll(() => output.textContent).toContain('file-99.txt');
    expect(output.scrollHeight).toBeGreaterThan(output.clientHeight);
    await expect.poll(() => output.scrollHeight - output.clientHeight - output.scrollTop).toBeLessThanOrEqual(1);
    output.scrollTop = 0;
    await command.fill('pwd');
    await page.getByRole('button', { name: /Run/ }).click();
    await expect.poll(() => output.textContent).toContain('/ $ pwd');
    await expect.poll(() => output.scrollHeight - output.clientHeight - output.scrollTop).toBeLessThanOrEqual(1);
    await command.fill('cat file-0.txt');
    await page.getByRole('button', { name: /Run/ }).click();
    await expect.poll(() => output.textContent).toContain('long wrapped output');
    await page.viewport(850, 800);
    await expect.poll(() => output.scrollHeight - output.clientHeight - output.scrollTop).toBeLessThanOrEqual(1);
    await page.getByRole('button', { name: 'Dock left', exact: true }).click();
    await page.getByRole('button', { name: 'terminal', exact: true }).click();
    await expect.poll(() => output.scrollHeight - output.clientHeight - output.scrollTop).toBeLessThanOrEqual(1);
    await page.getByRole('button', { name: 'Close volume explorer' }).click();
    await page.getByRole('button', { name: 'Open OPFS VFS Volume Explorer' }).click();
    const reopened = host.querySelector<HTMLPreElement>('.terminal-output')!;
    await expect.poll(() => reopened.scrollHeight - reopened.clientHeight - reopened.scrollTop).toBeLessThanOrEqual(1);
  } finally {
    root.unmount();
    host.remove();
  }
});
