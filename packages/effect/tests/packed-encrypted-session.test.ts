import { deleteVolume } from '@opfs-vfs/opfs-vfs';
import type { Exit } from 'effect';
import { expect, it, vi } from 'vitest';

const examplePath = (import.meta as unknown as { env?: Record<string, string> }).env
  ?.VITE_PACKED_EFFECT_ENCRYPTED_SESSION;

type Example = typeof import('../examples/encrypted-session');
type Runtime = ReturnType<Example['makeSessionRuntime']>;
const load = async (): Promise<Example> => (await import(/* @vite-ignore */ examplePath!)) as Example;

const secret = (example: Awaited<ReturnType<typeof load>>, value: string) => example.Redacted.make(value);
const fileName = (prefix: string) => `effect-${prefix}-${crypto.randomUUID()}.bin`;
const dispose = async (example: Example, runtime: Runtime) => example.Effect.runPromiseExit(runtime.disposeEffect);

const exampleRuntime = async (example: Example, config: Parameters<Example['makeSessionRuntime']>[0]) =>
  example.makeSessionRuntime(config);

const start = async (example: Example, runtime: Runtime) => {
  const started = await example.startSessionRuntime(runtime);
  expect(started._tag).toBe('Started');
  return runtime;
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const failingFinalizer = (example: Example) => {
  class Probe extends example.Context.Service<Probe, {}>()('test/DisposalFailureProbe') {}
  return example.Layer.effect(
    Probe,
    example.Effect.gen(function* () {
      yield* example.Effect.addFinalizer(() => example.Effect.die(new Error('controlled-disposal-failure')));
      return {};
    }),
  );
};

const credentialCause = (example: Example, exit: Exit.Exit<unknown, unknown>) => {
  if (exit._tag !== 'Failure' || exit.cause.reasons.length !== 1) return undefined;
  const reason = exit.cause.reasons[0];
  if (reason?._tag !== 'Fail' || !example.PlatformError.isPlatformError(reason.error)) return undefined;
  const wrapper = reason.error.reason.cause;
  return example.Schema.is(example.VolumeError)(wrapper) &&
    wrapper.kind === 'lifecycle' &&
    example.Schema.is(example.EncryptionError)(wrapper.cause) &&
    wrapper.cause.reason === 'CredentialsRejected'
    ? { platform: reason.error, wrapper, encryption: wrapper.cause }
    : undefined;
};

it.skipIf(!examplePath)(
  'mounts the four explicit plugin profiles and both combined request orders',
  async () => {
    const example = await load();
    const profiles = [
      { profile: 'plain' as const, encrypted: false },
      { profile: 'subscriptions' as const, encrypted: false },
      { profile: 'encrypted' as const, encrypted: true },
      { profile: 'combined' as const, encrypted: true, order: 'encryption-first' as const },
      { profile: 'combined' as const, encrypted: true, order: 'subscriptions-first' as const },
    ];
    for (const entry of profiles) {
      const name = fileName(entry.profile);
      const runtime = await exampleRuntime(example, {
        fileName: name,
        profile: entry.profile,
        openMode: 'create-new',
        ...(entry.encrypted ? { secret: secret(example, 'profile-secret-never-log-this') } : {}),
        ...(entry.order ? { order: entry.order } : {}),
      });
      try {
        await start(example, runtime);
        const result = await runtime.runPromise(
          example.Effect.gen(function* () {
            const fs = yield* example.FileSystem.FileSystem;
            yield* fs.writeFileString('/profile.txt', entry.profile);
            return yield* fs.readFileString('/profile.txt');
          }),
        );
        expect(result).toBe(entry.profile);
        expect((await example.Effect.runPromise(example.Volume.inspect(name))).encrypted).toBe(entry.encrypted);
        if (entry.profile === 'combined') await runtime.runPromise(example.acceptReconciledSave);
        if (entry.profile === 'subscriptions' || entry.profile === 'combined') {
          const received = await runtime.runPromise(
            example.Effect.scoped(
              example.Effect.gen(function* () {
                const service = yield* example.Subscriptions.Subscriptions;
                const fs = yield* example.FileSystem.FileSystem;
                const subscription = yield* service.subscribe({ path: '/', scope: 'directory', recursive: true });
                yield* fs.writeFileString('/notice.txt', 'change');
                const change = yield* example.Stream.runHead(subscription.changes);
                return { change, retirement: yield* subscription.retired };
              }),
            ),
          );
          expect(received.change?._tag).toBe('Some');
          if (received.change?._tag === 'Some') expect(received.change.value.type).toBe('create');
          expect(received.retirement.status).toBe('released');
        }
      } finally {
        await dispose(example, runtime);
        await deleteVolume(name);
      }
    }
  },
  120_000,
);

it.skipIf(!examplePath)(
  'inspects before open, never creates a missing existing volume, and limits passkeys to creation',
  async () => {
    const example = await load();
    const missing = fileName('missing-existing');
    const openMissing = await example.startSessionRuntime(
      example.makeSessionRuntime({
        fileName: missing,
        profile: 'encrypted',
        openMode: 'open-existing',
        secret: secret(example, 'missing-secret'),
      }),
    );
    expect(openMissing._tag).toBe('StartFailed');
    if (openMissing._tag === 'StartFailed') {
      const reason = openMissing.startExit._tag === 'Failure' ? openMissing.startExit.cause.reasons[0] : undefined;
      expect(
        reason?._tag === 'Fail' && example.Schema.is(example.VolumeError)(reason.error) ? reason.error.code : undefined,
      ).toBe('ENOENT');
    }
    expect((await example.Effect.runPromise(example.Volume.inspect(missing))).exists).toBe(false);

    const name = fileName('passkey-create');
    const runtime = example.ManagedRuntime.make(
      example.createEncryptedLayer(name, secret(example, 'recovery-secret'), new Uint8Array(32).fill(0x5a)),
    );
    try {
      await start(example, runtime);
      expect((await example.Effect.runPromise(example.Volume.inspect(name))).encrypted).toBe(true);
    } finally {
      await dispose(example, runtime);
    }

    const wrongSecret = secret(example, 'wrong-secret-must-not-leak');
    const failedOpenRuntime = example.ManagedRuntime.make(
      example
        .makeSessionLayer({ fileName: name, profile: 'encrypted', openMode: 'open-existing', secret: wrongSecret })
        .pipe(example.Layer.provideMerge(failingFinalizer(example))),
    );
    const failedOpen = await example.startSessionRuntime(failedOpenRuntime);
    expect(failedOpen._tag).toBe('StartFailed');
    if (failedOpen._tag === 'StartFailed') {
      expect(failedOpen.disposeExit._tag).toBe('Success');
      expect(failedOpen.startExit._tag).toBe('Failure');
      if (failedOpen.startExit._tag === 'Failure') {
        expect(
          failedOpen.startExit.cause.reasons.some(
            (reason) =>
              reason._tag === 'Fail' &&
              example.Schema.is(example.EncryptionError)(reason.error) &&
              reason.error.reason === 'CredentialsRejected',
          ),
        ).toBe(true);
        expect(
          failedOpen.startExit.cause.reasons.some(
            (reason) => reason._tag === 'Die' && String(reason.defect).includes('controlled-disposal-failure'),
          ),
        ).toBe(true);
        expect(JSON.stringify(failedOpen.startExit.cause)).not.toContain('wrong-secret-must-not-leak');
      }
    }
    await deleteVolume(name);
    await deleteVolume(missing);
  },
  60_000,
);

it.skipIf(!examplePath)(
  'rejects an incompatible live plugin profile without downgrading an encrypted volume',
  async () => {
    const example = await load();
    const name = fileName('profile-mismatch');
    const owner = await exampleRuntime(example, {
      fileName: name,
      profile: 'combined',
      openMode: 'create-new',
      secret: secret(example, 'mismatch-owner-secret'),
    });
    try {
      await start(example, owner);
      const mismatch = await example.startSessionRuntime(
        example.makeSessionRuntime({ fileName: name, profile: 'subscriptions', openMode: 'open-existing' }),
      );
      expect(mismatch._tag).toBe('StartFailed');
      if (mismatch._tag === 'StartFailed' && mismatch.startExit._tag === 'Failure') {
        const reason = mismatch.startExit.cause.reasons[0];
        expect(reason?._tag).toBe('Fail');
        if (reason?._tag === 'Fail')
          expect(example.Schema.is(example.VolumeError)(reason.error) ? reason.error.code : undefined).toBe(
            'VFS_PLUGIN_MISMATCH',
          );
      }
      expect((await example.Effect.runPromise(example.Volume.inspect(name))).encrypted).toBe(true);
      expect(
        await owner.runPromise(
          example.Effect.gen(function* () {
            const fs = yield* example.FileSystem.FileSystem;
            yield* fs.writeFileString('/owner-still-open.txt', 'encrypted');
            return yield* fs.readFileString('/owner-still-open.txt');
          }),
        ),
      ).toBe('encrypted');
    } finally {
      await dispose(example, owner);
      await deleteVolume(name);
    }
  },
  60_000,
);

it.skipIf(!examplePath)(
  'keeps live integrity failure distinct from terminal authentication and sanitizes the failure',
  async () => {
    const example = await load();
    const name = fileName('integrity');
    const secretText = 'private-recovery-secret-do-not-serialize';
    const payload = 'private-file-payload-do-not-serialize';
    const writer = await exampleRuntime(example, {
      fileName: name,
      profile: 'encrypted',
      openMode: 'create-new',
      secret: secret(example, secretText),
    });
    try {
      await start(example, writer);
      await writer.runPromise(
        example.Effect.gen(function* () {
          const fs = yield* example.FileSystem.FileSystem;
          const volume = yield* example.Volume.Volume;
          yield* fs.writeFileString('/proof', payload);
          yield* volume.sync;
        }),
      );
    } finally {
      await dispose(example, writer);
    }

    const tamper = new Worker(new URL('./encrypted-tamper.worker.ts', import.meta.url), { type: 'module' });
    const tampered = await new Promise<boolean>((resolve) => {
      tamper.onmessage = (event: MessageEvent<{ readonly ok: boolean }>) => resolve(event.data.ok);
      tamper.onerror = () => resolve(false);
      tamper.postMessage({ fileName: name, offset: 4096 });
    }).finally(() => tamper.terminate());
    expect(tampered).toBe(true);

    const reader = await exampleRuntime(example, {
      fileName: name,
      profile: 'encrypted',
      openMode: 'open-existing',
      secret: secret(example, secretText),
    });
    try {
      await start(example, reader);
      const readExit = await reader.runPromiseExit(
        example.Effect.gen(function* () {
          const fs = yield* example.FileSystem.FileSystem;
          return yield* fs.readFileString('/proof');
        }),
      );
      expect(readExit._tag).toBe('Failure');
      if (readExit._tag === 'Failure') {
        const reason = readExit.cause.reasons[0];
        expect(reason?._tag).toBe('Fail');
        if (reason?._tag === 'Fail') {
          expect(example.PlatformError.isPlatformError(reason.error)).toBe(true);
          if (example.PlatformError.isPlatformError(reason.error)) {
            expect(reason.error.reason._tag).toBe('InvalidData');
            expect(example.Volume.errorOf(reason.error)).toMatchObject({
              _tag: 'EncryptionError',
              reason: 'IntegrityFailure',
            });
            const serialized = JSON.stringify({
              outer: reason.error,
              cause: reason.error.reason.cause,
              decoded: example.Volume.errorOf(reason.error),
            });
            expect(serialized).not.toContain(secretText);
            expect(serialized).not.toContain(payload);
            expect(serialized).not.toContain('private-recovery-secret');
          }
        }
      }
      const persistence = await reader.runPromiseExit(
        example.Effect.gen(function* () {
          const volume = yield* example.Volume.Volume;
          return yield* volume.persistence;
        }),
      );
      expect(persistence._tag).toBe('Success');
    } finally {
      await dispose(example, reader);
      await deleteVolume(name);
    }
  },
  90_000,
);

it.skipIf(!examplePath)(
  'attaches a wrong-secret follower, makes takeover terminal, then replaces only after disposal',
  async () => {
    const example = await load();
    const name = fileName('takeover');
    const good = secret(example, 'correct-secret-never-log-this');
    const owner = await exampleRuntime(example, {
      fileName: name,
      profile: 'combined',
      openMode: 'create-new',
      secret: good,
    });
    let follower: Awaited<ReturnType<typeof exampleRuntime>> | undefined;
    let controller: ReturnType<typeof example.makeSessionController> | undefined;
    let releaseCredentials = () => {};
    try {
      await start(example, owner);
      await owner.runPromise(
        example.Effect.gen(function* () {
          const fs = yield* example.FileSystem.FileSystem;
          const volume = yield* example.Volume.Volume;
          yield* fs.writeFileString('/session-save.txt', 'owner-saved-once');
          yield* volume.sync;
        }),
      );
      follower = await exampleRuntime(example, {
        fileName: name,
        profile: 'combined',
        openMode: 'open-existing',
        secret: secret(example, 'incorrect-secret-never-log-this'),
      });
      await start(example, follower);
      expect(
        await follower.runPromise(
          example.Effect.gen(function* () {
            const fs = yield* example.FileSystem.FileSystem;
            return yield* fs.readFileString('/session-save.txt');
          }),
        ),
      ).toBe('owner-saved-once');
      let prompted = 0;
      let enteredPrompt!: () => void;
      const promptEntered = new Promise<void>((resolve) => (enteredPrompt = resolve));
      const credentialsReleased = new Promise<void>((resolve) => (releaseCredentials = resolve));
      controller = example.makeSessionController(follower, { fileName: name, profile: 'combined' }, async (error) => {
        prompted++;
        expect(error.reason).toBe('CredentialsRejected');
        enteredPrompt();
        await credentialsReleased;
        return good;
      });
      const followerRuntime = controller.runtime();
      expect(followerRuntime).toBe(follower);
      await dispose(example, owner);

      let terminalExit: unknown;
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const exit = await follower.runPromiseExit(
          example.Effect.gen(function* () {
            const fs = yield* example.FileSystem.FileSystem;
            return yield* fs.readFileString('/session-save.txt');
          }),
        );
        const decoded = credentialCause(example, exit);
        if (decoded) {
          terminalExit = exit;
          expect(example.Volume.errorOf(decoded.platform)).toBe(decoded.encryption);
          expect(decoded.wrapper.outcome).toBe('unknown');
          break;
        }
        await wait(50);
      }
      expect(terminalExit).toBeDefined();

      const replacement = controller.save('must-not-replay-this-save');
      const queuedBeforeReplacement = controller.save('queued-before-credential-prompt');
      await Promise.race([
        promptEntered,
        wait(20_000).then(() => {
          throw new Error('credential prompt did not run');
        }),
      ]);
      const deniedDuringReplacement = controller.save('queued-during-replacement');
      releaseCredentials();
      const replaced = await replacement;
      expect(replaced._tag).toBe('Replaced');
      expect(prompted).toBe(1);
      if (replaced._tag === 'Replaced') {
        expect(replaced.useExit._tag).toBe('Failure');
        expect(replaced.disposeExit._tag).toBe('Success');
        expect(replaced.startExit._tag).toBe('Success');
        if (replaced.useExit._tag === 'Failure') expect(credentialCause(example, replaced.useExit)).toBeDefined();
      }
      expect((await queuedBeforeReplacement)._tag).toBe('Unavailable');
      expect((await deniedDuringReplacement)._tag).toBe('Unavailable');
      const replacementRuntime = controller.runtime();
      expect(replacementRuntime).toBeDefined();
      expect(
        await replacementRuntime!.runPromise(
          example.Effect.gen(function* () {
            const fs = yield* example.FileSystem.FileSystem;
            return yield* fs.readFileString('/session-save.txt');
          }),
        ),
      ).toBe('owner-saved-once');
    } finally {
      releaseCredentials();
      if (controller) await controller.close();
      else if (follower) await dispose(example, follower);
      await dispose(example, owner);
      await deleteVolume(name);
    }
  },
  120_000,
);

