import { describe, expect, it } from 'vitest';

import { VfsCorruptionError, VfsError } from '../fs-errors';
import { SAB_SIZE, Status, SyncMessenger } from '../sync-messenger';

// Int32 header slot layout (mirrors sync-messenger.ts internals).
const STATUS_SLOT = 0;
const HEADER_LEN_SLOT = 1;
const DATA_LEN_SLOT = 2;
const CALL_ID_SLOT = 3;
const PAYLOAD_OFFSET = 64;

function newSab(): SharedArrayBuffer {
  return new SharedArrayBuffer(SAB_SIZE + 64);
}

interface CallOutcome {
  type: 'CALL_RESULT' | 'CALL_ERROR';
  id: number;
  result?: unknown;
  message?: string;
  code?: unknown;
}

/**
 * Spawns the caller worker (which runs the blocking call()) and gives the test
 * full manual control over the listener side via the shared SAB. The supplied
 * `respond` callback is invoked once the worker has published a COMMAND; it can
 * craft an arbitrary response frame (correct/incorrect call ID, bogus lengths)
 * to exercise SAB-1/SAB-3 paths deterministically.
 */
function driveCall(
  sab: SharedArrayBuffer,
  cmd: string,
  payload: unknown,
  respond: (int32: Int32Array, observedCallId: number) => void,
): { worker: Worker; outcome: Promise<CallOutcome> } {
  const int32 = new Int32Array(sab);
  const worker = new Worker(new URL('./sync-messenger-caller-worker.ts', import.meta.url), { type: 'module' });

  const outcome = new Promise<CallOutcome>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('driveCall timed out')), 15000);
    worker.onerror = (e) => {
      clearTimeout(timer);
      reject(new Error(`worker error: ${e.message}`));
    };
    worker.onmessage = (event) => {
      const data = event.data;
      if (data.type === 'READY') {
        worker.postMessage({ type: 'CALL', id: 1, cmd, payload });
        // Poll the SAB for the COMMAND, then let the test respond.
        const poll = setInterval(() => {
          if (Atomics.load(int32, STATUS_SLOT) === Status.COMMAND) {
            clearInterval(poll);
            const observedCallId = int32[CALL_ID_SLOT];
            respond(int32, observedCallId);
          }
        }, 2);
        return;
      }
      if (data.type === 'CALL_RESULT' || data.type === 'CALL_ERROR') {
        clearTimeout(timer);
        resolve(data as CallOutcome);
      }
    };
    worker.postMessage({ type: 'INIT', sab });
  });

  return { worker, outcome };
}

function writeFrame(int32: Int32Array, sab: SharedArrayBuffer, status: Status, header: object, callId: number) {
  const encoded = new TextEncoder().encode(JSON.stringify(header));
  int32[HEADER_LEN_SLOT] = encoded.length;
  new Uint8Array(sab, PAYLOAD_OFFSET).set(encoded);
  int32[DATA_LEN_SLOT] = 0;
  int32[CALL_ID_SLOT] = callId;
  Atomics.store(int32, STATUS_SLOT, status);
  Atomics.notify(int32, STATUS_SLOT);
}

describe('SyncMessenger SAB-1 (call-ID protocol)', () => {
  it('rejects a reclaimed response instead of reporting undefined success', async () => {
    const sab = newSab();
    const { worker, outcome } = driveCall(sab, 'PING', {}, (words, id) => {
      writeFrame(words, sab, Status.IDLE, { error: 'lost failure' }, id);
    });
    try {
      const response = await outcome;
      expect(response.type).toBe('CALL_ERROR');
      expect(response.message).toMatch(/protocol desync/);
    } finally {
      worker.terminate();
    }
  });

  it('waits through a redundant COMMAND notification for the actual response', async () => {
    const sab = newSab();
    const { worker, outcome } = driveCall(sab, 'PING', {}, (words, id) => {
      Atomics.notify(words, STATUS_SLOT);
      setTimeout(() => writeFrame(words, sab, Status.RESULT, { result: 'actual response' }, id), 20);
    });
    try {
      expect(await outcome).toMatchObject({ type: 'CALL_RESULT', result: 'actual response' });
    } finally {
      worker.terminate();
    }
  });

  it('round-trips a request and echoes the call ID', async () => {
    const sab = newSab();
    const { worker, outcome } = driveCall(sab, 'PING', { n: 1 }, (int32) => {
      const observedId = int32[CALL_ID_SLOT];
      expect(observedId).toBe(1); // first call ID on a fresh messenger
      // Verify the request header carried the type/payload.
      const reqLen = int32[HEADER_LEN_SLOT];
      const reqCopy = new Uint8Array(reqLen);
      reqCopy.set(new Uint8Array(sab, PAYLOAD_OFFSET, reqLen));
      const req = JSON.parse(new TextDecoder().decode(reqCopy));
      expect(req).toEqual({ type: 'PING', payload: { n: 1 } });
      writeFrame(int32, sab, Status.RESULT, { result: 'pong' }, observedId);
    });
    const res = await outcome;
    worker.terminate();
    expect(res.type).toBe('CALL_RESULT');
    expect(res.result).toBe('pong');
    // Slot must be released back to IDLE after the caller consumed the frame.
    expect(Atomics.load(new Int32Array(sab), STATUS_SLOT)).toBe(Status.IDLE);
  });

  it('rejects a response whose echoed call ID does not match (stale frame)', async () => {
    const sab = newSab();
    const { worker, outcome } = driveCall(sab, 'PING', {}, (int32) => {
      const observedId = int32[CALL_ID_SLOT];
      // Simulate a late response from a previous (timed-out) call: wrong ID.
      writeFrame(int32, sab, Status.RESULT, { result: 'stale' }, observedId + 999);
    });
    const res = await outcome;
    worker.terminate();
    expect(res.type).toBe('CALL_ERROR');
    expect(res.message).toMatch(/protocol desync/i);
    // Even on protocol error the slot must be released.
    expect(Atomics.load(new Int32Array(sab), STATUS_SLOT)).toBe(Status.IDLE);
  });
});

