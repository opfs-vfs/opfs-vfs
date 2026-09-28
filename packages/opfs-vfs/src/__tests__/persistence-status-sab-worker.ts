import { OpenFlags } from '../opfs-vfs';
import { OpfsVfsWorker } from '../index_internal';
import { persistenceFaultRequest } from './persistence-fault-plugin';

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Expected persistence status to settle');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

self.onmessage = async (event: MessageEvent<{ fileName: string }>) => {
  const { fileName } = event.data;
  const client = new OpfsVfsWorker(fileName, {
    forceLeader: true,
    worker: () => new Worker(new URL('./persistence-status-worker.ts', import.meta.url), { type: 'module' }),
    plugins: [persistenceFaultRequest()],
  });
  let result: unknown;
  try {
    await client.ready;
    await until(() => client.getStatus().persistence !== null);
    const control = new BroadcastChannel(`persistence-fault-${fileName}`);
    try {
      const armed = new Promise<void>((resolve) => (control.onmessage = () => resolve()));
      control.postMessage({ type: 'fail', count: 1 });
      await armed;
    } finally {
      control.close();
    }
    const fd = client.openSync('/fault', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
    client.writeSync(fd, new Uint8Array([1]));
    client.closeSync(fd);
    let syncError: { code?: unknown } | undefined;
    try {
      client.syncSync();
    } catch (error) {
      syncError = {
        code: typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined,
      };
    }
    await until(
      () =>
        client.getStatus().persistence?.state === 'error' &&
        (client.getStatus().persistence?.failureRevision ?? 0) >= 1,
    );
    result = { syncError, persistence: client.getStatus().persistence };
  } catch (error) {
    result = { failure: String(error) };
  } finally {
    await client.closeVfs().catch(() => client.dispose());
  }
  // Reply only after close released the volume, so the page can delete it.
  self.postMessage(result);
};