it.skipIf(!examplePath)(
  'keeps a session unavailable when disposal fails after terminal credential failure',
  async () => {
    const example = await load();
    const name = fileName('dispose-failure');
    const owner = await exampleRuntime(example, {
      fileName: name,
      profile: 'combined',
      openMode: 'create-new',
      secret: secret(example, 'right-secret'),
    });
    let follower: Awaited<ReturnType<typeof exampleRuntime>> | undefined;
    let controller: ReturnType<typeof example.makeSessionController> | undefined;
    try {
      await start(example, owner);
      follower = example.ManagedRuntime.make(
        example.Layer.mergeAll(
          example.makeSessionLayer({
            fileName: name,
            profile: 'combined',
            openMode: 'open-existing',
            secret: secret(example, 'wrong-secret'),
          }),
          failingFinalizer(example),
        ),
      );
      await start(example, follower);
      controller = example.makeSessionController(follower, { fileName: name, profile: 'combined' }, async () => {
        throw new Error('credentials must not be requested before disposal succeeds');
      });
      await dispose(example, owner);
      const deadline = Date.now() + 20_000;
      let terminal = false;
      while (Date.now() < deadline) {
        const exit = await follower.runPromiseExit(
          example.Effect.gen(function* () {
            const fs = yield* example.FileSystem.FileSystem;
            return yield* fs.readFileString('/missing.txt');
          }),
        );
        if (credentialCause(example, exit)) {
          terminal = true;
          break;
        }
        await wait(50);
      }
      expect(terminal).toBe(true);
      const result = await controller.save('never-replay');
      expect(result._tag).toBe('ReplacementBlocked');
      if (result._tag === 'ReplacementBlocked') {
        expect(result.useExit._tag).toBe('Failure');
        expect(result.disposeExit._tag).toBe('Failure');
      }
      expect(controller.runtime()).toBeUndefined();
      expect((await controller.save('rejected'))._tag).toBe('Unavailable');
    } finally {
      if (controller) await controller.close();
      else if (follower) await dispose(example, follower);
      await dispose(example, owner);
      await deleteVolume(name);
    }
  },
  120_000,
);

