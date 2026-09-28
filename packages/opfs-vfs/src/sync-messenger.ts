import { parseRemoteError, reviveRemoteError, serializeRemoteError } from './remote-error';

/**
 * Default size of the SAB payload region (the binary area after the 64-byte
 * header). This is the PER-MESSAGE cap: a single request or response frame
 * (JSON header + binary data) must fit within it. Reads/writes larger than the
 * cap are transparently chunked at the worker proxy layer (index_internal.ts),
 * so callers see no size limit — but a chunked transfer is NOT atomic with
 * respect to a concurrent writer/crash (see the proxy `writeSync`/`readSync`).
 * A larger SAB raises the per-message cap and reduces chunk count.
 */
export const SAB_SIZE = 4 * 1024 * 1024; // 4MB
const PAYLOAD_OFFSET = 64;

// Int32 slot layout in the header region (bytes 0..63):
//   [0] status (see Status enum)
//   [1] header byte length
//   [2] data byte length
//   [3] call ID (monotonic per messenger; echoed by the worker in the response)
// Slots 4..15 remain spare.
const STATUS_SLOT = 0;
const HEADER_LEN_SLOT = 1;
const DATA_LEN_SLOT = 2;
const CALL_ID_SLOT = 3;

// After a caller timeout the worker may still be mid-flight, so the next call()
// waits (briefly) for it to settle back to IDLE before reusing the region.
const RECOVERY_WAIT_MS = 1000;
// Bounded wait the worker uses while parked on a status value; if it expires
// while still waiting for the caller to consume a RESULT/ERROR frame, the
// caller is presumed dead and the slot is reset to IDLE.
const CONSUMER_WAIT_MS = 5000;

// PERF-11: shared encoder/decoder hoisted to module scope (mirrors data-wal.ts)
// — TextEncoder/TextDecoder are reusable and thread-confined here, so a single
// instance avoids a per-call allocation on the hot SAB request/response path.
const sharedEncoder = new TextEncoder();
const sharedDecoder = new TextDecoder();
const revivedErrors = new WeakSet<object>();

export enum Status {
  IDLE = 0,
  COMMAND = 1,
  RESULT = 2,
  ERROR = 3,
}

interface SyncRequestHeader {
  type: string;
  payload: unknown;
}

interface SyncResponseHeader {
  result?: unknown;
}

interface SyncHandlerResult {
  result: unknown;
  data?: Uint8Array;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function assertSabPayloadFits(
  context: string,
  headerBytes: number,
  dataBytes: number = 0,
  capacity: number = SAB_SIZE,
) {
  if (headerBytes < 0 || dataBytes < 0) {
    throw new Error(`${context} has invalid payload lengths`);
  }
  if (headerBytes > capacity) {
    throw new Error(`${context} header exceeds SAB capacity (${headerBytes} > ${capacity})`);
  }
  if (headerBytes + dataBytes > capacity) {
    throw new Error(`${context} payload exceeds SAB capacity (${headerBytes + dataBytes} > ${capacity})`);
  }
}

export class SyncMessenger {
  private sab: SharedArrayBuffer;
  private int32: Int32Array;
  public callCount = 0;

  constructor(sab?: SharedArrayBuffer) {
    if (typeof SharedArrayBuffer === 'undefined') {
      throw new Error('SharedArrayBuffer is not supported.');
    }
    this.sab = sab || new SharedArrayBuffer(SAB_SIZE + 64);
    this.int32 = new Int32Array(this.sab);
  }

  get buffer() {
    return this.sab;
  }

  /**
   * SAB-5: per-message cap. A single request or response (header JSON + binary
   * data) must fit inside the SAB payload region, which is `byteLength - 64`
   * bytes (~4MB by default, see {@link SAB_SIZE}). Transfers larger than this
   * cannot cross the SAB in one frame; the proxy layer (index_internal.ts)
   * chunks reads/writes into pieces no larger than {@link maxDataBytesPerCall}
   * so large files round-trip transparently. Callers that bypass the proxy and
   * issue a raw oversized {@link call} still get a clean "exceeds SAB capacity"
   * error rather than corruption.
   */
  get payloadCapacity() {
    return this.sab.byteLength - PAYLOAD_OFFSET;
  }

