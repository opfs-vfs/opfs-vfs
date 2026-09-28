import { expect, test } from '@playwright/test';
import JSZip from 'jszip';
import { importWorkspace, validateArchivePath } from '../src/lib/archive';
import type { OpfsVfsJustBashAdapter } from '@opfs-vfs/opfs-vfs/just-bash';

test('archive paths reject traversal and platform-specific escapes', () => {
  for (const path of ['../x', '/x', 'C:/x', 'a\\b', `a\0b`]) expect(() => validateArchivePath(path)).toThrow();
  expect(validateArchivePath('docs/readme.md')).toBe('docs/readme.md');
});

test('imports nested files and empty directories', async () => {
  const zip = new JSZip();
  zip.folder('empty');
  zip.file('nested/deep/readme.md', 'hello');
  delete zip.files['nested/'];
  delete zip.files['nested/deep/'];
  const blob = await zip.generateAsync({ type: 'blob' });
  const directories = new Set(['/workspace']);
  const files = new Map<string, Uint8Array>();
  const fs = {
    exists: async (path: string) => directories.has(path) || files.has(path),
    mkdir: async (path: string) => {
      const parts = path.split('/').filter(Boolean);
      for (let i = 1; i <= parts.length; i += 1) directories.add(`/${parts.slice(0, i).join('/')}`);
    },
    writeFile: async (path: string, bytes: Uint8Array) => {
      const parent = path.slice(0, path.lastIndexOf('/'));
      if (!directories.has(parent)) throw new Error(`missing ${parent}`);
      files.set(path, bytes);
    },
  } as unknown as OpfsVfsJustBashAdapter;
  await expect(importWorkspace(fs, blob)).resolves.toBe(1);
  expect(directories).toContain('/workspace/empty');
  expect(new TextDecoder().decode(files.get('/workspace/nested/deep/readme.md'))).toBe('hello');
});
