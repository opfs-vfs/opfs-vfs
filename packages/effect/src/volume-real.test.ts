import { expect, it } from 'vitest';

const packedExample = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_PACKED_EFFECT_EXAMPLE;

it('inspects, writes, syncs and reopens a real direct volume in a worker', async () => {
  const worker = new Worker(new URL('./volume-smoke-worker.ts', import.meta.url), { type: 'module' });
  try {
    const result = await new Promise<{
      ok: boolean;
      first?: {
        persistence: { state: string };
        directSubscription: {
          change: { type: string; path: string } | null;
          retired: { status: string };
        };
        copyTemp: {
          directCopy: boolean;
          regularReplacement: boolean;
          scopedTempDirectoryRemoved: boolean;
          scopedTempFileRemoved: boolean;
          siblingSurvived: boolean;
          physicalTempParents: boolean;
        };
        namespace: {
          relativeLink: string;
          danglingLink: string;
          realLink: string;
          listing: ReadonlyArray<string>;
          metadata: { size: string; nlink: number | null };
          times: { atimeMs: number | null; mtimeMs: number | null };
          denied: boolean;
          readDenied: boolean;
          nestedDenied: boolean;
          nonEmpty: boolean;
          busy: boolean;
          dangling: boolean;
          cycle: boolean;
          trailingSlash: boolean;
        };
      };
      before?: { exists: boolean };
      after?: { exists: boolean };
      reopened?: { content: string; fileSystemContent: string; persistence: { state: string } };
      example?: { state: string; result?: unknown };
      error?: string;
    }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('direct volume worker timed out')), 20_000);
      worker.onerror = (event) => {
        clearTimeout(timeout);
        reject(event.error ?? new Error(event.message));
      };
      worker.onmessage = ({ data }) => {
        clearTimeout(timeout);
        resolve(data);
      };
      worker.postMessage({ type: 'run', example: packedExample });
    });
    expect(result.ok, result.error).toBe(true);
    expect(result.before?.exists).toBe(false);
    expect(result.after?.exists).toBe(true);
    expect(result.first).toMatchObject({
      persistence: { state: 'clean' },
      directSubscription: {
        change: { type: 'create', path: '/subscribed.txt' },
        retired: { status: 'released' },
      },
      copyTemp: {
        directCopy: true,
        regularReplacement: true,
        scopedTempDirectoryRemoved: true,
        scopedTempFileRemoved: true,
        siblingSurvived: true,
        physicalTempParents: true,
      },
      namespace: {
        relativeLink: 'sub/note',
        danglingLink: 'missing',
        realLink: '/namespace/tree/sub/note',
        listing: ['jump', 'link', 'sub', 'sub/note'],
        metadata: { size: '3', nlink: 2 },
        times: { atimeMs: 1250, mtimeMs: 2500 },
        denied: true,
        readDenied: true,
        nestedDenied: true,
        nonEmpty: true,
        busy: true,
        dangling: true,
        cycle: true,
        trailingSlash: true,
      },
    });
    expect(result.reopened).toMatchObject({
      content: 'scoped direct volume',
      fileSystemContent: 'scoped Effect FileSystem',
      persistence: { state: 'clean' },
    });
    if (packedExample) expect(result.example).toMatchObject({ state: 'clean' });
    if (packedExample?.endsWith('/filesystem-stream.ts')) expect(result.example?.result).toBe(16n * 1024n * 1024n + 1n);
  } finally {
    worker.terminate();
  }
}, 25_000);
