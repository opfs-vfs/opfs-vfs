import { useEffect, useRef, useState } from 'react';
import type { OpfsVfsWorker } from '@opfs-vfs/opfs-vfs/worker';
import type { DevtoolsOptions } from '@opfs-vfs/devtools';

export default function DevtoolsDemo({
  volumePrefix = 'devtools-demo',
  initialDock = 'floating',
}: {
  volumePrefix?: string;
  initialDock?: DevtoolsOptions['initialDock'];
}) {
  const [notice, setNotice] = useState('Create a demo volume first, then load Volume Explorer and connect to it.');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const mounted = useRef<{ unmount(): void } | undefined>(undefined);
  const owners = useRef<OpfsVfsWorker[]>([]);
  useEffect(
    () => () => {
      mounted.current?.unmount();
      owners.current.forEach((client) => void client.closeVfs());
    },
    [],
  );
  async function load() {
    setBusy(true);
    try {
      await import('@opfs-vfs/devtools/styles.css');
      const { mountDevtools } = await import('@opfs-vfs/devtools');
      mounted.current = mountDevtools({
        initialOpen: true,
        initialDock,
        initialTheme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
      });
      setLoaded(true);
      setNotice('Volume Explorer loaded. Create a demo volume or inspect an existing volume on this website.');
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }
  async function create() {
    setBusy(true);
    try {
      const { OpfsVfsWorker } = await import('@opfs-vfs/opfs-vfs/worker');
      const name = `${volumePrefix}-${Date.now()}.bin`;
      const client = new OpfsVfsWorker(name, { openMode: 'create-new' });
      await client.ready;
      owners.current.push(client);
      await client.writeFileBuffer(
        '/README.md',
        new TextEncoder().encode(
          '# A real browser volume\n\nThis file is stored in OPFS. Enable writes in the panel to edit it.\n\n- Create a folder\n- Copy or rename a file\n- Try `ls` in the terminal\n',
        ),
      );
      await client.writeFileBuffer('/settings.json', new TextEncoder().encode('{ "hello": "OPFS" }\n'));
      await client.flush();
      setNotice(`Created ${name}. The application owns it; connect from the panel. Files persist after reload.`);
    } catch (error) {
      setNotice(String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="devtools-demo">
      <div className="demo-actions">
        <button className="button" disabled={busy} onClick={() => void create()}>
          Create demo volume
        </button>
        <button className="button" disabled={loaded || busy} onClick={() => void load()}>
          {loaded ? 'Volume Explorer loaded' : 'Load Volume Explorer'}
        </button>
      </div>
      <p role="status">{notice}</p>
      <p>
        The panel operates on real browser storage. Writes start disabled for every connection. Choose{' '}
        <strong>Enable writes</strong> below the volume selector to create files and folders or use commands such as{' '}
        <code>mkdir</code>. Closing the panel leaves your application running.
      </p>
    </section>
  );
}
