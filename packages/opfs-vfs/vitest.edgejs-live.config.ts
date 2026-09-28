import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config';

const publicDir = fileURLToPath(new URL('../../apps/website/public/', import.meta.url));
if (!existsSync(`${publicDir}/vendor/edgejs/0.2.0-opfs-vfs.1/sdk/pkg/wasmer_sdk_js_bg.wasm`)) {
  throw new Error('Missing compatible EdgeJS host assets. See docs/EDGEJS.md.');
}

export default mergeConfig(
  base,
  defineConfig({
    publicDir,
    test: { include: ['src/__tests__/edgejs-live.probe.ts'], testTimeout: 180_000 },
  }),
);
