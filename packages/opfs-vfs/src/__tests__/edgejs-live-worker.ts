import { OpfsVfs, OpenFlags } from '../opfs-vfs';
import { createWasmerFileSystem } from '../wasmer-sync-adapter';
import type * as Sdk from '../../../../apps/website/public/vendor/edgejs/0.2.0-opfs-vfs.1/sdk/dist/index.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function read(vfs: OpfsVfs, path: string) {
  const fd = vfs.openSync(path);
  try {
    return decoder.decode(vfs.readSync(fd, vfs.fstatSync(fd).size).buffer);
  } finally {
    vfs.closeSync(fd);
  }
}
function write(vfs: OpfsVfs, path: string, value: string) {
  const fd = vfs.openSync(path, OpenFlags.O_RDWR | OpenFlags.O_CREAT | OpenFlags.O_TRUNC);
  try {
    vfs.writeSync(fd, encoder.encode(value));
    vfs.fsyncSync(fd);
  } finally {
    vfs.closeSync(fd);
  }
}

self.onmessage = async ({ data: name }: MessageEvent<string>) => {
  try {
    const url = new URL('/vendor/edgejs/0.2.0-opfs-vfs.1/sdk/dist/index.js', location.origin).href;
    const { Wasmer, SYNC_FILESYSTEM_ABI } = (await import(/* @vite-ignore */ url)) as typeof Sdk;
    if (SYNC_FILESYSTEM_ABI !== 1) throw new Error('Incompatible synchronous filesystem host');
    let vfs = new OpfsVfs(name, { bufferMode: 'disk' });
    await vfs.ready;
    write(vfs, '/input.txt', 'seed');
    const provider = createWasmerFileSystem(vfs);
    const descriptors = new Map<number, string>();
    let live = '';
    const fs: Sdk.SyncFileSystem = {
      ...provider,
      metadata(path) {
        if (path === '/io-error') throw Object.assign(new Error('Injected metadata error'), { code: 'EIO' });
        return provider.metadata(path);
      },
      open(path, options) {
        const fd = provider.open(path, options);
        descriptors.set(fd, path);
        return fd;
      },
      close(fd) {
        provider.close(fd);
        descriptors.delete(fd);
      },
      write(fd, bytes) {
        const count = provider.write(fd, bytes);
        if (descriptors.get(fd) === '/output.txt') {
          live = read(vfs, '/output.txt');
          write(vfs, '/input.txt', 'HOST-UPDATED-LONGER');
        }
        return count;
      },
    };
    let client = new Wasmer();
    let pkg = await client.packages.load('wasmer/edgejs@0.2.0');
    let sandbox = await client.sandboxes.create({
      packages: [pkg],
      network: { mode: 'disabled' },
      syncMounts: [{ path: '/data', fs }],
    });
    const program = `
const fs = require('node:fs'), assert = require('node:assert/strict');
(async () => {
  const live = fs.openSync('/data/input.txt', 'r');
  assert.equal(fs.fstatSync(live).size, 4);
  fs.writeFileSync('/data/output.txt', 'guest output');
  assert.equal(fs.fstatSync(live).size, 19);
  assert.equal(fs.readFileSync(live, 'utf8'), 'HOST-UPDATED-LONGER');
  fs.closeSync(live);
  fs.mkdirSync('/data/nested');
  const bytes = Buffer.alloc(150000); for (let i=0;i<bytes.length;i++) bytes[i]=i%251;
  fs.writeFileSync('/data/nested/binary', bytes);
  assert.deepEqual(fs.readFileSync('/data/nested/binary'), bytes);
  fs.appendFileSync('/data/nested/binary', 'abc');
  assert.equal(fs.statSync('/data/nested/binary').size, 150003);
  fs.truncateSync('/data/nested/binary', 3);
  fs.renameSync('/data/nested/binary', '/data/nested/renamed');
  assert(fs.readdirSync('/data/nested').includes('renamed'));
  fs.unlinkSync('/data/nested/renamed'); fs.rmdirSync('/data/nested');
  assert.throws(() => fs.statSync('/data/missing'), {code:'ENOENT'});
  assert.throws(() => fs.statSync('/data/io-error'), {code:'EIO'});
  for (let i=0;i<20;i++) {
    const path='/data/race-'+i;
    await Promise.all([fs.promises.writeFile(path,'one'),fs.promises.writeFile(path,'two')]);
    assert.throws(() => fs.writeFileSync(path, 'exclusive', {flag:'wx'}), {code:'EEXIST'});
    fs.unlinkSync(path);
  }
  console.log('passed live filesystem assertions');
})().catch(error => {console.error(error);process.exitCode=1;});`;
    const output = await sandbox
      .command(pkg, ['-e', program])
      .run({ check: false, timeoutMs: 60000, outputBytes: 65536 });
    if (output.reason !== 'exited' || output.exitCode !== 0)
      throw new Error(`${output.reason}: ${output.stderr.text()}`);
    await sandbox.close();
    await client.close();
    const remaining = descriptors.size;
    vfs.syncSync();
    await vfs.closeVfs();
    vfs = new OpfsVfs(name, { bufferMode: 'disk' });
    await vfs.ready;
    client = new Wasmer();
    pkg = await client.packages.load('wasmer/edgejs@0.2.0');
    sandbox = await client.sandboxes.create({
      packages: [pkg],
      network: { mode: 'disabled' },
      syncMounts: [{ path: '/data', fs: createWasmerFileSystem(vfs) }],
    });
    const reopened = await sandbox
      .command(pkg, ['-e', "console.log(require('node:fs').readFileSync('/data/input.txt','utf8'))"])
      .run({ timeoutMs: 30000 });
    await sandbox.close();
    await client.close();
    await vfs.closeVfs();
    self.postMessage({ exit: output.exitCode, reopened: reopened.stdout.text().trim(), live, descriptors: remaining });
  } catch (error) {
    // The test harness terminates this owner and waits for its volume lock; do
    // not race uncertain guest execution with storage cleanup here.
    self.postMessage({ error: String(error) });
  }
};
