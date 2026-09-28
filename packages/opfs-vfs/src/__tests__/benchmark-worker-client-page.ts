import { OpfsVfsWorker } from '../index_internal';
import { deleteVolume } from '../volume-files';
import { measureAsync, measureColdAsync, prepareDataset, type Workload } from './benchmark-worker-client-workloads';

type Mode = 'disk' | 'memory';
type SabRequest =
  | { type: 'open'; name: string; mode: Mode }
  | { type: 'measure'; workload: Workload; warmup: number; ops: number }
  | { type: 'coldLeader'; name: string; mode: Mode; warmup: number; count: number }
  | { type: 'close' };

declare global {
  interface Window {
    workerClientBenchmark: {
      env(): {
        userAgent: string;
        crossOriginIsolated: boolean;
        hardwareConcurrency: number;
        sharedArrayBuffer: boolean;
      };
      openLeader(name: string, mode: Mode): Promise<void>;
      openFollower(name: string, mode: Mode): Promise<void>;
      measure(workload: Workload, warmup: number, ops: number): Promise<unknown>;
      coldFollower(name: string, mode: Mode, warmup: number, count: number): Promise<unknown>;
      coldLeader(name: string, mode: Mode, warmup: number, count: number): Promise<unknown>;
      sab: {
        open(name: string, mode: Mode): Promise<void>;
        measure(workload: Workload, warmup: number, ops: number): Promise<unknown>;
        coldLeader(name: string, mode: Mode, warmup: number, count: number): Promise<unknown>;
        close(): Promise<void>;
      };
      close(): Promise<void>;
      remove(name: string): Promise<void>;
    };
  }
}

let client: OpfsVfsWorker | undefined;
let sabWorker: Worker | undefined;
let sabId = 0;
const sabPending = new Map<number, { resolve(value: unknown): void; reject(reason: unknown): void }>();

const assertLeader = (value: OpfsVfsWorker, expected: boolean) => {
  if ((value as unknown as { isLeader: boolean }).isLeader !== expected) {
    throw new Error(`Expected benchmark client to be ${expected ? 'leader' : 'follower'}`);
  }
};

const makeClient = (name: string, mode: Mode) => new OpfsVfsWorker(name, { bufferMode: mode });

const rejectSab = (reason: unknown) => {
  for (const pending of sabPending.values()) pending.reject(reason);
  sabPending.clear();
};

const ensureSabWorker = () => {
  if (sabWorker) return sabWorker;
  const worker = new Worker(new URL('./benchmark-worker-client-sab-worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
    const pending = sabPending.get(event.data.id);
    if (!pending) return;
    sabPending.delete(event.data.id);
    if (event.data.error) pending.reject(new Error(event.data.error));
    else pending.resolve(event.data.result);
  };
  worker.onerror = (event) => {
    // Drop the failed worker so cleanup does not wait on it forever.
    worker.terminate();
    if (sabWorker === worker) sabWorker = undefined;
    rejectSab(new Error(event.message || 'SAB benchmark worker failed'));
  };
  sabWorker = worker;
  return worker;
};

const requestSab = (request: SabRequest) =>
  new Promise<unknown>((resolve, reject) => {
    const id = ++sabId;
    sabPending.set(id, { resolve, reject });
    ensureSabWorker().postMessage({ id, ...request });
  });

async function close(): Promise<void> {
  if (!client) return;
  const current = client;
  client = undefined;
  await current.closeVfs();
}

async function openLeader(name: string, mode: Mode): Promise<void> {
  await close();
  client = makeClient(name, mode);
  await client.ready;
  assertLeader(client, true);
  await prepareDataset(client);
}

async function openFollower(name: string, mode: Mode): Promise<void> {
  await close();
  client = makeClient(name, mode);
  await client.ready;
  assertLeader(client, false);
}

Object.assign(window, {
  workerClientBenchmark: {
    env: () => ({
      userAgent: navigator.userAgent,
      crossOriginIsolated,
      hardwareConcurrency: navigator.hardwareConcurrency,
      sharedArrayBuffer: typeof SharedArrayBuffer === 'function',
    }),
    openLeader,
    openFollower,
    measure: (workload: Workload, warmup: number, ops: number) => {
      if (!client) throw new Error('Benchmark client is not open');
      return measureAsync(client, workload, { warmup, ops });
    },
    coldFollower: (name: string, mode: Mode, warmup: number, count: number) =>
      measureColdAsync(
        () => {
          const value = makeClient(name, mode);
          return { ready: value.ready.then(() => assertLeader(value, false)), closeVfs: () => value.closeVfs() };
        },
        { warmup, count },
      ),
    coldLeader: (name: string, mode: Mode, warmup: number, count: number) =>
      measureColdAsync(
        () => {
          const value = makeClient(name, mode);
          return { ready: value.ready.then(() => assertLeader(value, true)), closeVfs: () => value.closeVfs() };
        },
        { warmup, count },
      ),
    sab: {
      open: async (name: string, mode: Mode) => {
        await requestSab({ type: 'open', name, mode });
      },
      measure: (workload: Workload, warmup: number, ops: number) =>
        requestSab({ type: 'measure', workload, warmup, ops }),
      coldLeader: (name: string, mode: Mode, warmup: number, count: number) =>
        requestSab({ type: 'coldLeader', name, mode, warmup, count }),
      close: async () => {
        if (!sabWorker) return;
        const worker = sabWorker;
        try {
          await requestSab({ type: 'close' });
        } finally {
          worker.terminate();
          sabWorker = undefined;
        }
      },
    },
    close,
    remove: deleteVolume,
  },
});
