import { act, startTransition, useActionState, useRef } from 'react';
import { GENERATION_METHODS, OpfsVfsWorker } from '@opfs-vfs/opfs-vfs/worker';
import { subscriptionsRequest } from '@opfs-vfs/plugin-subscriptions/config';
import { describe, expect, it, vi } from 'vitest';
import { VolumeError, VolumeProvider, useVolume, useVolumeClient } from '../index';
import { closeManaged, cleanup, countingWorker, mount, volumeName, waitFor, worker } from './harness';

const descriptorMethods = ['open', 'read', 'write', 'seek', 'close', 'fstat', 'fsync', 'ftruncate'] as const;

function Commands({ values }: { values: unknown[] }) {
  values.push(useVolumeClient());
  return null;
}
function CurrentClient({
  expose,
  name,
}: {
  expose: (client: ReturnType<typeof useVolumeClient>) => void;
  name?: string;
}) {
  expose(useVolumeClient(name));
  return null;
}

type Save = {
  fs: NonNullable<ReturnType<typeof useVolumeClient>>;
  path: string;
  bytes: Uint8Array;
  generation: string;
};
type SaveState = { saved: boolean; error: VolumeError | null; generation: string | null };
type FirstBarrier = { wait: Promise<void>; entered: () => void };
function SaveAction({
  expose,
  firstBarrier,
  onOutcome,
  rendered,
}: {
  expose: (dispatch: (save: Save) => void, state: SaveState, fs: ReturnType<typeof useVolumeClient>) => void;
  firstBarrier?: FirstBarrier;
  onOutcome?: (save: Save, state: SaveState) => void;
  rendered?: string[];
}) {
  const volume = useVolume();
  const fs = useVolumeClient();
  const first = useRef(true);
  const [state, dispatch] = useActionState<SaveState, Save>(
    async (_previous, save) => {
      try {
        await save.fs.writeFileBuffer(save.path, save.bytes);
        if (first.current && firstBarrier) {
          first.current = false;
          firstBarrier.entered();
          await firstBarrier.wait;
        }
        await save.fs.sync();
        const next = { saved: true, error: null, generation: save.generation };
        onOutcome?.(save, next);
        return next;
      } catch (error) {
        const next = { saved: false, error: error as VolumeError, generation: save.generation };
        onOutcome?.(save, next);
        return next;
      }
    },
    { saved: false, error: null, generation: null },
  );
  if (fs && volume.generation) expose(dispatch, state, fs);
  const text = state.saved && state.generation === volume.generation ? 'saved' : state.error ? 'save failed' : 'idle';
  rendered?.push(text);
  return <p>{text}</p>;
}

