import { describe, expect, it } from 'vitest';

import { OpfsVfsWorker, type OpfsVfsWorkerOptions } from '../index_internal';

function initCoreWorker(payload: Record<string, unknown>) {
  return new Promise<{ type: string; result?: { error?: string; code?: string } }>((resolve, reject) => {
    const worker = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' });
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error('core worker INIT timed out'));
    }, 5000);
    worker.onerror = (event) => {
      clearTimeout(timeout);
      worker.terminate();
      reject(new Error(event.message));
    };
    worker.onmessage = ({ data }) => {
      clearTimeout(timeout);
      worker.terminate();
      resolve(data);
    };
    worker.postMessage({ id: 1, type: 'INIT', payload });
  });
}

describe('core worker storage options', () => {
  it('rejects legacy encryption options before creating a client worker', () => {
    const options = { encryption: undefined } as unknown as OpfsVfsWorkerOptions;
    expect(() => new OpfsVfsWorker('legacy-worker-option.bin', options)).toThrow(
      'Encryption is only available from the premium worker',
    );
  });

  it('rejects encryption sent directly to the core worker', async () => {
    const response = await initCoreWorker({ fileName: 'legacy-worker-init.bin', encryption: undefined });
    expect(response).toMatchObject({
      type: 'ERROR',
      result: { error: expect.stringContaining('Unsupported INIT field: encryption') },
    });
  });

  it('rejects an importing marker sent directly to the worker', async () => {
    const fileName = `worker-importing-init-${crypto.randomUUID()}.bin`;
    const root = await navigator.storage.getDirectory();
    const marker = fileName.replace(/\.bin$/, '.importing');
    await root.getFileHandle(marker, { create: true });
    try {
      await expect(
        initCoreWorker({ fileName, generation: crypto.randomUUID(), openMode: 'open-or-create' }),
      ).resolves.toMatchObject({
        type: 'ERROR',
        result: { code: 'VOLUME_IMPORTING' },
      });
    } finally {
      await root.removeEntry(marker);
    }
  });
});
