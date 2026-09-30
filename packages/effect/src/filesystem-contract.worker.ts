import { Effect, Scope } from 'effect';
import { deleteVolume } from '@opfs-vfs/opfs-vfs';
import { Volume } from './index.js';
import type { VolumeService } from './volume.js';
import { OpfsFileSystem } from './filesystem.js';
import { runFilesystemContract } from './filesystem-contract.js';

self.onmessage = async ({ data }: MessageEvent<{ mode: 'direct' | 'worker' }>) => {
  const fileName = `effect-conformance-${crypto.randomUUID()}.bin`;
  const root = `/${crypto.randomUUID()}`;
  try {
    const run = (makeVolume: Effect.Effect<VolumeService, unknown, Scope.Scope>) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const volume = yield* makeVolume;
            const fs = OpfsFileSystem.make(volume);
            yield* fs.makeDirectory(root, { recursive: true });
            const canonicalRoot = yield* fs.realPath(root);
            return yield* runFilesystemContract(fs, {
              root: canonicalRoot,
              path: (...parts) => [canonicalRoot.replace(/\/$/, ''), ...parts].join('/'),
            });
          }),
        ),
      );
    const result = await (data.mode === 'direct'
      ? run(Volume.makeDirect({ fileName }))
      : run(
          Volume.make({
            fileName,
            transport: 'dedicated',
            worker: () => new Worker(new URL('../../opfs-vfs/src/worker.ts', import.meta.url), { type: 'module' }),
          }),
        ));
    await deleteVolume(fileName);
    self.postMessage({ ok: true, result });
  } catch (error) {
    await deleteVolume(fileName).catch(() => {});
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
