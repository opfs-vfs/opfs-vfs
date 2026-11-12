import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// Dependencies and peers stay imports, so consumers' bundlers and lockfiles supply (and patch) them.
const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const packages = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})];

export default defineConfig({
  build: {
    lib: { entry: 'src/index.tsx', formats: ['es'], fileName: 'index', cssFileName: 'styles' },
    rollupOptions: {
      external: (id) => packages.some((name) => id === name || id.startsWith(`${name}/`)),
    },
  },
});
