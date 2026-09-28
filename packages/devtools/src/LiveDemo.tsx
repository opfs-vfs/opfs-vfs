import { useEffect, useRef, useState } from 'react';
import { OpfsVfsWorker } from '@opfs-vfs/opfs-vfs/worker';
import { DevtoolsSession } from './runtime';
import { DebugPanel } from './DebugPanel';
import { fixtures } from './mock-fixtures';

/** Disposable real-storage harness. The application owns its clients independently of devtools. */
export function LiveDemo() {
  const [session] = useState(() => new DevtoolsSession());
  const clients = useRef<OpfsVfsWorker[]>([]);
  const [notice, setNotice] = useState('Create a test volume, then connect from the panel.');
  useEffect(
    () => () => {
      session.dispose();
      clients.current.forEach((client) => void client.closeVfs());
    },
    [session],
  );
  async function create() {
    try {
      const name = `devtools-test-${Date.now()}.bin`;
      const client = new OpfsVfsWorker(name, { openMode: 'create-new' });
      await client.ready;
      clients.current.push(client);
      const files = fixtures()[0].files;
      for (const file of files.filter((file) => file.kind === 'directory')) await client.mkdir(file.path);
      for (const file of files.filter((file) => file.kind !== 'directory'))
        await client.writeFileBuffer(file.path, file.bytes?.slice() ?? new TextEncoder().encode(file.content), {
          exclusive: true,
        });
      await client.flush();
      setNotice(`Application owns ${name}. This is real OPFS data, retained after reload.`);
    } catch (error) {
      setNotice(String(error));
    }
  }
  return (
    <>
      <main style={{ padding: 32 }}>
        <h1>Real OPFS application</h1>
        <p>
          Each button press creates disposable test data. The volume explorer discovers it without receiving a volume
          reference.
        </p>
        <button onClick={() => void create()}>Create real test volume</button>
        <button
          onClick={async () => {
            await clients.current.pop()?.closeVfs();
            setNotice('Application owner stopped.');
          }}
        >
          Stop latest application owner
        </button>
        <p role="status">{notice}</p>
      </main>
      <DebugPanel runtime={session} initialOpen />
    </>
  );
}
