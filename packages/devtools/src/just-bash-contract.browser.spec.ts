// The core package does not depend on just-bash, so the checks against the real package live here.
import { Bash, MountableFs, type IFileSystem } from 'just-bash';
import { expect, test } from 'vitest';
import { deleteVolume } from '@opfs-vfs/opfs-vfs';
import { OpfsVfsJustBashAdapter } from '@opfs-vfs/opfs-vfs/just-bash';
import { OpfsVfsWorker } from '@opfs-vfs/opfs-vfs/worker';

test('forJustBash() satisfies just-bash IFileSystem and serves a real shell', async () => {
  const name = `devtools-just-bash-${crypto.randomUUID()}.bin`;
  const client = new OpfsVfsWorker(name, { openMode: 'create-new' });
  try {
    await client.ready;
    const adapter = new OpfsVfsJustBashAdapter(client);
    await adapter.writeFile('/workspace/a.txt', 'a');

    // Compile-time contract: `pnpm typecheck` fails if the wrapper stops being assignable.
    const fs: IFileSystem = adapter.forJustBash();
    // @ts-expect-error The adapter itself is not an IFileSystem: its getAllPaths() is asynchronous.
    const raw: IFileSystem = adapter;

    const bash = new Bash({ fs, cwd: '/workspace' });
    const unmatched = await bash.exec('ls *.md');
    expect(unmatched.exitCode).not.toBe(0);
    expect(unmatched.stderr).toContain('No such file or directory');
    expect(unmatched.stderr).not.toContain('not iterable');
    expect((await bash.exec('ls *.txt')).stdout).toBe('a.txt\n');

    // A file created through the shell is in the next glob and in the synchronous list, with no refresh.
    expect((await bash.exec('echo b > b.txt && mkdir notes && echo c > notes/c.txt')).exitCode).toBe(0);
    expect((await bash.exec('ls *.txt')).stdout).toBe('a.txt\nb.txt\n');
    expect((await bash.exec('ls */*.txt')).stdout).toBe('notes/c.txt\n');
    expect(fs.getAllPaths()).toEqual(
      expect.arrayContaining(['/workspace/a.txt', '/workspace/b.txt', '/workspace/notes/c.txt']),
    );
    expect((await bash.exec('rm b.txt')).exitCode).toBe(0);
    expect(fs.getAllPaths()).not.toContain('/workspace/b.txt');

    // just-bash's own composition iterates the base list synchronously; a Promise there is "not iterable".
    expect(new MountableFs({ base: fs }).getAllPaths()).toContain('/workspace/notes/c.txt');
    void raw;
  } finally {
    await client.closeVfs().catch(() => client.dispose());
    await deleteVolume(name).catch(() => {});
  }
}, 30_000);
