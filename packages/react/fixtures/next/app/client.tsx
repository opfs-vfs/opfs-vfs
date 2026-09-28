'use client';

import { StrictMode, useEffect, useRef, useState } from 'react';
import { VolumeProvider, useFileContent, useVolume, useVolumeClient } from '@opfs-vfs/react';
import { subscriptionsRequest } from '@opfs-vfs/plugin-subscriptions/config';

const artifact = {
  core: process.env.NEXT_PUBLIC_OPFS_VFS_CORE_ARTIFACT!,
  subscriptions: process.env.NEXT_PUBLIC_OPFS_VFS_SUBSCRIPTIONS_ARTIFACT!,
  react: process.env.NEXT_PUBLIC_OPFS_VFS_REACT_ARTIFACT!,
};
const worker = () => new Worker(new URL('./vfs.worker.ts', import.meta.url), { type: 'module' });
const legacyWorker = () => new Worker('/legacy-worker.js', { type: 'module' });
function Mismatch() {
  const volume = useVolume();
  return <p data-mismatch={volume.error?.details?.code ?? volume.status} />;
}
function Exercise() {
  const volume = useVolume();
  const fs = useVolumeClient();
  const live = useFileContent('/consumer-check.txt', { format: 'text' });
  const ran = useRef(false);
  const [result, setResult] = useState('pending');
  useEffect(() => {
    if (ran.current || volume.status !== 'ready' || !fs) return;
    ran.current = true;
    void (async () => {
      await fs.writeFileBuffer('/consumer-check.txt', new TextEncoder().encode('packed consumer'));
      await fs.sync();
      if (new TextDecoder().decode(await fs.readFileBuffer('/consumer-check.txt')) !== 'packed consumer')
        throw new Error('readback failed');
      setResult('passed');
    })().catch((error) => setResult(`failed: ${error.message}`));
  }, [fs, volume.status]);
  return (
    <p data-consumer={result} data-live={live.status === 'success' ? live.data : ''}>
      {volume.status}
    </p>
  );
}
export default function Client() {
  const [workerArtifact, setWorkerArtifact] = useState<Record<string, string>>({});
  useEffect(() => {
    const probe = worker();
    probe.onmessage = ({ data }) => setWorkerArtifact(data.artifact);
    return () => probe.terminate();
  }, []);
  return (
    <StrictMode>
      <main data-page-artifact={JSON.stringify(artifact)} data-worker-artifact={JSON.stringify(workerArtifact)}>
        <VolumeProvider fileName="packed-next.bin" worker={worker} plugins={[subscriptionsRequest()]}>
          <Exercise />
        </VolumeProvider>
        <VolumeProvider fileName="packed-next-mismatch.bin" worker={legacyWorker} plugins={[subscriptionsRequest()]}>
          <Mismatch />
        </VolumeProvider>
      </main>
    </StrictMode>
  );
}
