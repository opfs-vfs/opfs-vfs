import { describe, expect, it } from 'vitest';
import { deleteVolume } from '../volume-files';

type Response = {
  type: 'MOUNTED' | 'VERIFIED' | 'ERROR';
  error?: string;
  acknowledged?: number;
  walBytes?: number;
  dataBytes?: number;
  dataUnchanged?: boolean;
  names?: string[];
  size?: number;
  bytes?: Uint8Array;
  read?: number;
  eof?: number;
};

async function released(fileName: string) {
  await navigator.locks.request(`opfs-vfs-volume-${fileName}`, { signal: AbortSignal.timeout(10_000) }, () => {});
}

async function run(request: Record<string, unknown> & { fileName: string }): Promise<Response> {
  const owner = new Worker(new URL('./plaintext-owner-crash-worker.ts', import.meta.url), { type: 'module' });
  try {
    const response = await new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Owner timed out during ${String(request.type)}`)), 15_000);
      owner.onerror = (event) => {
        clearTimeout(timer);
        reject(new Error(event.message));
      };
      owner.onmessage = ({ data }: MessageEvent<Response>) => {
        clearTimeout(timer);
        if (data.type === 'ERROR') reject(new Error(data.error));
        else resolve(data);
      };
      owner.postMessage(request);
    });
    if (request.type === 'MOUNT') {
      await navigator.locks.request(`opfs-vfs-volume-${request.fileName}`, { ifAvailable: true }, (lock) => {
        expect(lock, 'nested worker retains volume ownership until its outer owner is terminated').toBeNull();
      });
    }
    return response;
  } finally {
    owner.terminate();
    // terminate() returns before the nested worker releases the volume lock.
    await released(request.fileName);
  }
}

async function verify(fileName: string, mode: 'memory' | 'disk', expected: Uint8Array, checkpoint = false) {
  const result = await run({ type: 'VERIFY', fileName, mode, length: expected.length, checkpoint });
  expect(result).toMatchObject({
    type: 'VERIFIED',
    names: ['file'],
    size: expected.length,
    read: expected.length,
    eof: 0,
  });
  expect(result.bytes).toEqual(expected);
}

const baseline = () => Uint8Array.from({ length: 4097 }, (_, i) => (i * 29 + 17) % 251);

describe('plaintext nested owner-worker termination', () => {
  it('releases an idle owner and its nested handles after a durable baseline', async () => {
    const fileName = `plain-owner-idle-${crypto.randomUUID()}.bin`;
    const expected = baseline();
    try {
      const mounted = await run({ type: 'MOUNT', fileName, baseline: expected });
      expect(mounted).toMatchObject({ type: 'MOUNTED', walBytes: 0, dataUnchanged: true });
      expect(mounted.dataBytes).toBeGreaterThan(0);
      await verify(fileName, 'disk', expected);
      await verify(fileName, 'memory', expected);
    } finally {
      await released(fileName);
      await deleteVolume(fileName);
    }
  }, 60_000);

  it('replays an acknowledged strict-memory write left in WAL by a terminated outer owner', async () => {
    const fileName = `plain-owner-wal-${crypto.randomUUID()}.bin`;
    const latest = Uint8Array.from({ length: 8199 }, (_, i) => (i * 47 + 83) % 251);
    try {
      const mounted = await run({ type: 'MOUNT', fileName, baseline: baseline(), latest });
      expect(mounted).toMatchObject({ type: 'MOUNTED', acknowledged: latest.length, dataUnchanged: true });
      expect(mounted.dataBytes).toBeGreaterThan(0);
      expect(mounted.walBytes).toBeGreaterThan(0);
      await verify(fileName, 'memory', latest, true);
      await verify(fileName, 'disk', latest);
    } finally {
      await released(fileName);
      await deleteVolume(fileName);
    }
  }, 60_000);
});
