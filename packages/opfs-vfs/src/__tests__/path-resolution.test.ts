import { beforeAll, describe, expect, it } from 'vitest';
import type { Section } from './path-resolution-worker.js';

const titles = [
  'dot-dot after a symlink to a directory is the parent of its target',
  'dot components need a directory and change nothing',
  'dot-dot at the root stays at the root',
  'a dot component after a missing name is ENOENT',
  'a dot component after a file is ENOTDIR',
  'dangling symlinks and loops',
  'every directory the walk passes through must be searchable',
  'the final component: stat follows a symlink, lstat does not',
  'creating, linking, renaming and removing through dot-dot act on the resolved location',
  'removing or renaming . or .. is EINVAL and changes nothing',
  'a directory cannot be moved into its own subtree through .. or a symlink',
  'a chain of 40 symlinks resolves and 41 fails with ELOOP',
  'subscription targets reject . and .. components, and are not file lookups',
  'recorded paths are canonical, also after a reopen',
];

for (const bufferMode of ['disk', 'memory'] as const) {
  describe(`POSIX path resolution on a mounted volume (${bufferMode} buffer mode)`, () => {
    let sections: Section[] = [];

    beforeAll(async () => {
      const worker = new Worker(new URL('./path-resolution-worker.ts', import.meta.url), { type: 'module' });
      try {
        const data = await new Promise<{ sections?: Section[]; error?: string }>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('path resolution worker timed out')), 20_000);
          worker.onerror = (event) => reject(new Error(event.message));
          worker.onmessage = (event) => {
            clearTimeout(timer);
            resolve(event.data);
          };
          worker.postMessage({ bufferMode });
        });
        if (data.error) throw new Error(data.error);
        sections = data.sections!;
      } finally {
        worker.terminate();
      }
    }, 30_000);

    it('covers every rule', () => {
      expect(sections.map((section) => section.name)).toEqual(titles);
    });

    for (const title of titles) {
      it(title, () => {
        expect(sections.find((section) => section.name === title)?.failures).toEqual([]);
      });
    }
  });
}
