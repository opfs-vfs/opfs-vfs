import { Effect } from 'effect';
import { Volume } from '../src/index.js';

export const save = Effect.gen(function* () {
  const volume = yield* Volume.makeDirect({ fileName: 'app.bin' });
  yield* volume.sync;
  return yield* volume.persistence;
}).pipe(Effect.scoped);
