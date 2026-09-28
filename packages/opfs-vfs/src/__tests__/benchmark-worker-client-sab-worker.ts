import { OpfsVfsWorker } from '../index_internal';
import { measureColdAsync, measureSync, prepareDataset, type Workload } from './benchmark-worker-client-workloads';

type Request =
  | { id: number; type: 'open'; name: string; mode: 'disk' | 'memory' }
  | { id: number; type: 'measure'; workload: Workload; warmup: number; ops: number }
  | { id: number; type: 'coldLeader'; name: string; mode: 'disk' | 'memory'; warmup: number; count: number }
  | { id: number; type: 'close' };

let client: OpfsVfsWorker | undefined;

const assertLeader = (value: OpfsVfsWorker) => {
  if (!(value as unknown as { isLeader: boolean }).isLeader)
    throw new Error('Expected SAB benchmark client to be leader');
};

async function close(): Promise<void> {
  if (!client) return;
  const current = client;
  client = undefined;
  await current.closeVfs();
}

async function handle(request: Request): Promise<unknown> {
  if (request.type === 'open') {
    await close();
    client = new OpfsVfsWorker(request.name, { bufferMode: request.mode });
    await client.ready;
    assertLeader(client);
    await prepareDataset(client);
    return undefined;
  }
  if (request.type === 'measure') {
    if (!client) throw new Error('SAB benchmark client is not open');
    return measureSync(client, request.workload, request);
  }
  if (request.type === 'coldLeader') {
    if (client) throw new Error('Close the SAB benchmark client before measuring cold readiness');
    return measureColdAsync(() => {
      const value = new OpfsVfsWorker(request.name, { bufferMode: request.mode });
      return { ready: value.ready.then(() => assertLeader(value)), closeVfs: () => value.closeVfs() };
    }, request);
  }
  await close();
  return undefined;
}

self.onmessage = (event: MessageEvent<Request>) => {
  const request = event.data;
  void handle(request).then(
    (result) => self.postMessage({ id: request.id, result }),
    (error: unknown) => {
      const value = error instanceof Error ? error : new Error(String(error));
      self.postMessage({ id: request.id, error: `${value.message}\n${value.stack ?? ''}` });
    },
  );
};
