import { act, StrictMode } from 'react';
import { renderToString } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { ClientStatus, OpfsVfsWorker } from '@opfs-vfs/opfs-vfs/worker';
import { VolumeProvider, usePersistentStorage, type PersistentStorageResult } from '../index';
import { requestPersistentStorageOnMount } from '../persistence';
import { mount, waitFor } from './harness';

function storage(value: Pick<StorageManager, 'persisted' | 'persist'>) {
  const previous = Object.getOwnPropertyDescriptor(navigator, 'storage');
  Object.defineProperty(navigator, 'storage', { configurable: true, value });
  return () => {
    if (previous) Object.defineProperty(navigator, 'storage', previous);
    else delete (navigator as unknown as { storage?: StorageManager }).storage;
  };
}

const opening = Object.freeze<ClientStatus>({
  fileName: 'persistent-storage-test.bin',
  transport: 'dedicated',
  fallbackReason: null,
  state: 'opening',
  role: null,
  ownerGeneration: null,
  error: null,
  persistence: null,
});
const client = {
  getStatus: () => opening,
  subscribeStatus: () => () => {},
  forGeneration: () => ({}),
} as unknown as OpfsVfsWorker;

function Probe({ seen }: { seen: PersistentStorageResult[] }) {
  const value = usePersistentStorage();
  seen.push(value);
  return <p data-status={value.status}>{value.status}</p>;
}

async function waitForStatus(seen: readonly PersistentStorageResult[], status: PersistentStorageResult['status']) {
  await act(async () => {
    await waitFor(() => seen.at(-1)?.status === status);
  });
}

it('checks after commit, shares manual and automatic work, and keeps grant errors separate from volumes', async () => {
  let resolveInitial!: (value: boolean) => void;
  const persistResolvers: ((value: boolean) => void)[] = [];
  const persisted = vi
    .fn()
    .mockImplementationOnce(() => new Promise<boolean>((resolve) => (resolveInitial = resolve)))
    .mockResolvedValue(false);
  const persist = vi.fn(() => new Promise<boolean>((resolve) => persistResolvers.push(resolve)));
  const restore = storage({ persisted, persist });
  const seen: PersistentStorageResult[] = [];
  let probe: Awaited<ReturnType<typeof mount>> | undefined;
  let providers: Awaited<ReturnType<typeof mount>> | undefined;
  try {
    expect(renderToString(<Probe seen={seen} />)).toContain('checking');
    expect(persisted).not.toHaveBeenCalled();

    probe = await mount(<Probe seen={seen} />);
    await waitFor(() => persisted.mock.calls.length === 1);
    expect(seen.at(-1)?.status).toBe('checking');

    let first!: Promise<void>;
    await act(async () => {
      resolveInitial(false);
      await new Promise<void>((resolve) => {
        queueMicrotask(() => {
          first = seen.at(-1)!.request();
          resolve();
        });
      });
      await waitFor(() => seen.at(-1)?.status === 'requesting');
    });
    expect(persisted).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenCalledTimes(1);

    let second!: Promise<void>;
    await act(async () => {
      persistResolvers[0](false);
      await new Promise<void>((resolve) => {
        queueMicrotask(() => {
          second = seen.at(-1)!.request();
          resolve();
        });
      });
      await waitFor(() => seen.at(-1)?.status === 'requesting');
    });
    expect(persist).toHaveBeenCalledTimes(2);

    await act(async () => {
      persistResolvers[1](false);
      await new Promise<void>((resolve) => {
        queueMicrotask(() => {
          requestPersistentStorageOnMount();
          resolve();
        });
      });
      await waitFor(() => seen.at(-1)?.status === 'requesting');
    });
    expect(persist).toHaveBeenCalledTimes(3);

    await act(async () => {
      persistResolvers[2](true);
      await Promise.all([first, second]);
    });
    await waitForStatus(seen, 'granted');

    providers = await mount(
      <StrictMode>
        <VolumeProvider client={client} persistentStorage="request-on-mount">
          {null}
        </VolumeProvider>
        <VolumeProvider name="other" client={client} persistentStorage="request-on-mount">
          {null}
        </VolumeProvider>
      </StrictMode>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(persist).toHaveBeenCalledTimes(3);

    persist.mockRejectedValueOnce(new Error('browser rejected request'));
    await act(async () => {
      await seen.at(-1)!.request();
    });
    await waitForStatus(seen, 'error');
    expect(seen.at(-1)?.error?.message).toBe('browser rejected request');

    persist.mockResolvedValueOnce(true);
    await act(async () => {
      await seen.at(-1)!.request();
    });
    await waitForStatus(seen, 'granted');
    expect(persist).toHaveBeenCalledTimes(5);

    const unavailable = storage({ persisted: undefined as never, persist: undefined as never });
    try {
      let unavailableSecond!: Promise<void>;
      await act(async () => {
        const unavailableFirst = seen.at(-1)!.request();
        unavailableSecond = seen.at(-1)!.request();
        expect(unavailableSecond).toBe(unavailableFirst);
        await unavailableFirst;
      });
      await waitForStatus(seen, 'unsupported');
    } finally {
      unavailable();
    }
  } finally {
    await providers?.unmount();
    await probe?.unmount();
    restore();
  }
});
