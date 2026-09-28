import { act, useLayoutEffect, useRef } from 'react';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { VolumeError, VolumeProvider, useVolumeClient } from '../index';
import { useVolumeBinding, VolumeBinding } from '../volume';
import { bounded, closeManaged, cleanup, countingWorker, mount, volumeName, waitFor } from './harness';

const Activity = (
  React as { Activity?: React.ComponentType<{ mode: 'visible' | 'hidden'; children?: React.ReactNode }> }
).Activity;

function Client({ seen }: { seen: unknown[] }) {
  seen.push(useVolumeClient());
  return null;
}

function CloseOnLayout({ close }: { close: () => Promise<void> }) {
  const closed = useRef(false);
  useLayoutEffect(() => {
    // Close once, before the provider's first attach; later snapshots carry other close functions.
    if (closed.current) return;
    closed.current = true;
    void close();
  }, [close]);
  return null;
}

function Probe({ into }: { into: { binding?: VolumeBinding } }) {
  into.binding = useVolumeBinding();
  return null;
}

describe('managed close', () => {
  it('consumes a pre-attach input after close', () => {
    const binding = new VolumeBinding('managed', 'test', 'test.bin');
    const pending = binding.getSnapshot();
    if (pending.ownership !== 'managed') throw new Error('expected a managed binding');
    const close = pending.close();
    expect(pending.close()).toBe(close);
    expect(binding.getSnapshot()).toMatchObject({ status: 'closed' });
    const sentinel = {
      kind: 'managed' as const,
      identity: 'sentinel',
      fileName: 'sentinel.bin',
      worker: () => {
        throw new Error('input should be discarded');
      },
      plugins: [],
      options: {},
      transport: 'auto' as const,
    };
    const holder: Parameters<VolumeBinding['attach']>[0] = { input: sentinel };
    const detach = binding.attach(holder);
    expect(holder.input).toBeNull();
    expect(detach).toEqual(expect.any(Function));
    detach();
  });

  it('does not acquire a volume closed by a child layout effect before attach', async () => {
    const fileName = volumeName();
    const factory = countingWorker();
    const closed: any[] = [];
    const fresh: any[] = [];
    const app = await mount(
      <VolumeProvider fileName={fileName} worker={factory.create}>
        {(v) => {
          closed.push(v);
          return v.ownership === 'managed' ? <CloseOnLayout close={v.close} /> : null;
        }}
      </VolumeProvider>,
    );
    let alias: Awaited<ReturnType<typeof mount>> | undefined;
    try {
      await waitFor(() => closed.at(-1)?.status === 'closed');
      // No entry was reserved: a different configuration for the same basename opens without a conflict.
      alias = await mount(
        <VolumeProvider name="fresh" fileName={fileName} worker={factory.create} options={{ bufferMode: 'memory' }}>
          {(v) => {
            fresh.push(v);
            return null;
          }}
        </VolumeProvider>,
      );
      await waitFor(() => fresh.at(-1)?.status === 'ready');
      expect(closed.map((v) => v.status)).not.toContain('ready');
      const close = closed.at(-1).close();
      expect(closed.at(-1).close()).toBe(close);
      await close;
      expect(closed.at(-1)).toMatchObject({ status: 'closed', isClosing: false, error: null });
      expect(factory.count).toBe(1);
    } finally {
      await closeManaged(closed, fresh);
      await cleanup(fileName, [app, ...(alias ? [alias] : [])], []);
    }
  });

  it('aborts a pending shared-worker probe without publishing a late error', async () => {
    const fileName = volumeName();
    const factory = countingWorker();
    const ports: MessagePort[] = [];
    const states: any[] = [];
    const app = await mount(
      <VolumeProvider
        fileName={fileName}
        worker={factory.create}
        transport="shared-worker"
        sharedWorker={() => {
          const channel = new MessageChannel();
          ports.push(channel.port2);
          return { port: channel.port1, onerror: null };
        }}
      >
        {(value) => {
          states.push(value);
          return null;
        }}
      </VolumeProvider>,
    );
    try {
      await waitFor(() => states.length > 0);
      await bounded(states.at(-1).close(), 'aborted shared-worker close');
      expect(states.at(-1)).toMatchObject({ status: 'closed', isClosing: false, error: null });
    } finally {
      ports.forEach((port) => port.close());
      await cleanup(fileName, [app], []);
    }
  });

  it('reports a failed shared-worker probe without spawning a dedicated worker', async () => {
    const fileName = volumeName();
    const factory = countingWorker();
    const ports: MessagePort[] = [];
    const states: any[] = [];
    const app = await mount(
      <VolumeProvider
        fileName={fileName}
        worker={factory.create}
        transport="shared-worker"
        sharedWorker={() => {
          const channel = new MessageChannel();
          const endpoint: { port: MessagePort; onerror: ((event: ErrorEvent) => unknown) | null } = {
            port: channel.port1,
            onerror: null,
          };
          ports.push(channel.port2);
          queueMicrotask(() => endpoint.onerror?.(new ErrorEvent('error')));
          return endpoint;
        }}
      >
        {(value) => {
          states.push(value);
          return null;
        }}
      </VolumeProvider>,
    );
    try {
      await waitFor(() => states.at(-1)?.status === 'error');
      expect(states.at(-1)).toMatchObject({
        transport: 'shared-worker',
        error: { kind: 'lifecycle', details: { code: 'VFS_WORKER_FAILED' } },
      });
      expect(factory.count).toBe(0);
    } finally {
      ports.forEach((port) => port.close());
      await cleanup(fileName, [app], []);
    }
  });

  it('immediately closes every alias, shares the close promise, and invalidates handles', async () => {
    const fileName = volumeName();
    const factory = countingWorker();
    const first: any[] = [];
    const second: any[] = [];
    const clients: unknown[] = [];
    const app = await mount(
      <>
        <VolumeProvider fileName={fileName} worker={factory.create}>
          {(v) => {
            first.push(v);
            return <Client seen={clients} />;
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
      await waitFor(() => first.at(-1)?.status === 'ready' && second.at(-1)?.status === 'ready');
      const handle = clients.at(-1) as { stat(path: string): Promise<unknown> };
      let close!: Promise<void>;
      act(() => {
        close = first.at(-1).close();
      });
      expect(first.at(-1)).toMatchObject({ status: 'closed', isClosing: true });
      expect(second.at(-1)).toMatchObject({ status: 'closed', isClosing: true });
      expect(clients.at(-1)).toBeNull();
      expect(first.at(-1).close()).toBe(close);
      await close;
      expect(first.at(-1)).toMatchObject({
        status: 'closed',
        isClosing: false,
        error: null,
        transport: 'dedicated',
        fallbackReason: 'shared-worker-factory-unavailable',
      });
      await expect(handle.stat('/')).rejects.toMatchObject({ outcome: 'not-applied' });
    } finally {
      await cleanup(fileName, [app], []);
    }
  });

  it('keeps closed aliases tombstoned and opens a new keyed lifetime after close', async () => {
    const fileName = volumeName();
    const factory = countingWorker();
    const old: any[] = [];
    const fresh: any[] = [];
    const probe: { binding?: VolumeBinding } = {};
    const tree = (mode: 'visible' | 'hidden', includeFresh = false) => {
      const oldProvider = (
        <VolumeProvider fileName={fileName} worker={factory.create}>
          {(v) => {
            old.push(v);
            return <Probe into={probe} />;
          }}
        </VolumeProvider>
      );
      return (
        <>
          {Activity ? <Activity mode={mode}>{oldProvider}</Activity> : oldProvider}
          {includeFresh && (
            <VolumeProvider key="fresh" name="fresh" fileName={fileName} worker={factory.create}>
              {(v) => {
                fresh.push(v);
                return null;
              }}
            </VolumeProvider>
          )}
        </>
      );
    };
    const app = await mount(tree('visible'));
    try {
      await waitFor(() => old.at(-1)?.status === 'ready');
      const generation = old.at(-1).generation;
      await old.at(-1).close();
      await app.render(tree('visible', true));
      await waitFor(() => fresh.at(-1)?.status === 'ready');
      expect(factory.count).toBe(2);
      expect(fresh.at(-1).generation).not.toBe(generation);
      expect(old.at(-1).status).toBe('closed');
      if (Activity) {
        await app.render(tree('hidden', true));
        await app.render(tree('visible', true));
        // A negative check: give a wrongly re-bound tombstone time to publish the fresh entry.
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(old.at(-1)).toMatchObject({ status: 'closed', generation: null });
      expect(probe.binding?.getSnapshot()).toMatchObject({ status: 'closed', generation: null });
      expect(old.at(-1).generation).not.toBe(fresh.at(-1).generation);
    } finally {
      await closeManaged(old, fresh);
      await cleanup(fileName, [app], []);
    }
  });

  it('binds a provider mounted during close to the closed outcome regardless of configuration', async () => {
    const fileName = volumeName();
    const factory = countingWorker();
    const first: any[] = [];
    const during: any[] = [];
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
      const closing = first.at(-1).close();
      await app.render(
        <>
          <VolumeProvider fileName={fileName} worker={factory.create}>
            {(v) => {
              first.push(v);
              return null;
            }}
          </VolumeProvider>
          <VolumeProvider name="during" fileName={fileName} worker={factory.create} options={{ bufferMode: 'memory' }}>
            {(v) => {
              during.push(v);
              return null;
            }}
          </VolumeProvider>
        </>,
      );
      expect(during.at(-1)).toMatchObject({ status: 'closed', isClosing: true });
      await closing;
      expect(during.at(-1)).toMatchObject({ status: 'closed', isClosing: false });
      expect(factory.count).toBe(1);
    } finally {
      await cleanup(fileName, [app], []);
    }
  });

  it('retains and reports a close flush error, then evicts the entry', async () => {
    const fileName = volumeName();
    const factory = countingWorker();
    const seen: any[] = [];
    const reports: VolumeError[] = [];
    const fresh: any[] = [];
    const app = await mount(
      <VolumeProvider fileName={fileName} worker={factory.create} onError={(error) => reports.push(error)}>
        {(v) => {
          seen.push(v);
          return null;
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
      if (typed.type === 'CLOSE_VFS')
        this.dispatchEvent(
          new MessageEvent('message', {
            data: { id: typed.id, type: 'ERROR', result: { error: 'flush failed', code: 'EIO' } },
          }),
        );
      else original.call(this, message, options as StructuredSerializeOptions);
    });
    try {
      await waitFor(() => seen.at(-1)?.status === 'ready');
      await expect(seen.at(-1).close()).rejects.toMatchObject({ operation: 'close', details: { code: 'EIO' } });
      expect(seen.at(-1)).toMatchObject({ status: 'closed', error: { details: { code: 'EIO' } } });
      expect(reports).toHaveLength(1);
      await app.render(
        <VolumeProvider key="fresh" fileName={fileName} worker={factory.create}>
          {(v) => {
            fresh.push(v);
            return null;
          }}
        </VolumeProvider>,
      );
      await waitFor(() => factory.count === 2);
    } finally {
      post.mockRestore();
      await closeManaged(seen, fresh);
      await cleanup(fileName, [app], []);
    }
  });
});
