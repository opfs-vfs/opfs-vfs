import { deleteVolume } from '@opfs-vfs/opfs-vfs';
import { OpfsVfsWorker } from '@opfs-vfs/opfs-vfs/worker';
import { subscriptionsRequest } from '@opfs-vfs/plugin-subscriptions/config';
import { act, StrictMode, useLayoutEffect } from 'react';
import * as React from 'react';
import { flushSync } from 'react-dom';
import { describe, expect, it } from 'vitest';
import { VolumeError, VolumeProvider, useVolumeClient } from '../index';
import { useVolumeBinding, VolumeBinding, type VolumeResult } from '../volume';
import { persistenceFaultRequest } from '../../../opfs-vfs/src/__tests__/persistence-fault-plugin';
import {
  closeManaged,
  ErrorBoundary,
  bareWorker,
  cleanup,
  countingWorker,
  mount,
  volumeName,
  waitFor,
  worker,
} from './harness';
import { testLockRequest } from './test-lock-plugin';

const Activity = (
  React as { Activity?: React.ComponentType<{ mode: 'visible' | 'hidden'; children?: React.ReactNode }> }
).Activity;
const ActivityComponent = Activity as React.ComponentType<{ mode: 'visible' | 'hidden'; children?: React.ReactNode }>;
const activityIt = it.skipIf(!Activity);
const webkitSharedWorker = /AppleWebKit/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent);

