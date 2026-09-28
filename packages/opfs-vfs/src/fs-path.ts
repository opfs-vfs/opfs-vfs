import { createVfsError } from './fs-errors';

export interface NormalizedPath {
  path: string;
  requiresDirectory: boolean;
}

export function normalizeFsPath(rawPath: string): NormalizedPath {
  if (rawPath.includes('\0')) {
    throw createVfsError('EINVAL', rawPath, 'Path contains NUL byte');
  }

  let input = rawPath;
  const requiresDirectory = input.length > 1 && input.endsWith('/');
  if (input === '' || input === '.' || input === './') {
    input = '/';
  }
  const parts = input.split('/');
  const stack: string[] = [];

  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      stack.pop();
      continue;
    }
    stack.push(part);
  }

  const path = stack.length === 0 ? '/' : `/${stack.join('/')}`;
  return { path, requiresDirectory };
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
