import { ByteSize, Effect, Stream } from 'effect';
import { OpfsFileSystem, Volume } from '@opfs-vfs/effect';

export const streamFile = (fileName = `effect-stream-${crypto.randomUUID()}.bin`) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const volume = yield* Volume.make({ fileName, transport: 'dedicated' });
        const fs = OpfsFileSystem.make(volume);
        const source = new Uint8Array(16 * 1024 * 1024 + 1);
        source.fill(7);
        yield* fs.writeFile('/source.bin', source);
        const sink = fs.sink('/copy.bin', { flag: 'w' });
        yield* Stream.run(fs.stream('/source.bin', { chunkSize: 64 * 1024 }), sink);
        yield* volume.sync;
        const copy = yield* fs.open('/copy.bin', { flag: 'r' });
        return ByteSize.toBigInt((yield* copy.stat).size);
      }),
    ),
  );
