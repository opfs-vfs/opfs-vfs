import { describe, expect, it } from 'vitest';

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

const enabled = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_SUBSCRIPTIONS_ACCEPTANCE === '1';

function run(mode: Mode, bufferMode: 'memory' | 'disk') {
  const worker = new Worker(new URL('./subscription-acceptance-worker.ts', import.meta.url), { type: 'module' });
  return new Promise<Result>((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('acceptance worker timed out'));
    }, 15000);
    worker.onerror = (event) => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(event.message));
    };
    worker.onmessage = ({ data }: MessageEvent<Result>) => {
      clearTimeout(timer);
      worker.terminate();
      if (data.error) reject(new Error(data.error));
      else resolve(data);
    };
    worker.postMessage({ mode, bufferMode });
  });
}

describe.skipIf(!enabled)('subscription acceptance modes', () => {
  it.each(['memory', 'disk'] as const)('measures no-plugin, metadata, and content %s mutations', async (bufferMode) => {
    const none = await run('none', bufferMode);
    const metadata = await run('metadata', bufferMode);
    const content = await run('content', bufferMode);
    console.info('SUBSCRIPTIONS_ACCEPTANCE', JSON.stringify({ none, metadata, content }));
    expect(none.deliveries).toBe(0);
    expect(none.captureCalls).toBeNull();
    expect(metadata.deliveries).toBe(102);
    expect(metadata.captureCalls).toBe(0);
    expect(metadata.deliveryIncludedFrames).toBe(0);
    expect(content.deliveries).toBe(102);
    expect(content.captureCalls).toBe(102);
    expect(content.captureBytes).toBe(102 * 4096);
    expect(content.deliveryIncludedFrames).toBe(102);
    expect(content.deliveryIncludedBytes).toBe(102 * 4096);
    expect(content.nativeReads).toBe(bufferMode === 'disk' ? 102 : null);
    expect(content.terminal).toBeUndefined();
  });
});
