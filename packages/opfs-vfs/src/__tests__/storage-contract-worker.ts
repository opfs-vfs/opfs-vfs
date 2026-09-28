import { testPlugin } from './test-plugin';
import { OpenFlags, OpfsVfs, type OpfsVfsOptions } from '../opfs-vfs';
import type { ConfiguredVfsPlugin, VolumeStorageFactory, VolumeStorageOpenContext } from '../plugins';
import { deleteVolume, volumeFileNames } from '../volume-files';

type Check = { pass: boolean; detail: string };

const unique = (label: string) => `${label}-${crypto.randomUUID()}.bin`;
const sidecars = ['.vault', '.crypt', '.crypt.log'];

async function snapshot(root: FileSystemDirectoryHandle, name: string) {
  const files = new Map<string, Uint8Array>();
  for (const file of volumeFileNames(name)) {
    try {
      files.set(file, new Uint8Array(await (await (await root.getFileHandle(file)).getFile()).arrayBuffer()));
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error;
    }
  }
  return files;
}

function sameFiles(left: Map<string, Uint8Array>, right: Map<string, Uint8Array>) {
  return (
    left.size === right.size &&
    [...left].every(([name, bytes]) => {
      const other = right.get(name);
      return (
        other !== undefined && bytes.length === other.length && bytes.every((byte, index) => byte === other[index])
      );
    })
  );
}

async function rejects(run: () => Promise<unknown>, code: string) {
  try {
    await run();
    return false;
  } catch (error) {
    return (error as { code?: unknown }).code === code;
  }
}

function trackingFactory(
  events: string[],
  options: { throwBeforeData?: boolean; failAfterOpen?: boolean } = {},
): VolumeStorageFactory {
  return async ({ data }) => ({
    data,
    beforeDataCommit() {
      events.push('sidecar');
      if (options.throwBeforeData) throw new Error('sidecar failed');
    },
    validateAfterMetadata() {
      if (options.failAfterOpen) throw new Error('post-open failure');
    },
    destroy() {
      events.push('destroy');
    },
  });
}

async function markerChecks(root: FileSystemDirectoryHandle, checks: Check[]) {
  for (const suffix of sidecars) {
    const name = unique(`storage-marker-${suffix.slice(1)}`);
    const marker = name.replace(/\.bin$/, suffix);
    const writable = await (await root.getFileHandle(marker, { create: true })).createWritable();
    await writable.write(new Uint8Array([1, 2, 3]));
    await writable.close();
    const before = await snapshot(root, name);
    const missingFactory = await rejects(() => new OpfsVfs(name).ready, 'EINVAL');
    const unchanged = sameFiles(before, await snapshot(root, name));
    const unrelated = await rejects(
      () => new OpfsVfs(name, { plugins: [testPlugin(trackingFactory([]))] }).ready,
      'EINVAL',
    );
    const partial =
      suffix === '.vault' ||
      (await rejects(
        () => new OpfsVfs(name, { plugins: [testPlugin(trackingFactory([]), ['.vault'])] }).ready,
        'EINVAL',
      ));
    const createNew = await rejects(() => new OpfsVfs(name, { openMode: 'create-new' }).ready, 'EEXIST');
    checks.push({
      pass:
        missingFactory &&
        unchanged &&
        unrelated &&
        partial &&
        createNew &&
        sameFiles(before, await snapshot(root, name)),
      detail: `${suffix} fails closed unless a storage provider declares it`,
    });
    await deleteVolume(name);
  }
}

