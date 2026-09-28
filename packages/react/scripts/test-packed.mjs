import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const root = resolve(packageRoot, '../..');
assert.equal(resolve('.'), packageRoot, 'run test:packed from react');
const packed = resolve('.packed');
rmSync(packed, { recursive: true, force: true });
mkdirSync(packed, { recursive: true });
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', ...options });
const pack = (cwd, destination = packed) => {
  const { filename } = JSON.parse(
    run('pnpm', ['pack', '--json', '--pack-destination', destination], { cwd, encoding: 'utf8', stdio: 'pipe' }),
  );
  return resolve(destination, filename);
};
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

run('pnpm', ['--filter', '@opfs-vfs/react...', 'build'], { cwd: root });
const core = pack(resolve(root, 'packages/opfs-vfs'));
const subscriptions = pack(resolve(root, 'packages/plugin-subscriptions'));
const react = pack(packageRoot);
const artifacts = {
  OPFS_VFS_CORE_ARTIFACT: `@opfs-vfs/opfs-vfs@${JSON.parse(run('tar', ['-xOzf', core, 'package/package.json'], { encoding: 'utf8', stdio: 'pipe' })).version}:${sha256(core)}`,
  OPFS_VFS_SUBSCRIPTIONS_ARTIFACT: `@opfs-vfs/plugin-subscriptions@${JSON.parse(run('tar', ['-xOzf', subscriptions, 'package/package.json'], { encoding: 'utf8', stdio: 'pipe' })).version}:${sha256(subscriptions)}`,
  OPFS_VFS_REACT_ARTIFACT: `@opfs-vfs/react@${JSON.parse(run('tar', ['-xOzf', react, 'package/package.json'], { encoding: 'utf8', stdio: 'pipe' })).version}:${sha256(react)}`,
};
assert.deepEqual(
  run('tar', ['-xOzf', react, 'package/LICENSE.md'], { stdio: 'pipe' }),
  readFileSync(resolve(root, 'LICENSE.md')),
  'packed license must match the repository license',
);
const files = run('tar', ['-tzf', react], { encoding: 'utf8', stdio: 'pipe' }).trim().split('\n');
assert(files.includes('package/dist/index.js'));
assert(files.includes('package/dist/index.d.ts'));
assert(files.includes('package/README.md'));
assert(files.every((file) => /^(package\/(?:package\.json|LICENSE\.md|README\.md)|package\/dist\/.*)$/.test(file)));
const manifest = JSON.parse(run('tar', ['-xOzf', react, 'package/package.json'], { encoding: 'utf8', stdio: 'pipe' }));
assert.equal(Object.hasOwn(manifest, 'private'), false);
assert(Object.values(manifest.peerDependencies).every((range) => !range.startsWith('workspace:')));

