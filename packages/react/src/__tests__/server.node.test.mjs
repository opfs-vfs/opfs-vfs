import assert from 'node:assert/strict';
import test from 'node:test';

for (const key of [
  'window',
  'document',
  'navigator',
  'Worker',
  'BroadcastChannel',
  'SharedArrayBuffer',
  'localStorage',
  'indexedDB',
]) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    get() {
      throw new Error(`${key} was accessed during server import`);
    },
  });
}

await test('server import and render do not access browser globals', async () => {
  const sdk = await import('@opfs-vfs/react');
  const React = await import('react');
  const { renderToString } = await import('react-dom/server');
  assert.deepEqual(Object.keys(sdk).sort(), [
    'DEFAULT_VOLUME',
    'File',
    'FileContent',
    'Folder',
    'VolumeError',
    'VolumeProvider',
    'useFile',
    'useFileContent',
    'useFolder',
    'usePersistentStorage',
    'useVolume',
    'useVolumeClient',
  ]);
  const Consumer = () => React.createElement('span', null, sdk.useVolume().status);
  const markup = renderToString(
    React.createElement(
      sdk.VolumeProvider,
      {
        fileName: 'react-server.bin',
        worker: () => {
          throw new Error('must not run');
        },
      },
      React.createElement(Consumer),
    ),
  );
  assert.match(markup, /pending/);
});
