import { deleteVolume } from '@opfs-vfs/opfs-vfs';
import { OpfsVfsWorker } from '@opfs-vfs/opfs-vfs/worker';
import { describe, expect, it, vi } from 'vitest';
import { subscribe, type SubscribeOptions } from '../client';
import { subscriptionsRequest } from '../config';

const worker = () => new Worker(new URL('./subscription-content-worker.ts', import.meta.url), { type: 'module' });

type Watch = Pick<SubscribeOptions, 'path' | 'scope' | 'recursive' | 'match'>;

/** Assert the exact events one subscriber sees for `act`, run against a tree of /a/x.txt and /a/sub/y.txt. */
async function expectEvents(
  watch: Watch,
  act: (fs: OpfsVfsWorker) => Promise<void>,
  expected: readonly string[],
  setup?: (fs: OpfsVfsWorker) => Promise<void>,
) {
  const name = `subscription-rename-${crypto.randomUUID()}.bin`;
  const fs = new OpfsVfsWorker(name, { worker, plugins: [subscriptionsRequest()] });
  try {
    await fs.ready;
    await fs.mkdir('/a');
    await fs.mkdir('/a/sub');
    await fs.mkdir('/p');
    await fs.writeFileBuffer('/a/x.txt', new Uint8Array([1]));
    await fs.writeFileBuffer('/a/sub/y.txt', new Uint8Array([2]));
    await setup?.(fs);
    const seen: string[] = [];
    const errors: string[] = [];
    // The client swallows onError exceptions, so record terminal errors instead of throwing.
    const onError = (cause: { code: string }) => void errors.push(cause.code);
    let sentinel = false;
    await subscribe(fs, { path: '/', scope: 'directory', recursive: true, match: /sentinel/, onError }, () => {
      sentinel = true;
    });
    await subscribe(fs, { recursive: false, ...watch, onError }, (change) => {
      if (change.path !== '/sentinel') seen.push(`${change.type} ${change.path} ${change.kind}`);
    });
    await act(fs);
    // Subscriptions progress independently, so wait for the expected events on the watched one itself.
    await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(expected.length));
    // Then give any unexpected extra rename events a chance to arrive before asserting.
    await fs.writeFileBuffer('/sentinel', new Uint8Array());
    await vi.waitFor(() => expect(sentinel).toBe(true));
    expect(errors).toEqual([]);
    expect(seen).toEqual(expected);
  } finally {
    await fs.closeVfs().catch(() => fs.dispose());
    fs.dispose();
    await deleteVolume(name);
  }
}

const renameDir = (fs: OpfsVfsWorker) => fs.rename('/a', '/b');
const dir = (path: string, recursive: boolean): Watch => ({ path, scope: 'directory', recursive });

describe('rename events', () => {
  it('reports a file rename as delete then create', async () => {
    await expectEvents(dir('/', true), (fs) => fs.rename('/a/x.txt', '/a/z.txt'), [
      'delete /a/x.txt file',
      'create /a/z.txt file',
    ]);
  });

  it('reports every descendant of a renamed directory to a recursive subscriber on the root', async () => {
    await expectEvents(dir('/', true), renameDir, [
      'delete /a/sub/y.txt file',
      'delete /a/sub directory',
      'delete /a/x.txt file',
      'delete /a directory',
      'create /b directory',
      'create /b/sub directory',
      'create /b/x.txt file',
      'create /b/sub/y.txt file',
    ]);
  });

  it('reports only deletes to a recursive subscriber on the old directory', async () => {
    await expectEvents(dir('/a', true), renameDir, [
      'delete /a/sub/y.txt file',
      'delete /a/sub directory',
      'delete /a/x.txt file',
      'delete /a directory',
    ]);
  });

  it('reports only creates to a recursive subscriber on the new parent', async () => {
    await expectEvents(dir('/p', true), (fs) => fs.rename('/a', '/p/b'), [
      'create /p/b directory',
      'create /p/b/sub directory',
      'create /p/b/x.txt file',
      'create /p/b/sub/y.txt file',
    ]);
  });

  it('reports only the directory itself to a non-recursive subscriber on the parent', async () => {
    await expectEvents(dir('/', false), renameDir, ['delete /a directory', 'create /b directory']);
  });

  it('reports a delete to a file subscriber at the old path and a create to one at the new path', async () => {
    const old = { path: '/a/x.txt', scope: 'file', recursive: false } as const;
    await expectEvents(old, renameDir, ['delete /a/x.txt file']);
    await expectEvents({ ...old, path: '/b/x.txt' }, renameDir, ['create /b/x.txt file']);
  });

  it('applies a match expression to descendant paths', async () => {
    const watch = { ...dir('/', true), match: /\.txt$/ };
    await expectEvents(watch, renameDir, [
      'delete /a/sub/y.txt file',
      'delete /a/x.txt file',
      'create /b/x.txt file',
      'create /b/sub/y.txt file',
    ]);
  });

  it('deletes the replaced empty directory first when a directory is renamed over it', async () => {
    await expectEvents(
      dir('/', true),
      renameDir,
      [
        'delete /b directory',
        'delete /a/sub/y.txt file',
        'delete /a/sub directory',
        'delete /a/x.txt file',
        'delete /a directory',
        'create /b directory',
        'create /b/sub directory',
        'create /b/x.txt file',
        'create /b/sub/y.txt file',
      ],
      (fs) => fs.mkdir('/b'),
    );
  });
});
