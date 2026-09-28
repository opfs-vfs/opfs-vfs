import { describe, it } from 'vitest';
import { deleteVolume } from '../volume-files';
import type { Scenario } from './crash-integrity-worker';

/** Run one step in a fresh worker, then terminate it natively (no close unless the step closes). */
async function step(name: string, scenario: Scenario, index: number) {
  const worker = new Worker(new URL('./crash-integrity-worker.ts', import.meta.url), { type: 'module' });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${scenario} step ${index} timed out`)), 30_000);
      worker.onerror = (event) => {
        clearTimeout(timer);
        reject(new Error(event.message));
      };
      worker.onmessage = ({ data }) => {
        clearTimeout(timer);
        if (data.error) reject(new Error(data.error));
        else resolve();
      };
      worker.postMessage({ name, scenario, step: index });
    });
  } finally {
    worker.terminate();
    await navigator.locks.request(`opfs-vfs-volume-${name}`, { signal: AbortSignal.timeout(10_000) }, () => {});
  }
}

const scenarios: [Scenario, number, string][] = [
  ['disk-attrs', 4, 'disk overwrites and growth within an allocated block survive attribute-log replay above quota'],
  ['sparse', 3, 'disk holes survive native termination and release only allocated blocks'],
  ['sparse-quota', 2, 'disk quota counts allocated blocks after remount'],
  ['gap', 2, 'memory mode persists the zero gap of a write past EOF over reused blocks'],
  ['ino-reuse', 3, 'memory mode never reissues an inode number that surviving WAL records name'],
  ['relink', 2, 'memory mode keeps a pathname that was unlinked and linked again before a crash'],
  ['repair-marker', 3, 'the mount-time repair extent survives immediate worker termination'],
  ['storage-extent', 2, 'the storage contract receives the newest replayed logical extent'],
  ['wal-tail', 3, 'a torn trailing data-WAL frame is truncated at mount'],
  ['compacted-log', 2, 'compacted metadata log rejects an A/B fallback in fail-stop mode'],
  ['newer-log', 2, 'newer metadata log rejects an A/B fallback in fail-stop mode'],
  ['disk-sync', 1, 'disk sync flushes data and metadata without a commit marker'],
  ['wal-checkpoint', 2, 'replaying a pre-checkpoint WAL preserves the post-sync files'],
  ['wal-checkpoint-failure', 2, 'a strict write after a failed checkpoint flush survives a crash'],
  [
    'log-order',
    1,
    'memory-mode sync makes both recovery logs durable before data writes and flushes the truncated WAL once',
  ],
];

describe('crash integrity', () => {
  for (const [scenario, steps, title] of scenarios) {
    it(
      title,
      async () => {
        const name = `crash-integrity-${scenario}-${crypto.randomUUID()}.bin`;
        try {
          for (let index = 0; index < steps; index++) await step(name, scenario, index);
        } finally {
          await deleteVolume(name);
        }
      },
      60_000,
    );
  }
});
