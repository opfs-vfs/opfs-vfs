import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    lib: {
      entry: {
        index: 'src/index.ts',
        worker: 'src/index_internal.ts',
        pglite: 'src/adapter.ts',
        duckdb: 'src/duckdb-adapter.ts',
        'just-bash': 'src/just-bash-adapter.ts',
        wasmer: 'src/wasmer-adapter.ts',
        'wasmer-sync': 'src/wasmer-sync-adapter.ts',
        storage: 'src/storage.ts',
        plugins: 'src/plugins.ts',
        changes: 'src/changes.ts',
        'worker-client': 'src/worker-client.ts',
        'worker-runtime': 'src/worker-runtime.ts',
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: ['@electric-sql/pglite', '@electric-sql/pglite/basefs'],
    },
    outDir: 'dist',
    emptyOutDir: true,
  },
  worker: {
    format: 'es',
    // Inline workers have no base URL for relative imports; bundle every chunk.
    rollupOptions: {
      output: {
        codeSplitting: false,
      },
    },
  },
});
