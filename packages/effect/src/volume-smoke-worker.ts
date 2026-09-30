import { Effect } from 'effect';
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
          yield* volume.sync;
          return yield* volume.persistence;
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
