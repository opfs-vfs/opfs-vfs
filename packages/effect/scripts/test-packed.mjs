import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = resolve(packageRoot, '../..');
assert.equal(resolve('.'), packageRoot, 'run test:packed from effect');
const encryptedMode = process.argv.includes('--encrypted');
assert(
  process.argv.slice(2).every((argument) => argument === '--encrypted'),
  'unsupported test-packed option',
);
let encryptionTarball;
if (encryptedMode) {
  encryptionTarball = process.env.OPFS_VFS_ENCRYPTION_TARBALL;
  const expectedSha = process.env.OPFS_VFS_ENCRYPTION_SHA256?.toLowerCase();
  assert(encryptionTarball && isAbsolute(encryptionTarball), 'OPFS_VFS_ENCRYPTION_TARBALL must be an absolute path');
  assert(expectedSha && /^[a-f0-9]{64}$/.test(expectedSha), 'OPFS_VFS_ENCRYPTION_SHA256 must be a SHA-256 hex digest');
  const actualSha = createHash('sha256').update(readFileSync(encryptionTarball)).digest('hex');
  assert.equal(actualSha, expectedSha, 'encryption candidate SHA-256 did not match');
  const manifest = JSON.parse(
    execFileSync('tar', ['-xOzf', encryptionTarball, 'package/package.json'], { encoding: 'utf8' }),
  );
  assert.equal(manifest.name, '@opfs-vfs/plugin-encryption', 'candidate must be @opfs-vfs/plugin-encryption');
}
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
const filesystemFile = resolve(packed, 'examples/filesystem-save.ts');
const streamFile = resolve(packed, 'examples/filesystem-stream.ts');
const subscriptionsFile = resolve(packed, 'examples/subscriptions.ts');
const reconciledViewFile = resolve(packed, 'examples/reconciled-view.ts');
const encryptedSessionFile = resolve(packed, 'examples/encrypted-session.ts');
const encryptedWorkerFile = resolve(packed, 'examples/encrypted-session.worker.ts');
writeFileSync(directFile, example('direct'));
writeFileSync(workerFile, example('worker-session'));
writeFileSync(filesystemFile, example('filesystem-save'));
writeFileSync(streamFile, example('filesystem-stream'));
writeFileSync(subscriptionsFile, example('subscriptions'));
writeFileSync(reconciledViewFile, example('reconciled-view'));
if (encryptedMode) {
  writeFileSync(encryptedSessionFile, example('encrypted-session'));
  writeFileSync(encryptedWorkerFile, example('encrypted-session.worker'));
}
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
  ...(encryptedMode ? [encryptionTarball] : []),
]);
for (const file of [
  directFile,
  workerFile,
  filesystemFile,
  streamFile,
  subscriptionsFile,
  reconciledViewFile,
  ...(encryptedMode ? [encryptedSessionFile, encryptedWorkerFile] : []),
]) {
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
const runBrowserExamples = (example) =>
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
    { env: { ...process.env, VITE_PACKED_EFFECT_EXAMPLE: example } },
  );
runBrowserExamples('/.packed/examples/direct.ts');
runBrowserExamples('/.packed/examples/filesystem-save.ts');
runBrowserExamples('/.packed/examples/filesystem-stream.ts');
run(
  'node',
  [
    resolve(packageRoot, 'node_modules/vitest/vitest.mjs'),
    'run',
    '--config',
    'vitest.packed.config.ts',
    'tests/packed-subscriptions.test.ts',
  ],
  { env: { ...process.env, VITE_PACKED_EFFECT_SUBSCRIPTIONS_EXAMPLE: '/.packed/examples/subscriptions.ts' } },
);
run(
  'node',
  [
    resolve(packageRoot, 'node_modules/vitest/vitest.mjs'),
    'run',
    '--config',
    'vitest.packed.config.ts',
    'tests/packed-reconciled-view.test.ts',
  ],
  {
    env: {
      ...process.env,
      VITE_PACKED_EFFECT_RECONCILED_VIEW_EXAMPLE: '/.packed/examples/reconciled-view.ts',
    },
  },
);
if (encryptedMode) {
  run(
    'node',
    [
      resolve(packageRoot, 'node_modules/vitest/vitest.mjs'),
      'run',
      '--config',
      'vitest.packed.config.ts',
      'tests/packed-encrypted-session.test.ts',
    ],
    {
      env: {
        ...process.env,
        VITE_PACKED_EFFECT_ENCRYPTED_SESSION: '/.packed/examples/encrypted-session.ts',
      },
    },
  );
}
