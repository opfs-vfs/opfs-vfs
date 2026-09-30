import { ByteSize, Effect } from 'effect';
import { deleteVolume, OpenFlags } from '@opfs-vfs/opfs-vfs';
import { subscriptions } from '@opfs-vfs/plugin-subscriptions';
import { Volume } from './index.js';
import { OpfsFileSystem } from './filesystem.js';

self.onmessage = async ({ data }: MessageEvent<{ example?: string }>) => {
  const fileName = `effect-${crypto.randomUUID()}.bin`;
  let pluginFile: string | undefined;
  let exampleFile: string | undefined;
  try {
    const before = await Effect.runPromise(Volume.inspect(fileName));
    const first = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.makeDirect({ fileName });
          const backend = Volume.unsafeBackend(volume);
          const fd = backend.openSync('/smoke.txt', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
          backend.writeSync(fd, new TextEncoder().encode('scoped direct volume'));
          backend.closeSync(fd);
          const fs = OpfsFileSystem.make(volume);
          yield* fs.writeFileString('/effect-fs.txt', 'scoped Effect FileSystem');
          yield* fs.makeDirectory('/namespace/tree/sub', { recursive: true, mode: 0o750 });
          yield* fs.writeFileString('/namespace/tree/sub/note', 'linked');
          yield* fs.symlink('sub/note', '/namespace/tree/link');
          yield* fs.symlink('/namespace', '/namespace/tree/jump');
          yield* fs.symlink('missing', '/namespace/dangling');
          const relativeLink = yield* fs.readLink('/namespace/tree/link');
          const danglingLink = yield* fs.readLink('/namespace/dangling');
          const realLink = yield* fs.realPath('/namespace/tree/link');
          const listing = yield* fs.readDirectory('/namespace/tree/', { recursive: true });
          yield* fs.utimes('/namespace/tree/sub/note', 1.25, new Date(2500));
          const times = yield* fs.stat('/namespace/tree/sub/note');
          yield* fs.link('/namespace/tree/sub/note', '/namespace/hard');
          yield* fs.rename('/namespace/hard', '/namespace/moved');
          yield* fs.truncate('/namespace/moved', 3);
          const metadata = yield* fs.stat('/namespace/moved');
          yield* fs.chmod('/namespace/moved', 0o400);
          const denied = yield* Effect.result(fs.access('/namespace/moved', { writable: true }));
          yield* fs.chmod('/namespace/moved', 0o200);
          const readDenied = yield* Effect.result(fs.access('/namespace/moved', { readable: true }));
          yield* fs.chmod('/namespace/moved', 0o600);
          yield* fs.access('/namespace/moved', { writable: true });
          const nonEmpty = yield* Effect.result(fs.remove('/namespace/tree'));
          const busy = yield* Effect.scoped(
            Effect.gen(function* () {
              yield* fs.open('/namespace/tree/sub/note');
              return yield* Effect.result(fs.remove('/namespace/tree', { recursive: true }));
            }),
          );
          yield* fs.remove('/namespace/tree', { recursive: true });
          yield* fs.remove('/namespace/missing', { force: true });
          const dangling = yield* Effect.result(fs.readFileString('/namespace/dangling'));
          yield* fs.symlink('cycle-b', '/namespace/cycle-a');
          yield* fs.symlink('cycle-a', '/namespace/cycle-b');
          const cycle = yield* Effect.result(fs.readFileString('/namespace/cycle-a'));
          const trailingSlash = yield* Effect.result(fs.stat('/namespace/moved/'));
          yield* fs.makeDirectory('/namespace/denied-tree/sub', { recursive: true });
          yield* fs.chmod('/namespace/denied-tree/sub', 0);
          const nestedDenied = yield* Effect.result(fs.readDirectory('/namespace/denied-tree', { recursive: true }));
          yield* volume.sync;
          return {
            persistence: yield* volume.persistence,
            namespace: {
              relativeLink,
              danglingLink,
              realLink,
              listing,
              metadata: {
                size: ByteSize.toBigInt(metadata.size).toString(),
                nlink: metadata.nlink._tag === 'Some' ? metadata.nlink.value : null,
              },
              times: {
                atimeMs: times.atime._tag === 'Some' ? times.atime.value.getTime() : null,
                mtimeMs: times.mtime._tag === 'Some' ? times.mtime.value.getTime() : null,
              },
              denied: denied._tag === 'Failure',
              readDenied: readDenied._tag === 'Failure',
              nestedDenied: nestedDenied._tag === 'Failure',
              nonEmpty: nonEmpty._tag === 'Failure',
              busy: busy._tag === 'Failure',
              dangling: dangling._tag === 'Failure',
              cycle: cycle._tag === 'Failure',
              trailingSlash: trailingSlash._tag === 'Failure',
            },
          };
        }),
      ),
    );
    const after = await Effect.runPromise(Volume.inspect(fileName));
    const reopened = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const volume = yield* Volume.makeDirect({ fileName, openMode: 'open-existing' });
          const backend = Volume.unsafeBackend(volume);
          const fd = backend.openSync('/smoke.txt', OpenFlags.O_RDONLY);
          const result = backend.readSync(fd, 64);
          backend.closeSync(fd);
          const fs = OpfsFileSystem.make(volume);
          return {
            content: new TextDecoder().decode(result.buffer.subarray(0, result.read)),
            fileSystemContent: yield* fs.readFileString('/effect-fs.txt'),
            persistence: yield* volume.persistence,
          };
        }),
      ),
    );
    const pluginName = `effect-plugin-${crypto.randomUUID()}.bin`;
    pluginFile = pluginName;
    const reusedPlugin = subscriptions();
    await Effect.runPromise(Effect.scoped(Volume.makeDirect({ fileName: pluginName, plugins: () => [reusedPlugin] })));
    const reused = await Effect.runPromise(
      Effect.flip(Effect.scoped(Volume.makeDirect({ fileName: pluginName, plugins: () => [reusedPlugin] }))),
    );
    if (reused._tag !== 'VolumeError' || reused.kind !== 'configuration' || reused.code !== 'EINVAL') {
      throw new Error('A configured direct plugin was reused without rejection');
    }
    const example = data.example ? await import(/* @vite-ignore */ data.example) : undefined;
    const exampleResult = example
      ? 'save' in example
        ? await Effect.runPromise((example as typeof import('../examples/direct.js')).save)
        : 'streamFile' in example
          ? await (example as typeof import('../examples/filesystem-stream.js')).streamFile(
              (exampleFile = `effect-stream-${crypto.randomUUID()}.bin`),
            )
          : await (example as typeof import('../examples/filesystem-save.js')).saveNote()
      : undefined;
    await deleteVolume(fileName);
    await deleteVolume(pluginFile);
    if (exampleFile) await deleteVolume(exampleFile);
    self.postMessage({ ok: true, before, after, first, reopened, example: { state: 'clean', result: exampleResult } });
  } catch (error) {
    await deleteVolume(fileName).catch(() => {});
    if (pluginFile) await deleteVolume(pluginFile).catch(() => {});
    if (exampleFile) await deleteVolume(exampleFile).catch(() => {});
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
