import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { deleteVolume } from '@opfs-vfs/opfs-vfs';
import { OpfsVfsWorker } from '@opfs-vfs/opfs-vfs/worker';
import { subscriptionsRequest } from '@opfs-vfs/plugin-subscriptions/config';
import {
  File,
  FileContent,
  Folder,
  type FolderResult,
  VolumeProvider,
  useFile,
  useFileContent,
  useFolder,
  useVolumeClient,
} from '../index';
import { closeManaged, mount, volumeName, waitFor, worker } from './harness';

async function waitForReact(check: () => boolean, label: string) {
  const deadline = performance.now() + 4_000;
  for (;;) {
    let matched = false;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      matched = check();
    });
    if (matched) return;
    if (performance.now() > deadline) throw new Error(`${label} timed out`);
  }
}

describe('live read hooks', () => {
  it('shares one folder listing and root watch across 100 committed hooks', async () => {
    const fileName = volumeName();
    const client = new OpfsVfsWorker(fileName, { worker, plugins: [subscriptionsRequest()] });
    const seen: unknown[] = [];
    let app: Awaited<ReturnType<typeof mount>> | undefined;
    try {
      await client.ready;
      const open = client.openFileChangeChannel.bind(client);
      let roots = 0;
      Object.defineProperty(client, 'openFileChangeChannel', {
        value: (...args: Parameters<typeof open>) => {
          roots++;
          return open(...args);
        },
      });
      const forGeneration = client.forGeneration.bind(client);
      let listings = 0;
      Object.defineProperty(client, 'forGeneration', {
        value: (generation: string) => {
          const facade = forGeneration(generation);
          return Object.freeze({
            ...facade,
            readdirEntries: async (...args: Parameters<typeof facade.readdirEntries>) => {
              listings++;
              return facade.readdirEntries(...args);
            },
          });
        },
      });
      function Consumer() {
        seen.push(useFolder('/'));
        return null;
      }
      app = await mount(
        <VolumeProvider client={client}>
          {Array.from({ length: 100 }, (_, index) => (
            <Consumer key={index} />
          ))}
        </VolumeProvider>,
      );
      await waitForReact(() => seen.some((result: any) => result.status === 'success'), '100 committed folder hooks');
      expect(roots).toBe(1);
      expect(listings).toBe(1);
    } finally {
      if (app) await app.unmount();
      await client.closeVfs().catch(() => {});
      client.dispose();
      await deleteVolume(fileName).catch(() => {});
    }
  });

  it('freezes shared folder entries without blocking real updates', async () => {
    const fileName = volumeName();
    const client = new OpfsVfsWorker(fileName, { worker, plugins: [subscriptionsRequest()] });
    let first: FolderResult | undefined;
    let second: FolderResult | undefined;
    let app: Awaited<ReturnType<typeof mount>> | undefined;
    function First() {
      first = useFolder('/');
      return null;
    }
    function Second() {
      second = useFolder('/');
      return null;
    }
    try {
      await client.ready;
      const fs = client.forGeneration(client.getStatus().ownerGeneration!);
      await fs.writeFileBuffer('/source', new Uint8Array([1]));
      app = await mount(
        <VolumeProvider client={client}>
          <First />
          <Second />
        </VolumeProvider>,
      );
      await waitForReact(
        () => first?.status === 'success' && second?.status === 'success' && first.data.length === 1,
        'shared folder snapshot',
      );
      const firstResult = first;
      const secondResult = second;
      if (firstResult?.status !== 'success' || secondResult?.status !== 'success')
        throw new Error('Expected folder snapshots');
      expect(firstResult.data).toBe(secondResult.data);
      expect(Object.isFrozen(firstResult.data[0]!)).toBe(true);
      expect(() => Object.assign(firstResult.data[0]!, { name: 'corrupted' })).toThrow(TypeError);
      expect(secondResult.data[0]!.name).toBe('source');

      await fs.writeFileBuffer('/added', new Uint8Array([2]));
      await waitForReact(
        () =>
          first?.status === 'success' &&
          second?.status === 'success' &&
          first.data.some((entry) => entry.name === 'added') &&
          second.data.some((entry) => entry.name === 'added'),
        'folder update after immutable shared snapshot',
      );
    } finally {
      if (app) await app.unmount();
      await client.closeVfs().catch(() => {});
      client.dispose();
      await deleteVolume(fileName).catch(() => {});
    }
  });

  it('acquires after commit and gives hooks and render callbacks the same resource contracts', async () => {
    const fileName = volumeName();
    const volumes: any[] = [];
    const seen: any[] = [];
    function Hooks() {
      seen.push({
        folder: useFolder('/'),
        file: useFile('/'),
        content: useFileContent('/missing', { format: 'text' }),
      });
      return (
        <>
          <Folder path="/">
            {(folder) => {
              seen.push({ componentFolder: folder });
              return null;
            }}
          </Folder>
          <File path="/">
            {(file) => {
              seen.push({ componentFile: file });
              return null;
            }}
          </File>
          <FileContent path="/missing">
            {(content) => {
              seen.push({ componentContent: content });
              return null;
            }}
          </FileContent>
        </>
      );
    }
    const app = await mount(
      <VolumeProvider fileName={fileName} worker={worker}>
        {(volume) => {
          volumes.push(volume);
          return <Hooks />;
        }}
      </VolumeProvider>,
    );
    try {
      await waitForReact(
        () => seen.some((value) => value.componentContent?.status === 'success'),
        'committed live reads',
      );
      const content = seen.findLast((value) => value.componentContent?.status === 'success');
      expect(content.componentContent.data).toBeNull();
      expect(seen.some((value) => value.file?.status === 'error')).toBe(true);
      expect(seen.some((value) => value.componentFile?.status === 'error')).toBe(true);
      expect(seen.some((value) => value.folder?.status === 'success')).toBe(true);
      expect(seen.some((value) => value.componentFolder?.status === 'success')).toBe(true);
    } finally {
      await act(async () => {
        await closeManaged(volumes);
      });
      await app.unmount();
    }
  });

  it('does not retain data while path, format, limit, volume, or enabled changes select a new read', async () => {
    const firstName = volumeName();
    const secondName = volumeName();
    const first = new OpfsVfsWorker(firstName, { worker, plugins: [subscriptionsRequest()] });
    const second = new OpfsVfsWorker(secondName, { worker, plugins: [subscriptionsRequest()] });
    const seen: any[] = [];
    let app: Awaited<ReturnType<typeof mount>> | undefined;
    try {
      await Promise.all([first.ready, second.ready]);
      await first
        .forGeneration(first.getStatus().ownerGeneration!)
        .writeFileBuffer('/one', new TextEncoder().encode('first'));
      await first
        .forGeneration(first.getStatus().ownerGeneration!)
        .writeFileBuffer('/two', new TextEncoder().encode('second'));
      await second
        .forGeneration(second.getStatus().ownerGeneration!)
        .writeFileBuffer('/one', new TextEncoder().encode('other'));
      const reads = new Map<OpfsVfsWorker, number>([
        [first, 0],
        [second, 0],
      ]);
      for (const client of [first, second]) {
        const forGeneration = client.forGeneration.bind(client);
        Object.defineProperty(client, 'forGeneration', {
          value: (generation: string) => {
            const facade = forGeneration(generation);
            return Object.freeze({
              ...facade,
              readFileBuffer: async (...args: Parameters<typeof facade.readFileBuffer>) => {
                reads.set(client, reads.get(client)! + 1);
                return facade.readFileBuffer(...args);
              },
            });
          },
        });
      }
      function Reader({
        path,
        volume,
        enabled,
        format,
        limit,
      }: {
        path: string;
        volume: string;
        enabled: boolean;
        format: 'bytes' | 'text';
        limit: number;
      }) {
        seen.push(useFileContent(path, { volume, enabled, format, limit }));
        return null;
      }
      const render = (props: {
        path: string;
        volume: string;
        enabled: boolean;
        format: 'bytes' | 'text';
        limit: number;
      }) => (
        <VolumeProvider name="one" client={first}>
          <VolumeProvider name="two" client={second}>
            <Reader {...props} />
          </VolumeProvider>
        </VolumeProvider>
      );
      const expectNewRead = (
        start: number,
        status: 'idle' | 'pending',
        expectedData: string | Uint8Array | undefined,
      ) => {
        expect(seen[start]).toMatchObject({ status, data: undefined });
        for (const snapshot of seen.slice(start)) {
          if (snapshot.status === 'pending') expect(snapshot.data).toBeUndefined();
          if (snapshot.data !== undefined) expect(snapshot.data).toEqual(expectedData);
        }
      };

      app = await mount(render({ path: '/one', volume: 'one', enabled: false, format: 'text', limit: 16 }));
      expect(seen.at(-1)).toMatchObject({ status: 'idle', data: undefined });
      expect(reads.get(first)).toBe(0);
      await app.render(render({ path: '/one', volume: 'one', enabled: true, format: 'text', limit: 16 }));
      await waitForReact(() => seen.at(-1)?.status === 'success' && seen.at(-1)?.data === 'first', 'first path');

      const beforePath = seen.length;
      await app.render(render({ path: '/two', volume: 'one', enabled: true, format: 'text', limit: 16 }));
      await waitForReact(() => seen.at(-1)?.status === 'success' && seen.at(-1)?.data === 'second', 'second path');
      expectNewRead(beforePath, 'pending', 'second');

      const beforeFormat = seen.length;
      await app.render(render({ path: '/two', volume: 'one', enabled: true, format: 'bytes', limit: 16 }));
      await waitForReact(
        () => seen.at(-1)?.status === 'success' && seen.at(-1)?.data instanceof Uint8Array,
        'bytes format',
      );
      expectNewRead(beforeFormat, 'pending', new TextEncoder().encode('second'));
      const beforeLimit = reads.get(first)!;
      const beforeLimitedRead = seen.length;
      await app.render(render({ path: '/two', volume: 'one', enabled: true, format: 'bytes', limit: 1 }));
      await waitForReact(
        () => seen.at(-1)?.status !== 'pending' && reads.get(first)! > beforeLimit,
        'limited content result',
      );
      expectNewRead(beforeLimitedRead, 'pending', undefined);
      expect(seen.at(-1)?.data).toBeUndefined();

      const beforeVolume = seen.length;
      await app.render(render({ path: '/one', volume: 'two', enabled: true, format: 'text', limit: 16 }));
      await waitForReact(() => seen.at(-1)?.status === 'success' && seen.at(-1)?.data === 'other', 'selected volume');
      expectNewRead(beforeVolume, 'pending', 'other');
      const beforeDisabled = reads.get(second)!;
      const beforeDisabledRead = seen.length;
      await app.render(render({ path: '/two', volume: 'two', enabled: false, format: 'text', limit: 16 }));
      await waitForReact(() => seen.at(-1)?.status === 'idle', 'disabled read');
      expectNewRead(beforeDisabledRead, 'idle', undefined);
      expect(seen.at(-1)).toMatchObject({ data: undefined });
      expect(reads.get(second)).toBe(beforeDisabled);
    } finally {
      if (app) await app.unmount();
      await Promise.allSettled([first.closeVfs(), second.closeVfs()]);
      first.dispose();
      second.dispose();
      await Promise.all([firstName, secondName].map((name) => deleteVolume(name).catch(() => {})));
    }
  });

  it('does not detach bytes shared by a content resource when a command writes them', async () => {
    const fileName = volumeName();
    const client = new OpfsVfsWorker(fileName, { worker, plugins: [subscriptionsRequest()] });
    let content: any;
    let command: ReturnType<typeof useVolumeClient> = null;
    let app: Awaited<ReturnType<typeof mount>> | undefined;
    function Reader() {
      content = useFileContent('/source');
      command = useVolumeClient();
      return null;
    }
    try {
      await client.ready;
      await client
        .forGeneration(client.getStatus().ownerGeneration!)
        .writeFileBuffer('/source', new Uint8Array([1, 2, 3]));
      app = await mount(
        <VolumeProvider client={client}>
          <Reader />
        </VolumeProvider>,
      );
      await waitForReact(() => content?.status === 'success' && command !== null, 'shared content and command');
      const bytes = content.data as Uint8Array;
      await act(async () => {
        await command!.writeFileBuffer('/copy', bytes);
      });
      expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
      expect(content.data).toBe(bytes);
      expect(await client.forGeneration(client.getStatus().ownerGeneration!).readFileBuffer('/copy')).toEqual(bytes);
    } finally {
      if (app) await app.unmount();
      await client.closeVfs().catch(() => {});
      client.dispose();
      await deleteVolume(fileName).catch(() => {});
    }
  });

  it('follower hooks observe a separate SAB owner sync write and rescan after a real subscription invalidation', async () => {
    const fileName = volumeName();
    const owner = new Worker(new URL('./sab-owner-worker.ts', import.meta.url), { type: 'module' });
    const events: { type: string; message?: string }[] = [];
    owner.onmessage = ({ data }) => events.push(data);
    let client: OpfsVfsWorker | undefined;
    let app: Awaited<ReturnType<typeof mount>> | undefined;
    let content: ReturnType<typeof useFileContent> | undefined;
    function Reader() {
      content = useFileContent('/sab');
      return null;
    }
    const command = async (type: 'START' | 'WRITE' | 'INVALIDATE' | 'CLOSE', value?: number) => {
      const before = events.length;
      owner.postMessage({ type, fileName, value });
      const expected = type === 'START' ? 'READY' : type === 'WRITE' ? 'SYNC_RETURNED' : `${type}D`;
      await waitFor(() => events.slice(before).some((event) => event.type === expected || event.type === 'ERROR'));
      const response = events.slice(before).find((event) => event.type === expected || event.type === 'ERROR')!;
      const failure = response.type === 'ERROR' ? response : undefined;
      if (failure) throw new Error(failure.message);
      return response;
    };
    try {
      await command('START');
      client = new OpfsVfsWorker(fileName, { worker, plugins: [subscriptionsRequest()] });
      await client.ready;
      const forGeneration = client.forGeneration.bind(client);
      let reads = 0;
      Object.defineProperty(client, 'forGeneration', {
        value: (generation: string) => {
          const facade = forGeneration(generation);
          return Object.freeze({
            ...facade,
            readFileBuffer: async (...args: Parameters<typeof facade.readFileBuffer>) => {
              if (args[0] === '/sab') reads++;
              return facade.readFileBuffer(...args);
            },
          });
        },
      });
      app = await mount(
        <VolumeProvider client={client}>
          <Reader />
        </VolumeProvider>,
      );
      await waitForReact(() => content?.status === 'success' && content.data === null, 'follower initial read');

      await command('WRITE', 1);
      await waitForReact(
        () => content?.status === 'success' && content.data instanceof Uint8Array && content.data[0] === 1,
        'separate owner sync write',
      );

      await command('WRITE', 2);
      await waitForReact(
        () => content?.status === 'success' && content.data instanceof Uint8Array && content.data[0] === 2,
        'pre-invalidation update',
      );
      const beforeRescan = reads;
      await command('INVALIDATE');
      await waitForReact(
        () =>
          reads > beforeRescan &&
          content?.status === 'success' &&
          content.data instanceof Uint8Array &&
          content.data[0] === 2,
        'rescan after partial-mutation invalidation',
      );
    } finally {
      if (app) await app.unmount();
      await client?.closeVfs().catch(() => {});
      client?.dispose();
      owner.postMessage({ type: 'CLOSE' });
      await waitFor(() => events.some((event) => event.type === 'CLOSED')).catch(() => {});
      owner.terminate();
      await deleteVolume(fileName).catch(() => {});
    }
  });
});