describe('SyncMessenger SAB-3 (response length validation)', () => {
  it('rejects bogus response lengths without wedging the slot in RESULT', async () => {
    const sab = newSab();
    const { worker, outcome } = driveCall(sab, 'PING', {}, (int32) => {
      const observedId = int32[CALL_ID_SLOT];
      // Oversized header length: the caller must reject and still reset to IDLE
      // via the finally{} block rather than leaving the slot in RESULT forever.
      int32[HEADER_LEN_SLOT] = SAB_SIZE + 1024;
      int32[DATA_LEN_SLOT] = 0;
      int32[CALL_ID_SLOT] = observedId;
      Atomics.store(int32, STATUS_SLOT, Status.RESULT);
      Atomics.notify(int32, STATUS_SLOT);
    });
    const res = await outcome;
    worker.terminate();
    expect(res.type).toBe('CALL_ERROR');
    expect(res.message).toMatch(/exceeds SAB capacity|failed/i);
    // The finally{} reset must have released the slot to IDLE.
    expect(Atomics.load(new Int32Array(sab), STATUS_SLOT)).toBe(Status.IDLE);
  });
});

it('keeps an error code when the full VfsError envelope does not fit', async () => {
  const capacity = new TextEncoder().encode('{"error":"","code":"ENOENT"}').length;
  const sab = new SharedArrayBuffer(capacity + PAYLOAD_OFFSET);
  const messenger = new SyncMessenger(sab);
  messenger.listen(async () => {
    throw new VfsError('ENOENT');
  });
  const worker = new Worker(new URL('./sync-messenger-caller-worker.ts', import.meta.url), { type: 'module' });
  try {
    const outcome = await new Promise<CallOutcome>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('caller timed out')), 15000);
      worker.onerror = (event) => {
        clearTimeout(timer);
        reject(new Error(`worker error: ${event.message}`));
      };
      worker.onmessage = (event) => {
        if (event.data.type === 'READY') worker.postMessage({ type: 'CALL', id: 1, cmd: 'PING', payload: {} });
        if (event.data.type === 'CALL_ERROR') {
          clearTimeout(timer);
          resolve(event.data);
        }
      };
      worker.postMessage({ type: 'INIT', sab });
    });
    expect(outcome).toMatchObject({ type: 'CALL_ERROR', code: 'ENOENT' });
  } finally {
    worker.terminate();
  }
});

it('keeps a validated remote error without a code intact', async () => {
  const sab = new SharedArrayBuffer(4096 + PAYLOAD_OFFSET);
  const messenger = new SyncMessenger(sab);
  messenger.listen(async () => {
    throw new VfsCorruptionError('data-wal', 'Bad frame', 64);
  });
  const worker = new Worker(new URL('./sync-messenger-caller-worker.ts', import.meta.url), { type: 'module' });
  try {
    const outcome = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('caller timed out')), 15000);
      worker.onmessage = (event) => {
        if (event.data.type === 'READY') worker.postMessage({ type: 'CALL', id: 1, cmd: 'PING', payload: {} });
        if (event.data.type === 'CALL_ERROR') {
          clearTimeout(timer);
          resolve(event.data);
        }
      };
      worker.postMessage({ type: 'INIT', sab });
    });
    expect(outcome).toMatchObject({
      message: 'Bad frame',
      name: 'VfsCorruptionError',
      category: 'data-wal',
      offset: 64,
    });
  } finally {
    worker.terminate();
  }
});
