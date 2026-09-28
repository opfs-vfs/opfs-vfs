import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = resolve(packageRoot, '../..');
assert.equal(resolve('.'), packageRoot, 'run test:packed from plugin-subscriptions');
const packed = resolve('.packed');
rmSync(packed, { recursive: true, force: true });
mkdirSync(packed, { recursive: true });
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', ...options });
const coreRoot = resolve(packageRoot, '../opfs-vfs');
run('pnpm', ['--filter', '@opfs-vfs/plugin-subscriptions...', 'build'], { cwd: root });
const pack = (cwd) => {
  const { filename } = JSON.parse(
    run('pnpm', ['pack', '--json', '--pack-destination', packed], { cwd, encoding: 'utf8', stdio: 'pipe' }),
  );
  return resolve(packed, filename);
};
const core = pack(coreRoot);
const filename = pack(packageRoot);
assert.deepEqual(
  run('tar', ['-xOzf', resolve(packed, filename), 'package/LICENSE.md'], { stdio: 'pipe' }),
  readFileSync(resolve(root, 'LICENSE.md')),
  'packed license must match the repository license',
);
assert.deepEqual(
  run('tar', ['-xOzf', resolve(packed, filename), 'package/README.md'], { stdio: 'pipe' }),
  readFileSync(resolve(packageRoot, 'README.md')),
  'packed README must match the repository README',
);
writeFileSync(
  resolve(packed, 'package.json'),
  JSON.stringify({ name: 'subscription-packed-check', private: true, type: 'module' }),
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
  resolve(packed, filename),
]);
for (const file of ['packed-consumer.ts', 'packed-consumer-worker.ts', 'packed-consumer-direct-worker.ts'])
  copyFileSync(resolve(packageRoot, 'tests', file), resolve(packed, file));
const examples = resolve(packed, 'examples');
mkdirSync(examples, { recursive: true });
const currentView = resolve(examples, 'current-view.ts');
writeFileSync(
  currentView,
  run('tar', ['-xOzf', resolve(packed, filename), 'package/examples/current-view.ts'], { stdio: 'pipe' }),
);
const snippets = (file, source) => {
  const matches = [...source.matchAll(/```ts(?:[^\n]*)\n([\s\S]*?)```/g)];
  assert(matches.length, `expected TypeScript snippets in ${file}`);
  return matches.map((match, index) => {
    const output = resolve(packed, `docs-${file}-${index}.ts`);
    writeFileSync(output, match[1]);
    return output;
  });
};
const subscriptionApi = readFileSync(resolve(root, 'docs/SUBSCRIPTIONS.md'), 'utf8');
const documentation = [
  ...snippets('readme', readFileSync(resolve(packageRoot, 'README.md'), 'utf8')),
  ...snippets('api', subscriptionApi),
  ...snippets('file-subscriptions', readFileSync(resolve(root, 'docs/specs/file-subscriptions.md'), 'utf8')),
  ...snippets(
    'website-subscriptions',
    readFileSync(resolve(root, 'apps/website/src/content/docs/docs/plugins/subscriptions.md'), 'utf8'),
  ),
];
writeFileSync(
  resolve(packed, 'consumer.ts'),
  "export * from '@opfs-vfs/plugin-subscriptions';\nexport * from '@opfs-vfs/plugin-subscriptions/config';\nexport * from '@opfs-vfs/plugin-subscriptions/client';\nexport * from '@opfs-vfs/opfs-vfs/worker-runtime';\n",
);
run('node', [
  resolve(root, 'node_modules/typescript/bin/tsc'),
  '--ignoreConfig',
  '--noEmit',
  '--strict',
  '--lib',
  'ES2024,WebWorker',
  '--target',
  'ES2024',
  '--module',
  'ESNext',
  '--moduleResolution',
  'bundler',
  resolve(packed, 'consumer.ts'),
  resolve(packed, 'packed-consumer.ts'),
  resolve(packed, 'packed-consumer-worker.ts'),
  resolve(packed, 'packed-consumer-direct-worker.ts'),
  currentView,
  ...documentation,
]);
run(
  'node',
  [
    resolve(packageRoot, 'node_modules/vitest/vitest.mjs'),
    'run',
    '--config',
    'vitest.packed.config.ts',
    'tests/packed-direct.test.ts',
    'tests/packed-worker-follower.test.ts',
  ],
  {
    env: { ...process.env, VITE_PACKED_SUBSCRIPTIONS_CONSUMER: '/.packed/packed-consumer.ts' },
  },
);
