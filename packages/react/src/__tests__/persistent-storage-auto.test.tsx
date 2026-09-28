import { act, StrictMode } from 'react';
import { expect, it, vi } from 'vitest';
import type { ClientStatus, OpfsVfsWorker } from '@opfs-vfs/opfs-vfs/worker';
import { VolumeProvider, usePersistentStorage, type PersistentStorageResult } from '../index';
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
  fileName: 'persistent-storage-auto-test.bin',
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
  return null;
}

it('uses its first automatic opportunity to join a manual request and never retries it', async () => {
  let resolvePersist!: (value: boolean) => void;
  const persisted = vi.fn(async () => false);
  const persist = vi.fn(() => new Promise<boolean>((resolve) => (resolvePersist = resolve)));
  const restore = storage({ persisted, persist });
  const seen: PersistentStorageResult[] = [];
  let probe: Awaited<ReturnType<typeof mount>> | undefined;
  let providers: Awaited<ReturnType<typeof mount>> | undefined;
  try {
    probe = await mount(<Probe seen={seen} />);
    await act(async () => {
      await waitFor(() => seen.at(-1)?.status === 'not-granted');
    });

    let manual!: Promise<void>;
    await act(async () => {
      manual = seen.at(-1)!.request();
      await waitFor(() => seen.at(-1)?.status === 'requesting');
    });
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
    expect(persist).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolvePersist(false);
      await manual;
    });
    await act(async () => {
      await waitFor(() => seen.at(-1)?.status === 'not-granted');
    });

    await providers.unmount();
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
    expect(persist).toHaveBeenCalledTimes(1);
  } finally {
    await providers?.unmount();
    await probe?.unmount();
    restore();
  }
});
