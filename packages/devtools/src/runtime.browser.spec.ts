import { expect, test, vi, type MockInstance } from 'vitest';
import { OpfsVfsWorker } from '@opfs-vfs/opfs-vfs/worker';
import { deleteVolume } from '@opfs-vfs/opfs-vfs';
import { DevtoolsSession } from './runtime';
import { importArchive } from './archive';
import JSZip from 'jszip';
const encode = (text: string) => new TextEncoder().encode(text);

test('terminal keeps cd between commands and creates relative files in that directory', async () => {
  const name = `devtools-shell-${crypto.randomUUID()}.bin`;
  const owner = new OpfsVfsWorker(name, { openMode: 'create-new' });
  const otherName = `devtools-shell-other-${crypto.randomUUID()}.bin`;
  const otherOwner = new OpfsVfsWorker(otherName, { openMode: 'create-new' });
  const session = new DevtoolsSession();
  try {
    await owner.ready;
    await otherOwner.ready;
    await session.refresh();
    await session.connect(name);
    session.setWrites(name, true);
    expect((await session.run(name, 'mkdir tmp')).exitCode).toBe(0);
    expect((await session.run(name, 'cd tmp')).exitCode).toBe(0);
    expect((await session.run(name, 'pwd')).stdout).toBe('/tmp\n');
    expect((await session.run(name, 'touch note.txt')).exitCode).toBe(0);
    expect(await owner.exists('/tmp/note.txt')).toBe(true);
    expect(await owner.exists('/note.txt')).toBe(false);
    expect(session.cwd(name)).toBe('/tmp');
    expect((await session.run(name, 'cd missing')).exitCode).toBe(1);
    expect((await session.run(name, '(cd /)')).exitCode).toBe(0);
    expect((await session.run(name, 'pwd')).stdout).toBe('/tmp\n');
    await session.connect(otherName);
    expect((await session.run(otherName, 'pwd')).stdout).toBe('/\n');
    expect((await session.run(name, 'pwd')).stdout).toBe('/tmp\n');
    expect((await session.run(name, 'cd /; false')).exitCode).toBe(1);
    expect((await session.run(name, 'pwd')).stdout).toBe('/\n');
    await session.run(name, 'cd tmp');
    await session.run(name, 'cd');
    expect((await session.run(name, 'pwd')).stdout).toBe('/\n');
  } finally {
    session.dispose();
    await owner.closeVfs();
    await otherOwner.closeVfs();
  }
}, 30000);

test('real application attachment, permissions, conditional saves, exclusive copies and owner loss', async () => {
  const name = `devtools-integration-${crypto.randomUUID()}.bin`;
  const owner = new OpfsVfsWorker(name, { openMode: 'create-new' });
  const session = new DevtoolsSession();
  try {
    await owner.ready;
    await owner.writeFileBuffer('/note.txt', encode('original'));
    await owner.mkdir('/destination');
    await owner.flush();
    expect((await session.refresh()).some((v) => v.name === name && v.state === 'application')).toBe(true);
    const root = await navigator.storage.getDirectory();
    let backingBytes = 0;
    for await (const [fileName, handle] of root.entries()) {
      if (handle.kind === 'file' && fileName.startsWith(name.slice(0, -4) + '.'))
        backingBytes += (await handle.getFile()).size;
    }
    expect(backingBytes).toBeGreaterThan(encode('original').length);
    expect(session.volumes.find((v) => v.name === name)?.storageBytes).toBe(backingBytes);
    await session.connect(name);
    await expect(session.mutate(name, { kind: 'file', parent: '/', name: 'blocked.txt' })).rejects.toThrow(
      'Enable writes',
    );
    expect(await owner.exists('/blocked.txt')).toBe(false);
    session.setWrites(name, true);
    for (const path of ['/.env', '/.env.local', '/app.conf', '/main.py', '/Dockerfile']) {
      await owner.writeFileBuffer(path, encode('SETTING=before\n'));
      const file = await session.read(name, path);
      expect(file.bytes).toBeUndefined();
      expect(file.content).toBe('SETTING=before\n');
      await session.save(name, file, 'SETTING=after\n');
      expect(new TextDecoder().decode(await owner.readFileBuffer(path))).toBe('SETTING=after\n');
    }
    await owner.writeFileBuffer('/invalid.conf', new Uint8Array([255]));
    expect((await session.read(name, '/invalid.conf')).bytes).toEqual(new Uint8Array([255]));
    await owner.writeFileBuffer('/bom.txt', new Uint8Array([239, 187, 191, 65]));
    const bom = await session.read(name, '/bom.txt');
    expect(bom.content).toBe('\uFEFFA');
    await session.save(name, bom, '\uFEFFB');
    expect([...(await owner.readFileBuffer('/bom.txt'))]).toEqual([239, 187, 191, 66]);
    const original = await session.read(name, '/note.txt');
    await owner.writeFileBuffer('/note.txt', encode('changed by app'));
    await expect(session.save(name, original, 'stale draft')).rejects.toThrow();
    expect(new TextDecoder().decode(await owner.readFileBuffer('/note.txt'))).toBe('changed by app');
    const fresh = await session.read(name, '/note.txt');
    await session.save(name, fresh, 'saved by devtools');
    expect((await session.run(name, 'cat /note.txt')).stdout).toBe('saved by devtools');
    const clip = await session.clipboard(name, '/note.txt', false);
    await owner.writeFileBuffer('/destination/note.txt', encode('must survive'));
    await expect(session.mutate(name, { kind: 'paste', parent: '/destination', clipboard: clip })).rejects.toThrow();
    expect(new TextDecoder().decode(await owner.readFileBuffer('/destination/note.txt'))).toBe('must survive');
    await session.mutate(name, { kind: 'folder', parent: '/', name: 'new-folder' });
    await session.mutate(name, { kind: 'paste', parent: '/new-folder', clipboard: clip });
    expect(new TextDecoder().decode(await owner.readFileBuffer('/new-folder/note.txt'))).toBe('saved by devtools');
    session.setWrites(name, false);
    await expect(session.run(name, 'printf denied > /blocked.txt')).rejects.toThrow('Enable writes');
    expect(await owner.exists('/blocked.txt')).toBe(false);
    session.dispose();
    await owner.writeFileBuffer('/after-detach.txt', encode('application is still alive'));
    expect(await owner.exists('/after-detach.txt')).toBe(true);
  } finally {
    session.dispose();
    await owner.closeVfs();
  }
}, 30000);

