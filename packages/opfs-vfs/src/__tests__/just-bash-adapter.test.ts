import { afterEach, describe, expect, it } from 'vitest';

import { OpfsVfsWorker } from '../index_internal';
import { OpfsVfsJustBashAdapter } from '../just-bash-adapter';

type AdapterContext = {
  fs: OpfsVfsJustBashAdapter;
  close: () => Promise<void>;
};

const backends = [
  {
    name: 'worker-backed',
    async create(): Promise<AdapterContext> {
      const id = Math.random().toString(36).slice(2);
      const vfs = new OpfsVfsWorker(`just-bash-worker-${id}.bin`, { forceLeader: true });
      await vfs.ready;
      return {
        fs: new OpfsVfsJustBashAdapter(vfs),
        close: async () => {
          await vfs.closeVfs();
        },
      };
    },
  },
];

for (const backend of backends) {
  describe(`OpfsVfsJustBashAdapter (${backend.name})`, () => {
    let context: AdapterContext | null = null;

    afterEach(async () => {
      await context?.close();
      context = null;
    });

    async function createAdapter() {
      context = await backend.create();
      return context.fs;
    }

    it('writes, appends, reads, chmods, utimes, and enumerates paths', async () => {
      const fs = await createAdapter();

      await fs.writeFile('/nested/hello.txt', 'hello');
      await fs.appendFile('/nested/hello.txt', ' world');

      expect(await fs.readFile('/nested/hello.txt')).toBe('hello world');
      expect(await fs.readFile('/nested/hello.txt', 'base64')).toBe('aGVsbG8gd29ybGQ=');

      const initial = await fs.stat('/nested/hello.txt');
      expect(initial).toMatchObject({
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        size: 11,
      });

      const mtime = new Date('2026-04-16T12:00:00.000Z');
      await fs.chmod('/nested/hello.txt', 0o100755);
      await fs.utimes('/nested/hello.txt', new Date('2026-04-16T11:00:00.000Z'), mtime);

      const updated = await fs.stat('/nested/hello.txt');
      expect(updated.mode).toBe(0o100755);
      expect(updated.mtime.getTime()).toBe(mtime.getTime());
      expect(fs.resolvePath('/nested', './sub/../hello.txt')).toBe('/nested/hello.txt');
      expect(new Set(await fs.getAllPaths())).toEqual(new Set(['/', '/nested', '/nested/hello.txt']));
    });

    it('preserves caller-owned full-buffer input across writeFile', async () => {
      const fs = await createAdapter();
      // Node/browser Buffer is a Uint8Array subtype whose slice() aliases the same backing store.
      // Model that shape so a slice-based pseudo-copy cannot make this regression falsely green.
      class AliasingUint8Array extends Uint8Array {
        override slice(start?: number, end?: number): Uint8Array<ArrayBuffer> {
          return this.subarray(start, end) as Uint8Array<ArrayBuffer>;
        }
      }
      const input = new AliasingUint8Array([0x50, 0x41, 0x43, 0x4b, 1, 2, 3, 4]);
      const expected = Uint8Array.from(input);

      await fs.writeFile('/pack.bin', input);

      expect(input.buffer.byteLength).toBe(expected.byteLength);
      expect(Uint8Array.from(input)).toEqual(expected);
      expect(await fs.readFileBuffer('/pack.bin')).toEqual(expected);
    });

    it('preserves caller-owned full-buffer input across appendFile', async () => {
      const fs = await createAdapter();
      const input = new Uint8Array([3, 4, 5]);
      const expected = Uint8Array.from(input);
      await fs.writeFile('/append.bin', new Uint8Array([1, 2]));

      await fs.appendFile('/append.bin', input);

      expect(input.buffer.byteLength).toBe(expected.byteLength);
      expect(Uint8Array.from(input)).toEqual(expected);
      expect(await fs.readFileBuffer('/append.bin')).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    });

    it('preserves a binary input view and its complete parent buffer', async () => {
      const fs = await createAdapter();
      const parent = new Uint8Array([9, 8, 7, 6, 5]);
      const expectedParent = Uint8Array.from(parent);
      const view = parent.subarray(1, 4);

      await fs.writeFile('/view.bin', view);

      expect(parent).toEqual(expectedParent);
      expect(await fs.readFileBuffer('/view.bin')).toEqual(new Uint8Array([8, 7, 6]));
    });

    it('preserves directory-only trailing slash semantics', async () => {
      const fs = await createAdapter();

      await fs.writeFile('/plain.txt', 'hello');

      await expect(fs.readFile('/plain.txt/')).rejects.toMatchObject({ code: 'ENOTDIR' });
      await expect(fs.stat('/plain.txt/')).rejects.toMatchObject({ code: 'ENOTDIR' });
      await expect(fs.exists('/plain.txt/')).resolves.toBe(false);
    });

    it('preserves trailing slash semantics for recursive rm', async () => {
      const fs = await createAdapter();

      await fs.writeFile('/plain.txt', 'hello');

      await expect(fs.rm('/plain.txt/', { recursive: true })).rejects.toMatchObject({ code: 'ENOTDIR' });
      await expect(fs.exists('/plain.txt')).resolves.toBe(true);
    });

    it('preserves symlink and hard-link semantics with dirent typing', async () => {
      const fs = await createAdapter();

      await fs.writeFile('/dir/target.txt', 'target');
      await fs.symlink('target.txt', '/dir/link.txt');

      const linkStat = await fs.lstat('/dir/link.txt');
      expect(linkStat).toMatchObject({
        isFile: false,
        isDirectory: false,
        isSymbolicLink: true,
      });

      const followed = await fs.stat('/dir/link.txt');
      expect(followed).toMatchObject({
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        size: 6,
      });

      expect(await fs.readlink('/dir/link.txt')).toBe('target.txt');
      expect(await fs.realpath('/dir/link.txt')).toBe('/dir/target.txt');

      await fs.link('/dir/target.txt', '/dir/hard.txt');
      await fs.writeFile('/dir/target.txt', 'updated');
      expect(await fs.readFile('/dir/hard.txt')).toBe('updated');

      expect(await fs.readdir('/dir')).toEqual(['hard.txt', 'link.txt', 'target.txt']);
      expect(await fs.readdirWithFileTypes('/dir')).toEqual([
        { name: 'hard.txt', isFile: true, isDirectory: false, isSymbolicLink: false },
        { name: 'link.txt', isFile: false, isDirectory: false, isSymbolicLink: true },
        { name: 'target.txt', isFile: true, isDirectory: false, isSymbolicLink: false },
      ]);
    });

    it('copies, moves, and removes trees recursively without following symlink deletes', async () => {
      const fs = await createAdapter();

      await fs.writeFile('/tree/a.txt', 'a');
      await fs.writeFile('/tree/sub/b.txt', 'b');
      await fs.symlink('../a.txt', '/tree/sub/link-to-a');

      await fs.cp('/tree', '/copy', { recursive: true });
      expect(await fs.readFile('/copy/sub/b.txt')).toBe('b');
      expect(await fs.readlink('/copy/sub/link-to-a')).toBe('../a.txt');
      expect(new Set(await fs.getAllPaths())).toEqual(
        new Set([
          '/',
          '/copy',
          '/copy/a.txt',
          '/copy/sub',
          '/copy/sub/b.txt',
          '/copy/sub/link-to-a',
          '/tree',
          '/tree/a.txt',
          '/tree/sub',
          '/tree/sub/b.txt',
          '/tree/sub/link-to-a',
        ]),
      );

      await fs.mv('/copy', '/moved');
      expect(await fs.exists('/copy')).toBe(false);
      expect(await fs.exists('/moved/sub/b.txt')).toBe(true);
      expect(new Set(await fs.getAllPaths())).toEqual(
        new Set([
          '/',
          '/moved',
          '/moved/a.txt',
          '/moved/sub',
          '/moved/sub/b.txt',
          '/moved/sub/link-to-a',
          '/tree',
          '/tree/a.txt',
          '/tree/sub',
          '/tree/sub/b.txt',
          '/tree/sub/link-to-a',
        ]),
      );

      await fs.rm('/moved/sub/link-to-a');
      expect(await fs.exists('/moved/a.txt')).toBe(true);
      expect(await fs.exists('/moved/sub/link-to-a')).toBe(false);

      await fs.rm('/moved', { recursive: true });
      expect(await fs.exists('/moved')).toBe(false);
      expect(new Set(await fs.getAllPaths())).toEqual(
        new Set(['/', '/tree', '/tree/a.txt', '/tree/sub', '/tree/sub/b.txt', '/tree/sub/link-to-a']),
      );
    });

    it('copies a read-only file without throwing at the utimes/chmod step (COR-1)', async () => {
      const fs = await createAdapter();
      await fs.writeFile('/ro.txt', 'secret');
      await fs.chmod('/ro.txt', 0o444);

      await fs.cp('/ro.txt', '/copy.txt');

      expect(await fs.readFile('/copy.txt')).toBe('secret');
      expect((await fs.stat('/copy.txt')).mode & 0o777).toBe(0o444);
    });

    it('recursively copies an r-x directory (chmod applied after children) (COR-1)', async () => {
      const fs = await createAdapter();
      await fs.mkdir('/src');
      await fs.writeFile('/src/inner.txt', 'data');
      await fs.chmod('/src', 0o555);

      await fs.cp('/src', '/dst', { recursive: true });

      expect(await fs.readFile('/dst/inner.txt')).toBe('data');
      expect((await fs.stat('/dst')).mode & 0o777).toBe(0o555);
    });

    it('removes directories recursively through follower worker clients', async () => {
      const fileName = `just-bash-follower-${Math.random().toString(36).slice(2)}.bin`;
      const leader = new OpfsVfsWorker(fileName);
      await leader.ready;
      const follower = new OpfsVfsWorker(fileName);
      await follower.ready;
      const fs = new OpfsVfsJustBashAdapter(follower);
      const followerHandle = follower as unknown as { abortController: AbortController; channel: BroadcastChannel };

      try {
        await fs.mkdir('/dir');
        // COR-8: non-recursive rm rejects a directory (POSIX/Node fs.rm); the
        // recursive flag is the only way to remove one.
        await expect(fs.rm('/dir')).rejects.toMatchObject({ code: 'EISDIR' });
        await fs.rm('/dir', { recursive: true });
        await expect(fs.exists('/dir')).resolves.toBe(false);
      } finally {
        followerHandle.abortController.abort();
        followerHandle.channel.close();
        await leader.closeVfs();
      }
    }, 15000);

    it('closes follower worker clients through the leader transport', async () => {
      const fileName = `just-bash-close-follower-${Math.random().toString(36).slice(2)}.bin`;
      const leader = new OpfsVfsWorker(fileName);
      await leader.ready;
      const follower = new OpfsVfsWorker(fileName);
      await follower.ready;
      const fs = new OpfsVfsJustBashAdapter(follower);

      try {
        await fs.writeFile('/dir/file.txt', 'hello');
        await expect(follower.closeVfs()).resolves.toBeUndefined();
      } finally {
        await leader.closeVfs();
      }
    }, 15000);

    it('releases leader handles when a follower requests shared shutdown', async () => {
      const fileName = `just-bash-shutdown-follower-${Math.random().toString(36).slice(2)}.bin`;
      const leader = new OpfsVfsWorker(fileName);
      await leader.ready;
      const follower = new OpfsVfsWorker(fileName);
      await follower.ready;
      const fs = new OpfsVfsJustBashAdapter(follower);

      try {
        await fs.writeFile('/dir/file.txt', 'hello');
        await follower.shutdownSharedVfs();

        const root = await navigator.storage.getDirectory();
        const handle = await root.getFileHandle(fileName, { create: true });
        const writable = await handle.createWritable();
        await writable.close();
      } finally {
        await Promise.allSettled([follower.closeVfs(), leader.closeVfs()]);
      }
    }, 15000);

    it('rebases the cached path tree on rename without a full rebuild', async () => {
      const fs = await createAdapter();

      await fs.writeFile('/source/inner/file.txt', 'hello');
      await fs.mkdir('/target');

      await fs.mv('/source', '/target');

      expect(new Set(await fs.getAllPaths())).toEqual(
        new Set(['/', '/target', '/target/inner', '/target/inner/file.txt']),
      );
      expect(await fs.exists('/source')).toBe(false);
      expect(await fs.exists('/target/inner/file.txt')).toBe(true);
    });

    it('rejects copying a directory into itself through a symlinked destination', async () => {
      const fs = await createAdapter();
      await fs.mkdir('/tree');
      await fs.writeFile('/tree/a.txt', 'a');
      await fs.symlink('/tree', '/link');
      await expect(fs.cp('/tree', '/link/copy', { recursive: true })).rejects.toMatchObject({ code: 'EINVAL' });
      expect((await fs.readdir('/tree')).sort()).toEqual(['a.txt']);
    });

    it('rejects copying a directory into itself', async () => {
      const fs = await createAdapter();

      await fs.writeFile('/tree/a.txt', 'a');

      await expect(fs.cp('/tree', '/tree/copy', { recursive: true })).rejects.toMatchObject({ code: 'EINVAL' });
      expect(await fs.exists('/tree/copy')).toBe(false);
    });

    it('decodes ascii by masking the high bit', async () => {
      const fs = await createAdapter();

      await fs.writeFile('/ascii.bin', new Uint8Array([0xe9]));

      expect(await fs.readFile('/ascii.bin', 'latin1')).toBe('é');
      expect(await fs.readFile('/ascii.bin', 'ascii')).toBe('i');
    });
  });
}
