import { deleteVolume, OpfsVfs } from '@opfs-vfs/opfs-vfs';
import type { CompletedLogicalOperation } from '@opfs-vfs/opfs-vfs/changes';
import type { ConfiguredVfsPlugin } from '@opfs-vfs/opfs-vfs/plugins';
import { subscribe, type Subscription } from '../client';
import { subscriptions } from '../index';

type Mode = 'none' | 'metadata' | 'content';
type Result = {
  mode: Mode;
  bufferMode: 'memory' | 'disk';
  commandMs: { firstWrite: number; remainingWrites: number; chmod: number; utimes: number };
  deliveries: number;
  captureCalls: number | null;
  captureBytes: number | null;
  deliveryIncludedFrames: number | null;
  deliveryIncludedBytes: number | null;
  nativeReads: number | null;
  terminal?: string;
  error?: string;
};

self.onmessage = async ({ data }: MessageEvent<{ mode: Mode; bufferMode: 'memory' | 'disk' }>) => {
  const name = `subscriptions-acceptance-${data.mode}-${data.bufferMode}-${crypto.randomUUID()}.bin`;
  let capturing = false;
  let captureCalls = 0;
  let captureBytes = 0;
  let deliveryIncludedFrames = 0;
  let deliveryIncludedBytes = 0;
  let nativeReads = 0;
  const descriptor = Object.getOwnPropertyDescriptor(FileSystemSyncAccessHandle.prototype, 'read');
  if (typeof descriptor?.value !== 'function') throw new Error('Sync access-handle read is missing');
  const originalRead = descriptor.value as FileSystemSyncAccessHandle['read'];
  FileSystemSyncAccessHandle.prototype.read = function (
    this: FileSystemSyncAccessHandle,
    ...args: Parameters<typeof originalRead>
  ) {
    if (capturing) nativeReads++;
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
        const session = contribution.create({
          ...host,
          send(client, frame) {
            if (frame.type === 'event' && frame.change.content.status === 'included') {
              deliveryIncludedFrames++;
              deliveryIncludedBytes += frame.change.content.bytes.byteLength;
            }
            host.send(client, frame);
          },
        });
        return {
          ...session,
          completed(operation) {
            const capture = operation.capture.bind(operation);
            const scoped: CompletedLogicalOperation = {
              ...operation,
              capture(record, maxBytes) {
                captureCalls++;
                capturing = true;
                try {
                  const result = capture(record, maxBytes);
                  if (result.status === 'included') captureBytes += result.bytes.byteLength;
                  return result;
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
  const fs = new OpfsVfs(name, { bufferMode: data.bufferMode, plugins: data.mode === 'none' ? [] : [plugin] });
  let subscription: Subscription | undefined;
  let result: Result = {
    mode: data.mode,
    bufferMode: data.bufferMode,
    commandMs: { firstWrite: 0, remainingWrites: 0, chmod: 0, utimes: 0 },
    deliveries: 0,
    captureCalls: data.mode === 'none' ? null : 0,
    captureBytes: data.mode === 'none' ? null : 0,
    deliveryIncludedFrames: data.mode === 'none' ? null : 0,
    deliveryIncludedBytes: data.mode === 'none' ? null : 0,
    nativeReads: data.mode === 'none' || data.bufferMode === 'memory' ? null : 0,
  };
  try {
    await fs.ready;
    fs.writeFileBufferSync('/file', new Uint8Array(4096));
    let deliveries = 0;
    let terminal: string | undefined;
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    let allDelivered!: () => void;
    const first = new Promise<void>((resolve) => (firstStarted = resolve));
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    const delivered = new Promise<void>((resolve) => (allDelivered = resolve));
    if (data.mode !== 'none') {
      subscription = await subscribe(
        fs,
        {
          path: '/file',
          scope: 'file',
          events: ['update'],
          content: data.mode === 'content' ? { maxBytes: 4096 } : false,
          onError(error) {
            terminal = error.code;
            allDelivered();
          },
        },
        async () => {
          if (++deliveries === 1) {
            firstStarted();
            await firstGate;
          }
          if (deliveries === 102) allDelivered();
        },
      );
    }
    let started = performance.now();
    fs.writeFileBufferSync('/file', new Uint8Array(4096).fill(1));
    const firstWrite = performance.now() - started;
    if (data.mode !== 'none') await first;
    started = performance.now();
    for (let i = 1; i < 100; i++) fs.writeFileBufferSync('/file', new Uint8Array(4096).fill(i + 1));
    const remainingWrites = performance.now() - started;
    started = performance.now();
    fs.chmodSync('/file', 0o600);
    const chmod = performance.now() - started;
    started = performance.now();
    fs.utimesSync('/file', 1_000_000, 1_000_000);
    const utimes = performance.now() - started;
    if (data.mode !== 'none') releaseFirst();
    if (data.mode !== 'none') await delivered;
    result = {
      mode: data.mode,
      bufferMode: data.bufferMode,
      commandMs: { firstWrite, remainingWrites, chmod, utimes },
      deliveries,
      captureCalls: data.mode === 'none' ? null : captureCalls,
      captureBytes: data.mode === 'none' ? null : captureBytes,
      deliveryIncludedFrames: data.mode === 'none' ? null : deliveryIncludedFrames,
      deliveryIncludedBytes: data.mode === 'none' ? null : deliveryIncludedBytes,
      nativeReads: data.mode === 'none' || data.bufferMode === 'memory' ? null : nativeReads,
      terminal,
    };
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    subscription?.unsubscribe();
    Object.defineProperty(FileSystemSyncAccessHandle.prototype, 'read', descriptor);
    try {
      await fs.closeVfs();
      await deleteVolume(name);
    } catch (error) {
      result.error = `${result.error ?? 'acceptance worker completed'}; cleanup failed: ${String(error)}`;
    }
    self.postMessage(result);
  }
};
