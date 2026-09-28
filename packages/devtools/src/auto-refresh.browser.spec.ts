import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { OpfsVfsWorker } from '@opfs-vfs/opfs-vfs/worker';
import { DevtoolsSession } from './runtime';
import { DebugPanel } from './DebugPanel';

const encode = (value: string) => new TextEncoder().encode(value);

test('shallow refresh reconciles changes, preserves previews, and discards cancelled reads', async () => {
  const name = `devtools-refresh-${crypto.randomUUID()}.bin`;
  const owner = new OpfsVfsWorker(name, { openMode: 'create-new' });
  const session = new DevtoolsSession();
  const controller = new AbortController();
  const files = () => session.volumes.find((v) => v.name === name)!.files;
  try {
    await owner.ready;
    await owner.mkdir('/nested');
    await owner.writeFileBuffer('/note.txt', encode('original'));
    await owner.writeFileBuffer('/nested/old.txt', encode('nested original'));
    await session.refresh();
    await session.connect(name);
    let release!: () => void;
    let started!: () => void;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    // Preserve the original method and call it with the intercepted client below.
    // oxlint-disable-next-line typescript/unbound-method
    const readStat = OpfsVfsWorker.prototype.lstat;
    const stat = vi.spyOn(OpfsVfsWorker.prototype, 'lstat').mockImplementationOnce(async function (
      this: OpfsVfsWorker,
      path,
    ) {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return readStat.call(this, path);
    });
    const pendingPreviewScan = session.listDirectory(name, '/', controller.signal);
    await reading;
    const original = await session.read(name, '/note.txt');
    release();
    await pendingPreviewScan;
    stat.mockRestore();
    expect(files().find((f) => f.path === '/note.txt')).toBe(original);
    await owner.writeFileBuffer('/nested/new.txt', encode('nested new'));
    await owner.writeFileBuffer('/new.txt', encode('new'));
    await session.listDirectory(name, '/', controller.signal);
    expect(files().find((f) => f.path === '/note.txt')).toBe(original);
    expect(files().some((f) => f.path === '/new.txt')).toBe(true);
    expect(files().some((f) => f.path === '/nested/new.txt')).toBe(false);
    await owner.writeFileBuffer('/note.txt', encode('changed by application'));
    await session.listDirectory(name, '/', controller.signal);
    expect(files().find((f) => f.path === '/note.txt')?.loaded).toBe(false);
    session.setWrites(name, true);
    await expect(session.save(name, original, 'draft')).rejects.toThrow();
    await owner.remove('/nested');
    await session.listDirectory(name, '/', controller.signal);
    expect(files().some((f) => f.path.startsWith('/nested'))).toBe(false);
    await owner.renameNoReplace('/new.txt', '/renamed.txt');
    await session.listDirectory(name, '/', controller.signal);
    expect(files().some((f) => f.path === '/new.txt')).toBe(false);
    expect(files().some((f) => f.path === '/renamed.txt')).toBe(true);
    const previous = files();
    const pending = session.listDirectory(name, '/', controller.signal);
    controller.abort();
    await pending;
    expect(files()).toBe(previous);
  } finally {
    session.dispose();
    await owner.closeVfs();
  }
}, 30000);

test('discovery preserves the cache of a volume owned by devtools', async () => {
  const session = new DevtoolsSession();
  const name = `devtools-owned-refresh-${crypto.randomUUID()}.bin`;
  try {
    await session.create(name);
    session.setWrites(name, true);
    await session.run(name, 'mkdir nested; echo original > nested/note.txt');
    const preview = await session.read(name, '/nested/note.txt');
    const files = session.volumes.find((v) => v.name === name)!.files;
    await session.refresh();
    const volume = session.volumes.find((v) => v.name === name)!;
    expect(volume.connection).toBe('owned');
    expect(volume.files).toBe(files);
    expect(volume.files.find((f) => f.path === '/nested/note.txt')).toBe(preview);
  } finally {
    session.dispose();
  }
}, 30000);

test('panel polls only the current folder, serializes reads, and stops when closed', async () => {
  const session = new DevtoolsSession();
  session.volumes = [{ name: 'workspace.bin', state: 'application', connection: 'passive', files: [] }];
  vi.spyOn(session, 'refresh').mockImplementation(async () => session.volumes);
  let release!: () => void;
  const listing = vi
    .spyOn(session, 'listDirectory')
    .mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return session.volumes;
    })
    .mockImplementation(async () => session.volumes);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  root.render(createElement(DebugPanel, { runtime: session, initialOpen: true }));
  try {
    await expect.poll(() => listing.mock.calls.length).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(listing).toHaveBeenCalledTimes(1);
    release();
    await expect.poll(() => listing.mock.calls.length).toBeGreaterThan(1);
    expect(listing.mock.calls.every(([name, path]) => name === 'workspace.bin' && path === '/')).toBe(true);
    await page.getByRole('button', { name: 'Close volume explorer', exact: true }).click();
    const count = listing.mock.calls.length;
    expect(listing.mock.calls.at(-1)![2].aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(listing).toHaveBeenCalledTimes(count);
    const style = getComputedStyle(host.querySelector('.opfs-launcher')!);
    expect(style.backdropFilter).toBe('blur(12px)');
    expect(style.backgroundColor).toContain('0.8');
  } finally {
    release?.();
    root.unmount();
    host.remove();
    session.dispose();
    vi.restoreAllMocks();
  }
});
