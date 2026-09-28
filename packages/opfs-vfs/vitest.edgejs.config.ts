import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config';

export default mergeConfig(
  base,
  defineConfig({
    // Serve the unmodified SDK with its worker and WASM files at their original relative URLs.
    publicDir: fileURLToPath(new URL('../', import.meta.resolve('@wasmer/sdk/browser'))),
    test: { include: ['src/__tests__/edgejs.probe.ts'], testTimeout: 180_000 },
  }),
);
