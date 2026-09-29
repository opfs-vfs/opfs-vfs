import { deleteVolume } from '@opfs-vfs/opfs-vfs';
import type { ChangeFrame, FileChangeSource } from '@opfs-vfs/opfs-vfs/changes';
import { expect, it } from 'vitest';

const examplePath = (import.meta as unknown as { env?: Record<string, string> }).env
  ?.VITE_PACKED_EFFECT_RECONCILED_VIEW_EXAMPLE;

it.skipIf(!examplePath)(
  'runs the packed reconciliation example through real overflow recovery and shutdown',
  async () => {
    const example = (await import(/* @vite-ignore */ examplePath!)) as typeof import('../examples/reconciled-view');
    const fileName = `effect-packed-reconciled-${crypto.randomUUID()}.bin`;
    const { Effect, Fiber, FileSystem, Layer, Queue, Volume } = example;
    const live = example.makeLayer(fileName);

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const volume = yield* Volume.Volume;
            const views = yield* Queue.unbounded<ReadonlyArray<string>>();
            const stale = yield* Queue.unbounded<void>();
            const registrations = yield* Queue.unbounded<{ readonly id: string; readonly order: number }>();
            const terminals = yield* Queue.unbounded<string>();
            const terminalAckAt = new Map<string, number>();
            let order = 0;

            yield* fs.makeDirectory('/tree');
            yield* fs.makeDirectory('/tree/old');
            for (let index = 0; index < 2050; index++)
              yield* fs.writeFileString(`/tree/old/file-${index}.txt`, 'x');

            const source = Volume.unsafeBackend(volume) as unknown as FileChangeSource;
            const open = source.openFileChangeChannel.bind(source);
            source.openFileChangeChannel = async (receive, interrupted, closed) => {
              const observe = (frame: ChangeFrame) => {
                if (frame.type === 'terminal') Queue.offerUnsafe(terminals, frame.code);
                receive(frame);
              };
              const channel = await open(observe, interrupted, closed);
              return {
                ...channel,
                request: async (command) => {
                  const reply = await channel.request(command);
                  if (command.type === 'terminal-ack' && reply.type === 'ok')
                    terminalAckAt.set(command.subscriptionId, ++order);
                  if (command.type === 'register' && reply.type === 'registered')
                    Queue.offerUnsafe(registrations, { id: reply.subscriptionId, order: ++order });
                  return reply;
                },
              };
            };

            const watcher = yield* Effect.forkChild(
              example.keepViewCurrent({
                path: '/tree',
                publish: (paths) => Queue.offer(views, paths),
                markStale: () => Queue.offer(stale, undefined),
              }),
            );
            const first = yield* Queue.take(registrations);
            yield* Effect.yieldNow;
            expect(yield* Queue.take(views)).toContain('old/file-0.txt');

            yield* fs.writeFileString('/tree/during-watch.txt', 'current');
            let view = yield* Queue.take(views);
            while (!view.includes('during-watch.txt')) view = yield* Queue.take(views);

            yield* fs.rename('/tree/old', '/tree/new');
            expect(yield* Queue.take(terminals)).toBe('SUBSCRIPTION_OVERFLOW');
            yield* Queue.take(stale);
            const second = yield* Queue.take(registrations);
            expect(terminalAckAt.get(first.id)).toBeDefined();
            expect(terminalAckAt.get(first.id)!).toBeLessThan(second.order);

            yield* Effect.yieldNow;
            view = yield* Queue.take(views);
            while (!view.includes('new/file-0.txt')) view = yield* Queue.take(views);
            yield* fs.writeFileString('/tree/after-retry.txt', 'rescanned');
            view = yield* Queue.take(views);
            while (!view.includes('after-retry.txt')) view = yield* Queue.take(views);

            yield* Fiber.interrupt(watcher);
            expect(second.id).not.toBe(first.id);
            expect(yield* Queue.take(stale)).toBeUndefined();
          }),
        ).pipe(Effect.provide(live)),
      );
    } finally {
      await deleteVolume(fileName);
    }
  },
  90_000,
);
