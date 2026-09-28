import { version as reactDomVersion } from 'react-dom';
import { version as reactVersion } from 'react';
import { expect, test } from 'vitest';

declare const __OPFS_VFS_REACT_VERSION__: string;

const expectedVersion = __OPFS_VFS_REACT_VERSION__;

test('browser bundle resolves the selected React and React DOM versions', () => {
  console.info(
    JSON.stringify({
      browser: navigator.userAgent,
      react: reactVersion,
      reactDom: reactDomVersion,
      expected: expectedVersion,
    }),
  );
  expect(reactVersion).toBe(expectedVersion);
  expect(reactDomVersion).toBe(expectedVersion);
});
