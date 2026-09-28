import { describe, expect, it } from 'vitest';

import { assertSabPayloadFits, SAB_SIZE } from '../sync-messenger';

describe('SyncMessenger', () => {
  it('should have SharedArrayBuffer', () => {
    expect(typeof SharedArrayBuffer).not.toBe('undefined');
  });

  it('rejects request payloads that exceed SAB capacity', () => {
    expect(() => assertSabPayloadFits('SyncMessenger.call(WRITE) request', 24, SAB_SIZE + 1, SAB_SIZE)).toThrow(
      /payload exceeds SAB capacity/,
    );
  });

  it('returns a controlled error for oversized response payloads', () => {
    expect(() => assertSabPayloadFits('SyncMessenger.listen response', 16, SAB_SIZE, SAB_SIZE)).toThrow(
      /payload exceeds SAB capacity/,
    );
  });
});
