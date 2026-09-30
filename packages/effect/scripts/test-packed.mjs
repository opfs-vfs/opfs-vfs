import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = resolve(packageRoot, '../..');
assert.equal(resolve('.'), packageRoot, 'run test:packed from effect');
const packed = resolve('.packed');
rmSync(packed, { recursive: true, force: true });
mkdirSync(packed, { recursive: true });
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', ...options });
run('pnpm', ['--filter', '@opfs-vfs/effect...', 'build'], { cwd: root });
const pack = (cwd) => {
  const { filename } = JSON.parse(
    run('pnpm', ['pack', '--json', '--pack-destination', packed], { cwd, encoding: 'utf8', stdio: 'pipe' }),
  );
  return resolve(packed, filename);
};
const core = pack(resolve(packageRoot, '../opfs-vfs'));
const plugins = pack(resolve(packageRoot, '../plugin-subscriptions'));
const effect = pack(packageRoot);
const example = run('tar', ['-xOzf', effect, 'package/examples/direct.ts'], { encoding: 'utf8', stdio: 'pipe' });
const exampleFile = resolve(packed, 'examples/direct.ts');
mkdirSync(resolve(packed, 'examples'));
writeFileSync(exampleFile, example);
writeFileSync(
  resolve(packed, 'package.json'),
  JSON.stringify({ name: 'effect-packed-check', private: true, type: 'module' }),
);
run('npm', [
  'install',
  '--prefix',
  packed,
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
  '--package-lock=false',
  core,
  plugins,
  effect,
]);
run('node', [
  resolve(root, 'node_modules/typescript/bin/tsc'),
  '--ignoreConfig',
  '--noEmit',
  '--skipLibCheck',
  '--strict',
  '--lib',
  'ES2024,WebWorker',
  '--target',
  'ES2024',
  '--module',
  'ESNext',
  '--moduleResolution',
  'bundler',
  exampleFile,
]);
run(
  'node',
  [
    resolve(packageRoot, 'node_modules/vitest/vitest.mjs'),
    'run',
    '--config',
    'vitest.packed.config.ts',
    'src/volume-real.test.ts',
  ],
  {
    env: { ...process.env, VITE_PACKED_EFFECT_EXAMPLE: '/.packed/examples/direct.ts' },
  },
);
