import { describe, expect, it } from 'vitest';
import { VfsCorruptionError, VfsError } from '../fs-errors';
import {
  parseRemoteError,
  reviveRemoteError,
  serializeRemoteError,
  toRemoteErrorDetails,
  type RemoteErrorDetails,
} from '../remote-error';

describe('remote errors', () => {
  it('keeps the supported VFS and platform error details', () => {
    expect(toRemoteErrorDetails(new VfsError('ENOENT', '/missing'))).toMatchObject({
      name: 'VfsError',
      code: 'ENOENT',
      errno: 2,
    });
    expect(toRemoteErrorDetails(new VfsCorruptionError('meta-snapshot', 'bad metadata', 128))).toEqual({
      message: 'bad metadata',
      name: 'VfsCorruptionError',
      category: 'meta-snapshot',
      offset: 128,
    });
    expect(toRemoteErrorDetails(new DOMException('quota', 'QuotaExceededError'))).toMatchObject({
      message: 'quota',
      name: 'QuotaExceededError',
    });
  });

  it('reads hostile error fields once and never copies unrelated properties', () => {
    const error = new Error();
    const reads = new Map<string, number>();
    for (const [key, value] of Object.entries({
      message: 'safe',
      name: 'Not-valid!',
      code: 'INVALID-code',
      errno: 1.5,
      category: 'unknown',
      offset: -1,
    })) {
      Object.defineProperty(error, key, {
        configurable: true,
        get() {
          reads.set(key, (reads.get(key) ?? 0) + 1);
          if (key === 'code' && reads.get(key) !== 1) throw new Error('read twice');
          return value;
        },
      });
    }
    expect(toRemoteErrorDetails(error)).toEqual({ message: 'safe' });
    expect([...reads.values()]).toEqual([1, 1, 1, 1, 1, 1]);

    const throwing = new Error('safe');
    Object.defineProperty(throwing, 'code', {
      get: () => {
        throw new Error('secret');
      },
    });
    expect(toRemoteErrorDetails(throwing)).toEqual({ message: 'safe' });
    const changing = new Error('safe');
    let codeReads = 0;
    Object.defineProperty(changing, 'code', { get: () => (++codeReads === 1 ? 'bad-code' : 'ENOENT') });
    expect(toRemoteErrorDetails(changing)).toEqual({ message: 'safe' });
    expect(codeReads).toBe(1);

    const secret = Object.assign(new Error('safe'), { stack: 'stack', cause: 'cause', secret: 'never' });
    const wire = serializeRemoteError(secret);
    expect(wire).toEqual({ error: 'safe' });
    expect(JSON.stringify(wire)).not.toContain('secret');
    expect(JSON.stringify(wire)).not.toContain('stack');
    expect(JSON.stringify(wire)).not.toContain('cause');
  });

  it('normalizes non-errors, truncates safely, and freezes details', () => {
    expect(toRemoteErrorDetails('x')).toEqual({ message: 'x' });
    expect(toRemoteErrorDetails(42)).toEqual({ message: '42' });
    expect(toRemoteErrorDetails(null)).toEqual({ message: 'null' });
    expect(
      toRemoteErrorDetails({
        toString: () => {
          throw new Error('nope');
        },
      }),
    ).toEqual({ message: 'Unknown VFS error' });
    const details = toRemoteErrorDetails('a'.repeat(1022) + '\ud800xx');
    expect(details.message).toBe(`${'a'.repeat(1022)}…`);
    expect(Object.isFrozen(details)).toBe(true);
  });

  it('strictly parses only supported wire fields', () => {
    expect(parseRemoteError({ error: 'legacy', code: 'ENOENT' })).toEqual({ message: 'legacy', code: 'ENOENT' });
    const optional = { name: 'VfsError', code: 'ENOENT', errno: 2, category: 'bitmap', offset: 0 };
    for (let bits = 0; bits < 32; bits++) {
      const wire: Record<string, unknown> = { error: 'ok' };
      Object.entries(optional).forEach(([key, value], index) => {
        if (bits & (1 << index)) wire[key] = value;
      });
      expect(parseRemoteError(wire)).not.toBeNull();
    }
    for (const invalid of [
      [],
      null,
      {},
      { error: 'ok', extra: true },
      { error: 1 },
      { error: 'x'.repeat(1025) },
      { error: 'ok', name: '9bad' },
      { error: 'ok', code: 'bad' },
      { error: 'ok', category: 'other' },
      { error: 'ok', offset: -1 },
      { error: 'ok', offset: 0.5 },
      { error: 'ok', errno: Number.MAX_SAFE_INTEGER + 1 },
    ])
      expect(parseRemoteError(invalid)).toBeNull();
  });

  it('round-trips revived details', () => {
    const details: RemoteErrorDetails = Object.freeze({
      message: 'missing',
      name: 'VfsError',
      code: 'ENOENT',
      errno: 2,
      category: 'meta-log',
      offset: 7,
    });
    const parsed = parseRemoteError(serializeRemoteError(reviveRemoteError(details)));
    expect(parsed).toEqual(details);
    expect(Object.isFrozen(parsed)).toBe(true);
  });
});
