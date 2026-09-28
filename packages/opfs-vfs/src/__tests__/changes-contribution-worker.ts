import { OpfsVfs } from '../opfs-vfs';
import { deleteVolume } from '../volume-files';
import { changeTestPlugin, eventFrame, type ChangePluginState } from './changes-test-plugin';

const name = (label: string) => `${label}-${crypto.randomUUID()}.bin`;
const check = (pass: boolean, detail: string) => ({ pass, detail });
const closeDelete = async (vfs: OpfsVfs, volume: string) => {
  try {
    await vfs.closeVfs();
  } catch {}
  await deleteVolume(volume);
};

self.onmessage = async () => {
  const checks: { pass: boolean; detail: string }[] = [];
  try {
    const volume = name('changes');
    const state: ChangePluginState = { creates: 0, closes: [], controls: [] };
    const plugin = changeTestPlugin(state);
    const vfs = new OpfsVfs(volume, { plugins: [plugin] });
    try {
      (plugin.logicalChanges as { version: number }).version = 2;
      await vfs.ready;
      const received: string[] = [];
      let explicitlyClosed = 0;
      const first = await vfs.openFileChangeChannel(
        (frame) => received.push(frame.type),
        () => received.push('interrupted'),
        () => explicitlyClosed++,
      );
      const registered = await first.request({
        type: 'register',
        subscriptionId: 'a',
        options: { path: '/missing', scope: 'file', recursive: false, events: ['create'], content: false },
      });
      state.host!.send(state.client!, eventFrame('a'));
      first.close();
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      checks.push(
        check(
          state.creates === 1 &&
            state.receiverVersion === 1 &&
            registered.type === 'registered' &&
            received.length === 0 &&
            explicitlyClosed === 0,
          'snapshots the contribution and cancels deferred direct delivery',
        ),
      );

      const interruptions: string[] = [];
      const channel = await vfs.openFileChangeChannel(
        () => {
          throw new Error('ignored callback failure');
        },
        (code) => {
          interruptions.push(code);
          throw new Error('ignored interruption failure');
        },
        () => {},
      );
      await channel.request({
        type: 'register',
        subscriptionId: 'p',
        options: { path: '/missing', scope: 'file', recursive: false, events: ['create'], content: false },
      });
      vfs.mkdirSync('/link-target');
      vfs.symlinkSync('/link-target', '/link');
      const symlink = await channel
        .request({
          type: 'register',
          subscriptionId: 's',
          options: { path: '/link/child', scope: 'file', recursive: false, events: ['create'], content: false },
        })
        .then(
          () => false,
          (error) => error.code === 'EINVAL',
        );
      const stillUsable = await channel
        .request({
          type: 'register',
          subscriptionId: 'after-symlink',
          options: { path: '/missing', scope: 'file', recursive: false, events: ['create'], content: false },
        })
        .then(
          () => true,
          () => false,
        );
      vfs.mkdirSync('/private');
      vfs.chmodSync('/private', 0);
      const permission = await channel
        .request({
          type: 'register',
          subscriptionId: 'q',
          options: { path: '/private/child', scope: 'file', recursive: false, events: ['create'], content: false },
        })
        .then(
          () => false,
          (error) => error.code === 'EACCES',
        );
      const controls = state.controls.length;
      const sparseEvents = await channel
        .request({
          type: 'register',
          subscriptionId: 'sparse',
          options: {
            path: '/missing',
            scope: 'file',
            recursive: false,
            events: new Array(1) as unknown as ['create'],
            content: false,
          },
        })
        .then(
          () => false,
          (error) => error.code === 'EINVAL',
        );
      const usableAfterSparse = await channel
        .request({
          type: 'register',
          subscriptionId: 'after-sparse',
          options: { path: '/missing', scope: 'file', recursive: false, events: ['create'], content: false },
        })
        .then(
          () => true,
          () => false,
        );
      const sparseWithExtra = new Array(1) as unknown as ['create'] & { extra?: string };
      sparseWithExtra.extra = 'create';
      const sparseExtraEvents = await channel
        .request({
          type: 'register',
          subscriptionId: 'sparse-extra',
          options: {
            path: '/missing',
            scope: 'file',
            recursive: false,
            events: sparseWithExtra,
            content: false,
          },
        })
        .then(
          () => false,
          (error) => error.code === 'EINVAL',
        );
      const invalidContent = await channel
        .request({
          type: 'register',
          subscriptionId: 'too-large',
          options: {
            path: '/missing',
            scope: 'file',
            recursive: false,
            events: ['create'],
            content: { maxBytes: 16 * 1024 * 1024 + 1 },
          },
        })
        .then(
          () => false,
          (error) => error.code === 'EINVAL',
        );
      checks.push(
        check(
          symlink &&
            stillUsable &&
            permission &&
            sparseEvents &&
            usableAfterSparse &&
            sparseExtraEvents &&
            invalidContent &&
            state.controls.length === controls + 1,
          'validates literal targets and rejects malformed wire data before dispatch',
        ),
      );

      const nanEventsLength = await channel
        .request({
          type: 'register',
          subscriptionId: 'nan-events-length',
          options: {
            path: '/missing',
            scope: 'file',
            recursive: false,
            events: new Proxy(['create'], {
              get(target, key, receiver) {
                return key === 'length' ? NaN : Reflect.get(target, key, receiver);
              },
            }) as never,
            content: false,
          },
        })
        .then(
          () => false,
          (error) => error.code === 'EINVAL',
        );
      let lengthCoercions = 0;
      const changingEventsLength = await channel
        .request({
          type: 'register',
          subscriptionId: 'changing-events-length',
          options: {
            path: '/missing',
            scope: 'file',
            recursive: false,
            events: new Proxy(['create', 'update', 'delete', 'create'], {
              get(target, key, receiver) {
                if (key === 'length') return { valueOf: () => (++lengthCoercions <= 2 ? 1 : 4) };
                return Reflect.get(target, key, receiver);
              },
            }) as never,
            content: false,
          },
        })
        .then(
          () => false,
          (error) => error.code === 'EINVAL',
        );
      let ownKeysCalls = 0;
      const changingCommandKeys = await channel
        .request(
          new Proxy(
            { type: 'cancel', subscriptionId: 'changing-command-keys', deliveryId: 1 },
            {
              ownKeys(target) {
                return ++ownKeysCalls === 1 ? Reflect.ownKeys(target) : ['type', 'subscriptionId'];
              },
            },
          ) as never,
        )
        .then(
          () => false,
          (error) => error.code === 'EINVAL',
        );
      checks.push(
        check(
          nanEventsLength && changingEventsLength && changingCommandKeys && ownKeysCalls === 1,
          'rejects Proxy commands with unstable lengths or keys',
        ),
      );

      let typeReads = 0;
      let maxBytesReads = 0;
      const getterReply = await channel.request({
        get type() {
          return ++typeReads === 1 ? 'register' : 'cancel';
        },
        subscriptionId: 'getter',
        options: {
          path: '/missing',
          scope: 'file',
          recursive: false,
          events: ['create'],
          content: {
            get maxBytes() {
              return ++maxBytesReads === 1 ? 1024 : 2 ** 40;
            },
          },
        },
      } as never);
      const captured = state.controls[state.controls.length - 1];
      const usableAfterGetter = await channel.request({ type: 'cancel', subscriptionId: 'getter' }).then(
        () => true,
        () => false,
      );
      checks.push(
        check(
          getterReply.type === 'registered' &&
            typeReads === 1 &&
            maxBytesReads === 1 &&
            captured?.type === 'register' &&
            captured.options.content !== false &&
            captured.options.content.maxBytes === 1024 &&
            usableAfterGetter,
          'snapshots getter-backed commands before validation and dispatch',
        ),
      );

      const originalStructuredClone = globalThis.structuredClone;
      let structuredCloneCalls = 0;
      globalThis.structuredClone = ((...args: Parameters<typeof structuredClone>) => {
        structuredCloneCalls++;
        return originalStructuredClone(...args);
      }) as typeof structuredClone;
      let unknownPayload = false;
      try {
        unknownPayload = await channel
          .request({
            type: 'cancel',
            subscriptionId: 'extra-payload',
            extra: new ArrayBuffer(32 * 1024 * 1024),
          } as never)
          .then(
            () => false,
            (error) => error.code === 'EINVAL',
          );
      } finally {
        globalThis.structuredClone = originalStructuredClone;
      }
      checks.push(
        check(unknownPayload && structuredCloneCalls === 0, 'rejects unknown command fields without cloning them'),
      );

      state.throwControl = true;
      state.throwControlCode = 'EINVAL';
      const cancel = await channel.request({ type: 'cancel', subscriptionId: 'after-symlink' }).then(
        () => false,
        (error) => error.code === 'EINVAL',
      );
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      const poisoned = await vfs
        .openFileChangeChannel(
          () => {},
          () => {},
          () => {},
        )
        .then(
          () => false,
          (error) => error.code === 'ENOTSUP',
        );
      checks.push(
        check(
          cancel && poisoned && interruptions.includes('SUBSCRIPTION_RESYNC_REQUIRED') && state.closes.length === 1,
          'non-register EINVAL poisons and disposes the capability',
        ),
      );
    } finally {
      await closeDelete(vfs, volume);
      checks.push(check(state.closes.length === 1, 'direct session cleanup is exactly once'));
    }

    for (const reply of ['badReply', 'asyncReply'] as const) {
      const volume = name(reply);
      const state: ChangePluginState = { creates: 0, closes: [], controls: [], [reply]: true };
      const vfs = new OpfsVfs(volume, { plugins: [changeTestPlugin(state)] });
      try {
        await vfs.ready;
        const channel = await vfs.openFileChangeChannel(
          () => {},
          () => {},
          () => {},
        );
        const rejected = await channel.request({ type: 'cancel', subscriptionId: 'reply' }).then(
          () => false,
          (error) => error.code === 'EINVAL',
        );
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        const poisoned = await vfs
          .openFileChangeChannel(
            () => {},
            () => {},
            () => {},
          )
          .then(
            () => false,
            (error) => error.code === 'ENOTSUP',
          );
        checks.push(
          check(rejected && poisoned && state.closes.length === 1, `${reply} is contained and poisons the capability`),
        );
      } finally {
        await closeDelete(vfs, volume);
      }
    }

    const malformedCloseVolume = name('malformed-close');
    let malformedClosed = 0;
    const malformedClose = new OpfsVfs(malformedCloseVolume, {
      plugins: [
        {
          id: 'malformed-close',
          contractVersion: 1,
          compatibilityKey: 'malformed-close',
          logicalChanges: {
            version: 1,
            create: (() => ({
              close() {
                malformedClosed++;
                throw new Error('malformed close');
              },
            })) as never,
          },
        },
      ],
    });
    const malformedCloseRejected = await malformedClose.ready.then(
      () => false,
      (error) => error.code === 'EINVAL',
    );
    checks.push(
      check(
        malformedCloseRejected && malformedClosed === 1,
        'malformed session closes once during initialization failure',
      ),
    );
    await closeDelete(malformedClose, malformedCloseVolume);

    const malformedVolume = name('malformed-changes');
    let destroyed = 0;
    const malformed = new OpfsVfs(malformedVolume, {
      plugins: [
        {
          id: 'storage-before-changes',
          contractVersion: 1,
          compatibilityKey: 'storage-before-changes',
          storage: {
            sidecars: [],
            factory: async ({ data }) => ({
              data,
              destroy() {
                destroyed++;
              },
            }),
          },
        },
        {
          id: 'malformed-changes',
          contractVersion: 1,
          compatibilityKey: 'malformed-changes',
          logicalChanges: { version: 1, create: (() => Promise.resolve({})) as never },
        },
      ],
    });
    const malformedRejected = await malformed.ready.then(
      () => false,
      (error) => error.code === 'EINVAL',
    );
    checks.push(check(malformedRejected && destroyed === 1, 'malformed sessions release acquired storage'));
    await closeDelete(malformed, malformedVolume);

    for (const order of ['storage-first', 'changes-first'] as const) {
      const volume = name(order);
      const state: ChangePluginState = { creates: 0, closes: [], controls: [] };
      let opened = 0;
      const storage = {
        id: `storage-${order}`,
        contractVersion: 1,
        compatibilityKey: `storage-${order}`,
        storage: {
          sidecars: [],
          factory: async ({ data }: { data: unknown }) => {
            opened++;
            return { data, destroy() {} };
          },
        },
      } as never;
      const vfs = new OpfsVfs(volume, {
        plugins: order === 'storage-first' ? [storage, changeTestPlugin(state)] : [changeTestPlugin(state), storage],
      });
      await vfs.ready;
      await vfs.closeVfs();
      checks.push(
        check(
          opened === 1 && state.creates === 1 && state.closes.join() === 'close',
          `${order} mounts storage and changes`,
        ),
      );
      await deleteVolume(volume);
    }

    const normalCloseVolume = name('change-normal-close');
    const normalCloseState: ChangePluginState = { creates: 0, closes: [], controls: [] };
    const normalClose = new OpfsVfs(normalCloseVolume, { plugins: [changeTestPlugin(normalCloseState)] });
    await normalClose.ready;
    const deliveredBeforeClose: string[] = [];
    let normallyClosed = 0;
    const normalChannel = await normalClose.openFileChangeChannel(
      (frame) => deliveredBeforeClose.push(frame.type),
      () => {},
      () => normallyClosed++,
    );
    await normalChannel.request({
      type: 'register',
      subscriptionId: 'normal',
      options: { path: '/missing', scope: 'file', recursive: false, events: ['create'], content: false },
    });
    normalCloseState.host!.send(normalCloseState.client!, eventFrame('normal'));
    await normalClose.closeVfs();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    checks.push(
      check(
        deliveredBeforeClose.length === 0 &&
          normallyClosed === 1 &&
          (() => {
            try {
              normalCloseState.host!.validateTarget({ path: '/missing', scope: 'file', recursive: false });
              return false;
            } catch (error) {
              return (error as { code?: unknown }).code === 'EBADF';
            }
          })(),
        'normal close cancels pending delivery and reports channel disposal once',
      ),
    );
    await deleteVolume(normalCloseVolume);

    const reusedChangesVolume = name('change-plugin-reused');
    const reusedChangesSecondVolume = name('change-plugin-reused-second');
    const reusedChangesState: ChangePluginState = { creates: 0, closes: [], controls: [] };
    const reusedChangesPlugin = changeTestPlugin(reusedChangesState);
    const reusedChanges = new OpfsVfs(reusedChangesVolume, { plugins: [reusedChangesPlugin] });
    await reusedChanges.ready;
    let reuseRejected = false;
    try {
      new OpfsVfs(reusedChangesSecondVolume, { plugins: [reusedChangesPlugin] });
    } catch (error) {
      reuseRejected = (error as { code?: string }).code === 'EINVAL';
    }
    await reusedChanges.closeVfs();
    checks.push(check(reuseRejected, 'direct logical-change plugin objects cannot be reused'));
    await deleteVolume(reusedChangesVolume);
    await deleteVolume(reusedChangesSecondVolume);

    const initFailureVolume = name('change-init-close');
    const initState: ChangePluginState = { creates: 0, closes: [], controls: [], throwClose: true };
    let initDestroyed = 0;
    const originalAdd = globalThis.addEventListener;
    const initError = new Error('post-session initialization failed');
    (globalThis as { addEventListener?: typeof globalThis.addEventListener }).addEventListener = () => {
      throw initError;
    };
    const initFailure = new OpfsVfs(initFailureVolume, {
      plugins: [
        {
          id: 'init-storage',
          contractVersion: 1,
          compatibilityKey: 'init-storage',
          storage: {
            sidecars: [],
            factory: async ({ data }) => ({
              data,
              destroy() {
                initDestroyed++;
              },
            }),
          },
        },
        changeTestPlugin(initState),
      ],
    });
    const preserved = await initFailure.ready.then(
      () => false,
      (error) => error === initError,
    );
    (globalThis as { addEventListener?: typeof globalThis.addEventListener }).addEventListener = originalAdd;
    checks.push(
      check(
        preserved && initState.closes.join() === 'initialization-failed' && initDestroyed === 1,
        'post-session initialization failure preserves its error despite throwing cleanup',
      ),
    );
    await closeDelete(initFailure, initFailureVolume);

    const closeFailureVolume = name('change-close-failure');
    const closeState: ChangePluginState = { creates: 0, closes: [], controls: [], throwClose: true };
    const closeFailure = new OpfsVfs(closeFailureVolume, { plugins: [changeTestPlugin(closeState)] });
    await closeFailure.ready;
    let closedAfterFailure = 0;
    await closeFailure.openFileChangeChannel(
      () => {},
      () => {},
      () => closedAfterFailure++,
    );
    const firstClose = await Promise.resolve()
      .then(() => closeFailure.closeVfs())
      .then(
        () => false,
        () => true,
      );
    const secondClose = await Promise.resolve()
      .then(() => closeFailure.closeVfs())
      .then(
        () => true,
        () => false,
      );
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    checks.push(
      check(
        firstClose && secondClose && closeState.closes.join() === 'close' && closedAfterFailure === 1,
        'failed close cleans the session exactly once and closes clients',
      ),
    );
    await deleteVolume(closeFailureVolume);
    self.postMessage(checks);
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error) });
  }
};
