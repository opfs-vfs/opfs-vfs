import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

// Dependencies and peers stay imports, so consumers' bundlers and lockfiles supply (and patch) them.
const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const packages = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})];
const external = (id: string) => packages.some((name) => id === name || id.startsWith(`${name}/`));

// Vite would bundle `new Worker(new URL(…))` here and emit a root-relative path the consumer cannot resolve. Emit the
// standard pattern after bundling instead; the consumer's bundler then bundles dist/pdf.worker.js and its pdf.js import.
const pdfWorkerUrl = (): Plugin => ({
  name: 'file-preview-pdf-worker-url',
  renderChunk(code) {
    if (!code.includes('__PDF_WORKER_URL__')) return null;
    return code.replaceAll('__PDF_WORKER_URL__', 'new URL("./pdf.worker.js", import.meta.url)');
  },
});

export default defineConfig({
  plugins: [pdfWorkerUrl()],
  build: {
    lib: {
      entry: { index: 'src/index.ts', 'pdf.worker': 'src/pdf.worker.ts' },
      formats: ['es'],
      fileName: (_format, name) => `${name}.js`,
      cssFileName: 'styles',
    },
    rollupOptions: { external },
  },
});
