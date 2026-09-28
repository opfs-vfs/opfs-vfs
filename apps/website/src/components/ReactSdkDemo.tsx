import { deleteVolume } from '@opfs-vfs/opfs-vfs';
import { type GenerationClient, openOpfsVfsWorker } from '@opfs-vfs/opfs-vfs/worker';
import type { OpfsVfsWorkerClient } from '@opfs-vfs/opfs-vfs/worker-client';
import { subscriptionsRequest } from '@opfs-vfs/plugin-subscriptions/config';
import {
  VolumeProvider,
  useFileContent,
  useFolder,
  usePersistentStorage,
  useVolume,
  useVolumeClient,
} from '@opfs-vfs/react';
import { useEffect, useRef, useState } from 'react';
import './react-sdk-demo.css';

const encoder = new TextEncoder();
const dedicatedFirstVolume = 'opfs-vfs-react-dedicated-notes.bin';
const dedicatedSecondVolume = 'opfs-vfs-react-dedicated-ideas.bin';
const sharedFirstVolume = 'opfs-vfs-react-shared-preview-notes.bin';
const sharedSecondVolume = 'opfs-vfs-react-shared-preview-ideas.bin';
const autoFirstVolume = 'opfs-vfs-react-auto-notes.bin';
const autoSecondVolume = 'opfs-vfs-react-auto-ideas.bin';
const notePath = '/note.txt';
type DemoTransport = 'auto' | 'dedicated' | 'shared-worker';

type QueuedSave = {
  readonly fs: GenerationClient;
  readonly generation: string;
  readonly path: string;
  readonly expected: Uint8Array | undefined;
  readonly next: Uint8Array;
};
type EditingBase = {
  readonly generation: string;
  readonly path: string;
  readonly exists: boolean;
  readonly bytes: Uint8Array;
  readonly text: string;
};

function worker() {
  return new Worker(new URL('../workers/react-demo.worker.ts', import.meta.url), { type: 'module' });
}

function sharedWorker(fileName: string) {
  return new SharedWorker(new URL('../workers/react-shared-preview.sharedworker.ts', import.meta.url), {
    type: 'module',
    name: `opfs-vfs-react-shared-preview-${fileName}`,
  });
}

function message(error: unknown) {
  return error instanceof Error ? error.message : 'The volume operation failed.';
}

function PersistenceControl() {
  const persistence = usePersistentStorage();
  const [requesting, setRequesting] = useState(false);
  const ask = async () => {
    setRequesting(true);
    try {
      await persistence.request();
    } finally {
      setRequesting(false);
    }
  };
  return (
    <aside className="react-sdk-persistence" aria-label="Browser storage persistence">
      <strong>Browser storage: {persistence.status}</strong>
      <span>This permission can improve retention. It is separate from synchronizing a write.</span>
      <button type="button" onClick={() => void ask()} disabled={requesting || persistence.status === 'granted'}>
        {requesting ? 'Requesting…' : 'Request persistence'}
      </button>
      {persistence.error && <p role="alert">{persistence.error.message}</p>}
    </aside>
  );
}

