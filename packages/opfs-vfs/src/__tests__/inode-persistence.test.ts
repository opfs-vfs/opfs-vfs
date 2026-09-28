import { describe, it } from 'vitest';
import { deleteVolume } from '../volume-files';
import type { Expected } from './inode-persistence-worker';

async function run(payload: Record<string, unknown>): Promise<Expected> {
  const worker = new Worker(new URL('./inode-persistence-worker.ts', import.meta.url), { type: 'module' });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('inode persistence worker timed out')), 15_000);
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

async function persists(payload: Record<string, unknown>, reader: 'memory' | 'disk') {
  const name = `inode-${crypto.randomUUID()}.bin`;
  try {
    const expected = await run({ ...payload, name, action: 'prepare' });
    for (let reopen = 0; reopen < 2; reopen++) {
      await run({ name, action: 'verify', mode: reader, encrypted: payload.encrypted, expected });
    }
  } finally {
    await deleteVolume(name);
  }
}

describe('inode data survives namespace changes', () => {
  for (const scenario of ['alias-unlink', 'alias-replace', 'alias-subtree']) {
    for (const reader of ['memory', 'disk'] as const) {
      it(
        `${scenario}: sync and native termination preserve bytes on repeated ${reader} mounts`,
        () => persists({ scenario, mode: 'memory' }, reader),
        30_000,
      );
    }
  }

  for (const mode of ['memory', 'disk'] as const) {
    for (const operation of ['append', 'shrink', 'grow']) {
      for (const crossBlock of [false, true]) {
        it(
          `${mode}: old descriptor ${operation}, crossBlock=${crossBlock}, updates surviving inode after namespace checkpoint`,
          () => persists({ scenario: 'descriptor', mode, operation, crossBlock, survivingAlias: true }, 'disk'),
          30_000,
        );
      }
      it(
        `${mode}: fully unlinked descriptor ${operation} cannot change reused pathname`,
        () => persists({ scenario: 'descriptor', mode, operation, crossBlock: true, survivingAlias: false }, 'disk'),
        30_000,
      );
    }
    it(
      `${mode}: same-size old descriptor write updates original mtime and preserves successor mtime`,
      () => persists({ scenario: 'descriptor', mode, operation: 'overwrite', survivingAlias: true }, 'disk'),
      30_000,
    );
    it(
      `${mode}: zero truncate releases blocks for reuse without changing the guard`,
      () => persists({ scenario: 'zero', mode }, 'disk'),
      30_000,
    );
  }
  it(
    'dirty pages written through separate aliases persist once per inode',
    () => persists({ scenario: 'coalesced', mode: 'memory' }, 'disk'),
    30_000,
  );

  it('WAL replay leaves successor prefix and suffix intact after unlink and rename reuse', async () => {
    const name = `inode-wal-${crypto.randomUUID()}.bin`;
    try {
      const expected = await run({ name, action: 'prepare', mode: 'memory', scenario: 'wal-replay' });
      await run({ name, action: 'verify', mode: 'memory', expected });
      for (let reopen = 0; reopen < 2; reopen++) await run({ name, action: 'verify', mode: 'disk', expected });
    } finally {
      await deleteVolume(name);
    }
  }, 30_000);
});
