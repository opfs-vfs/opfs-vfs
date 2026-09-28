import { afterEach, expect, it, vi } from 'vitest';
import { OpfsVfsWorker } from '../index_internal';
import { OpfsVfsJustBashAdapter } from '../just-bash-adapter';
import { OpfsVfsWasmerAdapter, type WasmerWorkspace } from '../wasmer-adapter';

const volumes: OpfsVfsWorker[] = [];
afterEach(async () => {
  for (const volume of volumes.splice(0)) await volume.closeVfs();
});

async function setup() {
  const vfs = new OpfsVfsWorker(`wasmer-adapter-${crypto.randomUUID()}.bin`, { forceLeader: true });
  volumes.push(vfs);
  await vfs.ready;
  const files = new OpfsVfsJustBashAdapter(vfs);
  await files.mkdir('/workspace');
  const absolute = (path: string) => (path === '.' ? '/workspace' : `/workspace/${path}`);
  const workspace: WasmerWorkspace = {
    readDir: async (path) =>
      (await files.readdirWithFileTypes(absolute(path))).map((e) => ({
        name: e.name,
        kind: e.isDirectory ? 'directory' : 'file',
        size: 0,
      })),
    readFile: (path) => files.readFileBuffer(absolute(path)),
    writeFile: (path, bytes) => files.writeFile(absolute(path), bytes),
    mkdir: (path) => files.mkdir(absolute(path), { recursive: true }),
    remove: (path) => files.rm(absolute(path), { recursive: true }),
  };
  return { vfs, files, workspace, adapter: new OpfsVfsWasmerAdapter(vfs) };
}

it('mirrors bytes, shorter overwrites, nested deletions and both type replacements', async () => {
  const opfs = await setup();
  const sandbox = await setup();
  await opfs.files.writeFile('/workspace/input', 'long original');
  await opfs.files.writeFile('/workspace/file-to-dir', 'old');
  await opfs.files.writeFile('/workspace/dir-to-file/child', 'old');
  await opfs.files.writeFile('/workspace/delete/child', 'old');
  await opfs.files.writeFile('/outside', 'keep');
  await sandbox.files.writeFile('/workspace/stale', 'old sandbox');
  await opfs.adapter.syncToSandbox(sandbox.workspace);
  expect(await sandbox.files.exists('/workspace/stale')).toBe(false);
  expect(await sandbox.files.readFile('/workspace/input')).toBe('long original');
  await sandbox.files.writeFile('/workspace/input', 'x');
  await sandbox.files.rm('/workspace/file-to-dir');
  await sandbox.files.writeFile('/workspace/file-to-dir/child', new Uint8Array([0, 255, 128]));
  await sandbox.files.rm('/workspace/dir-to-file', { recursive: true });
  await sandbox.files.writeFile('/workspace/dir-to-file', 'file');
  await sandbox.files.rm('/workspace/delete', { recursive: true });
  await opfs.adapter.syncFromSandbox(sandbox.workspace);
  expect(await opfs.files.readFile('/workspace/input')).toBe('x');
  expect(await opfs.files.readFileBuffer('/workspace/file-to-dir/child')).toEqual(new Uint8Array([0, 255, 128]));
  expect(await opfs.files.readFile('/workspace/dir-to-file')).toBe('file');
  expect(await opfs.files.exists('/workspace/delete')).toBe(false);
  expect(await opfs.files.readFile('/outside')).toBe('keep');
});

