import { expect, it, vi } from 'vitest';
import { CURRENT_BINARY_VERSION, frameMetaSnapshot, serializeMeta } from '../binary-metadata';
import { peekVolume } from '../peek-volume';

for (const suffix of ['.meta.a', '.meta.b']) {
  it(`recognizes a current plaintext snapshot in ${suffix}`, async () => {
    const inodes = new Map([['/', { ino: 1, isDir: true, size: 0, blocks: [], children: [], mode: 16877 }]]);
    const snapshot = frameMetaSnapshot(new Uint8Array(serializeMeta(inodes, 16, 4096)), 1, undefined, 8192, 4096);
    const file = new File([new Uint8Array(snapshot)], `peek${suffix}`);
    vi.stubGlobal('navigator', {
      storage: {
        getDirectory: async () => ({
          getFileHandle: async (name: string) => {
            if (name !== file.name) throw new DOMException('missing', 'NotFoundError');
            return { getFile: async () => file };
          },
        }),
      },
    });
    try {
      expect(await peekVolume('peek.bin')).toMatchObject({
        exists: true,
        encrypted: false,
        metadataVersion: CURRENT_BINARY_VERSION,
        compatible: true,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
}