test('discovery totals all backing files, refreshes sizes, and never reports an unreadable partial total', async () => {
  const root = await navigator.storage.getDirectory();
  const base = `devtools-size-${crypto.randomUUID()}`;
  const suffixes = [
    '.bin',
    '.meta.a',
    '.meta.b',
    '.bitmap',
    '.meta.log',
    '.data.log',
    '.bootstrap',
    '.vault',
    '.crypt',
    '.crypt.log',
    '.meta',
  ];
  const files = suffixes.map((suffix, index) => [base + suffix, index + 1] as const);
  files.push([`${base}-other.bin`, 100], [`${base}.bin.bak`, 100], [`${base}-empty.bin`, 0]);
  const session = new DevtoolsSession();
  const write = async (name: string, bytes: number) => {
    const file = await root.getFileHandle(name, { create: true });
    const stream = await file.createWritable();
    await stream.write(new Uint8Array(bytes));
    await stream.close();
  };
  let unreadable: MockInstance<FileSystemFileHandle['getFile']> | undefined;
  try {
    for (const [name, bytes] of files) await write(name, bytes);
    const total = suffixes.reduce((sum, _, index) => sum + index + 1, 0);
    await session.refresh();
    expect(session.volumes.find((v) => v.name === `${base}.bin`)).toMatchObject({
      storageBytes: total,
      connection: 'none',
    });
    expect(session.volumes.find((v) => v.name === `${base}-empty.bin`)?.storageBytes).toBe(0);
    await write(`${base}.bin`, 1024);
    await session.refresh();
    expect(session.volumes.find((v) => v.name === `${base}.bin`)?.storageBytes).toBe(total + 1023);
    // Called with the original handle below.
    // oxlint-disable-next-line typescript/unbound-method
    const getFile = FileSystemFileHandle.prototype.getFile;
    let failed = false;
    unreadable = vi.spyOn(FileSystemFileHandle.prototype, 'getFile').mockImplementation(function (
      this: FileSystemFileHandle,
    ) {
      if (!failed && files.slice(0, suffixes.length).some(([name]) => name === this.name)) {
        failed = true;
        return Promise.reject(new DOMException('Unreadable backing file', 'NotReadableError'));
      }
      return getFile.call(this);
    });
    await session.refresh();
    expect(failed).toBe(true);
    expect(session.volumes.find((v) => v.name === `${base}.bin`)?.storageBytes).toBeUndefined();
    unreadable.mockRestore();
    await root.removeEntry(`${base}.bin`);
    await session.refresh();
    expect(session.volumes.find((v) => v.name === `${base}.bin`)?.storageBytes).toBe(total - 1);
  } finally {
    unreadable?.mockRestore();
    session.dispose();
    for (const [name] of files) await root.removeEntry(name).catch(() => {});
  }
}, 30000);

