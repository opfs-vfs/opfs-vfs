import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { DebugPanel } from './DebugPanel';
import { DevtoolsSession } from './runtime';
import type { MockVolume } from './mock-state';

test('volume details distinguish unavailable and zero sizes and format large totals', async () => {
  await page.viewport(1000, 800);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const cases = [
    ['workspace.bin', undefined, 'Unavailable'],
    ['empty.bin', 0, '0 B'],
    ['small.bin', 512, '512 B'],
    ['kib.bin', 1024, '1.0 KiB'],
    ['mib.bin', 1024 ** 2, '1.0 MiB'],
    ['gib.bin', 1.5 * 1024 ** 3, '1.5 GiB'],
    ['tib.bin', 1024 ** 4, '1.0 TiB'],
  ] as const;
  root.render(
    createElement(DebugPanel, {
      initialOpen: true,
      initialVolumes: cases.map(([name, storageBytes]) => ({
        name,
        storageBytes,
        state: 'protected' as const,
        connection: 'none' as const,
        files: [],
      })),
    }),
  );
  try {
    for (const [name, bytes, label] of cases) {
      await page.getByRole('combobox', { name: 'Active volume' }).click();
      await page.getByRole('listbox').getByText(name, { exact: true }).click();
      await page.getByRole('button', { name: 'Volume details', exact: true }).click();
      await expect
        .poll(
          () =>
            Array.from(host.querySelectorAll('.volume-details dt')).find((dt) => dt.textContent === 'OPFS volume size')
              ?.nextElementSibling?.textContent,
        )
        .toBe(bytes === undefined ? label : `${label} (${bytes.toLocaleString()} bytes)`);
      await page.getByRole('button', { name: 'Close dialog' }).click();
    }
  } finally {
    root.unmount();
    host.remove();
  }
});

test('Refresh publishes new sizes even if listing fails or the owner disconnects', async () => {
  const session = new DevtoolsSession();
  const volume: MockVolume = {
    name: 'workspace.bin',
    state: 'application',
    connection: 'passive',
    storageBytes: 1024,
    files: [],
  };
  const refresh = vi.spyOn(session, 'refresh').mockResolvedValue([volume]);
  const list = vi.spyOn(session, 'list').mockRejectedValue(new Error('Listing failed'));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  root.render(createElement(DebugPanel, { initialOpen: true, runtime: session }));
  try {
    await expect.poll(() => host.querySelector('[aria-label="Active volume"]')?.textContent).toContain(volume.name);
    refresh.mockResolvedValue([{ ...volume, storageBytes: 2048 }]);
    await page.getByRole('button', { name: 'Refresh discovered volumes' }).click();
    await expect.poll(() => list.mock.calls.length).toBe(1);
    await page.getByRole('button', { name: 'Volume details', exact: true }).click();
    await expect.poll(() => host.querySelector('.volume-details')?.textContent).toContain('2.0 KiB');
    await page.getByRole('button', { name: 'Close dialog' }).click();
    refresh.mockResolvedValue([{ ...volume, connection: 'none', state: 'disconnected', storageBytes: 0 }]);
    await page.getByRole('button', { name: 'Refresh discovered volumes' }).click();
    await page.getByRole('button', { name: 'Volume details', exact: true }).click();
    await expect.poll(() => host.querySelector('.volume-details')?.textContent).toContain('0 B (0 bytes)');
    expect(list).toHaveBeenCalledTimes(1);
  } finally {
    root.unmount();
    host.remove();
    refresh.mockRestore();
    list.mockRestore();
    session.dispose();
  }
});
