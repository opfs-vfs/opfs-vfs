import { deleteVolume } from '@opfs-vfs/opfs-vfs';
import { OpfsVfsWorker } from '@opfs-vfs/opfs-vfs/worker';
import { describe, expect, it } from 'vitest';
import { subscribe, type Subscription } from '../client';
import { subscriptionsRequest } from '../config';

const content = { maxBytes: 16 * 1024 * 1024 };
const worker = () => new Worker(new URL('./subscription-content-worker.ts', import.meta.url), { type: 'module' });

function runWorker(path: string, bufferMode: 'memory' | 'disk') {
  const worker = new Worker(new URL(path, import.meta.url), { type: 'module' });
  return new Promise<{
    first?: number[][];
    second?: number[][];
    firstHeld?: number[];
    secondHeld?: number[];
    current?: number[];
    error?: string;
  }>((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('content worker timed out'));
    }, 15_000);
    worker.onerror = (event) => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(event.message));
    };
    worker.onmessage = ({ data }) => {
      clearTimeout(timer);
      worker.terminate();
      if (data.error) reject(new Error(data.error));
      else resolve(data);
    };
    worker.postMessage({ bufferMode });
  });
}

function runCapture(allowed: string, denied: string) {
  const worker = new Worker(new URL('./subscription-content-capture-worker.ts', import.meta.url), { type: 'module' });
  return new Promise<{ reads?: number; allowed?: string[]; denied?: string[]; error?: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('capture worker timed out'));
    }, 15_000);
    worker.onerror = (event) => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(event.message));
    };
    worker.onmessage = ({ data }) => {
      clearTimeout(timer);
      worker.terminate();
      if (data.error) reject(new Error(data.error));
      else resolve(data);
    };
    worker.postMessage({ allowed, denied });
  });
}

async function assertHistorical(result: {
  first?: number[][];
  second?: number[][];
  firstHeld?: number[];
  secondHeld?: number[];
  current?: number[];
}) {
  expect(result.first).toEqual([[1], [2]]);
  expect(result.second).toEqual([[1], [2]]);
  expect(result.firstHeld).toEqual([9]);
  expect(result.secondHeld).toEqual([1]);
  expect(result.current).toEqual([3]);
}

