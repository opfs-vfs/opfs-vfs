import { describe, expect, it } from 'vitest';

import { normalizeFsPath } from '../fs-path';

function expectErrorCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected ${code} error`);
}

describe('normalizeFsPath', () => {
  it('collapses repeated slashes and dot segments', () => {
    expect(normalizeFsPath('//a///./b/../c/')).toEqual({
      path: '/a/c',
      requiresDirectory: true,
    });
  });

  it('clamps dot-dot segments above root', () => {
    expect(normalizeFsPath('/../../x')).toEqual({
      path: '/x',
      requiresDirectory: false,
    });
  });

  it('maps empty and dot paths to root', () => {
    expect(normalizeFsPath('')).toEqual({ path: '/', requiresDirectory: false });
    expect(normalizeFsPath('./')).toEqual({ path: '/', requiresDirectory: true });
  });

  it('rejects NUL bytes', () => {
    expectErrorCode(() => normalizeFsPath('/bad\0path'), 'EINVAL');
  });
});