test('import markers remain visible and block advertised owners and retained connections', async () => {
  const id = crypto.randomUUID();
  const healthy = `devtools-healthy-${id}.bin`;
  const advertised = `devtools-advertised-${id}.bin`;
  const retained = `devtools-retained-${id}.bin`;
  const markerOnly = `devtools-marker-${id}.bin`;
  const root = await navigator.storage.getDirectory();
  const healthyOwner = new OpfsVfsWorker(healthy, { openMode: 'create-new' });
  const advertisedOwner = new OpfsVfsWorker(advertised, { openMode: 'create-new' });
  const session = new DevtoolsSession();
  const write = async (fileName: string, bytes: Uint8Array) => {
    const file = await root.getFileHandle(fileName, { create: true });
    const stream = await file.createWritable();
    await stream.write(new Uint8Array(bytes));
    await stream.close();
  };
  try {
    await Promise.all([healthyOwner.ready, advertisedOwner.ready]);
    await session.create(retained);
    await write(markerOnly.replace(/\.bin$/, '.importing'), encode('pending'));
    await write(advertised.replace(/\.bin$/, '.vault'), encode('protected'));
    await write(advertised.replace(/\.bin$/, '.importing'), encode('pending'));
    await write(retained.replace(/\.bin$/, '.importing'), encode('pending'));
    await expect(session.connect(retained)).rejects.toMatchObject({ code: 'VOLUME_IMPORTING' });
    expect(session.volumes.find((v) => v.name === retained)?.connection).toBe('none');
    await session.refresh();
    for (const name of [markerOnly, advertised, retained]) {
      expect(session.volumes.find((v) => v.name === name)).toMatchObject({
        state: 'busy',
        connection: 'none',
        error: 'Import in progress or incomplete.',
        files: [],
      });
      await expect(session.connect(name)).rejects.toMatchObject({ code: 'VOLUME_IMPORTING' });
    }
    expect(session.volumes.find((v) => v.name === markerOnly)?.storageBytes).toBe(7);
    expect(session.volumes.find((v) => v.name === advertised)?.storageBytes).toBeGreaterThan(7);
    expect(session.volumes.find((v) => v.name === healthy)?.state).toBe('application');
    await session.connect(healthy);
    expect(session.volumes.find((v) => v.name === healthy)?.connection).toBe('passive');
  } finally {
    session.dispose();
    await Promise.all([healthyOwner.closeVfs(), advertisedOwner.closeVfs()]);
    for (const name of [markerOnly, advertised, retained])
      await root.removeEntry(name.replace(/\.bin$/, '.importing')).catch(() => {});
    for (const name of [healthy, advertised, retained]) await deleteVolume(name).catch(() => {});
    await root.removeEntry(advertised.replace(/\.bin$/, '.vault')).catch(() => {});
  }
}, 30000);

test('inspection failures isolate one volume and keep healthy volumes discoverable', async () => {
  const id = crypto.randomUUID();
  const healthy = `devtools-good-${id}.bin`;
  const unreadable = `devtools-bad-${id}.bin`;
  const owners = [healthy, unreadable].map((name) => new OpfsVfsWorker(name, { openMode: 'create-new' }));
  const session = new DevtoolsSession();
  let spy: MockInstance<FileSystemFileHandle['getFile']> | undefined;
  try {
    for (const owner of owners) {
      await owner.ready;
      await owner.writeFileBuffer('/note.txt', encode('saved'));
      await owner.closeVfs();
    }
    // oxlint-disable-next-line typescript/unbound-method
    const getFile = FileSystemFileHandle.prototype.getFile;
    spy = vi.spyOn(FileSystemFileHandle.prototype, 'getFile').mockImplementation(function (this: FileSystemFileHandle) {
      if (this.name === unreadable.replace(/\.bin$/, '.meta.a'))
        return Promise.reject(new DOMException('Inspection denied', 'NotReadableError'));
      return getFile.call(this);
    });
    await session.refresh();
    expect(session.volumes.find((v) => v.name === unreadable)).toMatchObject({
      state: 'busy',
      connection: 'none',
      error: 'Inspection denied',
      files: [],
    });
    expect(session.volumes.find((v) => v.name === healthy)?.state).toBe('available');
    await session.connect(healthy);
  } finally {
    spy?.mockRestore();
    session.dispose();
    for (const name of [healthy, unreadable]) await deleteVolume(name).catch(() => {});
  }
}, 30000);