  /**
   * Largest binary `data` payload that is guaranteed to fit in one frame for a
   * request/response of the given command type, after reserving room for the
   * JSON header. The reserve is generous (1KB) so header growth (paths, flags,
   * call IDs) never pushes a chunk over capacity. Used by the worker proxy to
   * size read/write chunks.
   */
  get maxDataBytesPerCall(): number {
    const HEADER_RESERVE = 1024;
    return Math.max(0, this.payloadCapacity - HEADER_RESERVE);
  }

  private ensureFits(context: string, headerBytes: number, dataBytes: number = 0) {
    assertSabPayloadFits(context, headerBytes, dataBytes, this.payloadCapacity);
  }

  /**
   * SAB-7: build a JSON error envelope whose encoded length is
   * guaranteed to fit in the payload region by truncating the *message string*
   * (not the encoded bytes) and re-encoding until it fits. Truncating the
   * string first keeps the framed bytes valid JSON; a trailing ellipsis marks
   * truncation. The loop converges quickly because each step removes at least
   * one whole code unit, and `encodeInto`-free `TextEncoder.encode` reports the
   * true byte length including multi-byte chars and JSON escaping.
   */
  private encodeBoundedErrorHeader(error: unknown): Uint8Array {
    const cap = this.payloadCapacity;
    const { error: message, ...details } = serializeRemoteError(error);
    // Prefer every field; when even an empty message cannot carry them, keep only the code.
    for (const fields of [details, details.code === undefined ? {} : { code: details.code }]) {
      const build = (msg: string) => sharedEncoder.encode(JSON.stringify({ error: msg, ...fields }));
      const encoded = build(message);
      if (encoded.length <= cap) return encoded;
      let best = build('');
      if (best.length > cap) continue;
      // Shrink the message string until the full JSON frame fits. Reserve a few
      // chars for an ellipsis marker; halve-then-refine to converge in O(log n).
      let lo = 0;
      let hi = message.length;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const candidate = build(message.slice(0, mid) + (mid < message.length ? '…' : ''));
        if (candidate.length <= cap) {
          best = candidate;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return best;
    }
    // Degenerate fallback: even `{"error":""}` would not fit (absurdly tiny
    // SAB). Emit the largest valid-JSON prefix we can ("{").
    return sharedEncoder.encode('{}').subarray(0, Math.max(0, cap));
  }

  private makeRemoteError(payload: unknown) {
    const details = parseRemoteError(payload);
    if (!details) return new Error('Invalid VFS error response');
    const error = reviveRemoteError(details);
    revivedErrors.add(error);
    return error;
  }

  /**
   * PERF-11: when `opts.dataSink` is provided, response binary data is copied
   * directly from the SAB payload region into the sink (clamped to its length)
   * instead of allocating an intermediate buffer — the zero-extra-copy path for
   * readInto. The returned header result then carries no `data` field. Sink
   * contents are unspecified if the call throws.
   */
  call<T = unknown>(type: string, payload: unknown, data?: Uint8Array, opts?: { dataSink?: Uint8Array }): T {
    try {
      if (typeof window !== 'undefined' && typeof document !== 'undefined') {
        throw new Error('Atomics.wait cannot be called on the main thread.');
      }

      // If a previous call timed out the worker may still be mid-flight and the
      // slot may not be IDLE. Reusing the region now would corrupt it, so wait
      // (bounded) for the worker to settle, then fail loudly rather than scribble.
      if (Atomics.load(this.int32, STATUS_SLOT) !== Status.IDLE) {
        const recovery = this.waitForStatusChange(Status.COMMAND, RECOVERY_WAIT_MS);
        if (recovery === 'timed-out' && Atomics.load(this.int32, STATUS_SLOT) === Status.COMMAND) {
          throw new Error('SyncMessenger is poisoned: a prior call timed out and the worker is still busy.');
        }
        Atomics.store(this.int32, STATUS_SLOT, Status.IDLE);
      }

      const header = JSON.stringify({ type, payload });
      const encodedHeader = sharedEncoder.encode(header);
      this.ensureFits(`SyncMessenger.call(${type}) request`, encodedHeader.length, data?.length ?? 0);

      // Monotonic call ID echoed by the worker. A response whose echoed ID does
      // not match this call's ID is a stale frame from a timed-out call.
      this.callCount = (this.callCount + 1) | 0;
      const callId = this.callCount;
      this.int32[CALL_ID_SLOT] = callId;

      this.int32[HEADER_LEN_SLOT] = encodedHeader.length;
      new Uint8Array(this.sab, PAYLOAD_OFFSET).set(encodedHeader);

      if (data && data.length > 0) {
        this.int32[DATA_LEN_SLOT] = data.length;
        new Uint8Array(this.sab, PAYLOAD_OFFSET + encodedHeader.length).set(data);
      } else {
        this.int32[DATA_LEN_SLOT] = 0;
      }

      Atomics.store(this.int32, STATUS_SLOT, Status.COMMAND);
      Atomics.notify(this.int32, STATUS_SLOT);

      const waitResult = this.waitForStatusChange(Status.COMMAND, 30000);
      if (waitResult === 'timed-out') {
        // Do NOT reset the slot here: the worker may still be running and would
        // race the next call. Leave it as-is; the next call() recovers (above).
        throw new Error(`VFS worker did not respond within 30s (command: ${type})`);
      }
      const status = Atomics.load(this.int32, STATUS_SLOT);

      // Validate and copy EVERYTHING out of the SAB before releasing the slot.
      // The reset-to-IDLE lives in a finally so a throw (bogus lengths, bad
      // JSON) can never wedge the slot in RESULT/ERROR forever (which would
      // also re-trigger the SAB-2 spin). Copying first prevents the worker from
      // overwriting the region under a concurrent next command after release.
      let resHeader: SyncResponseHeader;
      let resData: Uint8Array | undefined;
      let echoedId: number;
      try {
        if (status !== Status.RESULT && status !== Status.ERROR) {
          throw new Error(`SyncMessenger protocol desync: invalid response status ${status}`);
        }
        echoedId = this.int32[CALL_ID_SLOT];
        const resHeaderLen = this.int32[HEADER_LEN_SLOT];
        const resDataLen = this.int32[DATA_LEN_SLOT];
        this.ensureFits(`SyncMessenger.call(${type}) response`, resHeaderLen, resDataLen);

        const resHeaderCopy = new Uint8Array(resHeaderLen);
        resHeaderCopy.set(new Uint8Array(this.sab, PAYLOAD_OFFSET, resHeaderLen));
        resHeader = JSON.parse(sharedDecoder.decode(resHeaderCopy)) as SyncResponseHeader;

        if (resDataLen > 0) {
          const sabData = new Uint8Array(this.sab, PAYLOAD_OFFSET + resHeaderLen, resDataLen);
          if (opts?.dataSink) {
            // PERF-11: SAB -> caller view directly; no intermediate allocation.
            opts.dataSink.set(sabData.subarray(0, Math.min(resDataLen, opts.dataSink.length)));
          } else {
            resData = new Uint8Array(resDataLen);
            resData.set(sabData);
          }
        }
      } finally {
        Atomics.store(this.int32, STATUS_SLOT, Status.IDLE);
        Atomics.notify(this.int32, STATUS_SLOT);
      }

      if (echoedId !== callId) {
        throw new Error(
          `SyncMessenger protocol desync: expected call ID ${callId} but got ${echoedId} (stale response after a timeout?)`,
        );
      }

      if (status === Status.ERROR) throw this.makeRemoteError(resHeader);

      if (resData) {
        if (resHeader.result && typeof resHeader.result === 'object') {
          return { ...resHeader.result, data: resData } as T;
        }
        return { result: resHeader.result, data: resData } as T;
      }

      return resHeader.result as T;
    } catch (error) {
      // Preserve structured error codes (e.g. EEXIST/ENOENT) built by
      // makeRemoteError so cross-worker callers observe the same errno behavior
      // as same-worker callers; otherwise wrapping in a bare Error would drop
      // `.code` and the adapter's errno mapping would fall back to EINVAL.
      // Validated remote errors keep every envelope field (a corruption error has no code).
      if (
        typeof error === 'object' &&
        error !== null &&
        (revivedErrors.has(error) || ('code' in error && typeof error.code === 'string'))
      ) {
        throw error;
      }
      throw new Error(`SyncMessenger.call(${type}) failed: ${getErrorMessage(error)}`);
    }
  }

  private waitForStatusChange(current: Status, timeoutMs: number) {
    const deadline = performance.now() + timeoutMs;
    while (Atomics.load(this.int32, STATUS_SLOT) === current) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) return 'timed-out';
      Atomics.wait(this.int32, STATUS_SLOT, current, remaining);
    }
    return 'not-equal';
  }

