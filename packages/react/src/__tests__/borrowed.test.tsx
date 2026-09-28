import { OpfsVfsWorker } from '@opfs-vfs/opfs-vfs/worker';
import { subscriptionsRequest } from '@opfs-vfs/plugin-subscriptions/config';
import { describe, expect, it, vi } from 'vitest';
import { VolumeError, VolumeProvider, useVolumeClient } from '../index';
import { useVolumeBinding } from '../volume';
import { persistenceFaultRequest } from '../../../opfs-vfs/src/__tests__/persistence-fault-plugin';
import { cleanup, mount, volumeName, waitFor, worker } from './harness';
import { testLockRequest } from './test-lock-plugin';

function Handle({ into }: { into: unknown[] }) {
  into.push(useVolumeClient());
  return null;
}

async function armPersistenceFailure(fileName: string) {
  const channel = new BroadcastChannel(`persistence-fault-${fileName}`);
  try {
    const armed = new Promise<void>((resolve) => (channel.onmessage = () => resolve()));
    channel.postMessage({ type: 'fail', count: 1 });
    await armed;
  } finally {
    channel.close();
  }
}

describe('borrowed providers', () => {
  it('reports a real owner persistence fault to each borrowed alias', async () => {
    const fileName = volumeName();
    const plugin = persistenceFaultRequest();
    const owner = new OpfsVfsWorker(fileName, { worker, plugins: [subscriptionsRequest(), plugin] });
    let follower: OpfsVfsWorker | undefined;
    let app: Awaited<ReturnType<typeof mount>> | undefined;
    try {
      await owner.ready;
      expect(owner.getStatus().role).toBe('leader');
      follower = new OpfsVfsWorker(fileName, { worker, plugins: [subscriptionsRequest(), plugin] });
      const rawFollower = follower;
      await rawFollower.ready;
      expect(rawFollower.getStatus().role).toBe('follower');
      const reports: VolumeError[] = [];
      app = await mount(
        <VolumeProvider name="two" client={rawFollower} onError={(error) => reports.push(error)}>
          {() => (
            <VolumeProvider name="one" client={rawFollower} onError={(error) => reports.push(error)}>
              {() => null}
            </VolumeProvider>
          )}
        </VolumeProvider>,
      );
      await waitFor(() => rawFollower.getStatus().persistence !== null);
      await armPersistenceFailure(fileName);
      await owner.writeFileBuffer('/fault', new Uint8Array([1]));
      await waitFor(() => reports.length === 2);
      for (const error of reports)
        expect(error).toMatchObject({
          kind: 'persistence',
          operation: 'persistence',
          volume: fileName,
          details: { code: 'EIO' },
          outcome: 'unknown',
        });
    } finally {
      await cleanup(fileName, app ? [app] : [], [owner, ...(follower ? [follower] : [])]);
    }
  });

  it('does not close or dispose a borrowed client on unmount', async () => {
    const fileName = volumeName();
    const raw = new OpfsVfsWorker(fileName, { worker, plugins: [subscriptionsRequest()] });
    await raw.ready;
    const close = vi.spyOn(raw, 'closeVfs');
    const dispose = vi.spyOn(raw, 'dispose');
    const states: any[] = [];
    const app = await mount(
      <VolumeProvider client={raw}>
        {(v) => {
          states.push(v);
          return null;
        }}
      </VolumeProvider>,
    );
    try {
      await waitFor(() => states.at(-1)?.status === 'ready');
      expect(states.at(-1)).toMatchObject({ ownership: 'borrowed' });
      expect('close' in states.at(-1)).toBe(false);
      await app.unmount();
      expect(close).not.toHaveBeenCalled();
      expect(dispose).not.toHaveBeenCalled();
      expect(raw.getStatus().state).toBe('ready');
    } finally {
      close.mockRestore();
      dispose.mockRestore();
      await cleanup(fileName, [], [raw]);
    }
  });

  it('observes external close and disposal, invalidating captured handles', async () => {
    for (const action of ['closeVfs', 'dispose'] as const) {
      const fileName = volumeName();
      const raw = new OpfsVfsWorker(fileName, { worker, plugins: [subscriptionsRequest()] });
      await raw.ready;
      const states: any[] = [];
      const handles: unknown[] = [];
      const app = await mount(
        <VolumeProvider client={raw}>
          {(v) => {
            states.push(v);
            return <Handle into={handles} />;
          }}
        </VolumeProvider>,
      );
      try {
        await waitFor(() => states.at(-1)?.status === 'ready');
        const handle = handles.at(-1) as { stat(path: string): Promise<unknown> };
        if (action === 'closeVfs') await raw.closeVfs();
        else raw.dispose();
        await waitFor(() => states.at(-1)?.status === 'closed');
        expect(handles.at(-1)).toBeNull();
        await expect(handle.stat('/')).rejects.toMatchObject({ outcome: 'not-applied' });
      } finally {
        await cleanup(fileName, [app], [raw]);
      }
    }
  });

  it('shares a generation for one object and separates independently created clients', async () => {
    const fileName = volumeName();
    const one = new OpfsVfsWorker(fileName, { worker, plugins: [subscriptionsRequest()] });
    const two = new OpfsVfsWorker(fileName, { worker, plugins: [subscriptionsRequest()] });
    await Promise.all([one.ready, two.ready]);
    const same: any[] = [];
    const different: any[] = [];
    const app = await mount(
      <>
        <VolumeProvider client={one}>
          {(v) => {
            same.push(v);
            return null;
          }}
        </VolumeProvider>
        <VolumeProvider name="same" client={one}>
          {(v) => {
            same.push(v);
            return null;
          }}
        </VolumeProvider>
        <VolumeProvider name="other" client={two}>
          {(v) => {
            different.push(v);
            return null;
          }}
        </VolumeProvider>
      </>,
    );
    try {
      await waitFor(
        () => same.filter((v) => v.status === 'ready').length === 2 && different.at(-1)?.status === 'ready',
      );
      expect(same.at(-1).generation).toBe(same.find((v) => v.status === 'ready').generation);
      expect(different.at(-1).generation).not.toBe(same.at(-1).generation);
    } finally {
      await cleanup(fileName, [app], [one, two]);
    }
  });

  it('updates every alias before running borrowed lifecycle error reporters', async () => {
    const fileName = volumeName();
    const leader = new OpfsVfsWorker(fileName, {
      worker,
      plugins: [subscriptionsRequest(), testLockRequest('right')],
    });
    await leader.ready;
    const follower = new OpfsVfsWorker(fileName, {
      worker,
      plugins: [subscriptionsRequest(), testLockRequest('wrong')],
      initTimeout: 2_000,
    });
    await follower.ready;
    const bindings: { one?: ReturnType<typeof useVolumeBinding>; two?: ReturnType<typeof useVolumeBinding> } = {};
    const reports: Record<'one' | 'two', string[][]> = { one: [], two: [] };
    function CaptureBindings() {
      bindings.one = useVolumeBinding('one');
      bindings.two = useVolumeBinding('two');
      return null;
    }
    const report = (alias: 'one' | 'two') => () =>
      reports[alias].push([bindings.one!.getSnapshot().status, bindings.two!.getSnapshot().status]);
    const app = await mount(
      <VolumeProvider name="two" client={follower} onError={report('two')}>
        {() => (
          <VolumeProvider name="one" client={follower} onError={report('one')}>
            {() => <CaptureBindings />}
          </VolumeProvider>
        )}
      </VolumeProvider>,
    );
    try {
      await leader.closeVfs();
      await waitFor(() => reports.one.length === 1 && reports.two.length === 1);
      expect(reports).toEqual({
        one: [['error', 'error']],
        two: [['error', 'error']],
      });
    } finally {
      await cleanup(fileName, [app], [leader, follower]);
    }
  });

  it('reports command errors only to the borrowed client that made the call', async () => {
    const firstName = volumeName();
    const secondName = volumeName();
    const firstRaw = new OpfsVfsWorker(firstName, { worker, plugins: [subscriptionsRequest()] });
    const secondRaw = new OpfsVfsWorker(secondName, { worker, plugins: [subscriptionsRequest()] });
    await Promise.all([firstRaw.ready, secondRaw.ready]);
    const firstHandles: unknown[] = [];
    const secondHandles: unknown[] = [];
    const firstReports: VolumeError[] = [];
    const secondReports: VolumeError[] = [];
    const app = await mount(
      <>
        <VolumeProvider client={firstRaw} onError={(error) => firstReports.push(error)}>
          {() => <Handle into={firstHandles} />}
        </VolumeProvider>
        <VolumeProvider client={secondRaw} onError={(error) => secondReports.push(error)}>
          {() => <Handle into={secondHandles} />}
        </VolumeProvider>
      </>,
    );
    try {
      await waitFor(() => firstHandles.at(-1) != null && secondHandles.at(-1) != null);
      const first = firstHandles.at(-1) as NonNullable<ReturnType<typeof useVolumeClient>>;
      const second = secondHandles.at(-1) as NonNullable<ReturnType<typeof useVolumeClient>>;
      const firstError = await first.readFileBuffer('/missing-one').catch((error) => error as VolumeError);
      const secondError = await second.readFileBuffer('/missing-two').catch((error) => error as VolumeError);
      expect(firstReports).toEqual([firstError]);
      expect(secondReports).toEqual([secondError]);
      expect(firstReports.every((error) => error.volume === firstRaw.getStatus().fileName)).toBe(true);
      expect(secondReports.every((error) => error.volume === secondRaw.getStatus().fileName)).toBe(true);
    } finally {
      await cleanup(firstName, [app], [firstRaw]);
      await cleanup(secondName, [], [secondRaw]);
    }
  });

  it('shows an already failed borrowed client without replaying its error', async () => {
    const fileName = volumeName();
    const raw = new OpfsVfsWorker(fileName, {
      worker,
      plugins: [subscriptionsRequest(), testLockRequest('wrong')],
      initTimeout: 2_000,
    });
    await raw.ready.catch(() => {});
    const reports: unknown[] = [];
    const states: any[] = [];
    const app = await mount(
      <VolumeProvider client={raw} onError={(error) => reports.push(error)}>
        {(v) => {
          states.push(v);
          return null;
        }}
      </VolumeProvider>,
    );
    try {
      await waitFor(() => states.at(-1)?.status === 'error');
      expect(reports).toEqual([]);
    } finally {
      await cleanup(fileName, [app], [raw]);
    }
  });
});
