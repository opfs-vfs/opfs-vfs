// Test helper worker: runs SyncMessenger.call() (which requires a worker
// context because it blocks on Atomics.wait). Driven by the main test thread,
// which owns the listen() side over a shared SAB.
import { SyncMessenger } from '../sync-messenger';

let messenger: SyncMessenger | null = null;

self.onmessage = (event: MessageEvent) => {
  const data = event.data;
  try {
    if (data.type === 'INIT') {
      messenger = new SyncMessenger(data.sab as SharedArrayBuffer);
      self.postMessage({ type: 'READY' });
      return;
    }
    if (data.type === 'CALL') {
      if (!messenger) throw new Error('messenger not initialized');
      const payloadBytes: Uint8Array | undefined = data.data;
      const result = messenger.call(data.cmd, data.payload, payloadBytes);
      self.postMessage({ type: 'CALL_RESULT', id: data.id, result });
      return;
    }
  } catch (error) {
    self.postMessage({
      type: 'CALL_ERROR',
      id: data.id,
      message: error instanceof Error ? error.message : String(error),
      code:
        typeof error === 'object' && error !== null && 'code' in error ? (error as { code: unknown }).code : undefined,
      name: error instanceof Error ? error.name : undefined,
      category: (error as { category?: unknown } | null)?.category,
      offset: (error as { offset?: unknown } | null)?.offset,
    });
  }
};