  listen(
    handler: (type: string, payload: unknown, data?: Uint8Array) => Promise<SyncHandlerResult>,
    options?: { blocking?: boolean; once?: boolean; signal?: AbortSignal },
  ) {
    const blocking = options?.blocking ?? false;
    const once = options?.once ?? false;
    // SAB-6: a cancellation token so a re-INIT can stop a previous listen loop.
    // Without it, re-initialising the worker against a new SAB left the old loop
    // running forever against the stale buffer.
    const signal = options?.signal;
    // Skip writing a response if the call ID has moved on (the caller timed out
    // and started a new request); writing now would corrupt the live frame.
    const callIdStale = (expectedCallId: number) =>
      this.int32[CALL_ID_SLOT] !== expectedCallId || Atomics.load(this.int32, STATUS_SLOT) !== Status.COMMAND;
    const writeErrorResponse = (error: unknown, expectedCallId: number) => {
      if (callIdStale(expectedCallId)) return;
      // SAB-7: truncate the message STRING (not the encoded JSON bytes) so the
      // framed payload is always valid JSON the caller can parse. Cutting bytes
      // after JSON.stringify would slice through the closing quote/brace (or a
      // multi-byte UTF-8 sequence), making JSON.parse throw and masking the
      // original error. Encode the full frame, and if it overflows, shrink the
      // message string and re-encode until it fits (the loop also accounts for
      // multi-byte chars and JSON escaping of the truncated tail).
      const encoded = this.encodeBoundedErrorHeader(error);
      this.int32[HEADER_LEN_SLOT] = encoded.length;
      new Uint8Array(this.sab, PAYLOAD_OFFSET, encoded.length).set(encoded);
      this.int32[DATA_LEN_SLOT] = 0;
      Atomics.store(this.int32, STATUS_SLOT, Status.ERROR);
      Atomics.notify(this.int32, STATUS_SLOT);
    };
    const writeResponse = (
      status: Status,
      header: Record<string, unknown>,
      data: Uint8Array | undefined,
      expectedCallId: number,
    ) => {
      // Re-check the call ID just before writing: if it moved on, the caller
      // already abandoned this request (timeout) and reused the region.
      if (callIdStale(expectedCallId)) return;
      const encoded = sharedEncoder.encode(JSON.stringify(header));
      this.ensureFits('SyncMessenger.listen response', encoded.length, data?.length ?? 0);

      this.int32[HEADER_LEN_SLOT] = encoded.length;
      new Uint8Array(this.sab, PAYLOAD_OFFSET).set(encoded);

      if (data && data.length > 0) {
        this.int32[DATA_LEN_SLOT] = data.length;
        new Uint8Array(this.sab, PAYLOAD_OFFSET + encoded.length).set(data);
      } else {
        this.int32[DATA_LEN_SLOT] = 0;
      }

      Atomics.store(this.int32, STATUS_SLOT, status);
      Atomics.notify(this.int32, STATUS_SLOT);
    };

    // Block/await until the slot leaves `current`, ensuring the loop never
    // iterates without either awaiting or blocking (no synchronous busy-spin).
    const waitWhile = async (current: Status, timeoutMs: number) => {
      if (blocking) {
        return Atomics.wait(this.int32, STATUS_SLOT, current, timeoutMs);
      } else if (typeof Atomics.waitAsync !== 'function') {
        // Engines without waitAsync: poll on macrotasks so postMessage stays served.
        const deadline = performance.now() + timeoutMs;
        while (Atomics.load(this.int32, STATUS_SLOT) === current && !signal?.aborted) {
          const remaining = deadline - performance.now();
          if (remaining <= 0) return 'timed-out';
          await new Promise<void>((r) => setTimeout(r, Math.min(1, remaining)));
        }
        return 'ok';
      } else {
        // Use waitAsync so the worker thread stays free for its postMessage
        // async API; fall back to a macrotask yield if the wait resolves sync.
        const waitResult = Atomics.waitAsync(this.int32, STATUS_SLOT, current, timeoutMs);
        if (waitResult.async) {
          return await waitResult.value;
        } else {
          await new Promise<void>((r) => setTimeout(r, 0));
          return waitResult.value;
        }
      }
    };

    const loop = async () => {
      while (true) {
        if (signal?.aborted) return;
        try {
          const status = Atomics.load(this.int32, STATUS_SLOT);
          if (status !== Status.COMMAND) {
            if (status === Status.RESULT || status === Status.ERROR) {
              // We already responded and are waiting for the caller to consume.
              // Wait on THAT value with a bound; if it never moves the caller is
              // presumed dead (e.g. terminated), so reset the slot ourselves. A
              // late caller rejects the reclaimed IDLE response status.
              const reason = await waitWhile(status, CONSUMER_WAIT_MS);
              if (
                reason === 'timed-out' &&
                Atomics.compareExchange(this.int32, STATUS_SLOT, status, Status.IDLE) === status
              ) {
                Atomics.notify(this.int32, STATUS_SLOT);
              }
            } else {
              const reason = await waitWhile(status, CONSUMER_WAIT_MS);
              if (status !== Status.IDLE && reason === 'timed-out') {
                Atomics.compareExchange(this.int32, STATUS_SLOT, status, Status.IDLE);
                Atomics.notify(this.int32, STATUS_SLOT);
              }
            }
            continue;
          }

          const callId = this.int32[CALL_ID_SLOT];
          const headerLen = this.int32[HEADER_LEN_SLOT];
          const dataLen = this.int32[DATA_LEN_SLOT];
          try {
            this.ensureFits('SyncMessenger.listen request', headerLen, dataLen);
            const headerCopy = new Uint8Array(headerLen);
            headerCopy.set(new Uint8Array(this.sab, PAYLOAD_OFFSET, headerLen));
            const header = JSON.parse(sharedDecoder.decode(headerCopy));
            if (!header || typeof header !== 'object' || Array.isArray(header) || typeof header.type !== 'string') {
              throw new Error('Invalid SyncMessenger request header');
            }
            const { type, payload } = header as SyncRequestHeader;
            let data: Uint8Array | undefined;
            if (dataLen > 0) {
              data = new Uint8Array(dataLen);
              data.set(new Uint8Array(this.sab, PAYLOAD_OFFSET + headerLen, dataLen));
            }
            const res = await handler(type, payload, data);
            writeResponse(Status.RESULT, { result: res.result }, res.data, callId);
            if (once) return;
          } catch (error) {
            writeErrorResponse(error, callId);
            if (once) return;
          }
        } catch (e) {
          console.error('SyncMessenger loop error:', e);
          // Yield a macrotask: a persistent failure must not spin the microtask
          // queue and starve the worker's message handling.
          await new Promise<void>((r) => setTimeout(r, 10));
        }
      }
    };
    void loop();
  }
}