function FaultHandle({ into }: { into: unknown[] }) {
  into.push(useVolumeClient('one'));
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

describe('managed providers', () => {
  it('reports a real persistence fault to each managed alias', async () => {
    const fileName = volumeName();
    const plugin = persistenceFaultRequest();
    const reports: VolumeError[] = [];
    const handles: unknown[] = [];
    const results: any[] = [];
    const app = await mount(
      <VolumeProvider
        name="two"
        fileName={fileName}
        worker={worker}
        plugins={[plugin]}
        onError={(error) => reports.push(error)}
      >
        {(two) => {
          results.push(two);
          return (
            <VolumeProvider
              name="one"
              fileName={fileName}
              worker={worker}
              plugins={[plugin]}
              onError={(error) => reports.push(error)}
            >
              {(one) => {
                results.push(one);
                return <FaultHandle into={handles} />;
              }}
            </VolumeProvider>
          );
        }}
      </VolumeProvider>,
    );
    try {
      await waitFor(() => handles.at(-1) !== null);
      const handle = handles.at(-1) as NonNullable<ReturnType<typeof useVolumeClient>>;
      await armPersistenceFailure(fileName);
      await handle.writeFileBuffer('/fault', new Uint8Array([1]));
      await waitFor(() => reports.length === 2);
      for (const error of reports)
        expect(error).toMatchObject({ kind: 'persistence', operation: 'persistence', volume: fileName });
    } finally {
      await closeManaged(results);
      await cleanup(fileName, [app], []);
    }
  });

  it('reports each new persistence revision without replaying known history', () => {
    const fileName = volumeName();
    const reports: VolumeError[] = [];
    const binding = new VolumeBinding('borrowed', {} as never, fileName);
    binding.onError = (error) => reports.push(error);
    const snapshot = (generation: string, failureRevision: number | null): VolumeResult =>
      Object.freeze({
        status: 'ready',
        error: null,
        missingCapabilities: [],
        role: 'leader',
        generation,
        persistence:
          failureRevision === null
            ? null
            : Object.freeze({
                state: failureRevision ? 'error' : 'clean',
                failureRevision,
                lastError: failureRevision ? { name: 'Error', message: 'fault', code: 'EIO' } : null,
                lastSalvage: null,
              }),
        transport: 'dedicated',
        fallbackReason: null,
        isClosing: false,
        ownership: 'borrowed',
      }) as VolumeResult;
    const source = {
      snapshot: snapshot('one', 1),
      store: null,
      ownerGeneration: 'one',
      attach() {},
      detach() {},
    };
    binding.initial(source);
    const publish = (generation: string, failureRevision: number | null) => {
      source.snapshot = snapshot(generation, failureRevision);
      source.ownerGeneration = generation;
      if (binding.changed(source)) binding.reportSnapshotError();
    };
    publish('one', null);
    publish('one', 1);
    expect(reports).toEqual([]);
    publish('one', 2);
    expect(reports).toMatchObject([{ kind: 'persistence', operation: 'persistence', details: { code: 'EIO' } }]);
    publish('one', 2);
    publish('two', 0);
    publish('two', 1);
    expect(reports).toHaveLength(2);
  });

  it('exposes the automatic dedicated fallback for an application worker', async () => {
    const fileName = volumeName();
    const factory = countingWorker();
    const states: any[] = [];
    const app = await mount(
      <VolumeProvider fileName={fileName} worker={factory.create}>
        {(value) => {
          states.push(value);
          return null;
        }}
      </VolumeProvider>,
    );
    try {
      await waitFor(() => states.at(-1)?.status === 'ready');
      expect(states.at(-1)).toMatchObject({
        transport: 'dedicated',
        fallbackReason: 'shared-worker-factory-unavailable',
      });
      expect(factory.count).toBe(1);
    } finally {
      await closeManaged(states);
      await cleanup(fileName, [app], []);
    }
  });

  it.skipIf(!webkitSharedWorker)('opens the no-worker default through the bundled SharedWorker asset', async () => {
    const fileName = volumeName();
    const states: any[] = [];
    const app = await mount(
      <VolumeProvider fileName={fileName}>
        {(value) => {
          states.push(value);
          return null;
        }}
      </VolumeProvider>,
    );
    try {
      await waitFor(() => states.at(-1)?.status === 'ready');
      expect(states.at(-1)).toMatchObject({ transport: 'shared-worker', fallbackReason: null });
    } finally {
      await closeManaged(states);
      await cleanup(fileName, [app], []);
    }
  });

  it('keeps passive observation for the bundled dedicated worker', async () => {
    const fileName = volumeName();
    const states: VolumeResult[] = [];
    const app = await mount(
      <VolumeProvider fileName={fileName} transport="dedicated">
        {(value) => {
          states.push(value);
          return null;
        }}
      </VolumeProvider>,
    );
    const channel = new BroadcastChannel(`opfs-vfs-${fileName}`);
    try {
      await waitFor(() => states.at(-1)?.status === 'ready');
      const id = crypto.randomUUID();
      let observed: unknown;
      channel.onmessage = ({ data }) => {
        if (data?.type === 'OBSERVER_INFO' && data.id === id) observed = data;
      };
      channel.postMessage({ type: 'OBSERVER_PROBE', id });
      await waitFor(() => observed !== undefined);
      expect(observed).toMatchObject({ generation: expect.any(String), protocol: 1 });
    } finally {
      channel.close();
      await closeManaged(states);
      await cleanup(fileName, [app], []);
    }
  });

  activityIt('uses the latest hidden construction input on first acquisition', async () => {
    const fileName = volumeName();
    const factoryA = countingWorker();
    const factoryB = countingWorker();
    const seen: any[] = [];
    const tree = (mode: 'hidden' | 'visible', factory: typeof factoryA, secret: string) => (
      <ActivityComponent mode={mode}>
        <VolumeProvider fileName={fileName} worker={factory.create} plugins={[testLockRequest(secret)]}>
          {(v) => {
            seen.push(v);
            return null;
          }}
        </VolumeProvider>
      </ActivityComponent>
    );
    const app = await mount(tree('hidden', factoryA, 'wrong'));
    try {
      await app.render(tree('hidden', factoryB, 'right'));
      await app.render(tree('visible', factoryB, 'right'));
      await waitFor(() => seen.at(-1)?.status === 'ready');
      expect(factoryA.count).toBe(0);
      expect(factoryB.count).toBe(1);
    } finally {
      await closeManaged(seen);
      await cleanup(fileName, [app], []);
    }
  });

  it('shares one compatible client across roots and aliases', async () => {
    const fileName = volumeName();
    const factory = countingWorker();
    const first: any[] = [];
    const second: any[] = [];
    const one = await mount(
      <VolumeProvider fileName={fileName} worker={factory.create}>
        {(v) => {
          first.push(v);
          return null;
        }}
      </VolumeProvider>,
    );
    const two = await mount(
      <>
        <VolumeProvider fileName={fileName} worker={factory.create}>
          {(v) => {
            second.push(v);
            return null;
          }}
        </VolumeProvider>
        <VolumeProvider name="alias" fileName={fileName} worker={factory.create}>
          {(v) => {
            second.push(v);
            return null;
          }}
        </VolumeProvider>
      </>,
    );
    try {
      await waitFor(() => first.at(-1)?.status === 'ready' && first.at(-1)?.generation === second.at(-1)?.generation);
      expect(factory.count).toBe(1);
    } finally {
      await closeManaged(first, second);
      await cleanup(fileName, [one, two], []);
    }
  });

  it('shares compatible aliases despite different opaque plugin options', async () => {
    const fileName = volumeName();
    const factory = countingWorker();
    const first: any[] = [];
    const second: any[] = [];
    const errors: Error[] = [];
    const owner = await mount(
      <VolumeProvider fileName={fileName} worker={factory.create} plugins={[testLockRequest('right')]}>
        {(v) => {
          first.push(v);
          return null;
        }}
      </VolumeProvider>,
    );
    try {
      await waitFor(() => first.at(-1)?.status === 'ready');
      const generation = first.at(-1)?.generation;
      const alias = await mount(
        <ErrorBoundary onError={(error) => errors.push(error)}>
          <VolumeProvider
            name="alias"
            fileName={fileName}
            worker={factory.create}
            plugins={[testLockRequest('other-secret')]}
          >
            {(v) => {
              second.push(v);
              return null;
            }}
          </VolumeProvider>
        </ErrorBoundary>,
      );
      await waitFor(() => second.at(-1)?.status === 'ready');
      expect(errors).toEqual([]);
      expect(second.at(-1)?.generation).toBe(generation);
      expect(factory.count).toBe(1);
      await alias.unmount();
    } finally {
      await closeManaged(first, second);
      await cleanup(fileName, [owner], []);
    }
  });

  it('classifies a real queued ownership timeout as lifecycle', async () => {
    const fileName = volumeName();
    let releaseLock: (() => void) | undefined;
    const held = navigator.locks.request(
      `opfs-vfs-lock-${fileName}`,
      () =>
        new Promise<void>((resolve) => {
          releaseLock = resolve;
        }),
    );
    await waitFor(() => releaseLock !== undefined);
    const states: any[] = [];
    const app = await mount(
      <VolumeProvider fileName={fileName} worker={worker} options={{ initTimeout: 50 }}>
        {(value) => {
          states.push(value);
          return null;
        }}
      </VolumeProvider>,
    );
    try {
      await act(async () => await waitFor(() => states.at(-1)?.status === 'error'));
      expect(states.at(-1)?.error).toMatchObject({
        kind: 'lifecycle',
        details: { code: 'VFS_INITIALIZATION_TIMEOUT' },
      });
    } finally {
      releaseLock!();
      await held;
      await closeManaged(states);
      await cleanup(fileName, [app], []);
    }
  });

  it('rejects conflicting retained configuration without disturbing the original', async () => {
    const fileName = volumeName();
    const good = countingWorker();
    const seen: any[] = [];
    const owner = await mount(
      <VolumeProvider fileName={fileName} worker={good.create}>
        {(v) => {
          seen.push(v);
          return null;
        }}
      </VolumeProvider>,
    );
    const errors: Error[] = [];
    try {
      await waitFor(() => seen.at(-1)?.status === 'ready');
      const generation = seen.at(-1).generation;
      const rejected = await mount(
        <ErrorBoundary onError={(error) => errors.push(error)}>
          <VolumeProvider fileName={fileName} worker={worker} options={{ bufferMode: 'memory' }}>
            {() => null}
          </VolumeProvider>
        </ErrorBoundary>,
      );
      await waitFor(() => errors.length === 1);
      expect(errors[0]).toMatchObject({ kind: 'configuration', operation: 'configure' });
      expect(seen.at(-1).generation).toBe(generation);
      await rejected.unmount();
    } finally {
      await closeManaged(seen);
      await cleanup(fileName, [owner], []);
    }
  });

  it('accepts equivalent inline construction inputs and ignores alternate factories', async () => {
    const fileName = volumeName();
    const good = countingWorker();
    const alternate = countingWorker();
    const renders: any[] = [];
    const make = (tick: number) => (
      <VolumeProvider fileName={fileName} worker={() => good.create()} options={{ initTimeout: 2_000, debug: false }}>
        {(v) => {
          renders.push({ tick, value: v });
          return null;
        }}
      </VolumeProvider>
    );
    const app = await mount(make(1));
    try {
      await waitFor(() => renders.at(-1)?.value.status === 'ready');
      await app.render(make(2));
      const alias = await mount(
        <VolumeProvider name="alias" fileName={fileName} worker={alternate.create} options={{ initTimeout: 2_000 }}>
          {() => null}
        </VolumeProvider>,
      );
      await waitFor(() => good.count === 1);
      expect(alternate.count).toBe(0);
      await alias.unmount();
    } finally {
      await closeManaged(renders.map((entry) => entry.value));
      await cleanup(fileName, [app], []);
    }
  });

  it('normalizes core defaults before comparing managed configurations', async () => {
    const fileName = volumeName();
    const factory = countingWorker();
    const first: any[] = [];
    const second: any[] = [];
    const app = await mount(
      <VolumeProvider fileName={fileName} worker={factory.create}>
        {(v) => {
          first.push(v);
          return null;
        }}
      </VolumeProvider>,
    );
    try {
      await waitFor(() => first.at(-1)?.status === 'ready');
      const alias = await mount(
        <VolumeProvider
          name="defaults"
          fileName={fileName}
          worker={factory.create}
          options={{ sabSize: 4 * 1024 * 1024, initTimeout: 0, maxFileSize: 0x100000000, maxNameLength: 255 }}
        >
          {(v) => {
            second.push(v);
            return null;
          }}
        </VolumeProvider>,
      );
      await waitFor(() => second.at(-1)?.status === 'ready');
      expect(second.at(-1)?.generation).toBe(first.at(-1)?.generation);
      expect(factory.count).toBe(1);
      await alias.unmount();
    } finally {
      await closeManaged(first, second);
      await cleanup(fileName, [app], []);
    }
  });

  it('uses the render-time options snapshot after caller mutation', async () => {
    const fileName = volumeName();
    const factory = countingWorker();
    const options: { bufferMode?: 'memory' } = {};
    const first: any[] = [];
    const second: any[] = [];
    const errors: Error[] = [];
    function Mutate() {
      useLayoutEffect(() => {
        options.bufferMode = 'memory';
      }, []);
      return null;
    }
    const app = await mount(
      <ErrorBoundary onError={(error) => errors.push(error)}>
        <VolumeProvider fileName={fileName} worker={factory.create} options={options}>
          {(v) => {
            first.push(v);
            return <Mutate />;
          }}
        </VolumeProvider>
      </ErrorBoundary>,
    );
    try {
      // The mutated object is a changed identity on the next render; the entry keeps the committed snapshot.
      await waitFor(() => errors.length === 1);
      expect(errors[0]).toMatchObject({ kind: 'configuration', operation: 'configure' });
      const alias = await mount(
        <VolumeProvider name="same" fileName={fileName} worker={factory.create}>
          {(v) => {
            second.push(v);
            return null;
          }}
        </VolumeProvider>,
      );
      await waitFor(() => second.at(-1)?.status === 'ready');
      expect(factory.count).toBe(1);
      await alias.unmount();
    } finally {
      await closeManaged(first, second);
      await cleanup(fileName, [app], []);
    }
  });

  it('requires a keyed remount for changed identity and retains compatible clients', async () => {
    const fileName = volumeName();
    const factory = countingWorker();
    const seen: any[] = [];
    const errors: Error[] = [];
    const app = await mount(
      <ErrorBoundary onError={(error) => errors.push(error)}>
        <VolumeProvider key="one" fileName={fileName} worker={factory.create}>
          {(v) => {
            seen.push(v);
            return null;
          }}
        </VolumeProvider>
      </ErrorBoundary>,
    );
    try {
      await waitFor(() => seen.at(-1)?.status === 'ready');
      const generation = seen.at(-1).generation;
      await app.render(
        <ErrorBoundary onError={(error) => errors.push(error)}>
          <VolumeProvider key="one" fileName={volumeName()} worker={factory.create}>
            {() => null}
          </VolumeProvider>
        </ErrorBoundary>,
      );
      await waitFor(() => errors.length === 1);
      expect(errors[0]).toMatchObject({ kind: 'configuration' });
      await app.render(
        <VolumeProvider key="two" fileName={fileName} worker={factory.create}>
          {(v) => {
            seen.push(v);
            return null;
          }}
        </VolumeProvider>,
      );
      await waitFor(() => seen.at(-1)?.generation === generation);
      expect(factory.count).toBe(1);
    } finally {
      await closeManaged(seen);
      await cleanup(fileName, [app], []);
    }
  });

  it('rejects invalid input before constructing a worker', async () => {
    const fileName = volumeName();
    const factory = countingWorker();
    const configurationErrors: Error[] = [];
    const invalid: Record<string, unknown>[] = [
      { fileName, worker: factory.create, options: { unknown: true } },
      { fileName, worker: factory.create, options: { attachTo: 'x' } },
      { fileName, worker: factory.create, options: { sabSize: -65 } },
      { fileName, worker: factory.create, options: { sabSize: 1 } },
      { fileName, worker: factory.create, options: { bufferMode: 'ram' } },
      { fileName, worker: factory.create, options: { initTimeout: 1.5 } },
      { fileName, worker: factory.create, options: { claimIfAvailable: true } },
      {
        fileName,
        worker: factory.create,
        options: { claimIfAvailable: true, openMode: 'open-existing', forceLeader: true },
      },
      { fileName, worker: 'not a function' },
      { fileName: 'no-bin', worker: factory.create },
      { fileName: 'bad/name.bin', worker: factory.create },
      { fileName: '', worker: factory.create },
      { fileName, worker: factory.create, plugins: [subscriptionsRequest(), subscriptionsRequest()] },
      { fileName, worker: factory.create, plugins: [{ ...subscriptionsRequest(), compatibilityKey: 'wrong' }] },
      {
        fileName,
        worker: factory.create,
        plugins: [
          subscriptionsRequest(),
          { id: 'duplicate', contractVersion: 1, compatibilityKey: 'x', options: {} },
          { id: 'duplicate', contractVersion: 1, compatibilityKey: 'x', options: {} },
        ],
      },
      {
        fileName,
        worker: factory.create,
        plugins: [{ id: 'bad_id', contractVersion: 1, compatibilityKey: 'x', options: {} }],
      },
      { fileName, worker: factory.create, plugins: [{ id: 'valid', contractVersion: 1, compatibilityKey: 'x' }] },
      {
        fileName,
        worker: factory.create,
        plugins: [{ id: 'valid', contractVersion: 1, compatibilityKey: 'x', options: {}, extra: true }],
      },
      {
        fileName,
        worker: factory.create,
        plugins: [
          { id: 'valid', contractVersion: 1, compatibilityKey: 'x', requiredOpenMode: 'create-new', options: {} },
        ],
      },
      {
        fileName,
        worker: factory.create,
        plugins: [
          { id: 'one', contractVersion: 1, compatibilityKey: 'x', options: {} },
          { id: 'two', contractVersion: 1, compatibilityKey: 'x', options: {} },
          { id: 'three', contractVersion: 1, compatibilityKey: 'x', options: {} },
        ],
      },
      { fileName, worker: factory.create, client: {} },
      { fileName, worker: factory.create, name: '' },
      { fileName, worker: factory.create, name: Symbol() },
      { fileName, worker: factory.create, persistentStorage: 'always' },
    ];
    for (const props of invalid) {
      const errors: Error[] = [];
      const app = await mount(
        <ErrorBoundary onError={(error) => errors.push(error)}>
          <VolumeProvider {...(props as any)}>{() => null}</VolumeProvider>
        </ErrorBoundary>,
      );
      await waitFor(() => errors.length === 1);
      expect(errors[0]).toMatchObject({ kind: 'configuration' });
      configurationErrors.push(...errors);
      await app.unmount();
    }
    for (const error of configurationErrors) {
      expect(error.message).not.toContain('right');
      expect(error.message).not.toContain('wrong');
      expect(error.message).not.toContain('-65');
      expect(error.message).not.toContain('ram');
    }
    expect(factory.count).toBe(0);
    await deleteVolume(fileName).catch(() => {});
  });

  it('publishes unsupported without retaining an entry and opens after a keyed remount', async () => {
    const fileName = volumeName();
    const factory = countingWorker();
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crossOriginIsolated');
    const seen: any[] = [];
    const results: any[] = [];
    try {
      Object.defineProperty(globalThis, 'crossOriginIsolated', { configurable: true, value: false });
      const app = await mount(
        <VolumeProvider key="unsupported" fileName={fileName} worker={factory.create}>
          {(v) => {
            results.push(v);
            seen.push(v);
            return null;
          }}
        </VolumeProvider>,
      );
      await waitFor(() => seen.at(-1)?.status === 'unsupported');
      expect(seen.at(-1)).toMatchObject({ status: 'unsupported', error: { kind: 'unsupported' } });
      expect(seen.at(-1).close()).toBe(seen.at(-1).close());
      expect(seen.at(-1)?.missingCapabilities).toContain('cross-origin-isolation');
      expect(factory.count).toBe(0);
      if (original) Object.defineProperty(globalThis, 'crossOriginIsolated', original);
      else delete (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
      await app.render(
        <VolumeProvider key="ready" fileName={fileName} worker={factory.create}>
          {(v) => {
            results.push(v);
            seen.push(v);
            return null;
          }}
        </VolumeProvider>,
      );
      await waitFor(() => seen.at(-1)?.status === 'ready');
      await closeManaged(results);
      await app.unmount();
    } finally {
      if (original) Object.defineProperty(globalThis, 'crossOriginIsolated', original);
      await deleteVolume(fileName).catch(() => {});
    }
  });

  it('constructs once in Strict Mode and does not construct abandoned renders', async () => {
    const fileName = volumeName();
    const abandonedName = volumeName();
    const factory = countingWorker();
    const seen: object[] = [];
    const results: any[] = [];
    const app = await mount(
      <VolumeProvider fileName={fileName} worker={factory.create}>
        {(v) => {
          results.push(v);
          if (v.status === 'ready') seen.push(v);
          return null;
        }}
      </VolumeProvider>,
      true,
    );
    const errors: Error[] = [];
    const abandoned = await mount(
      <ErrorBoundary onError={(error) => errors.push(error)}>
        <VolumeProvider fileName={abandonedName} worker={factory.create}>
          <Throw />
        </VolumeProvider>
      </ErrorBoundary>,
    );
    const reopened: any[] = [];
    let retry: Awaited<ReturnType<typeof mount>> | undefined;
    try {
      await waitFor(() => seen.length > 0 && errors.length === 1);
      await app.render(
        <VolumeProvider fileName={fileName} worker={factory.create}>
          {(v) => {
            results.push(v);
            if (v.status === 'ready') seen.push(v);
            return null;
          }}
        </VolumeProvider>,
      );
      expect(factory.count).toBe(1);
      expect(seen.at(-1)).toBe(seen[0]);
      retry = await mount(
        <VolumeProvider fileName={abandonedName} worker={factory.create} options={{ bufferMode: 'memory' }}>
          {(v) => {
            reopened.push(v);
            return null;
          }}
        </VolumeProvider>,
      );
      await waitFor(() => reopened.at(-1)?.status === 'ready');
      expect(factory.count).toBe(2);
    } finally {
      await closeManaged(results, reopened);
      await cleanup(fileName, [app, abandoned], []);
      if (retry) await cleanup(abandonedName, [retry], []);
    }
  });

  it('retries locked aliases from the first visible error without duplicate reports', async () => {
    const fileName = volumeName();
    const factory = countingWorker();
    const reports: { alias: string; error: VolumeError }[] = [];
    const states: Record<string, string[]> = { one: [], two: [], retry: [] };
    const results: any[] = [];
    let app: Awaited<ReturnType<typeof mount>>;
    let retried = false;
    const retry = (
      <VolumeProvider
        key="right"
        fileName={fileName}
        worker={factory.create}
        plugins={[testLockRequest('right')]}
        options={{ initTimeout: 2_000 }}
      >
        {(v) => {
          results.push(v);
          states.retry.push(v.status);
          return null;
        }}
      </VolumeProvider>
    );
    const report = (alias: 'one' | 'two') => (error: VolumeError) => {
      reports.push({ alias, error });
      if (!retried) {
        retried = true;
        // Remount synchronously, effects included, while the failure is being published.
        flushSync(() => app.root.render(<StrictMode>{retry}</StrictMode>));
      }
    };
    const wrong = (
      <>
        <VolumeProvider
          name="one"
          fileName={fileName}
          worker={factory.create}
          plugins={[testLockRequest('wrong')]}
          options={{ initTimeout: 2_000 }}
          onError={report('one')}
        >
          {(v) => {
            results.push(v);
            states.one.push(v.status);
            return null;
          }}
        </VolumeProvider>
        <VolumeProvider
          name="two"
          fileName={fileName}
          worker={factory.create}
          plugins={[testLockRequest('wrong')]}
          options={{ initTimeout: 2_000 }}
          onError={report('two')}
        >
          {(v) => {
            results.push(v);
            states.two.push(v.status);
            return null;
          }}
        </VolumeProvider>
      </>
    );
    app = await mount(<div key="wrong">{wrong}</div>, true);
    try {
      await waitFor(() => reports.length === 2);
      await waitFor(() => states.retry.at(-1) === 'ready');
      expect(reports.map(({ alias }) => alias)).toEqual(expect.arrayContaining(['one', 'two']));
      expect(reports.filter(({ alias }) => alias === 'one')).toHaveLength(1);
      expect(reports.filter(({ alias }) => alias === 'two')).toHaveLength(1);
      expect(reports[0].error).toMatchObject({
        kind: 'encryption',
        details: { code: 'EVOLUMELOCKED' },
        volume: fileName,
      });
      expect(factory.count).toBe(2);
      expect([...new Set(states.retry)]).toEqual(['pending', 'ready']);
    } finally {
      await closeManaged(results);
      await cleanup(fileName, [app], []);
    }
  });

  it('updates every alias before running lifecycle error reporters', async () => {
    const fileName = volumeName();
    const factory = countingWorker();
    const bindings: { one?: ReturnType<typeof useVolumeBinding>; two?: ReturnType<typeof useVolumeBinding> } = {};
    const snapshotsAtReport: string[][] = [];
    const results: any[] = [];
    function CaptureBindings() {
      bindings.one = useVolumeBinding('one');
      bindings.two = useVolumeBinding('two');
      return null;
    }
    const report = () =>
      snapshotsAtReport.push([bindings.one!.getSnapshot().status, bindings.two!.getSnapshot().status]);
    const app = await mount(
      <VolumeProvider
        name="two"
        fileName={fileName}
        worker={factory.create}
        plugins={[testLockRequest('wrong')]}
        options={{ initTimeout: 2_000 }}
        onError={report}
      >
        {(two) => {
          results.push(two);
          return (
            <VolumeProvider
              name="one"
              fileName={fileName}
              worker={factory.create}
              plugins={[testLockRequest('wrong')]}
              options={{ initTimeout: 2_000 }}
              onError={report}
            >
              {(one) => {
                results.push(one);
                return <CaptureBindings />;
              }}
            </VolumeProvider>
          );
        }}
      </VolumeProvider>,
    );
    try {
      await waitFor(() => snapshotsAtReport.length === 2);
      expect(snapshotsAtReport).toEqual([
        ['error', 'error'],
        ['error', 'error'],
      ]);
    } finally {
      await closeManaged(results);
      await cleanup(fileName, [app], []);
    }
  });

  it('surfaces an incompatible raw owner before timeout, then allows fresh ownership', async () => {
    const fileName = volumeName();
    const raw = new OpfsVfsWorker(fileName, { worker: bareWorker, initTimeout: 4_000 });
    const states: { status: string; error?: VolumeError | null }[] = [];
    const results: any[] = [];
    await raw.ready;
    const app = await mount(
      <VolumeProvider fileName={fileName} worker={worker} options={{ initTimeout: 4_000 }}>
        {(v) => {
          results.push(v);
          states.push({ status: v.status, error: v.error });
          return null;
        }}
      </VolumeProvider>,
    );
    try {
      await waitFor(() => states.at(-1)?.status === 'error', 'plugin mismatch', 2_000);
      expect(states.at(-1)?.error).toMatchObject({ kind: 'lifecycle', details: { code: 'VFS_PLUGIN_MISMATCH' } });
      await raw.closeVfs();
      await app.render(
        <VolumeProvider key="fresh" fileName={fileName} worker={worker} options={{ initTimeout: 4_000 }}>
          {(v) => {
            results.push(v);
            states.push({ status: v.status, error: v.error });
            return null;
          }}
        </VolumeProvider>,
      );
      await waitFor(() => states.at(-1)?.status === 'ready');
    } finally {
      await closeManaged(results);
      await cleanup(fileName, [app], [raw]);
    }
  });

  it('evicts a follower whose takeover fails and allows corrected credentials', async () => {
    const fileName = volumeName();
    const raw = new OpfsVfsWorker(fileName, {
      worker,
      plugins: [subscriptionsRequest(), testLockRequest('right')],
      initTimeout: 3_000,
    });
    const factory = countingWorker();
    const states: { status: string; error: VolumeError | null }[] = [];
    const reports: VolumeError[] = [];
    const results: any[] = [];
    await raw.ready;
    const app = await mount(
      <VolumeProvider
        key="wrong"
        fileName={fileName}
        worker={factory.create}
        plugins={[testLockRequest('wrong')]}
        options={{ initTimeout: 3_000 }}
        onError={(error) => reports.push(error)}
      >
        {(v) => {
          results.push(v);
          states.push({ status: v.status, error: v.error });
          return null;
        }}
      </VolumeProvider>,
    );
    try {
      await waitFor(() => states.at(-1)?.status === 'ready');
      await raw.closeVfs();
      await waitFor(() => states.at(-1)?.status === 'error');
      expect(states.at(-1)?.error).toMatchObject({ kind: 'encryption', details: { code: 'EVOLUMELOCKED' } });
      expect(results.at(-1).close()).toBe(results.at(-1).close());
      expect(reports).toHaveLength(1);
      await app.render(
        <VolumeProvider
          key="right"
          fileName={fileName}
          worker={factory.create}
          plugins={[testLockRequest('right')]}
          options={{ initTimeout: 3_000 }}
        >
          {(v) => {
            results.push(v);
            states.push({ status: v.status, error: v.error });
            return null;
          }}
        </VolumeProvider>,
      );
      await waitFor(() => states.at(-1)?.status === 'ready');
      expect(factory.count).toBe(2);
    } finally {
      await closeManaged(results);
      await cleanup(fileName, [app], [raw]);
    }
  });
});

function Throw(): never {
  throw new Error('abandoned render');
}