it.skipIf(!examplePath)(
  'leaves the session unavailable when credential collection is cancelled',
  async () => {
    const example = await load();
    const name = fileName('cancel-credentials');
    const owner = await exampleRuntime(example, {
      fileName: name,
      profile: 'combined',
      openMode: 'create-new',
      secret: secret(example, 'owner-secret'),
    });
    let follower: Runtime | undefined;
    let controller: ReturnType<typeof example.makeSessionController> | undefined;
    try {
      await start(example, owner);
      follower = await exampleRuntime(example, {
        fileName: name,
        profile: 'combined',
        openMode: 'open-existing',
        secret: secret(example, 'follower-wrong-secret'),
      });
      await start(example, follower);
      controller = example.makeSessionController(follower, { fileName: name, profile: 'combined' }, async (error) => {
        expect(error.reason).toBe('CredentialsRejected');
        return undefined;
      });
      await dispose(example, owner);
      const deadline = Date.now() + 20_000;
      let terminal = false;
      while (Date.now() < deadline) {
        const exit = await follower.runPromiseExit(
          example.Effect.gen(function* () {
            const fs = yield* example.FileSystem.FileSystem;
            return yield* fs.readFileString('/missing.txt');
          }),
        );
        if (credentialCause(example, exit)) {
          terminal = true;
          break;
        }
        await wait(50);
      }
      expect(terminal).toBe(true);
      const result = await controller.save('cancelled-save-is-not-replayed');
      expect(result._tag).toBe('ReplacementCancelled');
      if (result._tag === 'ReplacementCancelled') {
        expect(result.useExit._tag).toBe('Failure');
        expect(result.disposeExit._tag).toBe('Success');
      }
      expect(controller.runtime()).toBeUndefined();
      expect((await controller.save('must-remain-unavailable'))._tag).toBe('Unavailable');
    } finally {
      if (controller) await controller.close();
      else if (follower) await dispose(example, follower);
      await dispose(example, owner);
      await deleteVolume(name);
    }
  },
  120_000,
);

