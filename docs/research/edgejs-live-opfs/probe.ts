import { OpfsVfs, OpenFlags as F } from '/@opfs-source/opfs-vfs.ts';
const { Wasmer } = await import(/* @vite-ignore */ new URL('/dist/index.js', location.origin).href);
const log = (stage, extra = {}) => self.postMessage({ stage, ...extra });
const check = (v, msg) => {
  if (!v) throw Error(msg);
};
const text = new TextEncoder(),
  decoder = new TextDecoder();
const name = `live-edgejs-${crypto.randomUUID()}.bin`;
let vfs, wasmer, sandbox;
let hostChanged = false,
  checkpoint = false;
const openFds = new Map();
const counts = {};
const p = (path) => '/' + path.replace(/^\/+/, '');
const meta = (s) => ({
  kind: s.is_dir ? 'directory' : 'file',
  size: s.size,
  accessed: s.atimeMs ?? 0,
  modified: s.mtimeMs ?? 0,
  created: s.ctimeMs ?? 0,
});
const readHost = (path) => {
  const fd = vfs.openSync(path);
  try {
    return decoder.decode(vfs.readSync(fd, vfs.fstatSync(fd).size).buffer);
  } finally {
    vfs.closeSync(fd);
  }
};
const writeHost = (path, data) => {
  const fd = vfs.openSync(path, F.O_RDWR | F.O_CREAT | F.O_TRUNC);
  try {
    vfs.writeSync(fd, typeof data === 'string' ? text.encode(data) : data);
    vfs.fsyncSync(fd);
  } finally {
    vfs.closeSync(fd);
  }
};
const raw = {
  metadata(path) {
    if (p(path) === '/io-error') throw Object.assign(Error('injected I/O failure'), { code: 'EIO' });
    return meta(vfs.statSync(p(path)));
  },
  readDir(path) {
    return vfs.readdirNamesSync(p(path)).map((name) => ({ name, ...meta(vfs.statSync(p(path) + '/' + name)) }));
  },
  createDir(path) {
    vfs.mkdirSync(p(path));
  },
  removeDir(path) {
    vfs.rmdirSync(p(path));
  },
  removeFile(path) {
    vfs.unlinkSync(p(path));
  },
  rename(from, to) {
    vfs.renameSync(p(from), p(to));
    for (const [fd, path] of openFds) if (path === p(from)) openFds.set(fd, p(to));
  },
  open(path, o) {
    const flags =
      (o.read && o.write ? F.O_RDWR : o.write ? F.O_WRONLY : F.O_RDONLY) |
      (o.append ? F.O_APPEND : 0) |
      (o.truncate ? F.O_TRUNC : 0) |
      (o.create || o.createNew ? F.O_CREAT : 0) |
      (o.createNew ? F.O_EXCL : 0);
    const fd = vfs.openSync(p(path), flags);
    openFds.set(fd, p(path));
    return fd;
  },
  read(fd, length) {
    return vfs.readSync(fd, length).buffer;
  },
  write(fd, bytes) {
    const n = vfs.writeSync(fd, bytes);
    if (openFds.get(fd) === '/checkpoint' && !checkpoint) {
      checkpoint = true;
      log('guest-checkpoint', { visible: readHost('/guest.txt'), openHandles: openFds.size });
    }
    return n;
  },
  unlink(fd) {
    const path = openFds.get(fd);
    if (!path) return;
    try {
      if (vfs.statSync(path).ino !== vfs.fstatSync(fd).ino)
        throw Object.assign(Error('unlink path changed'), { code: 'ENOTSUP' });
      vfs.unlinkSync(path);
      for (const [id, entry] of openFds) if (entry === path) openFds.set(id, null);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  },
  seek(fd, offset, whence) {
    return vfs.seekSync(fd, offset, whence);
  },
  fstat(fd) {
    return meta(vfs.fstatSync(fd));
  },
  setLen(fd, size) {
    vfs.ftruncateSync(fd, size);
  },
  flush(fd) {
    vfs.fsyncSync(fd);
  },
  close(fd) {
    vfs.closeSync(fd);
    openFds.delete(fd);
  },
};
const provider = Object.fromEntries(
  Object.entries(raw).map(([name, fn]) => [
    name,
    (...args) => {
      counts[name] = (counts[name] ?? 0) + 1;
      return fn(...args);
    },
  ]),
);
self.onmessage = ({ data }) => {
  if (data.type === 'mutate') {
    try {
      check(readHost('/guest.txt') === 'from-guest', 'guest write not visible live');
      writeHost('/input.txt', 'HOST-UPDATED-LONGER');
      hostChanged = true;
      log('host-mutated', { value: readHost('/input.txt') });
    } catch (e) {
      log('FAIL', { error: String(e) });
    }
  }
};
const script = `
const fs=require('node:fs');const assert=require('node:assert/strict');
(async()=>{
assert.equal(fs.readFileSync('/opfs/input.txt','utf8'),'seed');
const live=fs.openSync('/opfs/input.txt','r');
fs.writeFileSync('/opfs/guest.txt','from-guest');
fs.writeFileSync('/opfs/checkpoint','ready');
let seen='';
for(let i=0;i<400;i++){const b=Buffer.alloc(64);seen=b.subarray(0,fs.readSync(live,b,0,b.length,0)).toString();if(seen==='HOST-UPDATED-LONGER')break;await new Promise(r=>setTimeout(r,10))}
assert.equal(seen,'HOST-UPDATED-LONGER');assert.equal(fs.fstatSync(live).size,19);fs.closeSync(live);
fs.mkdirSync('/opfs/nested');
const bytes=Buffer.alloc(150000);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
fs.writeFileSync('/opfs/nested/binary',bytes);assert.deepEqual(fs.readFileSync('/opfs/nested/binary'),bytes);
fs.renameSync('/opfs/nested/binary','/opfs/nested/renamed');
fs.appendFileSync('/opfs/guest.txt','+append');assert.equal(fs.readFileSync('/opfs/guest.txt','utf8'),'from-guest+append');
fs.truncateSync('/opfs/guest.txt',5);assert.equal(fs.readFileSync('/opfs/guest.txt','utf8'),'from-');
assert(fs.readdirSync('/opfs/nested').includes('renamed'));
fs.unlinkSync('/opfs/nested/renamed');fs.rmdirSync('/opfs/nested');
assert.throws(()=>fs.readFileSync('/opfs/missing'),{code:'ENOENT'});
assert.throws(()=>fs.statSync('/opfs/io-error'),{code:'EIO'});
fs.openSync('/opfs/leaked','w');
console.log('LIVE-OPFS-PASS');
})().catch(e=>{console.error(e.stack);process.exitCode=1});`;
try {
  log('init', { crossOriginIsolated });
  vfs = new OpfsVfs(name, { bufferMode: 'disk', localDurabilityMode: 'strict' });
  await vfs.ready;
  writeHost('/input.txt', 'seed');
  wasmer = new Wasmer();
  await wasmer.ready();
  log('load');
  const pkg = await wasmer.packages.load('wasmer/edgejs@0.2.0');
  log('loaded', { id: pkg.id });
  for (const paths of [['/'], ['/workspace'], ['relative'], ['/opfs/../bad'], ['/opfs', '/opfs']]) {
    let rejected = false;
    try {
      const invalid = await wasmer.sandboxes.create({
        network: { mode: 'disabled' },
        syncMounts: paths.map((path) => ({ path, fs: provider })),
      });
      await invalid.close();
    } catch {
      rejected = true;
    }
    check(rejected, 'invalid mount accepted: ' + paths);
  }
  log('mount-validation');
  const control = await wasmer.sandboxes.create({ packages: [pkg], network: { mode: 'disabled' } });
  await control.fs.writeFile(
    'control.cjs',
    text.encode(
      `try{require('node:fs').readFileSync('/opfs/input.txt');process.exit(42)}catch(e){if(e.code!=='ENOENT')throw e;console.log('NO-MOUNT-CONTROL-PASS')}`,
    ),
  );
  const negative = await control.command(pkg, ['/workspace/control.cjs']).run({ timeoutMs: 60000, check: false });
  check(negative.ok, 'no mount negative control failed');
  log('control', { stdout: negative.stdout.text() });
  await control.close();
  sandbox = await wasmer.sandboxes.create({
    packages: [pkg],
    network: { mode: 'disabled' },
    syncMounts: [{ path: '/opfs', fs: provider }],
  });
  await sandbox.fs.writeFile('main.cjs', text.encode(script));
  log('run');
  const output = await sandbox.command(pkg, ['/workspace/main.cjs']).run({ timeoutMs: 90000, check: false });
  log('output', { exitCode: output.exitCode, stdout: output.stdout.text(), stderr: output.stderr.text() });
  check(output.ok && output.stdout.text().includes('LIVE-OPFS-PASS'), 'guest failed');
  check(hostChanged, 'no live host update');
  check(readHost('/guest.txt') === 'from-', 'final host value');
  check(!vfs.readdirNamesSync('/').includes('nested'), 'guest delete not visible');
  await sandbox.close();
  sandbox = undefined;
  check(openFds.size === 0, 'leaked descriptors after close');
  await wasmer.close();
  wasmer = undefined;
  await vfs.closeVfs();
  vfs = new OpfsVfs(name, { bufferMode: 'disk', openMode: 'open-existing' });
  await vfs.ready;
  check(readHost('/input.txt') === 'HOST-UPDATED-LONGER', 'input reopen');
  check(readHost('/guest.txt') === 'from-', 'guest reopen');
  wasmer = new Wasmer();
  await wasmer.ready();
  const reopenedPkg = await wasmer.packages.load('wasmer/edgejs@0.2.0');
  sandbox = await wasmer.sandboxes.create({
    packages: [reopenedPkg],
    network: { mode: 'disabled' },
    syncMounts: [{ path: '/opfs', fs: provider }],
  });
  await sandbox.fs.writeFile(
    'reopen.cjs',
    text.encode(
      `const fs=require('node:fs');const a=require('node:assert/strict');a.equal(fs.readFileSync('/opfs/input.txt','utf8'),'HOST-UPDATED-LONGER');a.equal(fs.readFileSync('/opfs/guest.txt','utf8'),'from-');a(!fs.existsSync('/opfs/nested'));console.log('REOPEN-PASS');`,
    ),
  );
  const reopen = await sandbox.command(reopenedPkg, ['/workspace/reopen.cjs']).run({ timeoutMs: 60000, check: false });
  check(
    reopen.ok && reopen.stdout.text().includes('REOPEN-PASS'),
    'fresh runtime reopen failed: ' + reopen.stderr.text(),
  );
  await sandbox.close();
  sandbox = undefined;
  check(openFds.size === 0, 'reopen descriptor leak');
  log('PASS', { counts, openHandles: openFds.size, reopened: reopen.stdout.text() });
} catch (e) {
  log('FAIL', { error: String(e), stack: e.stack, counts, openHandles: openFds.size });
} finally {
  await sandbox?.close();
  await wasmer?.close();
  await vfs?.closeVfs();
  log('closed');
}
