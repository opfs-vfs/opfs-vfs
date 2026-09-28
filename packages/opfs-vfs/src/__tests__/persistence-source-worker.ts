import { deleteVolume } from '../index';
import { persistenceSources } from '../mount-context';
import { OpenFlags, OpfsVfs, type SyncAccessHandleTag } from '../opfs-vfs';

type Case = 'strict-data-wal' | 'data-wal-write' | 'strict-meta-log' | 'snapshot' | 'checkpoint-retry';
const setup: Record<Case, { tags: SyncAccessHandleTag[]; durability: 'strict' | 'balanced' }> = {
  // Strict per-operation flushes of the data WAL and the namespace log.
  'strict-data-wal': { tags: ['dataLog'], durability: 'strict' },
  // A failed (non-quota) data WAL frame write, in any durability mode.
  'data-wal-write': { tags: ['dataLog'], durability: 'balanced' },
  'strict-meta-log': { tags: ['metaLog'], durability: 'strict' },
  // Meta-log compaction: a full metadata snapshot written by an ordinary namespace operation.
  snapshot: { tags: ['metaA', 'metaB'], durability: 'balanced' },
  // A failed sync checkpoint is retried by the next write, which can fail again.
  'checkpoint-retry': { tags: ['dataLog'], durability: 'balanced' },
};

// Failures at each source must be recorded, and the retained failure must survive the next clean sync.
self.onmessage = async ({ data }: MessageEvent<{ case: Case }>) => {
  const { tags, durability } = setup[data.case];
  const fileName = `persistence-source-${crypto.randomUUID()}.bin`;
  // One entry per upcoming flush of a wrapped handle: true fails it.
  let plan: boolean[] = [];
  // A fresh error per failure, like real I/O errors; re-recording the same object is not a new failure.
  let injected: Error | undefined;
  const vfs = new OpfsVfs(fileName, {
    bufferMode: 'memory',
    localDurabilityMode: durability,
    _wrapSyncAccessHandle: (handle, tag) => {
      if (!tags.includes(tag)) return handle;
      const fail = () => {
        if (plan.shift()) throw (injected = Object.assign(new Error('Injected I/O failure'), { code: 'EIO' }));
      };
      if (data.case === 'data-wal-write') {
        const write = handle.write.bind(handle);
        handle.write = (buffer, options) => {
          fail();
          return write(buffer, options);
        };
      } else {
        const flush = handle.flush.bind(handle);
        handle.flush = () => {
          fail();
          flush();
        };
      }
      return handle;
    },
  });
  const write = (bytes: number[]) => {
    const fd = vfs.openSync('/file', OpenFlags.O_CREAT | OpenFlags.O_RDWR);
    try {
      vfs.writeSync(fd, new Uint8Array(bytes), 0);
    } finally {
      vfs.closeSync(fd);
    }
  };
  const attempt = (operation: () => void) => {
    try {
      operation();
      return false;
    } catch (error) {
      return error !== undefined && error === injected;
    }
  };
  let result: unknown;
  try {
    await vfs.ready;
    const source = persistenceSources.get(vfs)!;
    let notified = 0;
    source.watch(() => notified++);
    const thrown: boolean[] = [];
    if (data.case === 'checkpoint-retry') {
      write([1]);
      // The sync flushes the pending WAL records, then fails its checkpoint.
      plan = [false, true];
      thrown.push(attempt(() => vfs.syncSync()));
      // The next write retries the checkpoint first, and that retry fails too.
      plan = [true];
      thrown.push(attempt(() => write([2])));
    } else {
      // Put the namespace log at its compaction threshold, so the next metadata write is a full snapshot.
      if (data.case === 'snapshot') (vfs as unknown as { logOffset: number }).logOffset = 4 * 1024 * 1024;
      plan = [true];
      thrown.push(
        attempt(() =>
          data.case === 'strict-data-wal' || data.case === 'data-wal-write' ? write([1, 2, 3]) : vfs.mkdirSync('/dir'),
        ),
      );
    }
    plan = [];
    const failed = source.read();
    vfs.syncSync();
    const recovered = source.read();
    const view = (value: typeof failed) => ({
      state: value.state,
      failureRevision: value.failureRevision,
      retained: value.failure === injected,
    });
    result = { thrown, failed: view(failed), recovered: view(recovered), notified };
  } catch (error) {
    result = { error: String(error) };
  } finally {
    await vfs.closeVfs();
    await deleteVolume(fileName);
  }
  // Reply only after cleanup, so terminating the worker cannot interrupt the volume deletion.
  self.postMessage(result);
};
