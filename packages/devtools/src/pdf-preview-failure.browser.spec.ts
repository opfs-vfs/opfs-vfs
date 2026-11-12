import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test } from 'vitest';
import { FilePreview } from '@opfs-vfs/file-preview';
import { pdfWithPages } from './pdf-fixture';

// Own file: the shared pdf.js worker is cached per module instance, and each spec file gets a fresh page.
test('pdf preview reports a worker that cannot start and retries with a new worker', async () => {
  const RealWorker = window.Worker;
  const terminated: unknown[] = [];
  class BrokenWorker extends EventTarget {
    constructor() {
      super();
      setTimeout(() => this.dispatchEvent(new Event('error')), 0);
    }
    terminate() {
      terminated.push(this);
    }
    postMessage() {}
  }
  window.Worker = BrokenWorker as unknown as typeof Worker;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const file = (path: string) => ({ path, content: '', bytes: pdfWithPages('Hello') });
  try {
    root.render(createElement(FilePreview, { file: file('/a.pdf') }));
    await expect
      .poll(() => host.querySelector('[role="alert"]')?.textContent, { timeout: 15_000 })
      .toMatch(/PDF worker could not be started.*setPdfWorkerSrc/);
    expect(terminated).toHaveLength(1);
    window.Worker = RealWorker;
    root.render(createElement(FilePreview, { file: file('/b.pdf') }));
    await expect
      .poll(() => host.querySelector('canvas')?.getAttribute('data-rendered'), { timeout: 15_000 })
      .toBe('true');
    expect(host.querySelector('[role="alert"]')).toBeNull();
  } finally {
    window.Worker = RealWorker;
    root.unmount();
    host.remove();
  }
});