describe('generation command handles', () => {
  it('is null while pending and exposes only frozen path methods while ready', async () => {
    const fileName = volumeName();
    const values: unknown[] = [];
    const results: any[] = [];
    const app = await mount(
      <VolumeProvider fileName={fileName} worker={worker}>
        {(v) => {
          results.push(v);
          return <Commands values={values} />;
        }}
      </VolumeProvider>,
    );
    try {
      expect(values.at(-1)).toBeNull();
      await waitFor(() => values.at(-1) !== null);
      const handle = values.at(-1) as NonNullable<ReturnType<typeof useVolumeClient>>;
      expect(Object.isFrozen(handle)).toBe(true);
      expect(Object.keys(handle)).toHaveLength(GENERATION_METHODS.length - descriptorMethods.length);
      for (const method of descriptorMethods) expect(handle).not.toHaveProperty(method);
      expect(handle).not.toHaveProperty('closeVfs');
      await handle.writeFileBuffer('/path', new Uint8Array([1]));
      expect(await handle.readFileBuffer('/path')).toEqual(new Uint8Array([1]));
      await app.render(
        <VolumeProvider fileName={fileName} worker={worker}>
          {() => <Commands values={values} />}
        </VolumeProvider>,
      );
      expect(values.at(-1)).toBe(handle);
    } finally {
      await closeManaged(results);
      await cleanup(fileName, [app], []);
    }
  });

  it('round-trips filesystem methods without detaching caller bytes', async () => {
    const fileName = volumeName();
    let fs: ReturnType<typeof useVolumeClient> = null;
    const results: any[] = [];
    const app = await mount(
      <VolumeProvider fileName={fileName} worker={worker}>
        {(v) => {
          results.push(v);
          return (
            <CurrentClient
              expose={(client) => {
                fs = client;
              }}
            />
          );
        }}
      </VolumeProvider>,
    );
    try {
      await waitFor(() => fs !== null);
      const bytes = new Uint8Array([1, 2, 3]);
      await fs!.mkdir('/dir');
      await fs!.writeFileBuffer('/dir/a', bytes);
      expect(bytes.byteLength).toBe(3);
      expect(await fs!.readFileBuffer('/dir/a')).toEqual(bytes);
      expect((await fs!.stat('/dir/a')).size).toBe(3);
      expect((await fs!.readdirEntries('/dir')).map((entry) => entry.name)).toContain('a');
      await fs!.rename('/dir/a', '/dir/b');
      await fs!.unlink('/dir/b');
    } finally {
      await closeManaged(results);
      await cleanup(fileName, [app], []);
    }
  });

  it('normalizes command errors, reports once, and preserves expected-content conflicts', async () => {
    const fileName = volumeName();
    let fs: ReturnType<typeof useVolumeClient> = null;
    const reports: VolumeError[] = [];
    const results: any[] = [];
    const app = await mount(
      <VolumeProvider
        fileName={fileName}
        worker={worker}
        onError={(error) => {
          reports.push(error);
          throw new Error('reporter failure');
        }}
      >
        {(v) => {
          results.push(v);
          return (
            <CurrentClient
              expose={(client) => {
                fs = client;
              }}
            />
          );
        }}
      </VolumeProvider>,
    );
    try {
      await waitFor(() => fs !== null);
      const error = await fs!.readFileBuffer('/missing').catch((cause) => cause as VolumeError);
      expect(error).toMatchObject({
        kind: 'filesystem',
        operation: 'readFileBuffer',
        path: '/missing',
        volume: fileName,
        details: { code: 'ENOENT' },
        outcome: 'unknown',
      });
      expect(reports).toEqual([error]);
      await fs!.writeFileBuffer('/a', new Uint8Array([1]));
      await expect(
        fs!.writeFileBuffer('/a', new Uint8Array([2]), { expected: new Uint8Array([9]) }),
      ).rejects.toMatchObject({ kind: 'conflict' });
    } finally {
      await closeManaged(results);
      await cleanup(fileName, [app], []);
    }
  });

  it('reports command errors only to the alias that made the call', async () => {
    const fileName = volumeName();
    let first: ReturnType<typeof useVolumeClient> = null;
    let second: ReturnType<typeof useVolumeClient> = null;
    const firstReports: VolumeError[] = [];
    const secondReports: VolumeError[] = [];
    const results: any[] = [];
    const app = await mount(
      <>
        <VolumeProvider fileName={fileName} worker={worker} onError={(error) => firstReports.push(error)}>
          {(volume) => {
            results.push(volume);
            return <CurrentClient expose={(client) => (first = client)} />;
          }}
        </VolumeProvider>
        <VolumeProvider
          name="second"
          fileName={fileName}
          worker={worker}
          onError={(error) => secondReports.push(error)}
        >
          {(volume) => {
            results.push(volume);
            return <CurrentClient name="second" expose={(client) => (second = client)} />;
          }}
        </VolumeProvider>
      </>,
    );
    try {
      await waitFor(() => first !== null && second !== null);
      const one = await first!.readFileBuffer('/one').catch((error) => error as VolumeError);
      const two = await first!.readFileBuffer('/two').catch((error) => error as VolumeError);
      const three = await second!.readFileBuffer('/three').catch((error) => error as VolumeError);
      expect(firstReports).toEqual([one, two]);
      expect(secondReports).toEqual([three]);
    } finally {
      await closeManaged(results);
      await cleanup(fileName, [app], []);
    }
  });

  it('keeps a React Action pinned to its dispatched generation after a sync failure', async () => {
    const fileName = volumeName();
    const factory = countingWorker();
    let dispatch: ((save: Save) => void) | undefined;
    let state: { saved: boolean; error: VolumeError | null; generation: string | null } | undefined;
    let current: ReturnType<typeof useVolumeClient> = null;
    let generation: string | null = null;
    const results: any[] = [];
    const rendered: string[] = [];
    const app = await mount(
      <VolumeProvider fileName={fileName} worker={factory.create}>
        {(result) => {
          results.push(result);
          generation = result.generation;
          return (
            <SaveAction
              rendered={rendered}
              expose={(next, value, handle) => {
                dispatch = next;
                state = value;
                current = handle;
              }}
            />
          );
        }}
      </VolumeProvider>,
    );
    const original = Worker.prototype.postMessage;
    const post = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (
      this: Worker,
      message,
      options,
    ) {
      const typed = message as { id?: number; type?: string };
      if (typed.type === 'SYNC')
        this.dispatchEvent(
          new MessageEvent('message', {
            data: { id: typed.id, type: 'ERROR', result: { error: 'sync failed', code: 'EIO' } },
          }),
        );
      else original.call(this, message, options as StructuredSerializeOptions);
    });
    try {
      await waitFor(() => !!dispatch && !!current && !!generation);
      await act(async () =>
        dispatch!({ fs: current!, path: '/save', bytes: new Uint8Array([7]), generation: generation! }),
      );
      await waitFor(() => state?.error?.operation === 'sync');
      expect(state).toMatchObject({
        saved: false,
        error: { details: { code: 'EIO' }, outcome: 'unknown' },
        generation,
      });
      expect(await current!.readFileBuffer('/save')).toEqual(new Uint8Array([7]));
      expect(rendered).not.toContain('saved');
    } finally {
      post.mockRestore();
      await closeManaged(results);
      await cleanup(fileName, [app], []);
    }
  });

  it('refuses queued Actions that captured a prior follower generation', async () => {
    const fileName = volumeName();
    const leader = new OpfsVfsWorker(fileName, { worker, plugins: [subscriptionsRequest()] });
    await leader.ready;
    let dispatch: ((save: Save) => void) | undefined;
    let state: SaveState | undefined;
    let current: ReturnType<typeof useVolumeClient> = null;
    let generation: string | null = null;
    const results: any[] = [];
    const outcomes: SaveState[] = [];
    const rendered: string[] = [];
    const barrier = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const app = await mount(
      <VolumeProvider fileName={fileName} worker={worker}>
        {(result) => {
          results.push(result);
          generation = result.generation;
          return (
            <SaveAction
              firstBarrier={{ wait: barrier.promise, entered: entered.resolve }}
              rendered={rendered}
              onOutcome={(_save, outcome) => outcomes.push(outcome)}
              expose={(next, value, handle) => {
                dispatch = next;
                state = value;
                current = handle;
              }}
            />
          );
        }}
      </VolumeProvider>,
    );
    try {
      await waitFor(() => !!dispatch && current !== null && generation !== null);
      const old = current!;
      const oldGeneration = generation!;
      const firstBytes = new Uint8Array([1]);
      const secondBytes = new Uint8Array([2]);
      act(() =>
        startTransition(() => {
          dispatch!({ fs: old, path: '/queued', bytes: firstBytes, generation: oldGeneration });
          dispatch!({ fs: old, path: '/queued-2', bytes: secondBytes, generation: oldGeneration });
        }),
      );
      await entered.promise;
      await leader.closeVfs();
      await waitFor(
        () =>
          results.at(-1)?.status === 'recovering' ||
          (results.at(-1)?.generation !== null && results.at(-1)?.generation !== oldGeneration),
      );
      barrier.resolve();
      await waitFor(() => outcomes.length === 2 && state?.generation === oldGeneration);
      expect(outcomes[0]).toMatchObject({
        saved: false,
        generation: oldGeneration,
        error: { operation: 'sync', outcome: 'not-applied', kind: 'lifecycle' },
      });
      expect(outcomes[1]).toMatchObject({
        saved: false,
        generation: oldGeneration,
        error: { operation: 'writeFileBuffer', outcome: 'not-applied' },
      });
      await waitFor(
        () => results.at(-1)?.status === 'ready' && results.at(-1)?.generation !== oldGeneration && current !== old,
      );
      expect(await current!.readFileBuffer('/queued')).toEqual(firstBytes);
      await expect(current!.readFileBuffer('/queued-2')).rejects.toMatchObject({ details: { code: 'ENOENT' } });
      expect(rendered).not.toContain('saved');
      expect(state?.generation).toBe(oldGeneration);
      expect(state?.generation).not.toBe(results.at(-1)?.generation);
    } finally {
      await closeManaged(results);
      await cleanup(fileName, [app], [leader]);
    }
  });
});
