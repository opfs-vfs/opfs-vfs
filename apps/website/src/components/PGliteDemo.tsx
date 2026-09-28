import { useActionDialog } from './ui/action-dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { SelectField } from './ui/select-field';
import { Download, Upload, Plus, Save, RotateCcw, Trash2 } from 'lucide-react';
import { Repl } from '@electric-sql/pglite-repl';
import type { PGliteWorker } from '@electric-sql/pglite/worker';
import { useEffect, useRef, useState } from 'react';
import {
  createDatabase,
  openDatabase,
  openTemporaryDatabase,
  readDatabaseRegistry,
  recreateDatabase,
  resetDatabaseSchema,
  validateDataArchive,
  type DatabaseRecord,
} from '../lib/pglite';
import './PGliteDemo.css';
import { useTheme } from '../lib/use-theme';
const EXPORT_TIMEOUT_MS = 30_000;
async function exportArchive(pg: PGliteWorker) {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      pg.waitReady.then(() => pg.dumpDataDir('gzip')),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Export timed out while waiting for the database leader.')),
          EXPORT_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
export default function PGliteDemo() {
  const theme = useTheme();
  const { confirmAction, dialog } = useActionDialog();
  const [databases, setDatabases] = useState<DatabaseRecord[]>([]),
    [active, setActive] = useState('playground'),
    [name, setName] = useState('my-database'),
    [pg, setPg] = useState<PGliteWorker | null>(null),
    [status, setStatus] = useState('Opening database…'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [backend, setBackend] = useState<'persistent' | 'memory'>('persistent');
  const pgRef = useRef<PGliteWorker | null>(null),
    operation = useRef(0),
    input = useRef<HTMLInputElement>(null);
  const install = async (nextName: string, open: () => Promise<PGliteWorker>, temporary = false) => {
    const token = ++operation.current;
    setBusy(true);
    setError('');
    setStatus(`Opening ${nextName}…`);
    setPg(null);
    const previous = pgRef.current;
    pgRef.current = null;
    try {
      await previous?.close();
      const next = await open();
      if (token !== operation.current) {
        await next.close();
        return;
      }
      pgRef.current = next;
      setPg(next);
      if (!temporary) setActive(nextName);
      const show = () => {
        if (token === operation.current)
          setStatus(
            temporary
              ? 'Temporary memory · rows disappear on reopen'
              : `${nextName} · ${next.isLeader ? 'Leader' : 'Connected'} · persistent OPFS VFS · memory buffer · balanced durability`,
          );
      };
      show();
      next.onLeaderChange(() => {
        if (token === operation.current) setStatus(`Reconnecting ${nextName}…`);
        setTimeout(() => void next.waitReady.then(show).catch(() => undefined), 0);
      });
    } catch (cause) {
      if (token === operation.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setStatus('Database unavailable');
      }
      throw cause;
    } finally {
      if (token === operation.current) setBusy(false);
    }
  };
  useEffect(() => {
    let stored = readDatabaseRegistry();
    setDatabases(stored);
    const syncDatabases = () => setDatabases(readDatabaseRegistry());
    addEventListener('storage', syncDatabases);
    const initial = stored[0]?.name ?? 'playground';
    const initialize = async () => {
      if (stored.length) return install(initial, () => openDatabase(initial));
      try {
        await install(initial, async () => {
          // The fixed default name may already have a complete physical volume
          // if a previous page was closed between reservation and registration.
          const created = await createDatabase(initial, undefined, true);
          setDatabases(created.records);
          return created.pg;
        });
      } catch {
        stored = readDatabaseRegistry();
        setDatabases(stored);
        if (stored.some((x) => x.name === initial)) await install(initial, () => openDatabase(initial));
      }
    };
    void initialize().catch(() => undefined);
    return () => {
      operation.current++;
      removeEventListener('storage', syncDatabases);
      const current = pgRef.current;
      pgRef.current = null;
      void current?.close().catch(() => undefined);
    };
  }, []);
  const create = (archive?: Blob) =>
    install(name, async () => {
      const created = await createDatabase(name, archive);
      setDatabases(created.records);
      return created.pg;
    }).catch(() => undefined);
  const save = () => {
    if (!pg) return;
    setBusy(true);
    setError('');
    void pg
      .syncToFs()
      .then(() => setStatus('Saved to persistent storage'))
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };
  const resetVolume = async () => {
    if (
      !(await confirmAction(
        `Delete and recreate the entire ${active} volume?`,
        'All tables and rows will be deleted. This fails safely if another tab is using it.',
      ))
    )
      return;
    await install(active, () => recreateDatabase(active)).catch(async (cause) => {
      await install(active, () => openDatabase(active)).catch(() => undefined);
      setError(
        `${cause instanceof Error ? cause.message : String(cause)} Close the database in other tabs, then retry.`,
      );
    });
  };
  const exportDb = async () => {
    if (!pg) return;
    setBusy(true);
    setError('');
    try {
      const blob = await exportArchive(pg),
        url = URL.createObjectURL(blob),
        link = document.createElement('a');
      link.href = url;
      link.download = `${active}.pglite.tgz`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const importDb = async (file: File) => {
    setBusy(true);
    setError('');
    try {
      await validateDataArchive(file);
      await create(file);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const switchBackend = (next: 'persistent' | 'memory') => {
    setBackend(next);
    void install(
      next === 'memory' ? 'temporary memory' : active,
      next === 'memory' ? openTemporaryDatabase : () => openDatabase(active),
      next === 'memory',
    ).catch(() => undefined);
  };
  return (
    <section className="pglite-demo" aria-busy={busy}>
      {dialog}
      <header>
        <div>
          <p className="eyebrow">Persistent PostgreSQL in your browser</p>
          <h2>PGlite playground</h2>
          <p role="status">{status}</p>
        </div>
        <label>
          Database
          <SelectField
            label="Database"
            value={String(active)}
            onValueChange={(value) => {
              const selected = value;
              void install(selected, () => openDatabase(selected)).catch(() => undefined);
            }}
            options={databases.map((x) => ({ value: x.name, label: x.name }))}
            disabled={busy || backend === 'memory'}
            className="w-full"
          />
        </label>
      </header>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="database-actions">
        <label>
          Storage
          <SelectField
            label="Storage"
            value={String(backend)}
            onValueChange={(value) => switchBackend(value as 'persistent' | 'memory')}
            options={[
              { value: 'persistent', label: 'Persistent OPFS VFS' },
              { value: 'memory', label: 'Temporary memory' },
            ]}
            disabled={busy}
            className="w-full"
          />
        </label>
        <label>
          New database
          <Input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} />
        </label>
        <Button variant="default" size="default" disabled={busy || backend === 'memory'} onClick={() => void create()}>
          <Plus aria-hidden="true" /> Create
        </Button>
        <Button
          variant="outline"
          size="default"
          disabled={busy || backend === 'memory'}
          onClick={() => input.current?.click()}
        >
          <Upload aria-hidden="true" /> Import PGlite archive
        </Button>
        <input
          ref={input}
          hidden
          type="file"
          accept=".tar,.tgz,.tar.gz"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void importDb(file);
            e.target.value = '';
          }}
        />
        <Button
          variant="outline"
          size="default"
          disabled={busy || !pg || backend === 'memory'}
          onClick={() => void exportDb()}
        >
          <Download aria-hidden="true" /> Export PGlite archive
        </Button>
        <Button variant="outline" size="default" disabled={busy || !pg || backend === 'memory'} onClick={save}>
          <Save aria-hidden="true" /> Save
        </Button>
        <Button
          variant="outline"
          size="default"
          disabled={busy || !pg}
          onClick={() =>
            void install(
              backend === 'memory' ? 'temporary memory' : active,
              backend === 'memory' ? openTemporaryDatabase : () => openDatabase(active),
              backend === 'memory',
            ).catch(() => undefined)
          }
        >
          <RotateCcw aria-hidden="true" /> Reopen
        </Button>
        <Button
          variant="destructive"
          size="default"
          disabled={busy || !pg || backend === 'memory'}
          onClick={async () => {
            if (
              await confirmAction(
                `Drop every table in ${active} for all connected tabs?`,
                'All tables and rows in this database will be deleted.',
              )
            ) {
              setBusy(true);
              void resetDatabaseSchema(pg!)
                .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
                .finally(() => setBusy(false));
            }
          }}
        >
          <RotateCcw aria-hidden="true" /> Reset schema
        </Button>
        <Button
          variant="destructive"
          size="default"
          disabled={busy || !pg || backend === 'memory'}
          onClick={() => void resetVolume()}
        >
          <Trash2 aria-hidden="true" /> Reset volume
        </Button>
      </div>
      <p className="archive-note">Exports are PGlite data-directory archives, not raw OPFS VFS volume files.</p>
      <div className="repl-shell">{pg ? <Repl pg={pg} theme={theme} showTime /> : <p>Connecting…</p>}</div>
    </section>
  );
}
