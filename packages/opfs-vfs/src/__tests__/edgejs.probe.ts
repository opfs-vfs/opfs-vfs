import { expect, it } from 'vitest';
import type * as Sdk from '@wasmer/sdk/browser';
import { OpfsVfsWorker } from '../index_internal';
import { OpfsVfsJustBashAdapter } from '../just-bash-adapter';
import { OpfsVfsWasmerAdapter } from '../wasmer-adapter';

it('runs upstream EdgeJS and preserves guest writes after OPFS and sandbox reopen', async () => {
  const sdkUrl = new URL('/dist/index.js', location.origin).href;
  const { Wasmer } = (await import(/* @vite-ignore */ sdkUrl)) as typeof Sdk;
  const wasmer = new Wasmer();
  const volume = `edgejs-probe-${crypto.randomUUID()}.bin`;
  let vfs = new OpfsVfsWorker(volume, { forceLeader: true, bufferMode: 'disk' });
  let sandbox: Sdk.Sandbox | undefined;
  try {
    await vfs.ready;
    const pkg = await wasmer.packages.load('wasmer/edgejs@0.2.0');
    sandbox = await wasmer.sandboxes.create({ packages: [pkg], network: { mode: 'disabled' } });
    let files = new OpfsVfsJustBashAdapter(vfs);
    await files.writeFile('/workspace/input.txt', 'opfs-vfs');
    await files.writeFile('/workspace/deleted.txt', 'delete me');
    await files.writeFile('/workspace/short.txt', 'long original content');
    await files.writeFile('/outside.txt', 'untouched');
    await files.writeFile(
      '/workspace/main.cjs',
      `
      const fs = require('node:fs');
      const source = fs.readFileSync('/workspace/input.txt', 'utf8');
      fs.mkdirSync('/workspace/nested');
      fs.writeFileSync('/workspace/nested/result.txt', 'edgejs:' + source.toUpperCase());
      fs.writeFileSync('/workspace/short.txt', 'x');
      fs.unlinkSync('/workspace/deleted.txt');
      console.log('edgejs:' + source);
    `,
    );
    const adapter = new OpfsVfsWasmerAdapter(vfs);
    await adapter.syncToSandbox(sandbox.fs);
    const output = await sandbox.command(pkg, ['/workspace/main.cjs']).run({ timeoutMs: 60_000 });
    expect(output.exitCode).toBe(0);
    expect(output.stdout.text()).toContain('edgejs:opfs-vfs');
    await adapter.syncFromSandbox(sandbox.fs);
    await vfs.closeVfs();
    await sandbox.close();
    sandbox = undefined;
    vfs = new OpfsVfsWorker(volume, { forceLeader: true, bufferMode: 'disk' });
    await vfs.ready;
    files = new OpfsVfsJustBashAdapter(vfs);
    expect(await files.readFile('/workspace/nested/result.txt')).toBe('edgejs:OPFS-VFS');
    expect(await files.readFile('/workspace/short.txt')).toBe('x');
    expect(await files.exists('/workspace/deleted.txt')).toBe(false);
    expect(await files.readFile('/outside.txt')).toBe('untouched');
    sandbox = await wasmer.sandboxes.create({ packages: [pkg], network: { mode: 'disabled' } });
    await new OpfsVfsWasmerAdapter(vfs).syncToSandbox(sandbox.fs);
    const reopened = await sandbox
      .command(pkg, ['-e', "console.log(require('node:fs').readFileSync('/workspace/nested/result.txt','utf8'))"])
      .run({ timeoutMs: 60_000 });
    expect(reopened.stdout.text().trim()).toBe('edgejs:OPFS-VFS');
    console.log(
      JSON.stringify({
        sdk: '0.14.0',
        guest: pkg.id,
        firstExit: output.exitCode,
        secondExit: reopened.exitCode,
        reopened: reopened.stdout.text().trim(),
      }),
    );
  } finally {
    try {
      await vfs.closeVfs();
    } finally {
      try {
        await sandbox?.close();
      } finally {
        await wasmer.close();
      }
    }
  }
});
