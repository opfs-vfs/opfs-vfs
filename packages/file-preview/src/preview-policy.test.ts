import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditorState } from '@codemirror/state';
import { limitTextChanges } from './text-limit.ts';
import { canEdit, extension, fileSize, MAX_PREVIEW_BYTES } from './preview-policy.ts';
await test('source editing preserves binary data and respects actual byte limits', () => {
  assert.equal(canEdit({ path: '/note.md', content: 'Hello' }), true);
  for (const path of [
    '/app.conf',
    '/app.CONF',
    '/settings.cfg',
    '/settings.ini',
    '/pyproject.toml',
    '/.env',
    '/.env.local',
    '/.ENV.PRODUCTION',
    '/example.env',
    '/.gitignore',
    '/.npmrc',
    '/.editorconfig',
    '/Dockerfile',
    '/Dockerfile.dev',
    '/Makefile',
    '/README',
    '/LICENSE',
    '/src/main.py',
    '/src/lib.rs',
    '/go.mod',
    '/go.sum',
    '/Cargo.lock',
    '/vite.config.mts',
    '/component.vue',
    '/component.svelte',
    '/styles.scss',
    '/main.cpp',
    '/Main.java',
    '/App.cs',
    '/schema.prisma',
    '/infra.tf',
    '/patch.diff',
  ])
    assert.equal(canEdit({ path, content: 'text' }), true, path);
  for (const path of ['/image.png', '/archive.zip', '/module.wasm', '/data.db', '/unknown.xyz', '/.env/image.png'])
    assert.equal(canEdit({ path, content: 'text' }), false, path);
  assert.equal(canEdit({ path: '/.env', content: 'KEY=value', bytes: new Uint8Array([255]) }), false);
  assert.equal(canEdit({ path: '/app.conf', content: 'a\0b' }), false);
  assert.equal(canEdit({ path: '/.env.local', content: 'x'.repeat(MAX_PREVIEW_BYTES + 1) }), false);
  assert.equal(canEdit({ path: '/photo.png', content: 'not text' }), false);
  assert.equal(canEdit({ path: '/bad.txt', content: 'ok', bytes: new Uint8Array([255]) }), false);
  assert.equal(canEdit({ path: '/bad.txt', content: 'a\0b' }), false);
  assert.equal(canEdit({ path: '/huge.txt', content: 'x'.repeat(MAX_PREVIEW_BYTES + 1) }), false);
  assert.equal(fileSize({ path: '/img.png', content: '', bytes: new Uint8Array(10) }), 10);
  assert.equal(extension('/folder.with.dot/README'), '');
  assert.equal(extension('/photo.SVG'), 'svg');
  let limited = false;
  const state = EditorState.create({
    doc: 'keep me',
    extensions: [
      limitTextChanges((value) => {
        limited = value;
      }),
    ],
  });
  const rejected = state.update({ changes: { from: 0, to: 7, insert: 'é'.repeat(MAX_PREVIEW_BYTES / 2 + 1) } });
  assert.equal(rejected.newDoc.toString(), 'keep me');
  assert.equal(limited, true);
  assert.equal(state.update({ changes: { from: 7, insert: '!' } }).newDoc.toString(), 'keep me!');
  assert.equal(limited, false);
});