writeFileSync(
  resolve(packed, 'package.json'),
  JSON.stringify({ name: 'react-packed-check', private: true, type: 'module' }),
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
  react,
  'react@19.2.4',
  'react-dom@19.2.4',
  '@types/react@19.2.14',
]);
writeFileSync(
  resolve(packed, 'server.mjs'),
  "import { createElement } from 'react';\nimport { renderToString } from 'react-dom/server';\nimport { VolumeProvider, usePersistentStorage } from '@opfs-vfs/react';\nfunction StorageStatus() { return createElement('p', null, usePersistentStorage().status); }\nconst html = renderToString(createElement('div', null, createElement(VolumeProvider, { fileName: 'packed.bin', worker: () => { throw new Error('not opened on the server'); } }, (volume) => createElement('p', null, volume.status)), createElement(StorageStatus)));\nif (!html.includes('pending') || !html.includes('checking')) throw new Error(`expected pending and checking markup, got ${html}`);\n",
);
run('node', [resolve(packed, 'server.mjs')]);
writeFileSync(
  resolve(packed, 'consumer.tsx'),
  "import type { OpfsVfsWorker } from '@opfs-vfs/opfs-vfs/worker';\nimport { DEFAULT_VOLUME, VolumeError, VolumeProvider, usePersistentStorage, useVolume, useVolumeClient } from '@opfs-vfs/react';\nconst worker = () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });\nconst client = null as unknown as OpfsVfsWorker;\nfunction Managed() { const volume = useVolume(DEFAULT_VOLUME); const fs = useVolumeClient(); const storage = usePersistentStorage(); void volume; void fs; void storage; return <VolumeProvider fileName=\"packed.bin\" worker={worker} persistentStorage=\"request-on-mount\">{null}</VolumeProvider>; }\nfunction Borrowed() { const volume = useVolume(); const fs = useVolumeClient(); const error: VolumeError | null = null; void volume; void fs; void error; return <VolumeProvider client={client}>{null}</VolumeProvider>; }\n// @ts-expect-error Providers cannot mix managed and borrowed props.\n<VolumeProvider fileName=\"packed.bin\" worker={worker} client={client}>{null}</VolumeProvider>;\nvoid Managed; void Borrowed;\n",
);
run('node', [
  resolve(root, 'node_modules/typescript/bin/tsc'),
  '--ignoreConfig',
  '--noEmit',
  '--strict',
  '--jsx',
  'react-jsx',
  '--module',
  'esnext',
  '--moduleResolution',
  'bundler',
  '--target',
  'es2024',
  '--lib',
  'es2024,dom',
  '--skipLibCheck',
  resolve(packed, 'consumer.tsx'),
]);
const fixtures = resolve(packed, 'fixtures');
cpSync(resolve(packageRoot, 'fixtures'), fixtures, { recursive: true });
run('npm', [
  'install',
  '--prefix',
  packed,
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
  '--package-lock=false',
  'vite@8.3.1',
  '@vitejs/plugin-react@6.1.1',
  'webpack@5.111.1',
  'webpack-cli@7.2.3',
  'webpack-dev-server@6.0.0',
  'html-webpack-plugin@5.6.8',
  'ts-loader@9.6.2',
  'typescript@5.9.3',
  'next@16.3.6',
]);
const fixtureEnv = {
  ...process.env,
  ...artifacts,
  ...Object.fromEntries(Object.entries(artifacts).map(([key, value]) => [`NEXT_PUBLIC_${key}`, value])),
};
const binary = (name) => resolve(packed, 'node_modules/.bin', name);
const legacyRef = 'ba6e48df536d87bef0a28f2298a6cabbe6a8799c';
const legacySource = resolve(packed, 'legacy-source');
const legacyArchive = resolve(packed, 'legacy-source.tar');
const legacyArtifacts = resolve(packed, 'legacy-artifacts');
writeFileSync(
  legacyArchive,
  execFileSync('git', ['archive', '--format=tar', legacyRef], { cwd: root, maxBuffer: 64 * 1024 * 1024 }),
);
mkdirSync(legacySource, { recursive: true });
mkdirSync(legacyArtifacts, { recursive: true });
run('tar', ['-xf', legacyArchive, '-C', legacySource]);
run('pnpm', ['install', '--frozen-lockfile'], { cwd: legacySource });
run('pnpm', ['--filter', '@opfs-vfs/opfs-vfs', '--filter', '@opfs-vfs/plugin-subscriptions', 'build'], {
  cwd: legacySource,
});
const legacyCore = pack(resolve(legacySource, 'packages/opfs-vfs'), legacyArtifacts);
const legacySubscriptions = pack(resolve(legacySource, 'packages/plugin-subscriptions'), legacyArtifacts);
const legacy = resolve(packed, 'legacy');
run('npm', [
  'install',
  '--prefix',
  legacy,
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
  '--package-lock=false',
  legacyCore,
  legacySubscriptions,
]);
fixtureEnv.OPFS_VFS_LEGACY_ROOT = resolve(legacy, 'node_modules');
run(binary('vite'), ['build', '--config', 'legacy-worker.config.mjs'], {
  cwd: resolve(fixtures, 'vite'),
  env: fixtureEnv,
});
const legacyWorker = resolve(fixtures, 'vite/dist-legacy/legacy-worker.js');
mkdirSync(resolve(fixtures, 'next/public'), { recursive: true });
copyFileSync(legacyWorker, resolve(fixtures, 'next/public/legacy-worker.js'));
run(binary('vite'), ['build'], { cwd: resolve(fixtures, 'vite'), env: fixtureEnv });
run(binary('webpack'), ['--config', 'webpack.config.mjs'], { cwd: resolve(fixtures, 'webpack'), env: fixtureEnv });
copyFileSync(legacyWorker, resolve(fixtures, 'vite/dist/legacy-worker.js'));
mkdirSync(resolve(fixtures, 'webpack/public'), { recursive: true });
copyFileSync(legacyWorker, resolve(fixtures, 'webpack/public/legacy-worker.js'));
run(binary('next'), ['build'], { cwd: resolve(fixtures, 'next'), env: fixtureEnv });
for (const fixture of ['vite', 'webpack', 'next']) {
  const packageJson = resolve(
    packed,
    'node_modules',
    '@opfs-vfs',
    fixture === 'next' ? 'react' : 'opfs-vfs',
    'package.json',
  );
  assert.equal(JSON.parse(readFileSync(packageJson, 'utf8')).name.startsWith('@opfs-vfs/'), true);
}
const installed = Object.fromEntries(
  ['opfs-vfs', 'plugin-subscriptions', 'react'].map((name) => {
    const manifestPath = realpathSync(resolve(packed, 'node_modules/@opfs-vfs', name, 'package.json'));
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return [name, { path: manifestPath, version: manifest.version, sha256: sha256(manifestPath) }];
  }),
);
for (const [name, expected] of Object.entries({
  react: realpathSync(resolve(packed, 'node_modules/react/package.json')),
  '@opfs-vfs/opfs-vfs': installed['opfs-vfs'].path,
  '@opfs-vfs/plugin-subscriptions': installed['plugin-subscriptions'].path,
  '@opfs-vfs/react': installed.react.path,
})) {
  const copies = run(
    'find',
    [resolve(packed, 'node_modules'), '-path', `*/node_modules/${name}/package.json`, '-type', 'f'],
    {
      encoding: 'utf8',
      stdio: 'pipe',
    },
  )
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((file) => realpathSync(file));
  assert.deepEqual(copies, [expected], `expected one resolved ${name} copy`);
}
assert.equal(installed['opfs-vfs'].version, artifacts.OPFS_VFS_CORE_ARTIFACT.split('@')[2].split(':')[0]);
assert.equal(
  installed['plugin-subscriptions'].version,
  artifacts.OPFS_VFS_SUBSCRIPTIONS_ARTIFACT.split('@')[2].split(':')[0],
);
assert.equal(installed.react.version, artifacts.OPFS_VFS_REACT_ARTIFACT.split('@')[2].split(':')[0]);
writeFileSync(resolve(packed, 'installed-artifacts.json'), `${JSON.stringify({ artifacts, installed }, null, 2)}\n`);
const maps = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = resolve(directory, entry.name);
    return entry.isDirectory()
      ? maps(file)
      : entry.name.endsWith('.map')
        ? [{ file, map: JSON.parse(readFileSync(file, 'utf8')) }]
        : [];
  });
