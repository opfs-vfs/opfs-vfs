import { describe, expect, it } from 'vitest';

import { DATA_WAL_VERSION, encodeDataWalRecord } from '../data-wal';
import { OpfsVfsWorker, type OpfsVfsWorkerOptions } from '../index_internal';

const uniqueFileName = (label: string): string => `${label}-${crypto.randomUUID()}.bin`;

async function overwriteDataWal(fileName: string, bytes: Uint8Array): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(fileName.replace(/\.bin$/, '.data.log'), {
    create: true,
  });
  const writable = await handle.createWritable();
  await writable.write(new Uint8Array(bytes));
  await writable.truncate(bytes.length);
  await writable.close();
}

describe('OpfsVfsWorker volume options', () => {
  it('refuses incomplete imports before following an advertised owner or creating a worker', async () => {
    const fileName = uniqueFileName('worker-importing');
    const owner = new OpfsVfsWorker(fileName);
    await owner.ready;
    const root = await navigator.storage.getDirectory();
    const marker = fileName.replace(/\.bin$/, '.importing');
    await root.getFileHandle(marker, { create: true });
    try {
      for (const options of [{}, { forceLeader: true }, { openMode: 'create-new' as const }]) {
        const client = new OpfsVfsWorker(fileName, options);
        try {
          await expect(client.ready).rejects.toMatchObject({ code: 'VOLUME_IMPORTING' });
          expect(client.disposed).toBe(true);
          const locks = await navigator.locks.query();
          expect(locks.pending?.some((lock) => lock.name === `opfs-vfs-lock-${fileName}`)).toBe(false);
        } finally {
          client.dispose();
        }
      }
    } finally {
      await root.removeEntry(marker);
      await owner.closeVfs();
    }
  });

  it('forwards noatime to the dedicated-worker OpfsVfs mount', async () => {
    const options = {
      forceLeader: true,
      noatime: true,
    } satisfies OpfsVfsWorkerOptions;
    const vfs = new OpfsVfsWorker(uniqueFileName('worker-noatime'), options);

    try {
      await vfs.ready;
      const writeFd = await vfs.open('/probe.txt', true);
      await vfs.write(writeFd, new TextEncoder().encode('probe'));
      await vfs.close(writeFd);

      const oldAtime = 1_700_000_000_000;
      const newerMtime = oldAtime + 60_000;
      await vfs.utimes('/probe.txt', oldAtime, newerMtime);
      const readFd = await vfs.open('/probe.txt', false);
      await vfs.read(readFd, 5);
      await vfs.close(readFd);

      expect((await vfs.stat('/probe.txt')).atimeMs).toBe(oldAtime);
    } finally {
      await vfs.closeVfs();
    }
  });

  it('forwards fail-stop recovery to the dedicated-worker OpfsVfs mount', async () => {
    const fileName = uniqueFileName('worker-fail-stop');
    const seed = new OpfsVfsWorker(fileName, {
      forceLeader: true,
      bufferMode: 'memory',
    });
    await seed.ready;
    await seed.closeVfs();

    const corruptFrame = encodeDataWalRecord({
      version: DATA_WAL_VERSION,
      op: 'write',
      inodeId: 1,
      offset: 0,
      data: new Uint8Array([1, 2, 3]),
    });
    corruptFrame[corruptFrame.length - 1] ^= 0xff;
    await overwriteDataWal(fileName, corruptFrame);

    const failStop = new OpfsVfsWorker(fileName, {
      forceLeader: true,
      bufferMode: 'memory',
      recoveryMode: 'fail-stop',
    });
    try {
      await expect(failStop.ready).rejects.toThrow(/VFS init failed.*Data WAL/i);
    } finally {
      failStop.dispose();
    }
  });
});
