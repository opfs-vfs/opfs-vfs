import { fileURLToPath } from 'node:url';
import { preview } from 'vite';

const staticDir = fileURLToPath(new URL('../.vercel/output/static', import.meta.url));
const portIndex = process.argv.lastIndexOf('--port');
const hostIndex = process.argv.indexOf('--host');
const port = Number(portIndex < 0 ? 4325 : process.argv[portIndex + 1]);
const host = hostIndex < 0 ? 'localhost' : process.argv[hostIndex + 1];

await preview({
  root: fileURLToPath(new URL('../', import.meta.url)),
  configFile: false,
  build: { outDir: staticDir },
  preview: {
    host,
    port,
    strictPort: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'X-Content-Type-Options': 'nosniff',
    },
  },
});