it('does not overwrite outside aliases and rejects OPFS links in either direction', async () => {
  const opfs = await setup();
  const sandbox = await setup();
  await opfs.files.writeFile('/outside', 'keep');
  await opfs.files.link('/outside', '/workspace/hard');
  await sandbox.files.writeFile('/workspace/hard', 'new');
  await opfs.adapter.syncFromSandbox(sandbox.workspace);
  expect(await opfs.files.readFile('/outside')).toBe('keep');
  expect(await opfs.files.readFile('/workspace/hard')).toBe('new');
  await opfs.files.symlink('/outside', '/workspace/link');
  await expect(opfs.adapter.syncFromSandbox(sandbox.workspace)).rejects.toThrow('linked or special');
  await expect(opfs.adapter.syncToSandbox(sandbox.workspace)).rejects.toThrow('linked or special');
  await opfs.files.rm('/workspace', { recursive: true });
  await opfs.files.mkdir('/outside-dir');
  await opfs.files.symlink('/outside-dir', '/workspace');
  await expect(opfs.adapter.syncFromSandbox(sandbox.workspace)).rejects.toThrow('existing directory');
});

it('rejects unreadable or malformed sources before any destination changes', async () => {
  const opfs = await setup();
  const sandbox = await setup();
  await opfs.files.writeFile('/workspace/keep', 'original');
  await sandbox.files.writeFile('/workspace/keep', 'new');
  await sandbox.files.writeFile('/workspace/fail', 'unreadable');
  const readFile = sandbox.workspace.readFile;
  sandbox.workspace.readFile = (path) => (path === 'fail' ? Promise.reject(new Error('read failure')) : readFile(path));
  await expect(opfs.adapter.syncFromSandbox(sandbox.workspace)).rejects.toThrow('read failure');
  expect(await opfs.files.readFile('/workspace/keep')).toBe('original');
  for (const name of ['', '.', '..', '../outside', 'bad\0name']) {
    sandbox.workspace.readDir = () => Promise.resolve([{ name, kind: 'file', size: 0 }]);
    await expect(opfs.adapter.syncFromSandbox(sandbox.workspace)).rejects.toThrow('Invalid workspace');
  }
  sandbox.workspace.readDir = () => Promise.reject(new Error('listing failure'));
  await expect(opfs.adapter.syncFromSandbox(sandbox.workspace)).rejects.toThrow('listing failure');
  expect(await opfs.files.readFile('/workspace/keep')).toBe('original');
  await opfs.files.rm('/workspace', { recursive: true });
  await expect(opfs.adapter.syncToSandbox(sandbox.workspace)).rejects.toThrow();
});

it('preflights destination names and stops stale deletion after a write failure', async () => {
  const opfs = await setup();
  const sandbox = await setup();
  await opfs.files.writeFile('/workspace/new', 'data');
  await sandbox.files.writeFile('/workspace/stale', 'keep on failure');
  const remove = vi.spyOn(sandbox.workspace, 'remove');
  const readDir = sandbox.workspace.readDir;
  sandbox.workspace.readDir = () => Promise.resolve([{ name: '../escape', kind: 'file', size: 0 }]);
  await expect(opfs.adapter.syncToSandbox(sandbox.workspace)).rejects.toThrow('Invalid workspace');
  expect(remove).not.toHaveBeenCalled();
  sandbox.workspace.readDir = readDir;
  sandbox.workspace.writeFile = () => Promise.reject(new Error('write failure'));
  await expect(opfs.adapter.syncToSandbox(sandbox.workspace)).rejects.toThrow('write failure');
  expect(remove).not.toHaveBeenCalled();
  expect(await sandbox.files.readFile('/workspace/stale')).toBe('keep on failure');
});

it('rejects unsupported entries and unbounded directory recursion before mutations', async () => {
  const opfs = await setup();
  const sandbox = await setup();
  await opfs.files.writeFile('/workspace/keep', 'original');
  sandbox.workspace.readDir = () => Promise.resolve([{ name: 'loop', kind: 'directory', size: 0 }]);
  await expect(opfs.adapter.syncFromSandbox(sandbox.workspace)).rejects.toThrow('64 directory levels');
  sandbox.workspace.readDir = () => Promise.resolve([{ name: 'device', kind: 'special' as 'file', size: 0 }]);
  await expect(opfs.adapter.syncFromSandbox(sandbox.workspace)).rejects.toThrow('Unsupported workspace');
  expect(await opfs.files.readFile('/workspace/keep')).toBe('original');
});