describe('completed-operation subscription content', () => {
  it.each(['memory', 'disk'] as const)(
    'keeps direct %s historical content isolated from later mutation',
    async (bufferMode) => {
      await assertHistorical(await runWorker('./subscription-content-direct-worker.ts', bufferMode));
    },
  );

  it.each([
    ['denied before allowed', '/z-open', '/a-locked'],
    ['allowed before denied', '/a-open', '/z-locked'],
  ])('deduplicates one disk capture for hard-link paths with %s', async (_order, allowed, denied) => {
    const result = await runCapture(allowed, denied);
    expect(result).toEqual({ reads: 1, allowed: ['included', 'included'], denied: ['unavailable'] });
  });

  it.each(['memory', 'disk'] as const)(
    'keeps async worker %s historical content isolated from later mutation',
    async (bufferMode) => {
      const name = `subscription-content-async-${bufferMode}-${crypto.randomUUID()}.bin`;
      const fs = new OpfsVfsWorker(name, { bufferMode, worker, plugins: [subscriptionsRequest()] });
      let firstSubscription: Subscription | undefined;
      let secondSubscription: Subscription | undefined;
      try {
        await fs.ready;
        await fs.writeFileBuffer('/document', new Uint8Array());
        let releaseFirst!: () => void;
        let releaseSecond!: () => void;
        let firstStarted!: () => void;
        let secondStarted!: () => void;
        let firstSecond!: () => void;
        let secondSecond!: () => void;
        const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
        const secondGate = new Promise<void>((resolve) => (releaseSecond = resolve));
        const firstA = new Promise<void>((resolve) => (firstStarted = resolve));
        const secondA = new Promise<void>((resolve) => (secondStarted = resolve));
        const firstB = new Promise<void>((resolve) => (firstSecond = resolve));
        const secondB = new Promise<void>((resolve) => (secondSecond = resolve));
        const first: number[][] = [];
        const second: number[][] = [];
        let firstHeld: Uint8Array | undefined;
        let secondHeld: Uint8Array | undefined;
        const options = {
          path: '/document',
          scope: 'file' as const,
          events: ['update'] as const,
          content,
          onError(error: Error) {
            throw error;
          },
        };
        firstSubscription = await subscribe(fs, options, async (change) => {
          if (change.content.status !== 'included') throw new Error('Missing async content');
          first.push([...change.content.bytes]);
          if (first.length === 1) {
            firstHeld = change.content.bytes;
            change.content.bytes[0] = 9;
            firstStarted();
            await firstGate;
          } else firstSecond();
        });
        secondSubscription = await subscribe(fs, options, async (change) => {
          if (change.content.status !== 'included') throw new Error('Missing async content');
          second.push([...change.content.bytes]);
          if (second.length === 1) {
            secondHeld = change.content.bytes;
            secondStarted();
            await secondGate;
          } else secondSecond();
        });
        await fs.writeFileBuffer('/document', new Uint8Array([1]));
        await Promise.all([firstA, secondA]);
        await fs.writeFileBuffer('/document', new Uint8Array([2]));
        await fs.unlink('/document');
        await fs.writeFileBuffer('/document', new Uint8Array([3]));
        const current = [...(await fs.readFileBuffer('/document'))];
        releaseFirst();
        releaseSecond();
        await Promise.all([firstB, secondB]);
        await assertHistorical({
          first,
          second,
          firstHeld: firstHeld && [...firstHeld],
          secondHeld: secondHeld && [...secondHeld],
          current,
        });
      } finally {
        firstSubscription?.unsubscribe();
        secondSubscription?.unsubscribe();
        await fs.closeVfs().catch(() => fs.dispose());
        await deleteVolume(name);
      }
    },
  );

  it.each(['memory', 'disk'] as const)(
    'captures SAB %s content before acknowledgement and later mutation',
    async (bufferMode) => {
      await assertHistorical(await runWorker('./subscription-content-sab-worker.ts', bufferMode));
    },
  );

  it.each(['memory', 'disk'] as const)(
    'reserves two follower %s A/B versions through asymmetric completion and termination',
    async (bufferMode) => {
      const name = `subscription-content-followers-${bufferMode}-${crypto.randomUUID()}.bin`;
      const owner = new OpfsVfsWorker(name, { bufferMode, worker, plugins: [subscriptionsRequest()] });
      let first: OpfsVfsWorker | undefined;
      let second: OpfsVfsWorker | undefined;
      let firstSubscription: Subscription | undefined;
      let secondSubscription: Subscription | undefined;
      try {
        await owner.ready;
        first = new OpfsVfsWorker(name, { bufferMode, worker, plugins: [subscriptionsRequest()] });
        second = new OpfsVfsWorker(name, { bufferMode, worker, plugins: [subscriptionsRequest()] });
        await Promise.all([first.ready, second.ready]);
        await owner.writeFileBuffer('/large', new Uint8Array());
        let releaseFirstA!: () => void;
        let releaseSecondA!: () => void;
        let releaseSecondB!: () => void;
        let firstA!: () => void;
        let secondA!: () => void;
        let firstB!: () => void;
        let secondB!: () => void;
        const firstAGate = new Promise<void>((resolve) => (releaseFirstA = resolve));
        const secondAGate = new Promise<void>((resolve) => (releaseSecondA = resolve));
        const secondBGate = new Promise<void>((resolve) => (releaseSecondB = resolve));
        const firstASeen = new Promise<void>((resolve) => (firstA = resolve));
        const secondASeen = new Promise<void>((resolve) => (secondA = resolve));
        const firstBSeen = new Promise<void>((resolve) => (firstB = resolve));
        const secondBSeen = new Promise<void>((resolve) => (secondB = resolve));
        const firstBytes: Uint8Array[] = [];
        const secondBytes: Uint8Array[] = [];
        let firstHeld: Uint8Array | undefined;
        let secondHeld: Uint8Array | undefined;
        const options = {
          path: '/large',
          scope: 'file' as const,
          events: ['update'] as const,
          content,
          onError(error: Error) {
            throw error;
          },
        };
        firstSubscription = await subscribe(first, options, async (change) => {
          if (change.content.status !== 'included') throw new Error('Missing first follower content');
          firstBytes.push(change.content.bytes.slice());
          if (firstBytes.length === 1) {
            firstHeld = change.content.bytes;
            change.content.bytes[0] = 9;
            firstA();
            await firstAGate;
          } else firstB();
        });
        secondSubscription = await subscribe(second, options, async (change) => {
          if (change.content.status !== 'included') throw new Error('Missing second follower content');
          secondBytes.push(change.content.bytes.slice());
          if (secondBytes.length === 1) {
            secondHeld = change.content.bytes;
            secondA();
            await secondAGate;
          } else {
            secondB();
            await secondBGate;
          }
        });
        const a = new Uint8Array(16 * 1024 * 1024).fill(1);
        const b = new Uint8Array(16 * 1024 * 1024).fill(2);
        await owner.writeFileBuffer('/large', a);
        await Promise.all([firstASeen, secondASeen]);
        await owner.writeFileBuffer('/large', b);
        await owner.unlink('/large');
        await owner.writeFileBuffer('/large', new Uint8Array([3]));
        expect(await owner.readFileBuffer('/large')).toEqual(new Uint8Array([3]));
        releaseFirstA();
        await firstBSeen;
        expect(firstHeld && [firstHeld.byteLength, firstHeld[0], firstHeld[firstHeld.byteLength - 1]]).toEqual([
          16 * 1024 * 1024,
          9,
          1,
        ]);
        expect(firstBytes).toHaveLength(2);
        expect(firstBytes.map((bytes) => [bytes.byteLength, bytes[0], bytes[bytes.length - 1]])).toEqual([
          [16 * 1024 * 1024, 1, 1],
          [16 * 1024 * 1024, 2, 2],
        ]);
        releaseSecondA();
        await secondBSeen;
        expect(secondHeld && [secondHeld.byteLength, secondHeld[0], secondHeld[secondHeld.byteLength - 1]]).toEqual([
          16 * 1024 * 1024,
          1,
          1,
        ]);
        expect(secondBytes).toHaveLength(2);
        expect(secondBytes.map((bytes) => [bytes.byteLength, bytes[0], bytes[bytes.length - 1]])).toEqual([
          [16 * 1024 * 1024, 1, 1],
          [16 * 1024 * 1024, 2, 2],
        ]);
        secondSubscription.unsubscribe();
        releaseSecondB();
      } finally {
        firstSubscription?.unsubscribe();
        secondSubscription?.unsubscribe();
        try {
          await owner.closeVfs();
        } finally {
          owner.dispose();
          first?.dispose();
          second?.dispose();
          await deleteVolume(name);
        }
      }
    },
  );
});
