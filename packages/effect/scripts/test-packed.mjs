import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = resolve(packageRoot, '../..');
assert.equal(resolve('.'), packageRoot, 'run test:packed from effect');
const packed = resolve(packageRoot, '.packed');
rmSync(packed, { recursive: true, force: true });
mkdirSync(resolve(packed, 'examples'), { recursive: true });
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', ...options });
run('pnpm', ['--filter', '@opfs-vfs/effect...', 'build'], { cwd: root });
const pack = (cwd) => {
  const { filename } = JSON.parse(
    run('pnpm', ['pack', '--json', '--pack-destination', packed], { cwd, encoding: 'utf8', stdio: 'pipe' }),
  );
  return resolve(packed, filename);
};
const core = pack(resolve(packageRoot, '../opfs-vfs'));
const subscriptions = pack(resolve(packageRoot, '../plugin-subscriptions'));
const effect = pack(packageRoot);
const effectRuntime = pack(resolve(packageRoot, 'node_modules/effect'));
const example = (name) =>
  run('tar', ['-xOzf', effect, `package/examples/${name}.ts`], { encoding: 'utf8', stdio: 'pipe' });
const directFile = resolve(packed, 'examples/direct.ts');
const workerFile = resolve(packed, 'examples/worker-session.ts');
writeFileSync(directFile, example('direct'));
writeFileSync(workerFile, example('worker-session'));
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
  subscriptions,
  effect,
  effectRuntime,
]);
for (const file of [directFile, workerFile]) {
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
    file,
  ]);
}
run(
  'node',
  [
    resolve(packageRoot, 'node_modules/vitest/vitest.mjs'),
    'run',
    '--config',
    'vitest.packed.config.ts',
    'src/volume-real.test.ts',
    'tests/packed-worker-session.test.ts',
  ],
  {
    env: { ...process.env, VITE_PACKED_EFFECT_EXAMPLE: '/.packed/examples/direct.ts' },
  },
);
