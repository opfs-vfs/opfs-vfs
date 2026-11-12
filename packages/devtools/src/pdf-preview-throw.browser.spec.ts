import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test } from 'vitest';
import { FilePreview } from '@opfs-vfs/file-preview';
import { pdfWithPages } from './pdf-fixture.ts';

// Own file: a worker cached by an earlier test would hide the constructor.
test('pdf preview reports a Worker constructor that throws', async () => {
  const RealWorker = window.Worker;
  window.Worker = class {
    constructor() {
      throw new Error('blocked by CSP');
    }
  } as unknown as typeof Worker;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    root.render(createElement(FilePreview, { file: { path: '/c.pdf', content: '', bytes: pdfWithPages('Hi') } }));
    await expect
      .poll(() => host.querySelector('[role="alert"]')?.textContent, { timeout: 15_000 })
      .toMatch(/blocked by CSP.*setPdfWorkerSrc/);
  } finally {
    window.Worker = RealWorker;
    root.unmount();
    host.remove();
  }
});
