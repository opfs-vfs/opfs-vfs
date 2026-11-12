import { useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, PDFWorker } from 'pdfjs-dist';
import type { PreviewProps } from './FilePreview.tsx';
import { pdfWorkerSrc } from './pdf-worker-src.ts';

// The library build replaces this with `new URL('./pdf.worker.js', import.meta.url)` (see vite.config.ts), so dist
// contains the `new Worker(new URL(…, import.meta.url))` pattern that the consumer's bundler resolves and bundles.
declare const __PDF_WORKER_URL__: URL;

const workerFailure = (reason: unknown) =>
  new Error(
    `The PDF worker could not be started${reason instanceof Error && reason.message ? ` (${reason.message})` : ''}. ` +
      'Call setPdfWorkerSrc(url) with the URL of pdfjs-dist/build/pdf.worker.min.mjs to configure it.',
  );

// One PDFWorker is owned here, not by a loading task: a task that owns the worker marks it as being destroyed when it
// is destroyed, and the next getDocument() on the same port then throws.
let shared: { worker: PDFWorker; failed: Promise<never> } | undefined;

// Returns undefined when pdf.js should use its own configuration (setPdfWorkerSrc or the application's settings).
function sharedWorker() {
  const src = pdfWorkerSrc();
  if (src) GlobalWorkerOptions.workerSrc = src;
  if (GlobalWorkerOptions.workerPort || GlobalWorkerOptions.workerSrc) return undefined;
  if (shared) return shared;
  const port = new Worker(__PDF_WORKER_URL__, { type: 'module' });
  const failed = new Promise<never>((_, reject) => {
    const fail = (event: Event) => {
      port.terminate();
      if (shared?.worker === worker) shared = undefined;
      worker.destroy();
      reject(workerFailure((event as ErrorEvent).message ? new Error((event as ErrorEvent).message) : undefined));
    };
    port.addEventListener('error', fail);
    port.addEventListener('messageerror', fail);
  });
  failed.catch(() => {});
  const worker = PDFWorker.create({ port });
  return (shared = { worker, failed });
}

// Adapted from the website's canvas PDF preview. No PDF scripting, annotation links, or HTML insertion.
export default function PdfPreview({ file }: PreviewProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [pages, setPages] = useState(0);
  const [error, setError] = useState('');
  const [rendered, setRendered] = useState(false);
  useEffect(() => {
    setPageNumber(1);
    setPages(0);
  }, [file.path, file.bytes, file.content]);
  useEffect(() => {
    let live = true;
    setRendered(false);
    setError('');
    let own: ReturnType<typeof sharedWorker>;
    try {
      own = sharedWorker();
    } catch (reason) {
      setError(workerFailure(reason).message);
      return;
    }
    const task = getDocument({
      worker: own?.worker,
      data: file.bytes?.slice() ?? new TextEncoder().encode(file.content),
    });
    void Promise.race([task.promise, ...(own ? [own.failed] : [])])
      .then(async (pdf) => {
        if (!live) return;
        setPages(pdf.numPages);
        const page = await pdf.getPage(pageNumber);
        const target = canvas.current;
        if (!live || !target) return;
        const original = page.getViewport({ scale: 1 });
        const scale = Math.min(1.5, Math.sqrt(4_000_000 / (original.width * original.height)));
        const viewport = page.getViewport({ scale });
        target.width = Math.max(1, Math.floor(viewport.width));
        target.height = Math.max(1, Math.floor(viewport.height));
        await page.render({ canvas: target, viewport }).promise;
        if (live) setRendered(true);
      })
      .catch((reason: unknown) => {
        if (live) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      live = false;
      void task.destroy().catch(() => {});
    };
  }, [file.bytes, file.content, pageNumber]);
  return (
    <div className="fp-pdf">
      <div className="fp-pdf-controls">
        <button disabled={pageNumber <= 1 || !rendered} onClick={() => setPageNumber((p) => p - 1)}>
          Previous page
        </button>
        <span>
          Page {pageNumber}
          {pages ? ` of ${pages}` : ''}
        </span>
        <button disabled={pageNumber >= pages || !rendered} onClick={() => setPageNumber((p) => p + 1)}>
          Next page
        </button>
      </div>
      {error ? (
        <p role="alert">{error}</p>
      ) : (
        <>
          <span role="status">{rendered ? '' : 'Rendering PDF…'}</span>
          <canvas ref={canvas} data-rendered={rendered} aria-label={`${file.path}, page ${pageNumber}`} />
        </>
      )}
    </div>
  );
}