test('inspection failure hides a retained connection without terminating its dirty owner', async () => {
  const name = `devtools-retained-error-${crypto.randomUUID()}.bin`;
  const session = new DevtoolsSession();
  let spy: MockInstance<FileSystemFileHandle['getFile']> | undefined;
  let resumed: DevtoolsSession | undefined;
  let client: OpfsVfsWorker | undefined;
  try {
    await session.create(name);
    client = (session as unknown as { connections: Map<string, { client: OpfsVfsWorker }> }).connections.get(
      name,
    )!.client;
    await client.writeFileBuffer('/unflushed.txt', encode('keep me'));
    // oxlint-disable-next-line typescript/unbound-method
    const getFile = FileSystemFileHandle.prototype.getFile;
    spy = vi.spyOn(FileSystemFileHandle.prototype, 'getFile').mockImplementation(function (this: FileSystemFileHandle) {
      if (this.name === name.replace(/\.bin$/, '.meta.a'))
        return Promise.reject(new DOMException('Inspection denied', 'NotReadableError'));
      return getFile.call(this);
    });
    await session.refresh();
    expect(session.volumes.find((v) => v.name === name)).toMatchObject({
      state: 'busy',
      connection: 'none',
      error: 'Inspection denied',
      files: [],
    });
    await expect(session.read(name, '/unflushed.txt')).rejects.toThrow('Connect this volume first');
    expect(client.disposed).toBe(false);
    expect(new TextDecoder().decode(await client.readFileBuffer('/unflushed.txt'))).toBe('keep me');
    spy.mockRestore();
    spy = undefined;
    await session.refresh();
    expect(session.volumes.find((v) => v.name === name)?.connection).toBe('owned');
    session.setWrites(name, true);
    await session.mutate(name, { kind: 'file', parent: '/', name: 'recovered.txt' });
    resumed = new DevtoolsSession();
    await resumed.refresh();
    expect(resumed.volumes.find((v) => v.name === name)?.connection).toBe('owned');
    expect((await resumed.read(name, '/unflushed.txt')).content).toBe('keep me');
  } finally {
    spy?.mockRestore();
    session.dispose();
    resumed?.dispose();
    if (client && !client.disposed) await client.closeVfs();
    await deleteVolume(name).catch(() => {});
  }
}, 30000);

test('ZIP import rejects traversal and file/ancestor collisions before any storage writes', async () => {
  const invalid = new JSZip();
  invalid.file('parent', 'file');
  invalid.file('parent/child.txt', 'child');
  await expect(importArchive(await invalid.generateAsync({ type: 'blob' }))).rejects.toThrow();
  const traversal = new JSZip();
  traversal.file('../escape.txt', 'unsafe');
  await expect(importArchive(await traversal.generateAsync({ type: 'blob' }))).rejects.toThrow('Unsafe archive path');
  const valid = new JSZip();
  valid.file('folder/test.txt', 'contents');
  const plan = await importArchive(await valid.generateAsync({ type: 'blob' }));
  expect(plan.map((f) => f.path)).toEqual(['/folder', '/folder/test.txt']);
});

test('new volumes and ZIP imports use real exclusive worker creation', async () => {
  const session = new DevtoolsSession();
  const name = `devtools-created-${crypto.randomUUID()}.bin`;
  const imported = `devtools-imported-${crypto.randomUUID()}.bin`;
  try {
    await session.create(name);
    expect(session.volumes.find((v) => v.name === name)?.connection).toBe('owned');
    session.setWrites(name, true);
    await session.mutate(name, { kind: 'file', parent: '/', name: 'created.txt' });
    await expect(session.create(name)).rejects.toThrow();
    const zip = new JSZip();
    zip.file('nested/hello.txt', 'real import');
    await session.transfer('import', imported, new File([await zip.generateAsync({ type: 'blob' })], 'test.zip'));
    expect((await session.read(imported, '/nested/hello.txt')).content).toBe('real import');
    session.dispose();
    const remounted = new DevtoolsSession();
    try {
      await remounted.refresh();
      expect(remounted.volumes.find((v) => v.name === imported)?.connection).toBe('owned');
    } finally {
      remounted.dispose();
    }
  } finally {
    session.dispose();
  }
}, 30000);

test('a timed-out attachment can explicitly reconnect to the same healthy owner', async () => {
  const name = `devtools-timeout-${crypto.randomUUID()}.bin`;
  const owner = new OpfsVfsWorker(name, { openMode: 'create-new' });
  const session = new DevtoolsSession();
  await owner.ready;
  await owner.writeFileBuffer('/note.txt', encode('still here'));
  await owner.flush();
  await session.refresh();
  await session.connect(name);
  session.setWrites(name, true);
  const channel = (owner as unknown as { channel: BroadcastChannel }).channel;
  const post = channel.postMessage.bind(channel);
  channel.postMessage = (data) => {
    if (data.type !== 'OBSERVER_RESPONSE') post(data);
  };
  try {
    await expect(session.read(name, '/note.txt')).rejects.toThrow('unknown');
    channel.postMessage = post;
    await session.refresh();
    expect(session.volumes.find((v) => v.name === name)?.connection).toBe('none');
    await session.connect(name);
    expect((await session.read(name, '/note.txt')).content).toBe('still here');
    await expect(session.mutate(name, { kind: 'file', parent: '/', name: 'write-must-be-reset.txt' })).rejects.toThrow(
      'Enable writes',
    );
  } finally {
    channel.postMessage = post;
    session.dispose();
    await owner.closeVfs();
  }
}, 30000);
