import { createVfsError } from './fs-errors';

export interface NormalizedPath {
  path: string;
  requiresDirectory: boolean;
}

function components(rawPath: string): string[] {
  if (rawPath.includes('\0')) {
    throw createVfsError('EINVAL', rawPath, 'Path contains NUL byte');
  }
  return rawPath.split('/').filter((part) => part !== '');
}

/**
 * The form every filesystem call hands to the resolver: absolute from the mount
 * root, without empty components. `.` and `..` are KEPT: what they name depends
 * on the directories and symlinks before them, so only the resolver's walk can
 * decide it. A trailing slash, or a final `.` or `..`, requires a directory.
 */
export function normalizeFsPath(rawPath: string): NormalizedPath {
  const parts = components(rawPath);
  const last = parts[parts.length - 1];
  return {
    path: `/${parts.join('/')}`,
    requiresDirectory: (rawPath.length > 1 && rawPath.endsWith('/')) || last === '.' || last === '..',
  };
}

/**
 * A purely textual normal form: `.` is dropped and `..` removes the component
 * before it, whatever that component is on disk. For keys, patterns and a
 * shell's logical paths only. It must never decide which file a filesystem
 * call reaches: behind a symlink it names a different one than the resolver.
 */
export function lexicalFsPath(rawPath: string): NormalizedPath {
  const stack: string[] = [];
  for (const part of components(rawPath)) {
    if (part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return { path: `/${stack.join('/')}`, requiresDirectory: rawPath.length > 1 && rawPath.endsWith('/') };
}

export function parentPath(path: string): string {
  if (path === '/') return '/';
  const index = path.lastIndexOf('/');
  if (index <= 0) return '/';
  return path.substring(0, index);
}

export function baseName(path: string): string {
  if (path === '/') return '/';
  const index = path.lastIndexOf('/');
  return index < 0 ? path : path.substring(index + 1);
}
