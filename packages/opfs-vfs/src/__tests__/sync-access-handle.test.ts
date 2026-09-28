import { describe, expect, it, vi } from 'vitest';
import { type SyncAccessHandle, withCompleteIo } from '../sync-access-handle';

describe('Complete OPFS I/O', () => {
  it('preserves view offsets and method receivers through partial progress and EOF', () => {
    const bytes = new Uint8Array([7, 8, 9, 10]);
    const raw = {
      read(buffer: ArrayBufferView, { at }: { at: number }) {
        expect(this).toBe(raw);
        const count = Math.min(2, Math.max(0, bytes.length - at), buffer.byteLength);
        new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength).set(bytes.subarray(at, at + count));
        return count;
      },
      write(buffer: ArrayBufferView, { at }: { at: number }) {
        expect(this).toBe(raw);
        const count = Math.min(2, buffer.byteLength);
        bytes.set(new Uint8Array(buffer.buffer, buffer.byteOffset, count), at);
        return count;
      },
      getSize: () => bytes.length,
      flush: vi.fn(),
      close: vi.fn(),
      truncate: vi.fn(),
    };
    const handle = withCompleteIo(raw);
    const destination = new Uint8Array(8).fill(99);
    expect(handle.read(destination.subarray(1, 7), { at: 0 })).toBe(4);
    // The unread remainder of the view past EOF is zeroed; bytes outside it are untouched.
    expect(destination).toEqual(new Uint8Array([99, 7, 8, 9, 10, 0, 0, 99]));
    expect(handle.write(new Uint8Array([99, 1, 2, 3, 99]).subarray(1, 4), { at: 1 })).toBe(3);
    expect(bytes).toEqual(new Uint8Array([7, 1, 2, 3]));
  });

  it('preserves exceptions after partial progress and rejects reads stalled before EOF', () => {
    const failure = new DOMException('quota', 'QuotaExceededError');
    const write = vi
      .fn()
      .mockReturnValueOnce(2)
      .mockImplementation(() => {
        throw failure;
      });
    const read = vi.fn(() => 0);
    const handle = withCompleteIo({ read, write, getSize: () => 8 } as unknown as SyncAccessHandle);
    expect(() => handle.write(new Uint8Array(4), { at: 1 })).toThrow(failure);
    expect(write.mock.calls[1][1]).toEqual({ at: 3 });
    expect(() => handle.read(new Uint8Array(4), { at: 0 })).toThrow('made no progress');
    expect(read).toHaveBeenCalledOnce();
  });
});