const selectedMaps = (directory, entry) => {
  const available = maps(directory).filter(
    ({ file }) => !directory.endsWith('/next/.next') || file.includes('/.next/static/'),
  );
  const byFile = new Map(available.map((record) => [record.file, record]));
  const selected = available.filter(({ map }) => map.sources?.some((source) => source.endsWith(entry)));
  assert.equal(selected.length, 1, `${directory} must have one source map for ${entry}`);
  for (let index = 0; index < selected.length; index += 1) {
    const chunkFile = selected[index].file.slice(0, -4);
    if (!existsSync(chunkFile)) continue;
    const chunk = readFileSync(chunkFile, 'utf8');
    // webpack's worker bootstrap records its startup chunk dependencies here (77 -> 861 in this fixture).
    for (const [, ids] of chunk.matchAll(/\.O\(void 0,\[([0-9]+(?:,[0-9]+)*)\]/g))
      for (const id of ids.split(',')) {
        const dependency = byFile.get(resolve(selected[index].file, '..', `${id}.js.map`));
        if (dependency && !selected.includes(dependency)) selected.push(dependency);
      }
  }
  return selected;
};
const packageSource = (source) => {
  const match = source.match(/node_modules\/(?:@opfs-vfs\/)?(?:opfs-vfs|plugin-subscriptions|react)\/dist\/[^?#]+/);
  return match?.[0].replace(/^node_modules\//, '') ?? null;
};
const packedArtifact = {
  '@opfs-vfs/opfs-vfs': core,
  '@opfs-vfs/plugin-subscriptions': subscriptions,
  '@opfs-vfs/react': react,
};
const assertSourceIdentity = (source, contents) => {
  const installedPath = packageSource(source);
  assert(installedPath, `expected an installed package source, got ${source}`);
  const [scope, name] = installedPath.split('/');
  const packageName = `${scope}/${name}`;
  const distPath = installedPath.split('/').slice(2).join('/');
  const bytes = Buffer.from(contents);
  assert.deepEqual(
    bytes,
    readFileSync(resolve(packed, 'node_modules', installedPath)),
    `${source} must match its installed file`,
  );
  assert.deepEqual(
    bytes,
    run('tar', ['-xOzf', packedArtifact[packageName], `package/${distPath}`], { stdio: 'pipe' }),
    `${source} must match its packed file`,
  );
  return installedPath;
};
const assertBundle = (directory, entry, packages) => {
  const sources = selectedMaps(directory, entry).flatMap(({ map }) =>
    (map.sources ?? []).map((source, index) => ({ source, contents: map.sourcesContent?.[index] })),
  );
  const relevant = sources.filter(({ source }) => packageSource(source));
  assert(relevant.length, `${entry} must include installed package source maps`);
  for (const packageName of packages)
    assert(
      relevant.some(({ source }) => packageSource(source)?.startsWith(`${packageName}/`)),
      `${entry} must resolve ${packageName}`,
    );
  const files = relevant.map(({ source, contents }) => {
    assert.equal(typeof contents, 'string', `${source} must include source content`);
    return assertSourceIdentity(source, contents);
  });
  assert(
    !sources.some(({ source }) => source.includes('/packages/react/src/')),
    `${entry} must not use the workspace React SDK source`,
  );
  return [...new Set(files)].sort((left, right) => left.localeCompare(right));
};
const bundleModules = {
  vite: {
    page: assertBundle(resolve(fixtures, 'vite/dist'), 'src/main.tsx', [
      '@opfs-vfs/react',
      '@opfs-vfs/opfs-vfs',
      '@opfs-vfs/plugin-subscriptions',
    ]),
    worker: assertBundle(resolve(fixtures, 'vite/dist'), 'src/vfs.worker.ts', [
      '@opfs-vfs/opfs-vfs',
      '@opfs-vfs/plugin-subscriptions',
    ]),
  },
  webpack: {
    page: assertBundle(resolve(fixtures, 'webpack/dist'), 'src/index.tsx', [
      '@opfs-vfs/react',
      '@opfs-vfs/opfs-vfs',
      '@opfs-vfs/plugin-subscriptions',
    ]),
    worker: assertBundle(resolve(fixtures, 'webpack/dist'), 'src/vfs.worker.ts', [
      '@opfs-vfs/opfs-vfs',
      '@opfs-vfs/plugin-subscriptions',
    ]),
  },
  next: {
    page: assertBundle(resolve(fixtures, 'next/.next'), 'app/client.tsx', [
      '@opfs-vfs/react',
      '@opfs-vfs/opfs-vfs',
      '@opfs-vfs/plugin-subscriptions',
    ]),
    worker: assertBundle(resolve(fixtures, 'next/.next'), 'app/vfs.worker.ts', [
      '@opfs-vfs/opfs-vfs',
      '@opfs-vfs/plugin-subscriptions',
    ]),
  },
};
const identitySource = selectedMaps(resolve(fixtures, 'vite/dist'), 'src/vfs.worker.ts')[0].map;
const identityIndex = identitySource.sources.findIndex((source) => packageSource(source));
const mismatched = { ...identitySource, sourcesContent: [...identitySource.sourcesContent] };
mismatched.sourcesContent[identityIndex] = 'mismatch';
assert.throws(() => assertSourceIdentity(mismatched.sources[identityIndex], mismatched.sourcesContent[identityIndex]));
writeFileSync(
  resolve(packed, 'bundle-artifacts.json'),
  `${JSON.stringify(
    {
      installed,
      legacy: {
        ref: legacyRef,
        core: sha256(legacyCore),
        subscriptions: sha256(legacySubscriptions),
      },
      bundleModules,
    },
    null,
    2,
  )}\n`,
);

const servers = [];
const waitFor = async (url) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // The child process is still starting.
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
};
const start = (command, args, cwd, port) => {
  const child = spawn(command, args, { cwd, env: fixtureEnv, stdio: 'inherit' });
  servers.push(child);
  return waitFor(`http://127.0.0.1:${port}/`);
};
try {
  for (const response of await Promise.all([
    start(binary('vite'), ['preview', '--host', '127.0.0.1', '--port', '4173'], resolve(fixtures, 'vite'), 4173),
    start(
      binary('webpack'),
      ['serve', '--config', 'webpack.config.mjs', '--port', '4174'],
      resolve(fixtures, 'webpack'),
      4174,
    ),
    start(binary('next'), ['start', '--hostname', '127.0.0.1', '--port', '4175'], resolve(fixtures, 'next'), 4175),
  ])) {
    assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(response.headers.get('cross-origin-embedder-policy'), 'require-corp');
  }
  const nextHtml = await (await fetch('http://127.0.0.1:4175/')).text();
  assert.match(nextHtml, /data-page-artifact/, 'Next must render the client component on the server');

  // The orchestration wrapper owns any shared browser lock; this package check stays portable.
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    for (const port of [4173, 4174, 4175]) {
      const page = await browser.newPage();
      const diagnostics = [];
      page.on('console', (message) => diagnostics.push(`console ${message.type()}: ${message.text()}`));
      page.on('pageerror', (error) => diagnostics.push(`pageerror: ${error.message}`));
      await page.goto(`http://127.0.0.1:${port}/`);
      const main = page.locator('main');
      if ((await main.count()) !== 1) throw new Error(`Fixture ${port} did not hydrate: ${await page.content()}`);
      await page.waitForFunction(() => document.querySelector('main')?.dataset.workerArtifact !== '{}');
      await page.waitForFunction(
        () => document.querySelector('[data-consumer]')?.getAttribute('data-consumer') === 'passed',
      );
      await page.waitForFunction(
        () => document.querySelector('[data-consumer]')?.getAttribute('data-live') === 'packed consumer',
      );
      try {
        await page.waitForFunction(
          () => document.querySelector('[data-mismatch]')?.getAttribute('data-mismatch') !== 'pending',
        );
      } catch (error) {
        const state = await page.locator('[data-mismatch]').getAttribute('data-mismatch');
        const resources = await page.evaluate(() =>
          performance
            .getEntriesByType('resource')
            .map((entry) => entry.name)
            .filter((name) => name.includes('legacy-worker')),
        );
        throw new Error(`Fixture ${port} mismatch state ${state}; ${diagnostics.join('\n')}; ${resources.join('\n')}`, {
          cause: error,
        });
      }
      const mismatch = await page.locator('[data-mismatch]').getAttribute('data-mismatch');
      if (mismatch !== 'VFS_PROTOCOL_MISMATCH') {
        const resources = await page.evaluate(() =>
          performance
            .getEntriesByType('resource')
            .map((entry) => entry.name)
            .filter((name) => name.includes('legacy-worker')),
        );
        throw new Error(`Fixture ${port} mismatch ${mismatch}; ${diagnostics.join('\n')}; ${resources.join('\n')}`);
      }
      const pageArtifact = await main.getAttribute('data-page-artifact');
      const workerArtifact = await main.getAttribute('data-worker-artifact');
      assert.deepEqual(JSON.parse(workerArtifact), JSON.parse(pageArtifact));
      await page.close();
    }
  } finally {
    await browser.close();
  }
} finally {
  for (const server of servers) server.kill();
}