async function pluginChecks(root: FileSystemDirectoryHandle, checks: Check[]) {
  const raw = async ({ data }: Parameters<VolumeStorageFactory>[0]) => ({ data, destroy() {} });
  const valid = () => testPlugin(raw);
  const invalid: unknown[] = [
    null,
    {},
    [null],
    [{}],
    [{ ...valid(), id: '' }],
    [{ ...valid(), contractVersion: 2 }],
    [{ ...valid(), compatibilityKey: 1 }],
    [{ ...valid(), storage: undefined }],
    [{ ...valid(), storage: { factory: raw, sidecars: ['.meta.a'] } }],
    [{ ...valid(), storage: { factory: raw, sidecars: ['../secret'] } }],
    [{ ...valid(), storage: { factory: raw, sidecars: ['.importing'] } }],
    [{ ...valid(), storage: { factory: raw, sidecars: ['.vault', '.vault'] } }],
    [valid(), valid()],
    [valid(), { ...valid(), id: 'other' }],
    [{ ...valid(), requiredOpenMode: 'open-existing' }],
  ];
  for (const plugins of invalid) {
    const name = unique('invalid-plugin');
    const rejected = await rejects(() => new OpfsVfs(name, { plugins } as OpfsVfsOptions).ready, 'EINVAL');
    checks.push({
      pass: rejected && (await snapshot(root, name)).size === 0,
      detail: 'invalid plugins reject before files',
    });
  }
  const legacyName = unique('legacy-storage-factory');
  checks.push({
    pass:
      (await rejects(
        () => new OpfsVfs(legacyName, { storageFactory: raw } as unknown as OpfsVfsOptions).ready,
        'EINVAL',
      )) && (await snapshot(root, legacyName)).size === 0,
    detail: 'public storageFactory is rejected before files',
  });
  for (const openMode of [undefined, 'open-existing'] as const) {
    const name = unique('plugin-required-create');
    const plugin: ConfiguredVfsPlugin = { ...valid(), requiredOpenMode: 'create-new' };
    checks.push({
      pass:
        (await rejects(() => new OpfsVfs(name, { openMode, plugins: [plugin] }).ready, 'EINVAL')) &&
        (await snapshot(root, name)).size === 0,
      detail: 'creation-only plugin rejects incompatible open mode before files',
    });
  }
  for (const bufferMode of ['disk', 'memory'] as const) {
    const name = unique('plugin-roundtrip');
    const firstPlugin: ConfiguredVfsPlugin = { ...valid(), requiredOpenMode: 'create-new' };
    const vfs = new OpfsVfs(name, { bufferMode, openMode: 'create-new', plugins: [firstPlugin] });
    const concurrentName = unique('plugin-concurrent');
    const concurrent = await rejects(
      () => new OpfsVfs(concurrentName, { openMode: 'create-new', plugins: [firstPlugin] }).ready,
      'EINVAL',
    );
    await vfs.ready;
    const fd = vfs.openSync('/roundtrip', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
    vfs.writeSync(fd, new Uint8Array([42]));
    vfs.closeSync(fd);
    await vfs.closeVfs();
    const originalFactoryClone = { ...firstPlugin };
    Object.defineProperty(firstPlugin, 'storage', { value: valid().storage });
    const reusedName = unique('plugin-reused');
    const reused = await rejects(
      () => new OpfsVfs(reusedName, { openMode: 'create-new', plugins: [firstPlugin] }).ready,
      'EINVAL',
    );
    const factoryName = unique('factory-reused');
    const factoryReused = await rejects(
      () => new OpfsVfs(factoryName, { openMode: 'create-new', plugins: [originalFactoryClone] }).ready,
      'EINVAL',
    );
    checks.push({
      pass:
        concurrent &&
        reused &&
        factoryReused &&
        (await snapshot(root, concurrentName)).size === 0 &&
        (await snapshot(root, reusedName)).size === 0 &&
        (await snapshot(root, factoryName)).size === 0,
      detail: `${bufferMode}: configured instance and underlying factory cannot be reused`,
    });
    const reopened = new OpfsVfs(name, { bufferMode, openMode: 'open-existing', plugins: [valid()] });
    await reopened.ready;
    const readFd = reopened.openSync('/roundtrip', OpenFlags.O_RDONLY);
    checks.push({
      pass: reopened.readSync(readFd, 1).buffer[0] === 42,
      detail: `${bufferMode}: fresh plugin roundtrip`,
    });
    reopened.closeSync(readFd);
    await reopened.closeVfs();
    await deleteVolume(name);
  }
  const failing = testPlugin(async () => {
    throw new Error('setup failed');
  });
  const failedName = unique('plugin-failed');
  await new OpfsVfs(failedName, { plugins: [failing] }).ready.catch(() => undefined);
  const retryName = unique('plugin-failed-reuse');
  checks.push({
    pass:
      (await rejects(() => new OpfsVfs(retryName, { plugins: [failing] }).ready, 'EINVAL')) &&
      (await snapshot(root, retryName)).size === 0,
    detail: 'failed initialization consumes its configured plugin',
  });
  await deleteVolume(failedName);

  // Mutable caller objects must not change ownership or factory selection after construction.
  const suffixes: '.vault'[] = [];
  const name = unique('plugin-snapshot');
  const plugin = testPlugin(async (context) => {
    await context.openSidecar('.vault');
    return raw(context);
  }, suffixes);
  const mounting = new OpfsVfs(name, { plugins: [plugin] });
  suffixes.push('.vault');
  let refused = false;
  try {
    await mounting.ready;
  } catch {
    refused = true;
  }
  checks.push({
    pass: refused && !(await snapshot(root, name)).has(name.replace(/\.bin$/, '.vault')),
    detail: 'undeclared sidecars stay unavailable after caller mutates its array',
  });
  await deleteVolume(name);
}

async function sidecarChecks(root: FileSystemDirectoryHandle, checks: Check[]) {
  const undeclaredName = unique('undeclared-sidecar');
  let threw = false;
  let rejected = false;
  const undeclared = new OpfsVfs(undeclaredName, {
    plugins: [
      testPlugin(async (context) => {
        try {
          rejected = await context.openSidecar('.crypt').then(
            () => false,
            (error) => error instanceof TypeError && error.message === 'Unsupported storage sidecar suffix: .crypt',
          );
        } catch {
          threw = true;
        }
        return { data: context.data, destroy() {} };
      }),
    ],
  });
  await undeclared.ready;
  checks.push({
    pass: !threw && rejected,
    detail: 'undeclared sidecars return rejected promises instead of throwing synchronously',
  });
  await undeclared.closeVfs();
  await deleteVolume(undeclaredName);

  const name = unique('declared-sidecars');
  let opener!: VolumeStorageOpenContext['openSidecar'];
  const plugin = () =>
    testPlugin(
      async (context) => {
        opener = (suffix, create) => context.openSidecar(suffix, create);
        const vault = await context.openSidecar('.vault');
        vault.write(new Uint8Array([7]), { at: 0 });
        vault.flush();
        return { data: context.data, destroy() {} };
      },
      ['.vault', '.crypt'],
    );
  for (let i = 0; i < 2; i++) {
    const vfs = new OpfsVfs(name, { plugins: [plugin()] });
    await vfs.ready;
    let lateRejected = false;
    try {
      await opener('.crypt');
    } catch {
      lateRejected = true;
    }
    await vfs.closeVfs();
    const handle = await (await root.getFileHandle(name.replace(/\.bin$/, '.vault'))).createSyncAccessHandle();
    const bytes = new Uint8Array(1);
    handle.read(bytes, { at: 0 });
    handle.close();
    checks.push({
      pass: bytes[0] === 7 && lateRejected && !(await snapshot(root, name)).has(name.replace(/\.bin$/, '.crypt')),
      detail: 'declared sidecars open and release on close; late openers cannot acquire handles',
    });
  }
  await deleteVolume(name);

  const failingName = unique('parallel-sidecar-failure');
  const original = navigator.storage.getDirectory.bind(navigator.storage);
  const failure = new Error('one sidecar acquisition failed');
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  Object.defineProperty(navigator.storage, 'getDirectory', {
    configurable: true,
    value: async () =>
      new Proxy(root, {
        get(target, key) {
          if (key === 'getFileHandle')
            return async (file: string, options?: FileSystemGetFileOptions) => {
              if (options?.create && file === failingName.replace(/\.bin$/, '.vault')) throw failure;
              if (options?.create && file === failingName.replace(/\.bin$/, '.crypt')) {
                started();
                await gate;
              }
              return target.getFileHandle(file, options);
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
  });
  try {
    const vfs = new OpfsVfs(failingName, {
      plugins: [
        testPlugin(
          async (context) => {
            await Promise.all([context.openSidecar('.vault'), context.openSidecar('.crypt')]);
            return { data: context.data, destroy() {} };
          },
          ['.vault', '.crypt'],
        ),
      ],
    });
    let settled = false;
    const result = vfs.ready
      .then(
        () => undefined,
        (error: unknown) => error,
      )
      .finally(() => {
        settled = true;
      });
    await waiting;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const waitedForPendingHandle = !settled;
    release();
    const error = await result;
    const handle = await (await root.getFileHandle(failingName.replace(/\.bin$/, '.crypt'))).createSyncAccessHandle();
    handle.close();
    checks.push({
      pass: waitedForPendingHandle && error === failure,
      detail: 'failed parallel sidecar opens drain before releasing handles and preserve primary error',
    });
  } finally {
    release();
    Object.defineProperty(navigator.storage, 'getDirectory', { configurable: true, value: original });
    await deleteVolume(failingName);
  }
}

async function legacyOptionCheck(root: FileSystemDirectoryHandle, checks: Check[]) {
  const name = unique('storage-legacy-option');
  const before = await snapshot(root, name);
  const rejected = await rejects(
    () => new OpfsVfs(name, { encryption: { secret: 'legacy' } } as unknown as OpfsVfsOptions).ready,
    'EINVAL',
  );
  checks.push({
    pass: rejected && sameFiles(before, await snapshot(root, name)),
    detail: 'legacy core encryption rejects before create',
  });
}

async function securityErrorCheck(root: FileSystemDirectoryHandle, checks: Check[]) {
  const storage = navigator.storage;
  const original = storage.getDirectory.bind(storage);
  const name = unique('storage-security');
  let calls = 0;
  Object.defineProperty(storage, 'getDirectory', {
    configurable: true,
    value: async () =>
      new Proxy(root, {
        get(target, key) {
          if (key !== 'getFileHandle') return Reflect.get(target, key);
          return async (fileName: string, options?: FileSystemGetFileOptions) => {
            calls++;
            if (fileName.endsWith('.vault') && options?.create === false)
              throw new DOMException('denied', 'SecurityError');
            return target.getFileHandle(fileName, options);
          };
        },
      }),
  });
  try {
    const before = await snapshot(root, name);
    let propagated = false;
    try {
      await new OpfsVfs(name).ready;
    } catch (error) {
      propagated = error instanceof DOMException && error.name === 'SecurityError';
    }
    checks.push({
      pass: propagated && calls > 0 && sameFiles(before, await snapshot(root, name)),
      detail: 'sidecar SecurityError propagates without creates',
    });
  } finally {
    Object.defineProperty(storage, 'getDirectory', { configurable: true, value: original });
  }
}

async function hookChecks(checks: Check[]) {
  const events: string[] = [];
  const wrap =
    (events: string[]): NonNullable<OpfsVfsOptions['_wrapSyncAccessHandle']> =>
    (handle, tag) =>
      new Proxy(handle, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (key === 'flush')
            return (...args: unknown[]) => {
              events.push(`flush:${tag}`);
              return (value as (...args: unknown[]) => unknown).apply(target, args);
            };
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
  const ordered = new OpfsVfs(unique('storage-order'), {
    plugins: [testPlugin(trackingFactory(events))],
    _wrapSyncAccessHandle: wrap(events),
  });
  await ordered.ready;
  events.length = 0;
  const fd = ordered.openSync('/data', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
  ordered.writeSync(fd, new Uint8Array([1]));
  ordered.closeSync(fd);
  await ordered.closeVfs();
  checks.push({
    pass: events.indexOf('sidecar') >= 0 && events.indexOf('sidecar') < events.indexOf('flush:data'),
    detail: 'sidecar hook runs before data flush',
  });

  const failingEvents: string[] = [];
  const failingOptions: { throwBeforeData?: boolean } = {};
  const failing = new OpfsVfs(unique('storage-fail-flush'), {
    plugins: [testPlugin(trackingFactory(failingEvents, failingOptions))],
    _wrapSyncAccessHandle: wrap(failingEvents),
  });
  await failing.ready;
  failingEvents.length = 0;
  failingOptions.throwBeforeData = true;
  const badFd = failing.openSync('/data', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
  failing.writeSync(badFd, new Uint8Array([1]));
  failing.closeSync(badFd);
  let aborted = false;
  try {
    failing.flushVfs();
  } catch {
    aborted = true;
  }
  checks.push({
    pass: aborted && failingEvents.includes('sidecar') && !failingEvents.includes('flush:data'),
    detail: 'throwing sidecar hook aborts before data flush',
  });
  failingEvents.length = 0;
  failingOptions.throwBeforeData = false;
  await Promise.resolve(failing.closeVfs()).catch(() => undefined);
  checks.push({
    pass: failingEvents.includes('flush:data'),
    detail: 'failure observer records the successful retry flush',
  });

  const initEvents: string[] = [];
  const initFailure = new OpfsVfs(unique('storage-init-destroy'), {
    plugins: [testPlugin(trackingFactory(initEvents, { failAfterOpen: true }))],
  });
  let initRejected = false;
  try {
    await initFailure.ready;
  } catch {
    initRejected = true;
  }
  checks.push({
    pass: initRejected && initEvents.filter((event) => event === 'destroy').length === 1,
    detail: 'storage destroy runs after init failure',
  });

  const codecEvents: string[] = [];
  const identityCodec = {
    overheadBytes: 0,
    seal: (bytes: Uint8Array) => bytes,
    sealInto: (bytes: Uint8Array, _role: number, _identity: number, out: Uint8Array, outOffset: number) => {
      out.set(bytes, outOffset);
      return bytes.length;
    },
    open: (bytes: Uint8Array) => bytes,
  };
  const missingCycles = new OpfsVfs(unique('storage-codec-cycles'), {
    plugins: [
      testPlugin(async ({ data }) => ({
        data,
        recordCodec: identityCodec,
        destroy: () => codecEvents.push('destroy'),
      })),
    ],
  });
  let codecRejected = false;
  try {
    await missingCycles.ready;
  } catch (error) {
    codecRejected = (error as { code?: unknown }).code === 'EINVAL';
  }
  checks.push({
    pass: codecRejected && codecEvents.filter((event) => event === 'destroy').length === 1,
    detail: 'record codecs require WAL cycle hooks',
  });

  const closeEvents: string[] = [];
  const closing = new OpfsVfs(unique('storage-close-destroy'), { plugins: [testPlugin(trackingFactory(closeEvents))] });
  await closing.ready;
  await closing.closeVfs();
  checks.push({
    pass: closeEvents.filter((event) => event === 'destroy').length === 1,
    detail: 'storage destroy runs on close',
  });
}

self.onmessage = async () => {
  const checks: Check[] = [];
  try {
    const root = await navigator.storage.getDirectory();
    await markerChecks(root, checks);
    await legacyOptionCheck(root, checks);
    await securityErrorCheck(root, checks);
    await hookChecks(checks);
    await pluginChecks(root, checks);
    await sidecarChecks(root, checks);
    self.postMessage(checks);
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error) });
  }
};