function VolumePanel({
  label,
  fileName,
  debug,
  requestedTransport,
}: {
  label: string;
  fileName: string;
  debug: boolean;
  requestedTransport: DemoTransport;
}) {
  const volume = useVolume();
  const fs = useVolumeClient();
  const content = useFileContent(notePath, { format: 'bytes' });
  const folder = useFolder('/');
  const [draft, setDraft] = useState('');
  const [base, setBase] = useState<EditingBase | null>(null);
  const [outcome, setOutcome] = useState('Open the volume, then write a note.');
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState<QueuedSave | null>(null);
  const secondClient = useRef<OpfsVfsWorkerClient | null>(null);
  const mounted = useRef(true);
  const shared = volume.transport === 'shared-worker';

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const client = secondClient.current;
      secondClient.current = null;
      client?.dispose();
    };
  }, []);

  useEffect(() => {
    if (volume.status !== 'ready' || !volume.generation || content.status !== 'success') return;
    const bytes = content.data ?? new Uint8Array();
    const next: EditingBase = {
      generation: volume.generation,
      path: notePath,
      exists: content.data !== null,
      bytes: bytes.slice(),
      text: new TextDecoder().decode(bytes),
    };
    const changed =
      !base ||
      base.generation !== next.generation ||
      base.path !== next.path ||
      base.exists !== next.exists ||
      base.bytes.length !== next.bytes.length ||
      base.bytes.some((byte, index) => byte !== next.bytes[index]);
    if (!base || (draft === base.text && changed)) {
      setBase(next);
      setDraft(next.text);
    }
  }, [base, content.data, content.status, draft, volume.generation, volume.status]);

  const captureSave = (): QueuedSave | null => {
    if (!fs || volume.status !== 'ready' || !volume.generation || !base || base.generation !== volume.generation)
      return null;
    return {
      fs,
      generation: volume.generation,
      path: base.path,
      expected: base.exists ? base.bytes.slice() : undefined,
      next: encoder.encode(draft),
    };
  };

  const runSave = async (action: QueuedSave) => {
    setBusy(true);
    setOutcome('Saving this generation…');
    try {
      await action.fs.writeFileBuffer(
        action.path,
        action.next,
        action.expected === undefined ? { exclusive: true } : { expected: action.expected },
      );
      await action.fs.sync();
      setBase({
        generation: action.generation,
        path: action.path,
        exists: true,
        bytes: action.next.slice(),
        text: new TextDecoder().decode(action.next),
      });
      setOutcome(`Saved and synchronized generation ${action.generation}.`);
    } catch (error) {
      setOutcome(
        `Save did not reach a confirmed synchronized state: ${message(error)} The draft is still available; refresh before retrying.`,
      );
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const action = captureSave();
    if (action) await runSave(action);
  };

  const queueSave = () => {
    const action = captureSave();
    if (!action) return;
    setQueued(action);
    setOutcome(
      `Queued a save for generation ${action.generation}. A later client update will be checked against these captured bytes.`,
    );
  };

  const runQueuedSave = async () => {
    if (!queued) return;
    const action = queued;
    setQueued(null);
    await runSave(action);
  };

  const reload = async () => {
    setBusy(true);
    setOutcome('Reloading the current file. This discards the draft when the read completes…');
    try {
      if (!fs || volume.status !== 'ready' || !volume.generation)
        throw new Error('Wait for a ready volume before reloading.');
      await content.refresh();
      const bytes = await fs.readFileBuffer(notePath);
      const next = {
        generation: volume.generation,
        path: notePath,
        exists: true,
        bytes: bytes.slice(),
        text: new TextDecoder().decode(bytes),
      };
      setBase(next);
      setDraft(next.text);
      setOutcome('Reloaded the current file and discarded the previous draft.');
    } catch (error) {
      setOutcome(`Reload failed; the draft was kept: ${message(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const writeFromSecondClient = async () => {
    setBusy(true);
    setOutcome('Opening a compatible second client…');
    try {
      const previous = secondClient.current;
      if (previous) await previous.closeVfs().finally(() => previous.dispose());
      const client = await openOpfsVfsWorker(fileName, {
        transport: requestedTransport,
        worker,
        sharedWorker,
        plugins: [subscriptionsRequest()],
        debug,
      });
      if (!mounted.current) {
        client.dispose();
        return;
      }
      secondClient.current = client;
      await client.ready;
      await client.writeFileBuffer(
        notePath,
        encoder.encode(`Updated by the compatible second client at ${new Date().toLocaleTimeString()}.`),
      );
      await client.sync();
      setOutcome(
        'A compatible second client synchronized a newer note. Save this editor to see the expected-content conflict.',
      );
    } catch (error) {
      setOutcome(`Second client failed: ${message(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const simulateSyncFailure = async () => {
    setBusy(true);
    try {
      if (!fs || volume.status !== 'ready') throw new Error('Wait for a ready volume before writing.');
      if (!base || base.generation !== volume.generation)
        throw new Error('Wait for a confirmed editor base before writing.');
      await fs.writeFileBuffer(
        notePath,
        encoder.encode(draft),
        base.exists ? { expected: base.bytes.slice() } : { exclusive: true },
      );
      throw new Error('Demo-only injected sync failure after a successful write; no sync was attempted');
    } catch (error) {
      setOutcome(
        `Demo-only injected sync failure: ${message(error)} This labels a successful write followed by a skipped sync, not a core durability failure. The draft remains available and the UI does not report Saved.`,
      );
    } finally {
      setBusy(false);
    }
  };

  const cleanup = async () => {
    setBusy(true);
    setOutcome('Closing this volume before removing its files…');
    try {
      const client = secondClient.current;
      secondClient.current = null;
      if (client) await client.closeVfs().finally(() => client.dispose());
      if (shared) {
        const admin = await import('@opfs-vfs/opfs-vfs/worker').then(({ createSharedWorkerFollower }) =>
          createSharedWorkerFollower(fileName, { plugins: [subscriptionsRequest()], debug }, sharedWorker),
        );
        try {
          await admin.ready;
          await admin.shutdownSharedVfs();
        } finally {
          admin.dispose();
        }
      } else if (volume.ownership === 'managed') await volume.close();
      await deleteVolume(fileName);
      setOutcome('Closed and removed this demo volume. Other volume controls remain independent.');
    } catch (error) {
      setOutcome(`Cleanup failed: ${message(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const close = async () => {
    if (volume.ownership !== 'managed') return;
    setBusy(true);
    try {
      await volume.close();
      setOutcome(
        shared
          ? "Closed this page's follower. The SharedWorker owner remains available to other pages."
          : "Closed this page's managed client. Another compatible page may take ownership.",
      );
    } catch (error) {
      setOutcome(`Close failed: ${message(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const status = `${label}: ${volume.status}${content.isRefreshing ? ', refreshing' : ''}${content.isStale ? ', stale data shown' : ''}`;
  return (
    <section className="react-sdk-volume" aria-labelledby={`${fileName}-heading`}>
      <header>
        <div>
          <p className="kicker">{requestedTransport} transport request</p>
          <h2 id={`${fileName}-heading`}>{label}</h2>
          <code>{fileName}</code>
        </div>
        <span className={`react-sdk-state state-${volume.status}`}>{status}</span>
      </header>
      <p className="react-sdk-status" role="status" aria-live="polite">
        {outcome}
      </p>
      <p className="react-sdk-transport">
        <strong>Transport:</strong> requested {requestedTransport}; selected {volume.transport ?? 'opening'}
        {volume.fallbackReason ? ` (${volume.fallbackReason})` : ''}.
      </p>
      {base && base.generation !== volume.generation && <p role="alert">Reload before saving this preserved draft.</p>}
      {volume.error && (
        <p className="react-sdk-error" role="alert">
          {volume.error.kind}: {volume.error.message}
        </p>
      )}
      {content.error && (
        <p className="react-sdk-error" role="alert">
          Read failed: {content.error.message}
        </p>
      )}
      <label htmlFor={`${fileName}-editor`}>Draft</label>
      <textarea
        id={`${fileName}-editor`}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="Write a note"
        disabled={busy || volume.status !== 'ready' || !base}
      />
      <p className="react-sdk-current">
        <strong>Current file:</strong>{' '}
        {content.status === 'success'
          ? content.data === null
            ? '(missing)'
            : new TextDecoder().decode(content.data)
          : content.status}
      </p>
      <p className="react-sdk-current">
        <strong>Explorer:</strong>{' '}
        {folder.status === 'success' ? folder.data?.map((entry) => entry.name).join(', ') || '(empty)' : folder.status}
      </p>
      <div className="react-sdk-actions">
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || !base || base.generation !== volume.generation || volume.status !== 'ready' || !fs}
        >
          Save and sync
        </button>
        <button
          type="button"
          onClick={queueSave}
          disabled={busy || !base || base.generation !== volume.generation || volume.status !== 'ready' || !fs}
        >
          Queue conflict-aware save
        </button>
        <button type="button" onClick={() => void writeFromSecondClient()} disabled={busy || volume.status !== 'ready'}>
          Update from second client
        </button>
        <button type="button" onClick={() => void runQueuedSave()} disabled={busy || !queued}>
          Run queued save
        </button>
        <button type="button" onClick={() => void reload()} disabled={busy || content.status !== 'success'}>
          Reload current file (discard draft)
        </button>
        <button
          type="button"
          onClick={() => void simulateSyncFailure()}
          disabled={busy || volume.status !== 'ready' || !fs}
        >
          Simulate sync failure
        </button>
        <button
          type="button"
          className="react-sdk-danger"
          onClick={() => void close()}
          disabled={volume.status === 'closed'}
        >
          Close this volume
        </button>
        <button
          type="button"
          className="react-sdk-danger"
          onClick={() => void cleanup()}
          disabled={busy || (!shared && volume.status === 'closed')}
        >
          Close and delete this volume
        </button>
      </div>
      <p className="react-sdk-note">
        The injected failure is a labeled UI demonstration. The ordinary Save action uses the real worker and waits for
        `sync()` before it reports success.
      </p>
    </section>
  );
}

export default function ReactSdkDemo() {
  const debug = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('opfsDebug');
  const requestedTransport: DemoTransport = (() => {
    const transport =
      typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('transport');
    return transport === 'dedicated' || transport === 'shared-worker' || transport === 'auto' ? transport : 'auto';
  })();
  const volumes =
    requestedTransport === 'shared-worker'
      ? [
          { label: 'Shared preview notes', fileName: sharedFirstVolume },
          { label: 'Shared preview ideas', fileName: sharedSecondVolume },
        ]
      : requestedTransport === 'dedicated'
        ? [
            { label: 'Dedicated notes', fileName: dedicatedFirstVolume },
            { label: 'Dedicated ideas', fileName: dedicatedSecondVolume },
          ]
        : [
            { label: 'Auto notes', fileName: autoFirstVolume },
            { label: 'Auto ideas', fileName: autoSecondVolume },
          ];
  return (
    <div className="react-sdk-demo">
      <PersistenceControl />
      {requestedTransport === 'shared-worker' && (
        <p className="react-sdk-note" role="status">
          SharedWorker preview: this forced route has no dedicated-worker fallback. It uses separate shared-preview
          volume names, so it does not open the auto or dedicated demo data. Open this exact URL in a second page to
          share each preview volume.
        </p>
      )}
      {debug && (
        <p className="react-sdk-note" role="status">
          Diagnostics are active. In Web Inspector, filter for <code>[opfs-vfs:diag]</code> and copy the JSON lines.
        </p>
      )}
      <div className="react-sdk-volumes">
        {volumes.map(({ label, fileName }) => (
          <VolumeProvider
            key={fileName}
            fileName={fileName}
            worker={worker}
            sharedWorker={sharedWorker}
            transport={requestedTransport}
            plugins={[subscriptionsRequest()]}
            options={debug ? { debug } : undefined}
          >
            <VolumePanel label={label} fileName={fileName} debug={debug} requestedTransport={requestedTransport} />
          </VolumeProvider>
        ))}
      </div>
    </div>
  );
}
