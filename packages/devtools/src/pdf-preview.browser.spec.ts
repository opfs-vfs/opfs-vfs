import { createElement, StrictMode, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { FilePreview } from '@opfs-vfs/file-preview';
import { pdfWithPages } from './pdf-fixture';

const pdf = (path: string, ...texts: string[]) => ({ path, content: '', bytes: pdfWithPages(...texts) });

async function mount(element: (file: ReturnType<typeof pdf>) => ReactElement, first: ReturnType<typeof pdf>) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const show = (file: ReturnType<typeof pdf>) => root.render(element(file));
  show(first);
  return {
    host,
    show,
    done: () => {
      root.unmount();
      host.remove();
    },
  };
}

const canvas = (host: HTMLElement) => host.querySelector('canvas');
const settled = (host: HTMLElement, label: string) => () => {
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(canvas(host)?.getAttribute('data-rendered')).toBe('true');
  expect(canvas(host)?.getAttribute('aria-label')).toContain(label);
};

for (const strict of [false, true]) {
  test(`pdf preview pages and file changes share one worker${strict ? ' under StrictMode' : ''}`, async () => {
    const element = (file: ReturnType<typeof pdf>) => {
      const preview = createElement(FilePreview, { file });
      return strict ? createElement(StrictMode, null, preview) : preview;
    };
    const { host, show, done } = await mount(element, pdf('/two.pdf', 'First', 'Second'));
    try {
      await expect.poll(() => host.textContent, { timeout: 15_000 }).toContain('Page 1 of 2');
      await expect.poll(() => canvas(host)?.getAttribute('data-rendered')).toBe('true');
      await page.getByRole('button', { name: 'Next page' }).click();
      await vi.waitFor(settled(host, 'page 2'), { timeout: 15_000 });
      await page.getByRole('button', { name: 'Previous page' }).click();
      await vi.waitFor(settled(host, 'page 1'), { timeout: 15_000 });
      show(pdf('/other.pdf', 'Other'));
      await vi.waitFor(settled(host, '/other.pdf'), { timeout: 15_000 });
      expect(host.textContent).toContain('Page 1 of 1');
    } finally {
      done();
    }
  });
}
