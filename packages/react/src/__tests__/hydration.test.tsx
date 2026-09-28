import { act } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { VolumeProvider, type VolumeResult } from '../index';
import { closeManaged, countingWorker, volumeName, waitFor } from './harness';

describe('hydration', () => {
  it('renders pending on the server and hydrates without recoverable errors before opening', async () => {
    const fileName = volumeName();
    const factory = countingWorker();
    const server = renderToString(
      <VolumeProvider fileName={fileName} worker={factory.create}>
        {(v) => <p data-status={v.status}>{v.status}</p>}
      </VolumeProvider>,
    );
    const container = document.createElement('div');
    container.innerHTML = server;
    document.body.append(container);
    const recoverable: unknown[] = [];
    const seen: string[] = [];
    const results: VolumeResult[] = [];
    expect(server).toContain('pending');
    expect(factory.count).toBe(0);
    const root = hydrateRoot(
      container,
      <VolumeProvider fileName={fileName} worker={factory.create}>
        {(v) => {
          seen.push(v.status);
          results.push(v);
          return <p data-status={v.status}>{v.status}</p>;
        }}
      </VolumeProvider>,
      { onRecoverableError: (error) => recoverable.push(error) },
    );
    try {
      await act(async () => {});
      expect(seen[0]).toBe('pending');
      expect(recoverable).toEqual([]);
      await waitFor(() => seen.at(-1) === 'ready');
    } finally {
      await closeManaged(results as never);
      await act(async () => root.unmount());
      container.remove();
      const { deleteVolume } = await import('@opfs-vfs/opfs-vfs');
      await deleteVolume(fileName).catch(() => {});
    }
  });
});