it.skipIf(!examplePath)(
  'shares one saved layer while distinct named-volume scopes close independently',
  async () => {
    const example = await load();
    const sharedName = fileName('shared-layer');
    const shared = example.ManagedRuntime.make(example.makeSharedNamedFileSystems(sharedName));
    try {
      await start(example, shared);
      const services = await shared.runPromise(
        example.Effect.gen(function* () {
          return { documents: yield* example.DocumentsFs, cache: yield* example.CacheFs };
        }),
      );
      expect(services.documents.volume).toBe(services.cache.volume);
      let closeCalls = 0;
      const backend = example.Volume.unsafeBackend(services.documents.volume) as { closeVfs: () => Promise<void> };
      const close = backend.closeVfs.bind(backend);
      backend.closeVfs = async () => {
        closeCalls++;
        return close();
      };
      const sharedDispose = await dispose(example, shared);
      expect(sharedDispose._tag).toBe('Success');
      expect(closeCalls).toBe(1);
    } finally {
      await dispose(example, shared);
      await deleteVolume(sharedName);
    }

    const documentsName = fileName('documents');
    const cacheName = fileName('cache');
    const documents = example.ManagedRuntime.make(example.makeDocumentsFileSystem(documentsName));
    const cache = example.ManagedRuntime.make(example.makeCacheFileSystem(cacheName));
    try {
      await start(example, documents);
      await start(example, cache);
      await documents.runPromise(
        example.Effect.gen(function* () {
          const app = yield* example.DocumentsFs;
          yield* app.fs.writeFileString('/same.txt', 'documents');
        }),
      );
      await cache.runPromise(
        example.Effect.gen(function* () {
          const app = yield* example.CacheFs;
          yield* app.fs.writeFileString('/same.txt', 'cache');
        }),
      );
      expect(
        await documents.runPromise(
          example.Effect.gen(function* () {
            const app = yield* example.DocumentsFs;
            return yield* app.fs.readFileString('/same.txt');
          }),
        ),
      ).toBe('documents');
      expect(
        await cache.runPromise(
          example.Effect.gen(function* () {
            const app = yield* example.CacheFs;
            return yield* app.fs.readFileString('/same.txt');
          }),
        ),
      ).toBe('cache');
      await dispose(example, documents);
      expect(
        await cache.runPromise(
          example.Effect.gen(function* () {
            const app = yield* example.CacheFs;
            return yield* app.fs.readFileString('/same.txt');
          }),
        ),
      ).toBe('cache');
    } finally {
      await dispose(example, documents);
      await dispose(example, cache);
      await deleteVolume(documentsName);
      await deleteVolume(cacheName);
    }
  },
  60_000,
);

