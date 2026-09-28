import { usePanelLayout } from './use-panel-layout';
import { useActionDialog } from './ui/action-dialog';
import { Textarea } from './ui/textarea';
import { Button } from './ui/button';
import { useCallback, useEffect, useMemo, useRef, useState, useId, type ReactNode } from 'react';
import { FilePlus2, FolderPlus, Pencil, Trash2, Upload, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { exportWorkspace, importWorkspace } from '../lib/archive';
import { captureDroppedFiles, importDroppedFiles, listTree, type ExplorerEntry } from '../lib/filesystem';
import { listVolumes, openVolume, registerVolume, seedVolume, type FilesystemSession } from '../lib/volume';
import { FileExplorer } from './FileExplorer';
import { FilePreview } from './FilePreview';
import { VolumeToolbar } from './VolumeToolbar';
import './filesystem-demo.css';
import './filesystem-theme.css';
import './explorer-actions.css';

export type FilesystemDemoApi = { refresh(): Promise<void>; select(path: string): void; session: FilesystemSession };

export function FilesystemDemo({
  namespace = 'filesystem',
  sidePanel,
}: {
  namespace?: string;
  sidePanel?: (api: FilesystemDemoApi) => ReactNode;
}) {
  const layout = usePanelLayout();
  const panelId = useId();
  const middleTab = useRef<HTMLButtonElement>(null);
  const { ask, confirmAction, dialog } = useActionDialog();
  const [session, setSession] = useState<FilesystemSession>();
  const [names, setNames] = useState<string[]>([]);
  const [entries, setEntries] = useState<ExplorerEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState('');
  const [revision, setRevision] = useState(0);
  const [command, setCommand] = useState('ls -la');
  const [output, setOutput] = useState('');
  const [busy, setBusy] = useState(false);
  const [mounting, setMounting] = useState(true);
  const [pendingName, setPendingName] = useState('Demo workspace');
  const [showLoading, setShowLoading] = useState(false);
  const [error, setError] = useState('');
  const [mobileView, setMobileView] = useState<'files' | 'middle' | 'preview'>(sidePanel ? 'middle' : 'files');
  const active = useRef<FilesystemSession | undefined>(undefined);
  const mounted = useRef(false);
  const generation = useRef(0);
  const mountAttempt = generation.current;
  const retry = useRef({ create: false, name: 'Demo workspace', reuse: true });
  const upload = useRef<HTMLInputElement>(null);
  const previewDirty = useRef(false);
  const report = (reason: unknown) => {
    if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason));
  };
  const refresh = useCallback(async () => {
    const current = active.current;
    if (!current) return;
    const next = await current.read((fs) => listTree(fs));
    if (active.current === current && mounted.current) {
      setEntries(next);
      setRevision((value) => value + 1);
    }
  }, []);
  const read = useCallback(<T,>(operation: (fs: FilesystemSession['fs']) => Promise<T>) => {
    const current = active.current;
    if (!current) return Promise.reject(new Error('No volume is mounted.'));
    return current.read(operation);
  }, []);
  const setDirty = useCallback((value: boolean) => {
    previewDirty.current = value;
  }, []);
  const selectPath = useCallback(
    (path: string) => {
      if (path === selectedPath) return true;
      if (previewDirty.current) {
        void confirmAction(
          'Discard unsaved preview changes?',
          'Your edits have not been saved. Discard them to open another file.',
        ).then((accepted) => {
          if (accepted && mounted.current) {
            previewDirty.current = false;
            setSelectedPath(path);
            if (entries.some((entry) => entry.path === path && entry.kind === 'file') && layout.narrow)
              setMobileView('preview');
          }
        });
        return false;
      }
      previewDirty.current = false;
      setSelectedPath(path);
      return true;
    },
    [selectedPath, confirmAction, entries, layout.narrow],
  );
  const mount = useCallback(
    async (name: string, create = false, reuse = false) => {
      if (
        active.current &&
        previewDirty.current &&
        !(await confirmAction(
          'Discard unsaved preview changes?',
          'Save your edits before switching volumes, or discard them to continue.',
        ))
      )
        return;
      previewDirty.current = false;
      const ticket = ++generation.current;
      retry.current = { create, name, reuse };
      if (mounted.current) {
        setBusy(true);
        setMounting(true);
        setPendingName(name);
        setShowLoading(false);
        setError('');
      }
      try {
        const previous = active.current;
        if (mounted.current) setSession(undefined);
        await previous?.close();
        active.current = undefined;
        const next = await openVolume(namespace, name, create, true, reuse);
        if (!mounted.current || ticket !== generation.current) {
          await next.close();
          return;
        }
        active.current = next;
        if (create && !(await next.read((fs) => fs.exists('/workspace/README.md')))) await seedVolume(next);
        const [known, tree] = await Promise.all([listVolumes(namespace), next.read((fs) => listTree(fs))]);
        if (!mounted.current || ticket !== generation.current) {
          active.current = undefined;
          await next.close();
          return;
        }
        setSession(next);
        setNames(known);
        setEntries(tree);
        setSelectedPath('/workspace/README.md');
        setRevision((value) => value + 1);
      } catch (reason) {
        if (mounted.current && ticket === generation.current) report(reason);
      } finally {
        if (mounted.current && ticket === generation.current) {
          setBusy(false);
          setMounting(false);
        }
      }
    },
    [namespace, confirmAction],
  );
  useEffect(() => {
    mounted.current = true;
    const syncVolumes = () =>
      void listVolumes(namespace)
        .then((known) => {
          if (mounted.current) setNames(known);
        })
        .catch(report);
    addEventListener('storage', syncVolumes);
    void listVolumes(namespace)
      .then((known) => {
        setNames(known);
        const name = known[0] || 'Demo workspace';
        return mount(name, !known.length, !known.length);
      })
      .catch((reason) => {
        report(reason);
        if (mounted.current) setMounting(false);
      });
    return () => {
      mounted.current = false;
      removeEventListener('storage', syncVolumes);
      generation.current += 1;
      const current = active.current;
      active.current = undefined;
      void current?.close();
    };
  }, [mount, namespace]);
  useEffect(() => {
    if (!mounting) {
      setShowLoading(false);
      return;
    }
    setShowLoading(false);
    const timer = setTimeout(() => {
      if (mounted.current && mountAttempt === generation.current) setShowLoading(true);
    }, 500);
    return () => clearTimeout(timer);
  }, [mounting, mountAttempt]);
  useEffect(() => {
    const protectDraft = (event: BeforeUnloadEvent) => {
      if (previewDirty.current) event.preventDefault();
    };
    addEventListener('beforeunload', protectDraft);
    return () => removeEventListener('beforeunload', protectDraft);
  }, []);
  useEffect(() => {
    if (!session) return;
    const update = () => void refresh().catch(report);
    session.changes.addEventListener('message', update);
    return () => session.changes.removeEventListener('message', update);
  }, [refresh, session]);
  const selected = useMemo(() => entries.find((entry) => entry.path === selectedPath) || null, [entries, selectedPath]);
  const targetDirectory =
    selected?.kind === 'directory'
      ? selected.path
      : selected?.path.slice(0, selected.path.lastIndexOf('/')) || '/workspace';
  const mutate = (operation: (fs: FilesystemSession['fs']) => Promise<unknown>) =>
    session?.run(operation).then(refresh).catch(report);
  const run = async () => {
    if (busy || mounting || !session || !command.trim()) return;
    setBusy(true);
    setError('');
    try {
      const result = await session.exec(command);
      setOutput([result.stdout, result.stderr].filter(Boolean).join('\n'));
      await refresh();
    } catch (reason) {
      report(reason);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const downloadBlob = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
  };
  const toolbarName = mounting ? pendingName : session?.name || pendingName;
  const api = session ? { refresh, select: selectPath, session } : null;
  return (
    <section className="filesystem-demo" aria-busy={busy || mounting}>
      {dialog}
      <VolumeToolbar
        busy={busy || mounting}
        ready={!!session}
        loading={mounting && showLoading}
        onRetry={
          !session && !mounting && error
            ? () => void mount(retry.current.name, retry.current.create, retry.current.reuse)
            : undefined
        }
        name={toolbarName}
        names={names.includes(toolbarName) ? names : [...names, toolbarName]}
        onOpen={mount}
        onCreate={(name) => void mount(name, true)}
        onReopen={() => {
          if (session) void mount(session.name);
        }}
        onExport={() => {
          if (!session) return;
          void session
            .read(exportWorkspace)
            .then((blob) => downloadBlob(blob, `${session.name}.zip`))
            .catch(report);
        }}
        onImport={(name, file) =>
          void (async () => {
            setBusy(true);
            let imported: FilesystemSession | undefined;
            let reserved = false;
            let published = false;
            try {
              imported = await openVolume(namespace, name, true, false);
              reserved = true;
              await imported.run((fs) => importWorkspace(fs, file));
              await imported.close();
              imported = undefined;
              await registerVolume(namespace, name);
              published = true;
              await mount(name);
            } catch (reason) {
              if (!published && reserved) {
                if (imported) await imported.remove({ unregister: false }).catch(() => {});
                else {
                  const rollback = await openVolume(namespace, name).catch(() => undefined);
                  await rollback?.remove({ unregister: false }).catch(() => {});
                }
              }
              report(reason);
              setBusy(false);
            }
          })()
        }
        onReset={() =>
          void (async () => {
            if (!session) return;
            if (
              !(await confirmAction(
                `Delete and recreate "${session.name}"?`,
                'All files in this volume will be removed. Other tabs must close this volume first.',
              ))
            )
              return;
            setBusy(true);
            try {
              await session.remove();
              active.current = undefined;
              setSession(undefined);
              await mount(session.name, true);
            } catch (reason) {
              try {
                await session.read(async () => undefined);
              } catch {
                const reopened = await openVolume(namespace, session.name);
                active.current = reopened;
                setSession(reopened);
              }
              report(reason);
              setBusy(false);
            }
          })()
        }
      />
      {error ? (
        <div className="demo-error" role="alert">
          {error}
        </div>
      ) : null}
      <nav className="filesystem-mobile-tabs" aria-label="Workspace views" inert={mounting || !session}>
        {(
          [
            ['files', 'Files'],
            ['middle', sidePanel ? 'Chat' : 'Shell'],
            ['preview', 'Preview'],
          ] as const
        ).map(([view, label]) => (
          <Button
            variant="outline"
            size="sm"
            key={view}
            ref={view === 'middle' ? middleTab : undefined}
            aria-pressed={mobileView === view}
            onClick={() => {
              if (view === 'files') layout.setCollapsed(false);
              setMobileView(view);
            }}
          >
            {label}
          </Button>
        ))}
      </nav>
      <div
        className={`filesystem-grid${sidePanel ? ' with-side-panel' : ''}`}
        inert={mounting || !session}
        ref={layout.grid}
        style={{ gridTemplateColumns: layout.columns }}
        data-collapsed={layout.collapsed}
        data-dragging={layout.dragging}
        data-mobile-view={mobileView}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          if (!session || mounting) return;
          const dropped = captureDroppedFiles(event.dataTransfer);
          void session
            .run((fs) => importDroppedFiles(fs, dropped, targetDirectory))
            .then(refresh)
            .catch(report);
        }}
      >
        <aside className="explorer-panel">
          <header>
            <div className="explorer-heading">
              <span className="panel-title">Explorer</span>
              <Button
                variant="ghost"
                size="icon-sm"
                className="explorer-toggle"
                aria-label={layout.collapsed ? 'Expand file tree' : 'Collapse file tree'}
                title={layout.collapsed ? 'Expand file tree' : 'Collapse file tree'}
                aria-expanded={!layout.collapsed}
                aria-controls={`${panelId}-files`}
                onClick={() => {
                  layout.setCollapsed(!layout.collapsed);
                  if (layout.narrow) {
                    setMobileView('middle');
                    middleTab.current?.focus();
                  }
                }}
              >
                {layout.collapsed ? <PanelLeftOpen aria-hidden="true" /> : <PanelLeftClose aria-hidden="true" />}
              </Button>
            </div>
          </header>
          <div className="explorer-actions" aria-label="File actions">
            <Button
              variant="ghost"
              size="sm"
              disabled={!session}
              title="New folder"
              aria-label="New folder"
              onClick={async () => {
                const name = await ask({ title: 'Folder name', input: true, action: 'Create' });
                if (name && !name.includes('/')) void mutate((fs) => fs.mkdir(`${targetDirectory}/${name}`));
              }}
            >
              <FolderPlus aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!session}
              title="New file"
              aria-label="New file"
              onClick={async () => {
                const name = await ask({ title: 'File name', input: true, action: 'Create' });
                if (name && !name.includes('/'))
                  void mutate(async (fs) => {
                    const path = `${targetDirectory}/${name}`;
                    if (await fs.exists(path)) throw new Error(`${path} already exists`);
                    await fs.writeFile(path, '');
                  });
              }}
            >
              <FilePlus2 aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!session}
              title="Add files"
              aria-label="Add files"
              onClick={() => upload.current?.click()}
            >
              <Upload aria-hidden="true" />
            </Button>
            <input
              ref={upload}
              hidden
              multiple
              type="file"
              onChange={(event) => {
                const files = Array.from(event.target.files || []);
                event.target.value = '';
                if (!session) return;
                void session
                  .run(async (fs) => {
                    for (const file of files) {
                      const path = `${targetDirectory}/${file.name}`;
                      if (await fs.exists(path)) throw new Error(`${path} already exists`);
                      await fs.writeFile(path, new Uint8Array(await file.arrayBuffer()));
                    }
                  })
                  .then(refresh)
                  .catch(report);
              }}
            />
            <Button
              variant="ghost"
              size="sm"
              disabled={!session || !selected || selected.path === '/workspace'}
              title="Rename"
              aria-label="Rename"
              onClick={async () => {
                if (!session || !selected) return;
                const name = await ask({ title: 'Rename to', initial: selected.name, input: true });
                if (!name || name.includes('/') || name === selected.name) return;
                const target = `${selected.path.slice(0, selected.path.lastIndexOf('/'))}/${name}`;
                void session
                  .run(async (fs) => {
                    if (await fs.exists(target)) throw new Error(`${target} already exists`);
                    await fs.mv(selected.path, target);
                  })
                  .then(() => {
                    selectPath(target);
                    return refresh();
                  })
                  .catch(report);
              }}
            >
              <Pencil aria-hidden="true" />
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={!session || !selected || selected.path === '/workspace'}
              title="Delete"
              aria-label="Delete"
              onClick={async () => {
                if (
                  !session ||
                  !selected ||
                  !(await confirmAction(
                    `Delete ${selected.name}?`,
                    'This deletes the selected file or folder and its contents.',
                  ))
                )
                  return;
                void mutate((fs) => fs.rm(selected.path, { recursive: true }));
              }}
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </div>
          <div id={`${panelId}-files`} className="explorer-content">
            <FileExplorer
              entries={entries}
              selected={selectedPath}
              onSelect={(entry) => {
                const accepted = selectPath(entry.path);
                if (accepted && entry.kind === 'file' && layout.narrow) setMobileView('preview');
                return accepted;
              }}
              onMove={(source, destination, mode) => {
                if (!session) return;
                const target = mode === 'exact' ? destination : `${destination}/${source.split('/').pop()}`;
                if (target === source) return;
                if (target.startsWith(`${source}/`)) {
                  report(new Error('A folder cannot be moved into itself.'));
                  return;
                }
                void session
                  .run(async (fs) => {
                    if (await fs.exists(target)) throw new Error(`${target} already exists`);
                    await fs.mv(source, target);
                  })
                  .then(refresh)
                  .catch(report);
              }}
            />
          </div>
        </aside>
        <div
          className="panel-divider explorer-divider"
          {...layout.divider(0, 'Resize file tree', `${panelId}-files`)}
        />
        {sidePanel ? (
          <div id={`${panelId}-middle`} className="side-panel">
            {api ? sidePanel(api) : null}
          </div>
        ) : (
          <div id={`${panelId}-middle`} className="shell-panel">
            <header>
              <span className="panel-title">just-bash</span>
              <span className="shell-status">Local workspace</span>
            </header>
            <pre>{output || '$ ls -la'}</pre>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void run();
              }}
            >
              <Textarea
                disabled={mounting || !session}
                aria-label="Shell command"
                aria-describedby={`${panelId}-shell-hint`}
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  if (!event.repeat) event.currentTarget.form?.requestSubmit();
                }}
              />
              <small id={`${panelId}-shell-hint`}>Enter to run · Shift+Enter for a new line</small>
            </form>
          </div>
        )}
        <div className="panel-divider" {...layout.divider(1, 'Resize workspace and preview', `${panelId}-middle`)} />
        <div className="preview-panel">
          <header>Preview</header>
          {session ? (
            <FilePreview
              entry={selected}
              revision={revision}
              read={read}
              onDirtyChange={setDirty}
              onSave={(path, value) => session.run((fs) => fs.writeFile(path, value)).then(refresh)}
            />
          ) : null}
        </div>
      </div>
      {layout.dragging ? <div className="panel-drag-overlay" /> : null}
    </section>
  );
}

export default FilesystemDemo;
