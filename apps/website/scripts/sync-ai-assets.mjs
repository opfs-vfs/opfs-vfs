import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = new URL('../', import.meta.url);
await mkdir(new URL('public/ai-assets/wasm', root), { recursive: true });
await cp(new URL('node_modules/@mediapipe/tasks-genai/wasm', root), new URL('public/ai-assets/wasm', root), {
  recursive: true,
});
// MediaPipe uses importScripts; its inference worker must be classic, not an ES module.
await build({
  entryPoints: [fileURLToPath(new URL('src/workers/gemma-runtime.worker.ts', root))],
  outfile: fileURLToPath(new URL('public/ai-assets/gemma-runtime.worker.js', root)),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
});
