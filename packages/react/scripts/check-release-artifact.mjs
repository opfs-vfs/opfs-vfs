import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = resolve(packageRoot, '../..');
assert.equal(resolve('.'), packageRoot, 'run check:release-artifact from react');

const reactVersion = process.env.OPFS_VFS_REACT_VERSION;
assert.match(
  reactVersion ?? '',
  /^19\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
  'OPFS_VFS_REACT_VERSION must select an exact React 19 version',
);

const artifactsRoot = resolve(packageRoot, '.release-artifacts');
rmSync(artifactsRoot, { recursive: true, force: true });
mkdirSync(artifactsRoot, { recursive: true });

const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', ...options });
const source = {
  commit: run('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim(),
  dirty: Boolean(run('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim()),
  requestedBrowser: process.env.OPFS_VFS_TEST_BROWSER ?? null,
};
const runtimeExports = [
  'DEFAULT_VOLUME',
  'File',
  'FileContent',
  'Folder',
  'VolumeError',
  'VolumeProvider',
  'useFile',
  'useFileContent',
  'useFolder',
  'usePersistentStorage',
  'useVolume',
  'useVolumeClient',
];
const pack = (cwd) => {
  const { filename } = JSON.parse(
    run('pnpm', ['pack', '--json', '--pack-destination', artifactsRoot], {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
    }),
  );
  return resolve(artifactsRoot, filename);
};
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const packedManifest = (artifact) =>
  JSON.parse(run('tar', ['-xOzf', artifact, 'package/package.json'], { encoding: 'utf8', stdio: 'pipe' }));
const allDependencies = (manifest) => ({
  ...manifest.dependencies,
  ...manifest.optionalDependencies,
  ...manifest.peerDependencies,
});
const files = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = resolve(directory, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  });

run('pnpm', ['--filter', '@opfs-vfs/react...', 'build'], { cwd: root });
const core = pack(resolve(root, 'packages/opfs-vfs'));
const subscriptions = pack(resolve(root, 'packages/plugin-subscriptions'));
const react = pack(packageRoot);
const manifests = {
  core: packedManifest(core),
  subscriptions: packedManifest(subscriptions),
  react: packedManifest(react),
};

assert.equal(manifests.core.name, '@opfs-vfs/opfs-vfs');
assert.equal(manifests.subscriptions.name, '@opfs-vfs/plugin-subscriptions');
assert.equal(manifests.react.name, '@opfs-vfs/react');
assert.equal(Object.hasOwn(manifests.react, 'private'), false);
assert.deepEqual(Object.keys(manifests.react.exports), ['.']);
assert.deepEqual(
  Object.keys(manifests.react.exports['.']).sort((left, right) => left.localeCompare(right)),
  ['import', 'types'],
);
for (const manifest of Object.values(manifests))
  assert(
    Object.values(allDependencies(manifest)).every(
      (range) => typeof range !== 'string' || !range.startsWith('workspace:'),
    ),
    manifest.name + ' packed manifest must not retain a workspace range',
  );
for (const forbidden of ['react', 'react-dom', '@tanstack/react-query', 'react-query', 'crypto'])
  assert.equal(
    Object.hasOwn(allDependencies(manifests.core), forbidden),
    false,
    'core must not publish a ' + forbidden + ' dependency',
  );

const packedFiles = run('tar', ['-tzf', react], { encoding: 'utf8', stdio: 'pipe' }).trim().split('\n');
assert(packedFiles.includes('package/dist/index.js'));
assert(packedFiles.includes('package/dist/index.d.ts'));
assert(
  packedFiles.every((file) => /^(package\/(?:package\.json|LICENSE\.md|README\.md)|package\/dist\/.*)$/.test(file)),
  'React tarball must contain only distribution files and package metadata',
);
assert.deepEqual(
  run('tar', ['-xOzf', react, 'package/LICENSE.md'], { stdio: 'pipe' }),
  readFileSync(resolve(root, 'LICENSE.md')),
  'packed license must match the repository license',
);

const extracted = resolve(artifactsRoot, 'react');
mkdirSync(extracted, { recursive: true });
run('tar', ['-xzf', react, '-C', extracted]);
const bundledSource = files(resolve(extracted, 'package/dist'))
  .filter((file) => file.endsWith('.js') || file.endsWith('.d.ts'))
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n');
assert.doesNotMatch(
  bundledSource,
  /(?:@opfs-vfs\/(?:premium|plugin-encryption)|@tanstack\/react-query|react-query)/,
  'public React distribution must not import premium or query code',
);

const consumer = resolve(artifactsRoot, 'consumer');
writeFileSync(
  resolve(artifactsRoot, 'package.json'),
  JSON.stringify({ name: 'react-release-artifact-check', private: true }),
);
run('npm', [
  'install',
  '--prefix',
  artifactsRoot,
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
  '--package-lock=false',
  core,
  subscriptions,
  react,
  'react@' + reactVersion,
  'react-dom@' + reactVersion,
]);
mkdirSync(consumer, { recursive: true });
writeFileSync(
  resolve(consumer, 'runtime.mjs'),
  [
    "import assert from 'node:assert/strict';",
    "import * as sdk from '@opfs-vfs/react';",
    "import reactManifest from 'react/package.json' with { type: 'json' };",
    "import domManifest from 'react-dom/package.json' with { type: 'json' };",
    'assert.equal(reactManifest.version, process.env.OPFS_VFS_REACT_VERSION);',
    'assert.equal(domManifest.version, process.env.OPFS_VFS_REACT_VERSION);',
    'const compare = (left, right) => left.localeCompare(right);',
    'assert.deepEqual(Object.keys(sdk).sort(compare), ' + JSON.stringify(runtimeExports) + '.sort(compare));',
  ].join('\n'),
);
run('node', [resolve(consumer, 'runtime.mjs')], {
  cwd: artifactsRoot,
  env: { ...process.env, OPFS_VFS_REACT_VERSION: reactVersion },
});

const evidence = {
  source,
  reactVersion,
  artifacts: Object.fromEntries(
    [
      ['core', core],
      ['subscriptions', subscriptions],
      ['react', react],
    ].map(([name, artifact]) => [
      name,
      { name: manifests[name].name, version: manifests[name].version, sha256: sha256(artifact) },
    ]),
  ),
  runtimeExports,
};
writeFileSync(resolve(artifactsRoot, 'release-artifacts.json'), JSON.stringify(evidence, null, 2) + '\n');
