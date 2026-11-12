let workerSrc: string | undefined;

/**
 * Sets the URL of the pdf.js worker script (`pdfjs-dist/build/pdf.worker.min.mjs`) used by PDF previews.
 * Call it once before the first PDF preview when your bundler does not handle
 * `new Worker(new URL('./x.js', import.meta.url), { type: 'module' })` inside dependencies.
 */
export function setPdfWorkerSrc(url: string | URL) {
  workerSrc = String(url);
}

export const pdfWorkerSrc = () => workerSrc;
