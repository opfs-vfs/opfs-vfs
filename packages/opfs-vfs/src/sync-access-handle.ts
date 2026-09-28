export interface SyncAccessHandle {
  read(buffer: ArrayBufferView, options: { at: number }): number;
  write(buffer: ArrayBufferView, options: { at: number }): number;
  flush(): void;
  close(): void;
  getSize(): number;
  truncate(newSize: number): void;
}

/** Complete partial OPFS I/O before callers publish sizes, offsets, or crypto records. */
export function withCompleteIo(handle: SyncAccessHandle): SyncAccessHandle {
  const transfer = (kind: 'read' | 'write', buffer: ArrayBufferView, at: number) => {
    let done = 0;
    let remaining = buffer;
    do {
      const count = handle[kind](remaining, { at: at + done });
      if (!Number.isSafeInteger(count) || count < 0 || count > remaining.byteLength) {
        throw new DOMException(`OPFS ${kind} returned an invalid byte count: ${count}`, 'InvalidStateError');
      }
      if (count === 0 && remaining.byteLength > 0) {
        if (kind === 'read' && at + done >= handle.getSize()) {
          // Callers size reads from metadata; never leave stale caller bytes past EOF.
          new Uint8Array(remaining.buffer, remaining.byteOffset, remaining.byteLength).fill(0);
          return done;
        }
        throw new DOMException(`OPFS ${kind} made no progress`, 'InvalidStateError');
      }
      done += count;
      if (done === buffer.byteLength) return done;
      remaining = new Uint8Array(buffer.buffer, buffer.byteOffset + done, buffer.byteLength - done);
    } while (done < buffer.byteLength);
    return done;
  };
  return {
    read: (buffer, { at }) => transfer('read', buffer, at),
    write: (buffer, { at }) => transfer('write', buffer, at),
    flush: () => handle.flush(),
    close: () => handle.close(),
    getSize: () => handle.getSize(),
    truncate: (size) => handle.truncate(size),
  };
}
