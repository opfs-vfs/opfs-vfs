import { OpenFlags } from '@opfs-vfs/opfs-vfs';
import { OpfsVfsWorker } from '@opfs-vfs/opfs-vfs/worker';
import { subscriptionsRequest } from '@opfs-vfs/plugin-subscriptions/config';

const volumeWorker = () => new Worker(new URL('./resync-volume-worker.ts', import.meta.url), { type: 'module' });
let vfs: OpfsVfsWorker | undefined;
let runtime: Worker | undefined;

function worker() {
  runtime = volumeWorker();
  return runtime;
}

self.onmessage = async ({ data }: MessageEvent<{ type: string; fileName?: string; value?: number }>) => {
  try {
    if (data.type === 'START') {
      vfs = new OpfsVfsWorker(data.fileName!, { worker, plugins: [subscriptionsRequest()] });
      await vfs.ready;
      self.postMessage({ type: 'READY' });
      return;
    }
    if (data.type === 'WRITE') {
      const fd = vfs!.openSync('/sab', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      try {
        vfs!.writeSync(fd, new Uint8Array([data.value!]));
      } finally {
        vfs!.closeSync(fd);
      }
      self.postMessage({ type: 'SYNC_RETURNED' });
      return;
    }
    if (data.type === 'INVALIDATE') {
      runtime!.postMessage({ type: 'INVALIDATE' });
      self.postMessage({ type: 'INVALIDATED' });
      return;
    }
    if (data.type === 'CLOSE') {
      await vfs?.closeVfs();
      runtime?.terminate();
      self.postMessage({ type: 'CLOSED' });
    }
  } catch (error) {
    self.postMessage({ type: 'ERROR', message: error instanceof Error ? error.message : String(error) });
  }
};
