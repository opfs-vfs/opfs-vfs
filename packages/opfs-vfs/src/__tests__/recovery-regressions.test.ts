import { describe, expect, it } from 'vitest';
import { deleteVolume } from '../volume-files';
import type { Expected } from './recovery-regressions-worker';

/** Runs one action in a fresh worker, then terminates it: `prepare` leaves its volume open, like a killed tab. */
async function run(payload: Record<string, unknown>): Promise<Expected> {
  const worker = new Worker(new URL('./recovery-regressions-worker.ts', import.meta.url), { type: 'module' });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('recovery regression worker timed out')), 15_000);
      worker.onerror = (event) => {
        clearTimeout(timer);
        reject(new Error(event.message));
      };
      worker.onmessage = ({ data }) => {
        clearTimeout(timer);
        if (data.error) reject(new Error(data.error));
        else resolve(data.expected);
      };
      worker.postMessage(payload);
    });
  } finally {
    worker.terminate();
    await navigator.locks.request(
      `opfs-vfs-volume-${String(payload.name)}`,
      { signal: AbortSignal.timeout(10_000) },
      () => {},
    );
  }
}

async function withVolume(prefix: string, body: (name: string) => Promise<void>) {
  const name = `${prefix}-${crypto.randomUUID()}.bin`;
  try {
    await body(name);
  } finally {
    await deleteVolume(name);
  }
}

/** Recover in memory mode (replays the WAL and closes cleanly), then read twice in disk mode. */
async function recoversExactly(name: string, expected: Expected) {
  await run({ name, action: 'verify', mode: 'memory', expected });
  for (let reopen = 0; reopen < 2; reopen++) await run({ name, action: 'verify', mode: 'disk', expected });
}

describe('memory-mode recovery after a killed tab', () => {
  for (const [scenario, label] of [
    ['shrink-hole', 'a write past the end of a shrunk file'],
    ['shrink-hole-snapshot', 'a write past the end of a shrunk file, logged by a full snapshot,'],
    ['extend', 'a truncate that extends a shrunk file'],
    ['reused-block', "a write past the end of a file in another file's old block"],
  ] as const) {
    it(
      `${label} followed by a namespace operation recovers zeros in the hole`,
      () =>
        withVolume('recovery-hole', async (name) => {
          const expected = await run({ name, action: 'prepare', scenario });
          await recoversExactly(name, expected);
        }),
      30_000,
    );
  }

  it(
    'growth logged by a namespace operation before a sync keeps its size after the sync',
    () =>
      withVolume('recovery-growth', async (name) => {
        const expected = await run({ name, action: 'prepare', scenario: 'synced-growth' });
        for (let reopen = 0; reopen < 2; reopen++) await run({ name, action: 'verify', mode: 'disk', expected });
      }),
    30_000,
  );

  it(
    'sizes loaded at mount survive growth and shrink logged by a namespace operation',
    () =>
      withVolume('recovery-prior', async (name) => {
        const expected = await run({ name, action: 'prepare', scenario: 'prior-session' });
        await recoversExactly(name, expected);
      }),
    30_000,
  );

  it(
    "a size an earlier release logged past the file's blocks is kept across a later crash",
    () =>
      withVolume('recovery-legacy-tail', async (name) => {
        await run({ name, action: 'prepare', scenario: 'legacy-tail-forge' });
        const expected = await run({ name, action: 'prepare', scenario: 'legacy-tail' });
        await recoversExactly(name, expected);
      }),
    30_000,
  );

  // The mount checks run before the error-code assertion, so a failure shows the unmountable volume first.
  for (const [scenario, label] of [
    ['failed-persist', 'a sync whose data write hit the quota leaves a volume that still mounts'],
    ['failed-hole-fill', 'a failed sync does not leave a hole mapped to a block that was never written'],
  ] as const) {
    it(
      label,
      () =>
        withVolume(`recovery-${scenario}`, async (name) => {
          const expected = await run({ name, action: 'prepare', scenario });
          await recoversExactly(name, expected);
          expect(expected.failure).toBe('ENOSPC');
        }),
      30_000,
    );
  }

  for (const [scenario, label] of [
    ['failed-multi-file', "a later file's write failed"],
    ['failed-flush', 'the data flush failed'],
  ] as const) {
    it(
      `a sync where ${label}, then a flushed namespace record and power loss, still mounts`,
      () =>
        withVolume(`recovery-${scenario}`, async (name) => {
          const expected = await run({ name, action: 'prepare', scenario });
          await run({ name, action: 'truncate-data', bytes: expected.flushedSize });
          await recoversExactly(name, expected);
          expect(expected.failure).toBe(scenario === 'failed-flush' ? 'InvalidStateError' : 'ENOSPC');
        }),
      30_000,
    );
  }

  it(
    'a zero-filled data WAL tail is a torn append, even in fail-stop mode',
    () =>
      withVolume('recovery-zero-tail', async (name) => {
        const expected = await run({ name, action: 'prepare', scenario: 'wal-only' });
        await run({ name, action: 'append-zeros', bytes: 64 });
        await run({ name, action: 'verify', mode: 'memory', recoveryMode: 'fail-stop', expected });
      }),
    30_000,
  );

  it(
    'a final data WAL frame that fails its checksum is a torn append, even in fail-stop mode',
    () =>
      withVolume('recovery-torn-frame', async (name) => {
        const expected = await run({ name, action: 'prepare', scenario: 'wal-two-files' });
        await run({ name, action: 'tear-final-frame' });
        await run({ name, action: 'verify', mode: 'memory', recoveryMode: 'fail-stop', expected });
      }),
    30_000,
  );
});

