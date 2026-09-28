import { describe, expect, it } from 'vitest';

import { SAB_SIZE, Status, SyncMessenger } from '../sync-messenger';

const STATUS_SLOT = 0;
const CALL_ID_SLOT = 3;

function newSab(): SharedArrayBuffer {
  return new SharedArrayBuffer(SAB_SIZE + 64);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('SyncMessenger polling fallback', () => {
  it.each([Status.RESULT, Status.ERROR])(
    'preserves an unconsumed %s until the consumer deadline',
    async (status) => {
      const descriptor = Object.getOwnPropertyDescriptor(Atomics, 'waitAsync')!;
      const controller = new AbortController();
      const sab = newSab();
      const int32 = new Int32Array(sab);
      const header = new TextEncoder().encode(JSON.stringify({ type: 'WRITE' }));
      int32[1] = header.length;
      int32[CALL_ID_SLOT] = 1;
      new Uint8Array(sab, 64, header.length).set(header);
      Atomics.store(int32, STATUS_SLOT, Status.COMMAND);
      Object.defineProperty(Atomics, 'waitAsync', { ...descriptor, value: undefined });
      try {
        const started = performance.now();
        new SyncMessenger(sab).listen(
          async () => {
            if (status === Status.ERROR) throw new Error('write failed');
            return { result: 'written' };
          },
          { signal: controller.signal },
        );
        await expect.poll(() => Atomics.load(int32, STATUS_SLOT)).toBe(status);
        await sleep(50);
        expect(Atomics.load(int32, STATUS_SLOT)).toBe(status);
        await expect.poll(() => Atomics.load(int32, STATUS_SLOT), { timeout: 8000 }).toBe(Status.IDLE);
        expect(performance.now() - started).toBeGreaterThanOrEqual(5000);

        // An aborted listener must leave the next response for its caller.
        int32[1] = header.length;
        int32[CALL_ID_SLOT] = 2;
        new Uint8Array(sab, 64, header.length).set(header);
        Atomics.store(int32, STATUS_SLOT, Status.COMMAND);
        await expect.poll(() => Atomics.load(int32, STATUS_SLOT)).toBe(status);
        controller.abort();
        await sleep(50);
        expect(Atomics.load(int32, STATUS_SLOT)).toBe(status);
      } finally {
        controller.abort();
        Object.defineProperty(Atomics, 'waitAsync', descriptor);
      }
    },
    15000,
  );
});

describe('SyncMessenger SAB-2 (no busy-spin / dead-caller recovery)', () => {
  // If the caller is terminated after consuming a COMMAND, the worker is left
  // parked on RESULT/ERROR. The old loop spun synchronously at 100% CPU and
  // never recovered. The new loop awaits and, after a bounded wait, resets the
  // slot to IDLE itself. We can prove "no synchronous spin" because a spinning
  // loop on the main thread would starve this test's timers and it would hang;
  // and we prove recovery because the slot flips back to IDLE on its own.
  it('does not synchronously spin while parked on a non-IDLE status, and self-resets', async () => {
    const sab = newSab();
    const int32 = new Int32Array(sab);
    const messenger = new SyncMessenger(sab);

    // Start the worker-side listener (non-blocking; safe on the main thread).
    messenger.listen(async () => ({ result: 'unused' }));

    // Simulate a dead caller that left a stale RESULT frame in the slot.
    int32[CALL_ID_SLOT] = 42;
    Atomics.store(int32, STATUS_SLOT, Status.RESULT);
    Atomics.notify(int32, STATUS_SLOT);

    // A macrotask timer must still fire promptly -> the loop is NOT spinning
    // synchronously (otherwise this await would never resolve).
    const before = Date.now();
    await sleep(50);
    expect(Date.now() - before).toBeLessThan(2000);
    // Still parked (CONSUMER_WAIT_MS not elapsed yet).
    expect(Atomics.load(int32, STATUS_SLOT)).toBe(Status.RESULT);

    // After the bounded consumer wait expires the worker resets to IDLE itself.
    let resetToIdle = false;
    for (let i = 0; i < 80; i++) {
      if (Atomics.load(int32, STATUS_SLOT) === Status.IDLE) {
        resetToIdle = true;
        break;
      }
      await sleep(100);
    }
    expect(resetToIdle).toBe(true);
  }, 15000);
});

describe('SyncMessenger SAB-6 (listen cancellation / INIT idempotency)', () => {
  // A second INIT must stop the previous listen() loop instead of leaving it
  // running against the old SAB. The loop honours an AbortSignal: once aborted
  // it stops servicing COMMANDs. We prove this by aborting, then publishing a
  // COMMAND and asserting it is NOT consumed (status stays COMMAND, handler not
  // invoked) — whereas a still-running loop would consume it.
  it('stops servicing commands once its signal is aborted', async () => {
    const sab = newSab();
    const int32 = new Int32Array(sab);
    const messenger = new SyncMessenger(sab);

    let handlerCalls = 0;
    const controller = new AbortController();
    messenger.listen(
      async () => {
        handlerCalls++;
        return { result: 'ok' };
      },
      { signal: controller.signal },
    );

    // Abort the loop, then give it a few macrotasks to observe the abort.
    controller.abort();
    await sleep(50);

    // Publish a COMMAND as if a (stale) caller issued one.
    int32[CALL_ID_SLOT] = 7;
    int32[1] = 2; // HEADER_LEN_SLOT
    new Uint8Array(sab, 64).set(new TextEncoder().encode('{}'));
    int32[2] = 0; // DATA_LEN_SLOT
    Atomics.store(int32, STATUS_SLOT, Status.COMMAND);
    Atomics.notify(int32, STATUS_SLOT);

    await sleep(300);

    // An aborted loop never picked it up: still COMMAND, handler never ran.
    expect(handlerCalls).toBe(0);
    expect(Atomics.load(int32, STATUS_SLOT)).toBe(Status.COMMAND);
  }, 15000);
});

describe('SyncMessenger SAB-7 (error responses are never byte-truncated mid-JSON)', () => {
  // A remote error whose message exceeds the payload region must still arrive as
  // a PARSEABLE error (truncated message prefix), not a JSON.parse failure. We
  // run listen() on the main thread (non-blocking) and call() from a worker.
  it('delivers an oversized remote error message as a parseable truncated prefix', async () => {
    // Tiny SAB so a few-KB message overflows the payload region cheaply.
    const PAYLOAD = 2048;
    const sab = new SharedArrayBuffer(PAYLOAD + 64);
    const messenger = new SyncMessenger(sab);

    // Distinctive, multi-byte-flavoured huge message far bigger than PAYLOAD.
    const hugeMessage = 'BOOM_' + 'é'.repeat(5000); // multi-byte chars + clear prefix
    messenger.listen(async () => {
      throw new Error(hugeMessage);
    });

    const worker = new Worker(new URL('./sync-messenger-caller-worker.ts', import.meta.url), { type: 'module' });
    const outcome = await new Promise<{ type: string; message?: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('caller timed out')), 15000);
      worker.onerror = (e) => {
        clearTimeout(timer);
        reject(new Error(`worker error: ${e.message}`));
      };
      worker.onmessage = (event) => {
        const d = event.data;
        if (d.type === 'READY') {
          worker.postMessage({ type: 'CALL', id: 1, cmd: 'BOOM', payload: {} });
          return;
        }
        if (d.type === 'CALL_RESULT' || d.type === 'CALL_ERROR') {
          clearTimeout(timer);
          resolve(d);
        }
      };
      worker.postMessage({ type: 'INIT', sab });
    });
    worker.terminate();

    // The call must reject (CALL_ERROR), and the message must be a real string
    // (no "Unexpected end of JSON input" / parse failure) carrying the prefix.
    expect(outcome.type).toBe('CALL_ERROR');
    expect(typeof outcome.message).toBe('string');
    expect(outcome.message).not.toMatch(/JSON|Unexpected|parse/i);
    expect(outcome.message).toContain('BOOM_');
    // And it was actually truncated (shorter than the original).
    expect((outcome.message as string).length).toBeLessThan(hugeMessage.length);
  }, 20000);
});
