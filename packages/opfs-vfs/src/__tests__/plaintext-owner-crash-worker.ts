import { OpfsVfsWorker } from '../index_internal';
import { OpenFlags } from '../opfs-vfs';

type Request =
  | { type: 'MOUNT'; fileName: string; baseline: Uint8Array; latest?: Uint8Array }
  | { type: 'VERIFY'; fileName: string; mode: 'memory' | 'disk'; length: number; checkpoint?: boolean };

async function rawBytes(fileName: string) {
  const root = await navigator.storage.getDirectory();
  const file = await (await root.getFileHandle(fileName, { create: false })).getFile();
  return new Uint8Array(await file.arrayBuffer());
}

self.onmessage = async ({ data }: MessageEvent<Request>) => {
  let vfs: OpfsVfsWorker | undefined;
  try {
    vfs = new OpfsVfsWorker(data.fileName, {
      forceLeader: true,
      bufferMode: data.type === 'MOUNT' ? (data.latest ? 'memory' : 'disk') : data.mode,
      localDurabilityMode: 'strict',
      noatime: true,
    });
    await vfs.ready;
    if (data.type === 'MOUNT') {
      const fd = await vfs.open('/file', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
      await vfs.write(fd, data.baseline, 0);
      await vfs.sync();
      const before = await rawBytes(data.fileName);
      let acknowledged = 0;
      if (data.latest) acknowledged = await vfs.write(fd, data.latest, 0);
      else await vfs.close(fd);
      const after = await rawBytes(data.fileName);
      const wal = await rawBytes(data.fileName.replace(/\.bin$/, '.data.log'));
      // Keep the mount and pending-write descriptor open. The parent terminates
      // this owner, which must also release its nested worker's OPFS handles.
      self.postMessage({
        type: 'MOUNTED',
        acknowledged,
        walBytes: wal.length,
        dataBytes: before.length,
        dataUnchanged: before.length === after.length && before.every((byte, i) => byte === after[i]),
      });
      return;
    }

    const fd = await vfs.open('/file');
    const { buffer, read } = await vfs.read(fd, data.length + 1, 0);
    const eof = await vfs.read(fd, 1, data.length);
    const result = {
      type: 'VERIFIED',
      names: await vfs.readdirNames('/'),
      size: (await vfs.fstat(fd)).size,
      bytes: buffer,
      read,
      eof: eof.read,
    };
    await vfs.close(fd);
    if (data.checkpoint) await vfs.sync();
    await vfs.closeVfs();
    vfs = undefined;
    self.postMessage(result);
  } catch (error) {
    try {
      await vfs?.closeVfs();
    } catch {
      vfs?.dispose();
    }
    self.postMessage({
      type: 'ERROR',
      error: error instanceof Error ? `${error.message}\n${error.stack}` : String(error),
    });
  }
};
