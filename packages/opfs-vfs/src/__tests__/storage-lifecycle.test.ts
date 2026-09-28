import { describe, it } from 'vitest';
import { deleteVolume } from '../volume-files';
import type { SequenceState } from './storage-lifecycle-worker';

async function released(name: string) {
  // terminate() returns before the browser releases its worker's Web Lock.
  await navigator.locks.request(`opfs-vfs-volume-${name}`, { signal: AbortSignal.timeout(10_000) }, () => {});
}

async function run<T = void>(payload: Record<string, unknown>): Promise<T> {
  const worker = new Worker(new URL('./storage-lifecycle-worker.ts', import.meta.url), { type: 'module' });
  try {
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.terminate();
        reject(new Error('storage lifecycle worker timed out'));
      }, 15_000);
      worker.onerror = (event) => {
        clearTimeout(timer);
        reject(new Error(event.message));
      };
      worker.onmessage = ({ data }) => {
        clearTimeout(timer);
        // This message acknowledges close/sync/fsync before native termination.
        if (data.error) reject(new Error(data.error));
        else resolve(data.result);
      };
      worker.postMessage(payload);
    });
  } finally {
    worker.terminate();
    await released(payload.name as string);
  }
}

describe('acknowledged storage lifecycle', () => {
  for (const writer of ['memory', 'disk'] as const) {
    for (const reader of ['memory', 'disk'] as const) {
      for (const durability of ['strict', 'relaxed', 'balanced'] as const) {
        for (const barrier of ['close', 'sync', 'fsync'] as const) {
          it(`${writer} -> ${reader}, ${durability}, ${barrier}: latest boundary bytes survive two reopens`, async () => {
            const name = `lifecycle-${crypto.randomUUID()}.bin`;
            try {
              await run({ scenario: 'write', name, mode: writer, durability, barrier });
              for (let reopen = 0; reopen < 2; reopen++) {
                await run({ scenario: 'verify', name, mode: reader, durability });
              }
            } finally {
              await deleteVolume(name);
            }
          }, 45_000);
        }
      }
    }
  }
});

describe('deterministic storage operation sequences', () => {
  for (const mode of ['memory', 'disk'] as const) {
    for (const durability of ['strict', 'relaxed', 'balanced'] as const) {
      for (const seed of [1, 42, 0x5eed]) {
        it(`${mode}, ${durability}, seed=${seed}: exact namespace and shared inode bytes after every sync/reopen`, async () => {
          const name = `sequence-${crypto.randomUUID()}.bin`;
          let state: SequenceState | undefined;
          try {
            for (let round = 0; round < 4; round++) {
              state = await run<SequenceState>({
                scenario: 'sequence',
                name,
                mode: round % 2 === 0 ? mode : mode === 'disk' ? 'memory' : 'disk',
                durability,
                seed,
                round,
                state,
              });
            }
            for (let reopen = 0; reopen < 2; reopen++) {
              await run({ scenario: 'verify', name, mode, durability, state });
            }
          } catch (error) {
            throw new Error(`seed=${seed}\n${state?.trace.join('\n') ?? ''}\n${String(error)}`, { cause: error });
          } finally {
            await deleteVolume(name);
          }
        }, 60_000);
      }
    }
  }
});
