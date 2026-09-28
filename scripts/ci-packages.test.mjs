import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

await test('affected packages include consumers and fall back to full coverage for shared or unknown changes', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'opfs-ci-'));
  const script = fileURLToPath(new URL('./ci-packages.mjs', import.meta.url));
  const run = (command, args, env = {}) =>
    execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const git = (...args) => run('git', args);
  const write = (path, text = 'changed\n') => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), text);
  };
  const commit = () => {
    git('add', '.');
    git('commit', '-qm', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  const selected = (base = '') => JSON.parse(run(process.execPath, [script], { BASE_SHA: base }));
  const core = '@opfs-vfs/opfs-vfs';
  const subscriptions = '@opfs-vfs/plugin-subscriptions';
  const react = '@opfs-vfs/react';
  const preview = '@opfs-vfs/file-preview';
  const devtools = '@opfs-vfs/devtools';
  const website = '@opfs-vfs/website';
  const all = [core, subscriptions, react, preview, devtools, website].sort();
  try {
    git('init', '-q', '--initial-branch=main');
    git('config', 'user.name', 'CI test');
    git('config', 'user.email', 'ci@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    write('package.json', JSON.stringify({ private: true, packageManager: 'pnpm@12.4.2' }));
    write('pnpm-workspace.yaml', 'packages:\n  - packages/*\n  - apps/*\n');
    for (const path of [
      'packages/opfs-vfs',
      'packages/plugin-subscriptions',
      'packages/react',
      'packages/file-preview',
      'packages/devtools',
      'apps/website',
    ]) {
      const manifest = JSON.parse(readFileSync(new URL(`../${path}/package.json`, import.meta.url), 'utf8'));
      const dependencies = Object.fromEntries(
        Object.entries({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies }).filter(
          ([, version]) => version.startsWith('workspace:'),
        ),
      );
      write(`${path}/package.json`, JSON.stringify({ name: manifest.name, version: '1.0.0', dependencies }));
      write(`${path}/source.ts`, 'original\n');
    }
    run('pnpm', ['install', '--lockfile-only', '--ignore-scripts']);
    const base = commit();
    assert.deepEqual(selected(), all);
    assert.deepEqual(selected('missing-base'), all);
    assert.deepEqual(selected(base), []);
    for (const [path, expected] of [
      ['packages/opfs-vfs/source.ts', [core, subscriptions, react, devtools, website]],
      ['packages/plugin-subscriptions/source.ts', [subscriptions, react, website]],
      ['packages/react/source.ts', [react, website]],
      ['packages/file-preview/source.ts', [preview, devtools, website]],
      ['packages/devtools/source.ts', [devtools, website]],
      ['apps/website/source.ts', [website]],
      ['apps/website/src/content/docs/example.md', [website]],
      ['README.md', []],
      ['LICENSE.md', all],
      ['docs/guide.md', []],
      ['.changeset/example.md', []],
      ['pnpm-lock.yaml', all],
      ['.github/workflows/ci.yml', all],
      ['patches/fix.patch', all],
      ['unknown/source.ts', all],
    ]) {
      git('reset', '--hard', base);
      write(path, path === 'pnpm-lock.yaml' ? `${readFileSync(join(cwd, path), 'utf8')}\n# changed\n` : 'changed\n');
      commit();
      assert.deepEqual(selected(base), expected.sort(), path);
    }
    git('reset', '--hard', base);
    git('rm', 'packages/opfs-vfs/source.ts');
    commit();
    assert.deepEqual(selected(base), [core, subscriptions, react, devtools, website].sort(), 'deleted source');
    git('reset', '--hard', base);
    rmSync(join(cwd, 'packages/opfs-vfs'), { recursive: true });
    commit();
    assert.deepEqual(selected(base), [subscriptions, react, preview, devtools, website].sort(), 'deleted package');
    git('reset', '--hard', base);
    write('packages/added/package.json', JSON.stringify({ name: '@opfs-vfs/added', version: '1.0.0' }));
    commit();
    assert.deepEqual(selected(base), [...all, '@opfs-vfs/added'].sort(), 'new package');
    git('reset', '--hard', base);
    git('mv', 'packages/opfs-vfs', 'packages/renamed');
    commit();
    assert.deepEqual(selected(base), all, 'renamed package');
    git('reset', '--hard', base);
    write('packages/opfs-vfs/source.ts');
    const stackedBase = commit();
    write('apps/website/source.ts');
    commit();
    assert.deepEqual(selected(stackedBase), [website], 'use actual stack base, not main');
    assert.deepEqual(
      selected(base),
      [core, subscriptions, react, devtools, website].sort(),
      'include lower layer when compared with main',
    );
    const pnpm = run('which', ['pnpm']);
    const shim = join(cwd, '.test-bin/pnpm');
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    for (const response of [
      '[]',
      JSON.stringify([
        ...all.map((name) => ({ name, path: join(cwd, 'packages/selected') })),
        { name: '@opfs-vfs/unknown', path: join(cwd, 'packages/unknown') },
      ]),
      JSON.stringify([{ name: website, path: join(cwd, 'apps/website') }]),
      'not JSON',
    ]) {
      write(
        '.test-bin/pnpm',
        `#!/bin/sh\nif [ "$1" = '--filter' ]; then\nprintf '%s' ${quote(response)}\nelse\nexec ${quote(pnpm)} "$@"\nfi\n`,
      );
      chmodSync(shim, 0o755);
      assert.deepEqual(
        JSON.parse(run(process.execPath, [script], { BASE_SHA: base, PATH: `${dirname(shim)}:${process.env.PATH}` })),
        all,
        `unsafe pnpm selection: ${response}`,
      );
    }
    write('.test-bin/pnpm', "#!/bin/sh\nprintf '[]'\n");
    assert.throws(
      () => run(process.execPath, [script], { PATH: `${dirname(shim)}:${process.env.PATH}` }),
      /No workspace packages/,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
