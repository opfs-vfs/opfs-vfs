import { describe, expect, it } from 'vitest';

import { lexicalFsPath, normalizeFsPath } from '../fs-path';

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
  it('drops empty components and keeps dot components for the resolver', () => {
    expect(normalizeFsPath('//a///./b/../c/')).toEqual({
      path: '/a/./b/../c',
      requiresDirectory: true,
    });
    expect(normalizeFsPath('/../../x')).toEqual({ path: '/../../x', requiresDirectory: false });
  });

  it('roots relative and empty paths', () => {
    expect(normalizeFsPath('')).toEqual({ path: '/', requiresDirectory: false });
    expect(normalizeFsPath('/')).toEqual({ path: '/', requiresDirectory: false });
    expect(normalizeFsPath('a/b')).toEqual({ path: '/a/b', requiresDirectory: false });
  });

  it('requires a directory after a trailing slash or a final dot component', () => {
    expect(normalizeFsPath('/a/')).toEqual({ path: '/a', requiresDirectory: true });
    expect(normalizeFsPath('/a/.')).toEqual({ path: '/a/.', requiresDirectory: true });
    expect(normalizeFsPath('/a/..')).toEqual({ path: '/a/..', requiresDirectory: true });
    expect(normalizeFsPath('./')).toEqual({ path: '/.', requiresDirectory: true });
    expect(normalizeFsPath('/a/.b')).toEqual({ path: '/a/.b', requiresDirectory: false });
  });

  it('rejects NUL bytes', () => {
    expectErrorCode(() => normalizeFsPath('/bad\0path'), 'EINVAL');
  });
});

describe('lexicalFsPath', () => {
  it('collapses repeated slashes and dot segments textually', () => {
    expect(lexicalFsPath('//a///./b/../c/')).toEqual({
      path: '/a/c',
      requiresDirectory: true,
    });
  });

  it('clamps dot-dot segments above root', () => {
    expect(lexicalFsPath('/../../x')).toEqual({
      path: '/x',
      requiresDirectory: false,
    });
  });

  it('maps empty and dot paths to root', () => {
    expect(lexicalFsPath('')).toEqual({ path: '/', requiresDirectory: false });
    expect(lexicalFsPath('./')).toEqual({ path: '/', requiresDirectory: true });
  });

  it('rejects NUL bytes', () => {
    expectErrorCode(() => lexicalFsPath('/bad\0path'), 'EINVAL');
  });
});
