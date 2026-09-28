import { expect, it } from 'vitest';
import { createSharedWorkerFollower, type OpfsVfsWorker } from '@opfs-vfs/opfs-vfs/worker';
import {
  DEFAULT_VOLUME,
  FileContent,
  type PersistentStorageStatus,
  type VolumeErrorOutcome,
  VolumeProvider,
  useFileContent,
  useFolder,
  usePersistentStorage,
  useVolume,
  useVolumeClient,
} from '../index';

const worker = () => new Worker(new URL('./volume-worker.ts', import.meta.url), { type: 'module' });
const bytes = new Uint8Array();
const unknownVolume: unique symbol = Symbol('another-volume');
const sharedWorker = () => {
  throw new Error('type fixture');
};

async function SharedFollowerIsBorrowable() {
  const client = await createSharedWorkerFollower('react-types-shared.bin', {}, sharedWorker);
  return <VolumeProvider client={client}>{null}</VolumeProvider>;
}

function Checks() {
  const result = useVolume(DEFAULT_VOLUME);
  const client = useVolumeClient();
  const persistentStorage = usePersistentStorage();
  const persistentStatus: PersistentStorageStatus = persistentStorage.status;
  void persistentStatus;
  void persistentStorage.request();
  if (client) {
    const read: Promise<Uint8Array> = client.readFileBuffer('/a');
    void read;
    void client.writeFileBuffer('/a', bytes, { expected: bytes });
    // @ts-expect-error VolumeClient deliberately omits lifecycle and descriptor methods.
    client.closeVfs();
    // @ts-expect-error VolumeClient deliberately omits lifecycle and descriptor methods.
    client.dispose();
    // @ts-expect-error VolumeClient deliberately omits lifecycle and descriptor methods.
    client.open('/a');
  }
  // @ts-expect-error close requires narrowing ownership first.
  result.close();
  if (result.ownership === 'managed') void result.close();
  // @ts-expect-error Only DEFAULT_VOLUME is a permitted symbol selector.
  useVolume(unknownVolume);
  const outcome: VolumeErrorOutcome = 'possibly-applied';
  void outcome;
  const text = useFileContent('/text', { format: 'text' });
  if (text.status === 'success' && text.data !== null) text.data.toUpperCase();
  const bytesResult = useFileContent('/bytes');
  if (bytesResult.status === 'success' && bytesResult.data !== null) void bytesResult.data.byteLength;
  const folder = useFolder('/');
  if (folder.status === 'success' && folder.data[0]) {
    // @ts-expect-error Folder entries are immutable snapshots.
    folder.data[0].name = 'mutated';
  }
  return (
    <>
      <FileContent path="/text" format="text">
        {(content) => {
          if (content.status === 'success' && content.data !== null) void content.data.toUpperCase();
          return null;
        }}
      </FileContent>
      <FileContent path="/bytes">
        {(content) => {
          if (content.status === 'success' && content.data !== null) void content.data.byteLength;
          return null;
        }}
      </FileContent>
    </>
  );
}

function InvalidProps() {
  const client = null as unknown as OpfsVfsWorker;
  // @ts-expect-error A provider is managed or borrowed, never both.
  <VolumeProvider fileName="react-types.bin" worker={worker} client={client}>
    {null}
  </VolumeProvider>;
  <VolumeProvider fileName="react-types.bin">{null}</VolumeProvider>;
  // @ts-expect-error Worker construction options do not accept a worker.
  <VolumeProvider fileName="react-types.bin" worker={worker} options={{ worker }}>
    {null}
  </VolumeProvider>;
  // @ts-expect-error Worker construction options do not accept plugins.
  <VolumeProvider fileName="react-types.bin" worker={worker} options={{ plugins: [] }}>
    {null}
  </VolumeProvider>;
  // @ts-expect-error Worker construction options do not accept attachment control.
  <VolumeProvider fileName="react-types.bin" worker={worker} options={{ attachTo: client }}>
    {null}
  </VolumeProvider>;
  <VolumeProvider name={DEFAULT_VOLUME} fileName="react-types.bin" worker={worker}>
    <Checks />
  </VolumeProvider>;
  <VolumeProvider fileName="react-types-persistent.bin" worker={worker} persistentStorage="request-on-mount">
    {null}
  </VolumeProvider>;
  <VolumeProvider client={client}>
    <Checks />
  </VolumeProvider>;
  // @ts-expect-error A borrowed provider requires the public worker-client shape.
  <VolumeProvider client={{}}>{null}</VolumeProvider>;
  return null;
}

it('type-level consumer contracts compile', () => {
  expect(true).toBe(true);
  void InvalidProps;
  void SharedFollowerIsBorrowable;
});
