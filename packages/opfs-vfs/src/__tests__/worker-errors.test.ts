import { describe, expect, it } from 'vitest';
import { shouldLogWorkerError } from '../worker-errors';

describe('shouldLogWorkerError', () => {
  it('suppresses expected missing-path probes from filesystem clients', () => {
    expect(
      shouldLogWorkerError({ code: 'ENOENT', payload: { path: '/workspace/etc/.git/packed-refs' }, type: 'OPEN' }),
    ).toBe(false);
    expect(shouldLogWorkerError({ code: 'ENOENT', payload: { path: '/workspace/etc/.git' }, type: 'RM' })).toBe(false);
    expect(shouldLogWorkerError({ code: 'ENOTDIR', payload: { path: '/workspace/.gitignore' }, type: 'STAT' })).toBe(
      false,
    );
  });

  it('suppresses normal repository tree-walk probes', () => {
    expect(
      shouldLogWorkerError({
        code: 'ENOENT',
        payload: { path: '/repositories/github%3A1294144996/.git/packed-refs' },
        type: 'OPEN',
      }),
    ).toBe(false);
    expect(
      shouldLogWorkerError({
        code: 'ENOTDIR',
        payload: { path: '/repositories/github%3A1294144996/apps/web/vite.config.ts' },
        type: 'READDIR',
      }),
    ).toBe(false);
  });

  it('keeps unexpected worker failures visible', () => {
    expect(shouldLogWorkerError({ code: 'EIO' })).toBe(true);
    expect(shouldLogWorkerError({ code: 'EACCES' })).toBe(true);
    expect(shouldLogWorkerError({ code: 'ECRYPTOINTEGRITY' })).toBe(true);
    expect(shouldLogWorkerError({})).toBe(true);
  });
});
