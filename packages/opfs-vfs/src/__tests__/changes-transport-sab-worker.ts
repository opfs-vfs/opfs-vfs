import { OpfsVfsWorker } from '../index_internal';
import { OpenFlags } from '../opfs-vfs';
import { changesTransportRequest } from './changes-transport-plugin';

const factory = () => new Worker(new URL('./changes-transport-worker.ts', import.meta.url), { type: 'module' });
let vfs: OpfsVfsWorker | undefined;

self.onmessage = async ({ data }: MessageEvent<{ type: string; fileName: string }>) => {
  if (data.type === 'CLOSE') {
    await vfs?.closeVfs();
    self.postMessage({ type: 'CLOSED' });
    return;
  }
  if (data.type !== 'RUN') return;
  try {
    vfs = new OpfsVfsWorker(data.fileName, {
      forceLeader: true,
      worker: factory,
      plugins: [changesTransportRequest()],
    });
    await vfs.ready;
    const changes = await vfs.openFileChangeChannel(
      (frame) => self.postMessage({ type: 'FRAME', frame }),
      (code) => self.postMessage({ type: 'INTERRUPTED', code }),
      () => self.postMessage({ type: 'CLOSED' }),
    );
    await changes.request({
      type: 'register',
      subscriptionId: 'local-sab',
      options: {
        path: '/',
        scope: 'directory',
        recursive: true,
        events: ['create', 'update', 'delete'],
        content: { maxBytes: 16 * 1024 * 1024 },
      },
    });
    await changes.request({ type: 'activate', subscriptionId: 'local-sab' });
    const fd = vfs.openSync('/sab', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
    try {
      vfs.writeSync(fd, new Uint8Array([1]));
      vfs.writeSync(fd, new Uint8Array([2]), 0);
    } finally {
      vfs.closeSync(fd);
    }
    self.postMessage({ type: 'SYNC_RETURNED' });
  } catch (error) {
    self.postMessage({ type: 'ERROR', message: error instanceof Error ? error.message : String(error) });
  }
};
