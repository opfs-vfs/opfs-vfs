import { afterEach, describe, expect, it } from 'vitest';
import { deleteVolume, volumeFileNames } from '../volume-files';
import { mountProfileMismatch, preparePluginRequests } from '../worker-plugins';
import { peekVolume } from '../peek-volume';
import { registryTestRequest } from './registry-test-plugin';

const workers: Worker[] = [];
const names: string[] = [];
const fileName = () => {
  const name = `registry-${crypto.randomUUID()}.bin`;
  names.push(name);
  return name;
};
const worker = (entry: 'core' | 'plugin' = 'plugin') => {
  const instance =
    entry === 'core'
      ? new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' })
      : new Worker(new URL('./registry-test-worker.ts', import.meta.url), { type: 'module' });
  workers.push(instance);
  return instance;
};
let nextId = 0;
function send(instance: Worker, type: string, payload: Record<string, unknown> = {}) {
  const id = ++nextId;
  return new Promise<{ type: string; result: unknown }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${type} timed out`)), 10_000);
    const onMessage = ({ data }: MessageEvent) => {
      if (data.id !== id) return;
      clearTimeout(timeout);
      instance.removeEventListener('message', onMessage);
      instance.removeEventListener('error', onError);
      resolve(data);
    };
    const onError = (event: ErrorEvent) => {
      clearTimeout(timeout);
      instance.removeEventListener('message', onMessage);
      instance.removeEventListener('error', onError);
      reject(new Error(event.message));
    };
    instance.addEventListener('message', onMessage);
    instance.addEventListener('error', onError);
    instance.postMessage({ id, type, payload });
  });
}
const init = (instance: Worker, payload: Record<string, unknown>) =>
  send(instance, 'INIT', { generation: crypto.randomUUID(), ...payload });
async function volumeFilesExist(name: string) {
  const root = await navigator.storage.getDirectory();
  return Promise.all(
    volumeFileNames(name).map(async (file) =>
      root.getFileHandle(file).then(
        () => true,
        () => false,
      ),
    ),
  );
}

afterEach(async () => {
  for (const instance of workers.splice(0)) instance.terminate();
  for (const name of names.splice(0)) await deleteVolume(name);
});

describe('worker plugin registry', () => {
  it('snapshots requests and rejects noncanonical profiles', () => {
    const request = registryTestRequest({ variant: 'b' });
    const { requests, profile } = preparePluginRequests([request], 'open-or-create', 'snapshot.bin');
    request.options.variant = 'a';
    expect(requests[0]?.options).toMatchObject({ variant: 'b' });
    expect(profile.plugins).toEqual([{ id: 'registry-test', contractVersion: 1, compatibilityKey: 'registry-test:b' }]);
    expect(mountProfileMismatch(profile, profile)).toBeUndefined();
    expect(mountProfileMismatch({ ...profile, extra: true }, profile)).toBe('VFS_PROTOCOL_MISMATCH');
    expect(mountProfileMismatch({ version: 1, plugins: profile.plugins }, profile)).toBe('VFS_PROTOCOL_MISMATCH');
    expect(mountProfileMismatch({ version: 2, plugins: profile.plugins }, profile)).toBe('VFS_PROTOCOL_MISMATCH');
    expect(mountProfileMismatch({ version: 2, capabilities: [], plugins: profile.plugins }, profile)).toBe(
      'VFS_PROTOCOL_MISMATCH',
    );
    expect(
      mountProfileMismatch(
        { ...profile, capabilities: ['error-details', 'future-capability', 'persistence-status'] },
        profile,
      ),
    ).toBeUndefined();
    expect(
      mountProfileMismatch(
        {
          ...profile,
          plugins: [{ id: 'registry-test', contractVersion: 1, compatibilityKey: 'registry-test:b', extra: true }],
        },
        profile,
      ),
    ).toBe('VFS_PLUGIN_MISMATCH');
    expect(
      mountProfileMismatch(
        { ...profile, plugins: [{ id: 'registry-test', contractVersion: 1, compatibilityKey: 'other' }] },
        profile,
      ),
    ).toBe('VFS_PLUGIN_MISMATCH');
    expect(() =>
      preparePluginRequests([registryTestRequest({ createOnly: true })], 'open-existing', 'snapshot.bin'),
    ).toThrow('requires create-new');
    expect(() =>
      preparePluginRequests([{ ...registryTestRequest(), options: { callback() {} } }], undefined, 'snapshot.bin'),
    ).toThrow('structured-cloneable');
    expect(() =>
      preparePluginRequests(
        [{ id: 'registry-test', contractVersion: 1, compatibilityKey: 'x' }],
        undefined,
        'snapshot.bin',
      ),
    ).toThrow('Invalid plugin request');
  });

  it('rejects bad requests and reserved INIT fields', async () => {
    const instance = worker();
    const valid = registryTestRequest();
    for (const plugins of [
      [valid, valid],
      [{ ...valid, contractVersion: 2 }],
      [{ ...valid, compatibilityKey: 'forged' }],
      [{ ...valid, id: 'missing' }],
      [{ ...valid, options: { variant: 'unknown' } }],
      [{ ...registryTestRequest({ createOnly: true }), requiredOpenMode: undefined }],
      [{ ...valid, requiredOpenMode: 'create-new' }],
    ]) {
      const name = fileName();
      const response = await init(instance, { fileName: name, plugins, openMode: 'create-new' });
      expect(response.type).toBe('ERROR');
      expect(await volumeFilesExist(name)).toEqual(volumeFileNames(name).map(() => false));
    }
    for (const extra of [{ storageFactory: () => {} }, { importOwnerToken: 'secret' }, { encryption: 'secret' }]) {
      // Functions cannot cross postMessage, so use a serializable sentinel here.
      const fields = 'storageFactory' in extra ? { storageFactory: true } : extra;
      const name = fileName();
      expect((await init(instance, { fileName: name, ...fields })).type).toBe('ERROR');
      expect(await volumeFilesExist(name)).toEqual(volumeFileNames(name).map(() => false));
    }
    const name = fileName();
    expect((await send(instance, 'INIT', { fileName: name })).type).toBe('ERROR');
    expect((await init(worker('core'), { fileName: name, plugins: [valid] })).type).toBe('ERROR');
    expect(await volumeFilesExist(name)).toEqual(volumeFileNames(name).map(() => false));
  });

  it('preserves stable plugin error codes without exposing option data', async () => {
    const response = await init(worker(), {
      fileName: fileName(),
      plugins: [registryTestRequest({ failCode: 'PLUGIN_OPTION_INVALID' })],
    });
    expect(response).toMatchObject({ type: 'ERROR', result: { code: 'PLUGIN_OPTION_INVALID' } });
    expect((response.result as { error: string }).error).toContain('Invalid worker plugin options: registry-test');
    expect((response.result as { error: string }).error).not.toContain('Secret plugin options');
  });

  it('preserves corruption details on an INIT mount failure', async () => {
    const response = await init(worker(), {
      fileName: fileName(),
      plugins: [registryTestRequest({ failCorruption: true })],
    });
    expect(response).toMatchObject({
      type: 'ERROR',
      result: {
        error: 'VFS init failed: Test corruption',
        name: 'VfsCorruptionError',
        category: 'meta-snapshot',
        offset: 128,
      },
    });
  });

  it('sanitizes throwing and changing plugin error code getters', async () => {
    for (const [failCode, code] of [
      ['throw-code-getter', 'EINVAL'],
      ['changing-code-getter', 'PLUGIN_OPTION_INVALID'],
    ]) {
      const response = await init(worker(), {
        fileName: fileName(),
        plugins: [registryTestRequest({ failCode })],
      });
      expect(response).toMatchObject({ type: 'ERROR', result: { code } });
      expect((response.result as { error: string }).error).not.toContain('Secret code getter');
    }
  });

  it('rejects reused plugin state before closing the current mount', async () => {
    const instance = worker();
    const name = fileName();
    const plugins = [registryTestRequest({ reuse: true })];
    expect((await init(instance, { fileName: name, plugins })).type).toBe('INIT');
    await send(instance, 'MKDIR', { path: '/live' });
    expect((await init(instance, { fileName: name, plugins })).type).toBe('ERROR');
    expect((await send(instance, 'EXISTS', { path: '/live' })).result).toBe(true);
    await send(instance, 'CLOSE_VFS');
  });

  it('rejects a repeated live owner generation before replacing the mount', async () => {
    const instance = worker();
    const name = fileName();
    const generation = crypto.randomUUID();
    expect((await init(instance, { fileName: name, generation })).type).toBe('INIT');
    await send(instance, 'MKDIR', { path: '/live' });
    expect(await init(instance, { fileName: name, generation })).toMatchObject({
      type: 'ERROR',
      result: { code: 'EINVAL' },
    });
    expect((await send(instance, 'EXISTS', { path: '/live' })).result).toBe(true);
    await send(instance, 'CLOSE_VFS');
  });

  it('mounts the validated snapshot without rereading plugin getters', async () => {
    const instance = worker();
    const response = await init(instance, {
      fileName: fileName(),
      plugins: [registryTestRequest({ snapshotOnly: true })],
    });
    expect(response.type).toBe('INIT');
    expect((await send(instance, 'MKDIR', { path: '/snapshot' })).type).toBe('MKDIR');
    expect((await send(instance, 'CLOSE_VFS')).type).toBe('CLOSE_VFS');
  });

  it('accepts matching create-new and keeps a live mount after invalid reinit', async () => {
    const name = fileName();
    const instance = worker();
    const request = registryTestRequest({ createOnly: true, variant: 'b' });
    const first = await init(instance, { fileName: name, openMode: 'create-new', plugins: [request] });
    expect(first).toMatchObject({
      type: 'INIT',
      result: {
        profile: {
          version: 2,
          capabilities: ['error-details', 'persistence-status'],
          plugins: [{ id: 'registry-test', contractVersion: 1, compatibilityKey: 'registry-test:b' }],
        },
      },
    });
    expect((await send(instance, 'MKDIR', { path: '/still-live' })).type).toBe('MKDIR');
    const bad = await init(instance, { fileName: name, openMode: 'open-existing', plugins: [request] });
    expect(bad.type).toBe('ERROR');
    expect((await send(instance, 'EXISTS', { path: '/still-live' })).result).toBe(true);
    for (const payload of [
      { fileName: 'invalid' },
      { fileName: fileName(), sab: new SharedArrayBuffer(1) },
      { fileName: fileName(), sab: new SharedArrayBuffer(64) },
      { fileName: fileName(), sab: new SharedArrayBuffer(67) },
    ]) {
      expect((await init(instance, payload)).type).toBe('ERROR');
      expect((await send(instance, 'EXISTS', { path: '/still-live' })).result).toBe(true);
      if (payload.fileName !== 'invalid') expect((await peekVolume(payload.fileName)).exists).toBe(false);
    }
    const another = fileName();
    const second = await init(instance, { fileName: another, openMode: 'create-new', plugins: [request] });
    expect(second.type).toBe('INIT'); // A reusable registration must return fresh configured state.
    expect((await send(instance, 'CLOSE_VFS')).type).toBe('CLOSE_VFS');
  });
});