it.skipIf(!examplePath)(
  'reopens an enrolled passkey volume and refuses create-new when occupied',
  async () => {
    const example = await load();
    const name = fileName('passkey-reopen');
    const passkey = new Uint8Array(32).fill(0x71);
    const created = example.ManagedRuntime.make(
      example.createEncryptedLayer(name, secret(example, 'recovery-secret'), passkey),
    );
    let reopened: Runtime | undefined;
    try {
      await start(example, created);
      await created.runPromise(
        example.Effect.gen(function* () {
          const fs = yield* example.FileSystem.FileSystem;
          yield* fs.writeFileString('/proof', 'passkey-readable');
          yield* (yield* example.Volume.Volume).sync;
        }),
      );
      await dispose(example, created);
      reopened = example.makeSessionRuntime({
        fileName: name,
        profile: 'encrypted',
        openMode: 'open-existing',
        secret: example.Redacted.make(passkey),
      });
      await start(example, reopened);
      expect(
        await reopened.runPromise(
          example.Effect.gen(function* () {
            return yield* (yield* example.FileSystem.FileSystem).readFileString('/proof');
          }),
        ),
      ).toBe('passkey-readable');

      const occupied = await example.startSessionRuntime(
        example.makeSessionRuntime({
          fileName: name,
          profile: 'encrypted',
          openMode: 'create-new',
          secret: secret(example, 'another-recovery-secret'),
        }),
      );
      expect(occupied._tag).toBe('StartFailed');
      if (occupied._tag === 'StartFailed' && occupied.startExit._tag === 'Failure') {
        const reason = occupied.startExit.cause.reasons.find(
          (entry) => entry._tag === 'Fail' && example.Schema.is(example.VolumeError)(entry.error),
        );
        expect(
          reason?._tag === 'Fail' && example.Schema.is(example.VolumeError)(reason.error)
            ? reason.error.code
            : undefined,
        ).toBe('EEXIST');
      }
    } finally {
      if (reopened) await dispose(example, reopened);
      await dispose(example, created);
      await deleteVolume(name);
    }
  },
  60_000,
);

