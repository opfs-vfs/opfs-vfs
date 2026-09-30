import { Cause, Deferred, Effect, Exit, Fiber } from 'effect';
import { describe, expect, it } from 'vitest';
import { Volume, VolumeError, type VolumeService } from './index.js';

const service = (sync: VolumeService['sync']): VolumeService => ({
  fileName: 'test.bin',
  sync,
  persistence: Effect.succeed({ state: 'clean', error: null }),
  acknowledgeOwnerChange: Effect.void,
});

const syncFailure = new VolumeError({
  kind: 'persistence',
  operation: 'sync',
  fileName: 'test.bin',
  outcome: 'unknown',
  code: 'VFS_SYNC_OWNER_CHANGED',
  details: null,
});

describe('Volume.withSync', () => {
  it('syncs once after the whole operation and preserves its result', async () => {
    const calls: string[] = [];
    const result = { saved: true };
    const volume = service(
      Effect.sync(() => {
        calls.push('sync');
      }),
    );
    const effect = Effect.gen(function* () {
      yield* Effect.sync(() => {
        calls.push('first write');
      });
      yield* Effect.sync(() => {
        calls.push('second write');
      });
      return result;
    });
    expect(await Effect.runPromise(effect.pipe(Volume.withSync, Effect.provideService(Volume.Volume, volume)))).toBe(
      result,
    );
    expect(calls).toEqual(['first write', 'second write', 'sync']);
  });

  it('preserves failure, defect and interruption without syncing', async () => {
    let syncs = 0;
    const volume = service(
      Effect.sync(() => {
        syncs++;
      }),
    );
    for (const effect of [Effect.fail('write failed'), Effect.die('defect'), Effect.failCause(Cause.interrupt(123))]) {
      const expected = await Effect.runPromiseExit(effect);
      const actual = await Effect.runPromiseExit(
        effect.pipe(Volume.withSync, Effect.provideService(Volume.Volume, volume)),
      );
      expect(actual).toEqual(expected);
    }
    expect(syncs).toBe(0);
  });

  it('propagates the original sync error after the operation has run', async () => {
    let wrote = false;
    const exit = await Effect.runPromiseExit(
      Effect.sync(() => {
        wrote = true;
      }).pipe(Volume.withSync, Effect.provideService(Volume.Volume, service(Effect.fail(syncFailure)))),
    );
    expect(wrote).toBe(true);
    expect(exit).toEqual(Exit.fail(syncFailure));
  });

  it('captures the outer volume and does not suppress nested syncs', async () => {
    const calls: string[] = [];
    const outer = service(
      Effect.sync(() => {
        calls.push('outer');
      }),
    );
    const inner = service(
      Effect.sync(() => {
        calls.push('inner');
      }),
    );
    await Effect.runPromise(
      Effect.void.pipe(
        Volume.withSync,
        Effect.provideService(Volume.Volume, inner),
        Volume.withSync,
        Effect.provideService(Volume.Volume, outer),
      ),
    );
    expect(calls).toEqual(['inner', 'outer']);
  });

  it('allows interruption while sync is waiting', async () => {
    let completed = false;
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const sync = Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Effect.never;
          completed = true;
        });
        const fiber = yield* Effect.forkChild(
          Effect.succeed(42).pipe(Volume.withSync, Effect.provideService(Volume.Volume, service(sync))),
        );
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(fiber);
        return yield* Fiber.await(fiber);
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(completed).toBe(false);
  });
});