describe('data WAL frames behind a damaged frame', () => {
  it(
    'a damaged length field of an early frame is corruption, not a torn append: fail-stop refuses and salvage reports it',
    () =>
      withVolume('recovery-damaged-length', async (name) => {
        await run({ name, action: 'prepare', scenario: 'wal-three-files' });
        await run({ name, action: 'damaged-wal-length' });
        await run({ name, action: 'damaged-wal-verify' });
      }),
    30_000,
  );
});

describe('volumes damaged by the path-order bug of an earlier release', () => {
  for (const blocker of ['file', 'file+nested', 'file+lost-file', 'file+lost-dir'] as const) {
    it(
      `entries under a non-directory move to a free lost+found directory (${blocker})`,
      () =>
        withVolume('recovery-blocked', async (name) => {
          const mode = blocker === 'file' || blocker === 'file+nested' ? 'memory' : 'disk';
          await run({ name, action: 'detached-forge', mode, blocker });
          for (let round = 0; round < 2; round++) {
            await run({ name, action: 'detached-verify', mode, blocker, recoveryMode: 'fail-stop', round });
          }
        }),
      30_000,
    );
  }

  for (const [mode, recoveryMode] of [
    ['memory', 'salvage'],
    ['disk', 'fail-stop'],
  ] as const) {
    it(
      `${mode}, ${recoveryMode}: entries left without a parent directory are reattached and the volume closes`,
      () =>
        withVolume('recovery-detached', async (name) => {
          await run({ name, action: 'detached-forge', mode });
          for (let round = 0; round < 2; round++) {
            await run({ name, action: 'detached-verify', mode, recoveryMode, round });
          }
        }),
      30_000,
    );
  }
});

describe('storage error handling', () => {
  for (const mode of ['memory', 'disk'] as const) {
    it(
      `${mode}: salvage reports the rollback to an older snapshot and fail-stop refuses it`,
      () => withVolume('rollback-report', (name) => run({ name, action: 'rollback-report', mode }).then(() => {})),
      30_000,
    );
  }

  for (const durability of ['relaxed', 'balanced', 'strict'] as const) {
    it(
      `${durability}: a namespace operation whose log write fails ${durability === 'strict' ? 'throws' : 'succeeds and the next sync retries'}`,
      () =>
        withVolume('deferred-namespace', (name) =>
          run({ name, action: 'deferred-namespace', durability }).then(() => {}),
        ),
      30_000,
    );
  }

  for (const durability of ['relaxed', 'balanced'] as const) {
    for (const variant of ['sync-fails', 'sync-succeeds'] as const) {
      it(
        `${durability}: an unlink whose log write failed does not let a ${variant === 'sync-fails' ? 'failing' : 'later'} sync reuse its blocks before the delete is durable`,
        () =>
          withVolume('unwritten-namespace', async (name) => {
            const expected = await run({ name, action: 'unwritten-namespace', durability, variant });
            await run({ name, action: 'unwritten-verify', variant, expected });
          }),
        30_000,
      );
    }

    it(
      `${durability}: a namespace log write that fails for a non-storage reason still throws`,
      () =>
        withVolume('non-storage-namespace', (name) =>
          run({ name, action: 'non-storage-namespace', durability }).then(() => {}),
        ),
      30_000,
    );
  }

  it(
    'an all-zero data WAL on a protected volume is an empty log, even in fail-stop mode',
    () => withVolume('zero-protected-wal', (name) => run({ name, action: 'zero-protected-wal' }).then(() => {})),
    30_000,
  );

  it(
    'a memory-mode truncate whose buffer cannot be allocated changes nothing',
    () => withVolume('truncate-alloc', (name) => run({ name, action: 'truncate-alloc' }).then(() => {})),
    30_000,
  );

  it(
    'blocks claimed by two files stay reported after later writes',
    () => withVolume('double-claim', (name) => run({ name, action: 'double-claim' }).then(() => {})),
    30_000,
  );
});
