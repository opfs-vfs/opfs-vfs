import { useEffect, useRef, useState } from 'react';
import { getDocument } from 'pdfjs-dist';
import { GlobalWorkerOptions } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PreviewProps } from './FilePreview';

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
    GlobalWorkerOptions.workerSrc = workerUrl;
    const task = getDocument({
      data: file.bytes?.slice() ?? new TextEncoder().encode(file.content),
      isEvalSupported: false,
    });
    void task.promise
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
