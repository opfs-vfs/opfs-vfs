import { deleteVolume, OpenFlags, OpfsVfs } from '@opfs-vfs/opfs-vfs';
import type { CompletedLogicalOperation } from '@opfs-vfs/opfs-vfs/changes';
import type { ConfiguredVfsPlugin } from '@opfs-vfs/opfs-vfs/plugins';
import { subscribe } from '../client';
import { subscriptions } from '../index';

type Result = { reads: number; allowed: string[]; denied: string[] } | { error: string };

self.onmessage = async ({ data }: MessageEvent<{ allowed: string; denied: string }>) => {
  const name = `subscription-content-capture-${crypto.randomUUID()}.bin`;
  let capturing = false;
  let reads = 0;
  const readDescriptor = Object.getOwnPropertyDescriptor(FileSystemSyncAccessHandle.prototype, 'read');
  if (typeof readDescriptor?.value !== 'function') throw new Error('Sync access-handle read is missing');
  const originalRead = readDescriptor.value as FileSystemSyncAccessHandle['read'];
  FileSystemSyncAccessHandle.prototype.read = function (
    this: FileSystemSyncAccessHandle,
    ...args: Parameters<typeof originalRead>
  ) {
    if (capturing) reads++;
    return originalRead.call(this, ...args);
  };
  const configured = subscriptions();
  const contribution = configured.logicalChanges;
  if (!contribution) throw new Error('Subscriptions contribution is missing logical changes');
  const plugin: ConfiguredVfsPlugin = {
    ...configured,
    logicalChanges: {
      ...contribution,
      create(host) {
        const session = contribution.create(host);
        return {
          ...session,
          completed(operation) {
            const capture = operation.capture.bind(operation);
            const scoped: CompletedLogicalOperation = {
              ...operation,
              capture(record, maxBytes) {
                capturing = true;
                try {
                  return capture(record, maxBytes);
                } finally {
                  capturing = false;
                }
              },
            };
            session.completed(scoped);
          },
        };
      },
    },
  };
  const fs = new OpfsVfs(name, { bufferMode: 'disk', plugins: [plugin] });
  let result: Result = { error: 'Capture worker did not finish' };
  try {
    await fs.ready;
    const allowedPath = `${data.allowed}/file`;
    const deniedPath = `${data.denied}/alias`;
    fs.mkdirSync(data.allowed);
    fs.mkdirSync(data.denied);
    fs.writeFileBufferSync(allowedPath, new Uint8Array());
    fs.linkSync(allowedPath, deniedPath);
    const fd = fs.openSync(allowedPath, OpenFlags.O_WRONLY);
    const allowed: string[] = [];
    const denied: string[] = [];
    let allowedOne!: () => void;
    let allowedTwo!: () => void;
    let deniedOne!: () => void;
    const allDelivered = Promise.all([
      new Promise<void>((resolve) => (allowedOne = resolve)),
      new Promise<void>((resolve) => (allowedTwo = resolve)),
      new Promise<void>((resolve) => (deniedOne = resolve)),
    ]);
    const options = { scope: 'file' as const, events: ['update'] as const, content: { maxBytes: 4096 }, onError() {} };
    const first = await subscribe(fs, { ...options, path: allowedPath }, (change) => {
      allowed.push(change.content.status === 'included' ? 'included' : change.content.reason);
      allowedOne();
    });
    const second = await subscribe(fs, { ...options, path: allowedPath }, (change) => {
      allowed.push(change.content.status === 'included' ? 'included' : change.content.reason);
      allowedTwo();
    });
    const deniedSubscription = await subscribe(fs, { ...options, path: deniedPath }, (change) => {
      denied.push(change.content.status === 'included' ? 'included' : change.content.reason);
      deniedOne();
    });
    fs.chmodSync(data.denied, 0);
    fs.writeSync(fd, new Uint8Array(4096).fill(7), 0);
    await allDelivered;
    fs.closeSync(fd);
    first.unsubscribe();
    second.unsubscribe();
    deniedSubscription.unsubscribe();
    result = { reads, allowed, denied };
  } catch (error) {
    result = { error: error instanceof Error ? error.message : String(error) };
  } finally {
    Object.defineProperty(FileSystemSyncAccessHandle.prototype, 'read', readDescriptor);
    try {
      await fs.closeVfs();
      await deleteVolume(name);
    } catch (error) {
      result = {
        error: `${'error' in result ? result.error : 'Capture worker completed'}; cleanup failed: ${String(error)}`,
      };
    }
    self.postMessage(result);
  }
};
