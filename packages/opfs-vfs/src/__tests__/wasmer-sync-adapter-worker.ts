import { OpenFlags, OpfsVfs } from '../opfs-vfs';
import { deleteVolume } from '../volume-files';
import { createWasmerFileSystem, type WasmerSyncOpenOptions } from '../wasmer-sync-adapter';

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

function errno(work: () => unknown, code: string) {
  try {
    work();
  } catch (error) {
    equal((error as { code?: string }).code, code);
    return;
  }
  throw new Error(`Expected ${code}`);
}

async function run(scenario: string, bufferMode: 'disk' | 'memory') {
  const name = `wasmer-sync-${crypto.randomUUID()}.bin`;
  let vfs = new OpfsVfs(name, { bufferMode, localDurabilityMode: 'relaxed' });
  await vfs.ready;
  let fs = createWasmerFileSystem(vfs);
  const handles = new Set<number>();
  const open = (path: string, options: Partial<WasmerSyncOpenOptions> = {}) => {
    const fd = fs.open(path, {
      read: true,
      write: true,
      create: true,
      append: false,
      truncate: false,
      createNew: false,
      ...options,
    });
    handles.add(fd);
    return fd;
  };
  const closeHandles = () => {
    for (const fd of handles) fs.close(fd);
    handles.clear();
  };
  try {
    if (scenario === 'io') {
      fs.createDir('/dir');
      const fd = open('/dir/file');
      equal(fs.write(fd, new Uint8Array([0, 255, 128, 3])), 4);
      equal(fs.seek(fd, -2, 1), 2);
      equal(Array.from(fs.read(fd, 5)), [128, 3]);
      equal(fs.seek(fd, 1, 0), 1);
      equal(fs.write(fd, new Uint8Array([42])), 1);
      const append = open('/dir/file', { append: true, create: false });
      fs.seek(append, 0, 0);
      fs.write(append, new Uint8Array([5]));
      equal(fs.fstat(fd).size, 5);
      equal(fs.seek(fd, -1, 2), 4);
      equal(Array.from(fs.read(fd, 1)), [5]);
      fs.setLen(fd, 3);
      equal(fs.fstat(append).size, 3);
      fs.seek(fd, 0, 0);
      equal(Array.from(fs.read(fd, 10)), [0, 42, 128]);
      equal(
        fs.readDir('/dir').map(({ name, kind, size }) => ({ name, kind, size })),
        [{ name: 'file', kind: 'file', size: 3 }],
      );
      vfs.utimesSync('/dir/file', 1712345600000, 1712345610000);
      equal(fs.metadata('/dir/file').accessed, 1712345600000);
      equal(fs.fstat(fd).modified, 1712345610000);
      errno(() => open('/dir/file', { createNew: true }), 'EEXIST');
      errno(() => open('/missing', { create: false }), 'ENOENT');
      errno(() => open('/dir'), 'EISDIR');
      errno(() => fs.removeDir('/dir'), 'ENOTEMPTY');
      errno(() => fs.seek(fd, NaN, 0), 'EINVAL');
      errno(() => fs.seek(fd, -10, 2), 'EINVAL');
      errno(() => fs.read(fd, -1), 'EINVAL');
      const readonly = open('/dir/file', { write: false, create: false });
      errno(() => fs.write(readonly, new Uint8Array([9])), 'EBADF');
      errno(() => fs.setLen(readonly, 0), 'EBADF');
      const external = vfs.openSync('/dir/file', OpenFlags.O_RDONLY);
      errno(() => fs.close(external), 'EBADF');
      vfs.closeSync(external);
      const injected = Object.assign(new Error('injected disk failure'), { code: 'EIO' });
      const original = vfs.fsyncSync.bind(vfs);
      vfs.fsyncSync = () => {
        throw injected;
      };
      errno(() => fs.flush(fd), 'EIO');
      vfs.fsyncSync = original;
      fs.flush(fd);
      closeHandles();
      errno(() => fs.read(fd, 1), 'EBADF');
      await vfs.closeVfs();
      vfs = new OpfsVfs(name, { bufferMode: 'disk' });
      await vfs.ready;
      fs = createWasmerFileSystem(vfs);
      equal(Array.from(fs.read(open('/dir/file', { create: false }), 10)), [0, 42, 128]);
      const truncated = open('/dir/file', { truncate: true });
      equal(fs.fstat(truncated).size, 0);
      closeHandles();
      fs.removeFile('/dir/file');
      fs.removeDir('/dir');
      equal(fs.readDir('/'), []);
    } else if (scenario === 'links') {
      const victim = open('/victim');
      fs.write(victim, new Uint8Array([11, 22, 33]));
      closeHandles();
      vfs.chmodSync('/victim', 0o444);
      const readonlyVictim = open('/victim', { write: false, create: false });
      const victimIno = vfs.statSync('/victim').ino;
      const source = open('/source');
      fs.write(source, new Uint8Array([44]));
      errno(() => open('/victim/.', { truncate: true }), 'EINVAL');
      errno(() => fs.removeFile('/victim/.'), 'EINVAL');
      errno(() => fs.rename('/source', '/victim/.'), 'EINVAL');
      errno(() => fs.rename('/victim/.', '/moved'), 'EINVAL');
      equal(vfs.statSync('/victim').ino, victimIno);
      equal(Array.from(fs.read(readonlyVictim, 10)), [11, 22, 33]);
      equal(fs.metadata('/source').size, 1);
      fs.createDir('/target');
      const fd = open('/target/file');
      fs.write(fd, new Uint8Array([7]));
      vfs.symlinkSync('/target', '/link');
      vfs.symlinkSync('/target/file', '/file-link');
      for (const path of ['/link/file', '/file-link']) {
        errno(() => fs.metadata(path), 'ENOTSUP');
        errno(() => open(path, { truncate: true }), 'ENOTSUP');
        errno(() => fs.removeFile(path), 'ENOTSUP');
      }
      errno(() => fs.readDir('/link'), 'ENOTSUP');
      errno(() => fs.createDir('/link/new'), 'ENOTSUP');
      errno(() => open('/link/new'), 'ENOTSUP');
      errno(() => fs.rename('/target/file', '/link/moved'), 'ENOTSUP');
      errno(() => fs.rename('/link/file', '/moved'), 'ENOTSUP');
      errno(() => fs.removeDir('/link'), 'ENOTSUP');
      for (const path of ['relative', '/../target/file', '/target/../target/file', '/bad\0name']) {
        errno(() => open(path), 'EINVAL');
      }
      errno(() => open('/target/file/'), 'ENOTDIR');
      vfs.linkSync('/target/file', '/hard');
      errno(() => fs.metadata('/hard'), 'ENOTSUP');
      errno(() => open('/hard', { truncate: true }), 'ENOTSUP');
      errno(() => fs.removeFile('/hard'), 'ENOTSUP');
      errno(() => fs.rename('/hard', '/elsewhere'), 'ENOTSUP');
      errno(() => fs.write(fd, new Uint8Array([8])), 'ENOTSUP');
      closeHandles();
      const original = vfs.openSync('/target/file');
      equal(Array.from(vfs.readSync(original, 10).buffer), [7]);
      vfs.closeSync(original);
    } else if (scenario === 'identity') {
      fs.createDir('/dir');
      const moved = open('/dir/file');
      fs.write(moved, new Uint8Array([1]));
      fs.rename('/dir/', '/new/');
      fs.rename('/new/file', '/new/renamed');
      fs.unlink(moved);
      errno(() => fs.metadata('/new/renamed'), 'ENOENT');
      equal(fs.fstat(moved).size, 1);
      const replacement = open('/new/renamed');
      fs.write(replacement, new Uint8Array([2]));
      fs.unlink(moved);
      equal(fs.metadata('/new/renamed').size, 1);

      const target = open('/target');
      const source = open('/source');
      fs.write(source, new Uint8Array([3]));
      fs.rename('/source', '/target');
      fs.unlink(target);
      equal(fs.metadata('/target').size, 1);
      fs.unlink(source);
      errno(() => fs.metadata('/target'), 'ENOENT');

      const stale = open('/external');
      vfs.renameSync('/external', '/outside');
      open('/external');
      errno(() => fs.unlink(stale), 'ENOTSUP');
      equal(fs.metadata('/external').kind, 'file');
      fs.removeFile('/external');
      errno(() => fs.unlink(stale), 'ENOTSUP');
      equal(fs.metadata('/outside').kind, 'file');
      const removed = open('/removed');
      fs.removeFile('/removed');
      open('/removed');
      fs.unlink(removed);
      equal(fs.metadata('/removed').kind, 'file');
    } else {
      throw new Error(`Unknown scenario: ${scenario}`);
    }
  } finally {
    try {
      closeHandles();
    } finally {
      await vfs.closeVfs();
      await deleteVolume(name);
    }
  }
}

self.onmessage = async ({ data }: MessageEvent<{ scenario: string; bufferMode: 'disk' | 'memory' }>) => {
  try {
    await run(data.scenario, data.bufferMode);
    self.postMessage({});
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.stack : String(error) });
  }
};