it.skipIf(!examplePath)(
  'rejects an import reservation before opening',
  async () => {
    const example = await load();
    const name = fileName('importing');
    const marker = name.replace(/\.bin$/, '.importing');
    const root = await navigator.storage.getDirectory();
    await root.getFileHandle(marker, { create: true });
    try {
      const started = await example.startSessionRuntime(
        example.makeSessionRuntime({ fileName: name, profile: 'plain', openMode: 'open-existing' }),
      );
      expect(started._tag).toBe('StartFailed');
      if (started._tag === 'StartFailed' && started.startExit._tag === 'Failure') {
        const reason = started.startExit.cause.reasons.find(
          (entry) => entry._tag === 'Fail' && example.Schema.is(example.VolumeError)(entry.error),
        );
        expect(
          reason?._tag === 'Fail' && example.Schema.is(example.VolumeError)(reason.error)
            ? reason.error.code
            : undefined,
        ).toBe('VOLUME_IMPORTING');
      }
    } finally {
      await root.removeEntry(marker);
      await deleteVolume(name);
    }
  },
  60_000,
);

it.skipIf(!examplePath)(
  'keeps all exits when a terminal follower rejects replacement credentials',
  async () => {
    const example = await load();
    const name = fileName('failed-replacement');
    const owner = example.makeSessionRuntime({
      fileName: name,
      profile: 'combined',
      openMode: 'create-new',
      secret: secret(example, 'correct-secret'),
    });
    let follower: Runtime | undefined;
    let controller: ReturnType<Example['makeSessionController']> | undefined;
    let releaseClose = () => {};
    try {
      await start(example, owner);
      await owner.runPromise(
        example.Effect.gen(function* () {
          yield* (yield* example.FileSystem.FileSystem).writeFileString('/session-save.txt', 'unchanged');
          yield* (yield* example.Volume.Volume).sync;
        }),
      );
      follower = example.makeSessionRuntime({
        fileName: name,
        profile: 'combined',
        openMode: 'open-existing',
        secret: secret(example, 'wrong-secret'),
      });
      await start(example, follower);
      const backend = await follower.runPromise(
        example.Effect.gen(function* () {
          return example.Volume.unsafeBackend(yield* example.Volume.Volume);
        }),
      );
      await dispose(example, owner);
      await vi.waitFor(
        async () => {
          const exit = await follower!.runPromiseExit(
            example.Effect.gen(function* () {
              return yield* (yield* example.FileSystem.FileSystem).readFileString('/session-save.txt');
            }),
          );
          expect(credentialCause(example, exit)).toBeDefined();
        },
        { timeout: 20_000, interval: 20 },
      );
      const originalClose = backend.closeVfs.bind(backend);
      let enterClose = () => {};
      const closeEntered = new Promise<void>((resolve) => (enterClose = resolve));
      const closeReleased = new Promise<void>((resolve) => (releaseClose = resolve));
      let closed = false;
      Object.assign(backend, {
        closeVfs: async () => {
          enterClose();
          await closeReleased;
          await originalClose();
          closed = true;
        },
      });
      let prompts = 0;
      controller = example.makeSessionController(follower, { fileName: name, profile: 'combined' }, async () => {
        prompts++;
        expect(closed).toBe(true);
        return secret(example, 'still-wrong');
      });
      const replacement = controller.save('must-not-write');
      await closeEntered;
      expect(prompts).toBe(0);
      expect(controller.runtime()).toBeUndefined();
      const duringClose = controller.save('must-not-queue-across-session');
      releaseClose();
      const result = await replacement;
      expect(result._tag).toBe('ReplacementFailed');
      if (result._tag === 'ReplacementFailed') {
        expect(credentialCause(example, result.useExit)).toBeDefined();
        expect(result.disposeExit._tag).toBe('Success');
        expect(result.startExit._tag).toBe('Failure');
        expect(result.replacementDisposeExit._tag).toBe('Success');
      }
      expect(prompts).toBe(1);
      expect(controller.runtime()).toBeUndefined();
      expect((await duringClose)._tag).toBe('Unavailable');
      expect((await controller.save('after-failed-build'))._tag).toBe('Unavailable');
    } finally {
      releaseClose();
      if (controller) await controller.close();
      else if (follower) await dispose(example, follower);
      await dispose(example, owner);
      await deleteVolume(name);
    }
  },
  60_000,
);
