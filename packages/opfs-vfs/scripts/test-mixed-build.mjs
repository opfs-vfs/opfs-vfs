import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = resolve(packageRoot, '../..');
const packed = resolve(packageRoot, '.packed');
const legacySource = resolve(packed, 'legacy-src');
const legacy = resolve(packed, 'legacy');
const candidate = resolve(packed, 'candidate');
const legacyRef = process.env.OPFS_VFS_LEGACY_REF ?? 'ba6e48d';
assert.equal(resolve('.'), packageRoot, 'run test:mixed-build from opfs-vfs');

const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', ...options });
const removeWorktree = () => {
  try {
    run('git', ['worktree', 'remove', '--force', legacySource], { cwd: root });
  } catch {
    // The worktree may not have been created yet.
  }
};
const pack = (cwd, destination) => {
  const { filename } = JSON.parse(
    run('pnpm', ['pack', '--json', '--pack-destination', destination], { cwd, encoding: 'utf8', stdio: 'pipe' }),
  );
  return resolve(destination, filename);
};
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const install = (destination, core, subscriptions) => {
  writeFileSync(resolve(destination, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run('npm', [
    'install',
    '--prefix',
    destination,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    core,
    subscriptions,
  ]);
};

removeWorktree();
rmSync(packed, { recursive: true, force: true });
mkdirSync(legacy, { recursive: true });
mkdirSync(candidate, { recursive: true });
try {
  run('git', ['worktree', 'add', '--detach', legacySource, legacyRef], { cwd: root });
  try {
    run('pnpm', ['install', '--frozen-lockfile', '--offline'], { cwd: legacySource });
  } catch {
    run('pnpm', ['install', '--frozen-lockfile'], { cwd: legacySource });
  }

  run('pnpm', ['--filter', '@opfs-vfs/plugin-subscriptions...', 'build'], { cwd: legacySource });
  const legacyCore = pack(resolve(legacySource, 'packages/opfs-vfs'), legacy);
  const legacySubscriptions = pack(resolve(legacySource, 'packages/plugin-subscriptions'), legacy);

  run('pnpm', ['--filter', '@opfs-vfs/plugin-subscriptions...', 'build'], { cwd: root });
  const candidateCore = pack(packageRoot, candidate);
  const candidateSubscriptions = pack(resolve(root, 'packages/plugin-subscriptions'), candidate);

  for (const file of [legacyCore, legacySubscriptions, candidateCore, candidateSubscriptions])
    console.log(`${sha256(file)}  ${file}`);
  console.log(
    `legacy commit: ${run('git', ['rev-parse', 'HEAD'], { cwd: legacySource, encoding: 'utf8', stdio: 'pipe' }).trim()}`,
  );
  console.log(
    `candidate commit: ${run('git', ['describe', '--always', '--dirty', '--abbrev=40'], { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim()}`,
  );

  install(legacy, legacyCore, legacySubscriptions);
  install(candidate, candidateCore, candidateSubscriptions);
  for (const file of ['client.ts', 'worker.ts', 'plain-worker.ts', 'factories.ts']) {
    copyFileSync(resolve(packageRoot, 'tests/mixed-build', file), resolve(legacy, file));
    copyFileSync(resolve(packageRoot, 'tests/mixed-build', file), resolve(candidate, file));
  }

  // The fixtures are templates; typecheck each copy against its own installed artifacts.
  for (const side of [legacy, candidate])
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
      ...['client.ts', 'worker.ts', 'plain-worker.ts', 'factories.ts'].map((file) => resolve(side, file)),
    ]);

  run(
    'node',
    [resolve(packageRoot, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.mixed-build.config.ts'],
    {
      cwd: packageRoot,
      env: {
        ...process.env,
        VITE_MIXED_LEGACY: '/.packed/legacy/',
        VITE_MIXED_CANDIDATE: '/.packed/candidate/',
      },
    },
  );
} finally {
  removeWorktree();
}
