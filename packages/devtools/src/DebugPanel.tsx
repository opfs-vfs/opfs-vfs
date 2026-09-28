import type { DevtoolsSession } from './runtime';
import { Select } from '@base-ui/react/select';
import { Tabs } from '@base-ui/react/tabs';
import {
  Suspense,
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  ChevronUp,
  CircleHelp,
  Database,
  File,
  FileCode2,
  FileText,
  Folder,
  Grip,
  HardDrive,
  Maximize2,
  Moon,
  PanelBottom,
  PanelLeft,
  PanelRight,
  PanelTop,
  Plus,
  RefreshCw,
  Search,
  Sun,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { canDelete, clampRect, connect, filterFiles, type Dock, type MockVolume, type Rect } from './mock-state';
import { FilePreview, TextEditor, canEdit, fileSize, type PreviewExtension } from '@opfs-vfs/file-preview';
import '@opfs-vfs/file-preview/styles.css';
import { FileActions, type FileAction } from './FileActions';
import { FileOperationDialog, type FileRequest } from './FileOperationDialog';
import {
  applyFileOperation,
  captureClipboard,
  parentPath,
  within,
  type FileClipboard,
  type FileOperation,
} from './mock-files';
import type { MockFile } from './mock-state';
import './debug-panel.css';

// Website brand mark from apps/website/src/layouts/SiteLayout.astro.
function OpfsLogo({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <circle
        cx="20"
        cy="20"
        r="17"
        strokeWidth="2.8"
        pathLength="120"
        strokeDasharray="27 4 12 4 25 4 16 4 20 4"
        transform="rotate(-92 20 20)"
      />
      <circle
        cx="20"
        cy="20"
        r="12.2"
        strokeWidth="3"
        pathLength="120"
        strokeDasharray="13 5 30 5 17 5 23 5 12 5"
        transform="rotate(-35 20 20)"
        opacity=".7"
      />
      <circle
        cx="20"
        cy="20"
        r="7.3"
        strokeWidth="2.8"
        pathLength="120"
        strokeDasharray="40 7 25 7 34 7"
        transform="rotate(14 20 20)"
      />
    </svg>
  );
}

export type Props = {
  runtime?: DevtoolsSession;
  initialVolumes?: MockVolume[];
  initialOpen?: boolean;
  initialDock?: Dock;
  initialScenario?: 'normal' | 'empty' | 'disconnected';
  initialTheme?: 'dark' | 'light';
  initialPath?: string;
  initialSource?: boolean;
  previewExtensions?: PreviewExtension[];
};
type DialogState = { kind: 'new' | 'import' | 'export' | 'delete' | 'details'; volume: string };
const size = (n: number) => {
  if (n < 1024) return `${n} B`;
  const unit = Math.min(Math.floor(Math.log2(n) / 10), 4);
  return `${(n / 1024 ** unit).toFixed(1)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][unit]}`;
};
const status = (v: MockVolume) =>
  v.connection === 'passive'
    ? 'Attached to application'
    : v.connection === 'owned'
      ? 'Opened by devtools'
      : {
          application: 'Application owner available',
          available: 'Closed',
          busy: 'In use · unavailable',
          protected: 'Protected',
          disconnected: 'Owner disconnected',
        }[v.state];
const layouts = [
  ['floating', Maximize2],
  ['left', PanelLeft],
  ['right', PanelRight],
  ['top', PanelTop],
  ['bottom', PanelBottom],
] as const;

// Shared panel: runtime connects real storage; Storybook may supply isolated memory fixtures.
export function DebugPanel({
  runtime,
  initialVolumes = [],
  initialOpen = false,
  initialDock = 'floating',
  initialScenario = 'normal',
  initialTheme = 'dark',
  initialPath = '/README.md',
  initialSource = false,
  previewExtensions,
}: Props) {
  const id = useId();
  const [volumes, setVolumes] = useState<MockVolume[]>(() =>
    initialScenario === 'empty'
      ? []
      : initialVolumes.map((v, i) =>
          i === 0 && initialScenario === 'disconnected' ? { ...v, state: 'disconnected', connection: 'none' } : v,
        ),
  );
  const [active, setActive] = useState(runtime ? '' : 'workspace.bin');
  const [directories, setDirectories] = useState<Record<string, string>>({ 'workspace.bin': parentPath(initialPath) });
  const [clipboard, setClipboard] = useState<FileClipboard | null>(null);
  const [fileRequest, setFileRequest] = useState<FileRequest | null>(null);
  const [open, setOpen] = useState(initialOpen);
  const [dock, setDock] = useState<Dock>(initialDock);
  const [theme, setTheme] = useState(initialTheme);
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [rect, setRect] = useState<Rect>(() =>
    clampRect(
      { x: (window.innerWidth - 1080) / 2, y: 100, width: 1080, height: 720 },
      window.innerWidth,
      window.innerHeight,
    ),
  );
  const [dockSize, setDockSize] = useState(560);
  const [split, setSplit] = useState(51);
  const [terminalHeight, setTerminalHeight] = useState(180);
  const [panelWidth, setPanelWidth] = useState(1080);
  const [mobileTab, setMobileTab] = useState('files');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('name');
  const [selected, setSelected] = useState<Record<string, string>>({ 'workspace.bin': initialPath });
  const draftBases = useRef<Record<string, MockFile>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [writable, setWritable] = useState<Record<string, boolean>>({});
  const [command, setCommand] = useState('');
  const [outputs, setOutputs] = useState<Record<string, string>>({});
  const [history, setHistory] = useState<string[]>([]);
  const historyIndex = useRef(0);
  const [notice, setNotice] = useState(
    runtime
      ? 'Open the panel to discover volumes on this origin.'
      : 'Discovery is simulated. Your real browser storage is untouched.',
  );
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [name, setName] = useState('');
  const [dialogError, setDialogError] = useState('');
  const [importTarget, setImportTarget] = useState('new');
  const [job, setJob] = useState<{ percent: number; label: string } | null>(null);
  const [archiveFile, setArchiveFile] = useState<File | undefined>();
  const [working, setWorking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [detailsTab, setDetailsTab] = useState('volume');
  const [previewSource, setPreviewSource] = useState(initialSource);
  const launcher = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const terminalOutput = useRef<HTMLPreElement>(null);
  const modal = useRef<HTMLDialogElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const cancelJob = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const volume = volumes.find((v) => v.name === active);
  const currentFile = volume?.files.find((f) => f.path === selected[active] && f.kind !== 'directory');
  const draftKey = `${active}:${currentFile?.path}`;
  const dirty = Object.hasOwn(drafts, draftKey);
  const sourceAvailable = !!currentFile && (!runtime || currentFile.loaded) && canEdit(currentFile);
  const previewMode = previewSource && sourceAvailable ? 'source' : 'preview';
  const enabled = volume?.connection !== 'none' && !volume?.error && !!volume;
  const writeEnabled = enabled && ((!runtime && volume?.connection === 'owned') || !!writable[active]);
  const directory = directories[active] ?? '/';
  const terminalDirectory = runtime?.cwd(active) ?? '/';
  const rows = volume
    ? filterFiles(volume.files, search, sort).filter((f) => search || parentPath(f.path) === directory)
    : [];
  const narrow = panelWidth < 690;
  const connected = volumes.filter((v) => v.connection !== 'none').length;
  const updateVolume = (volumeName: string, update: (v: MockVolume) => MockVolume) =>
    setVolumes((all) => all.map((v) => (v.name === volumeName ? update(v) : v)));

  useLayoutEffect(() => {
    const output = terminalOutput.current;
    if (output) output.scrollTop = output.scrollHeight;
  }, [
    outputs,
    active,
    open,
    enabled,
    mobileTab,
    narrow,
    panelWidth,
    viewport.height,
    dock,
    terminalHeight,
    rect.height,
    dockSize,
  ]);

  useEffect(() => {
    if (!runtime || !open) return;
    let live = true;
    let running = false;
    const refresh = async () => {
      if (running) return;
      running = true;
      try {
        const next = await runtime.refresh();
        if (live) {
          setVolumes([...next]);
          setActive((value) => value || next[0]?.name || '');
          setWritable((all) =>
            Object.fromEntries(
              Object.entries(all).map(([name, value]) => [
                name,
                value && next.some((v) => v.name === name && v.connection !== 'none'),
              ]),
            ),
          );
        }
      } catch (error) {
        if (live) setNotice(String(error));
      } finally {
        running = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [runtime, open]);
  useEffect(() => {
    if (!runtime || !enabled || !currentFile || currentFile.loaded || currentFile.error) return;
    let live = true;
    const name = active,
      path = currentFile.path;
    runtime.read(name, path).then(
      (file) => {
        if (live) updateVolume(name, (v) => ({ ...v, files: v.files.map((f) => (f.path === path ? file : f)) }));
      },
      (error) => {
        if (live)
          updateVolume(name, (v) => ({
            ...v,
            files: v.files.map((f) => (f.path === path ? { ...f, error: String(error) } : f)),
          }));
      },
    );
    return () => {
      live = false;
    };
  }, [runtime, active, enabled, currentFile]);
  async function saveCurrentFile() {
    if (!currentFile || !writeEnabled || !dirty || saving) return;
    const name = active,
      file = currentFile,
      key = draftKey,
      text = drafts[key];
    setSaving(true);
    try {
      if (runtime) await runtime.save(name, draftBases.current[key] ?? file, text);
      const saved = { ...file, content: text, size: new TextEncoder().encode(text).length, modified: Date.now() };
      updateVolume(name, (v) => ({ ...v, files: v.files.map((f) => (f.path === file.path ? saved : f)) }));
      setDrafts((all) => {
        if (all[key] !== text) {
          draftBases.current[key] = saved;
          return all;
        }
        const next = { ...all };
        delete next[key];
        delete draftBases.current[key];
        return next;
      });
      setNotice(`Saved ${file.path}${runtime ? ' to OPFS' : ' to simulated data'}.`);
    } catch (error) {
      setNotice(String(error));
    } finally {
      setSaving(false);
    }
  }
  async function refreshFiles() {
    if (!runtime) {
      setNotice('Discovery refreshed.');
      return;
    }
    try {
      const discovered = await runtime.refresh();
      setVolumes([...discovered]);
      if (discovered.some((v) => v.name === active && v.connection !== 'none'))
        setVolumes([...(await runtime.list(active))]);
      setNotice('Refreshed from OPFS.');
    } catch (error) {
      setNotice(String(error));
    }
  }
  useEffect(() => {
    const onResize = () => {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useEffect(() => {
    if (!panel.current || !open) return;
    const observer = new ResizeObserver(([entry]) => setPanelWidth(entry.contentRect.width));
    observer.observe(panel.current);
    panel.current.focus();
    return () => observer.disconnect();
  }, [open]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        setOpen(true);
        panel.current?.focus();
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => {
      window.removeEventListener('keydown', shortcut);
      clearInterval(cancelJob.current);
    };
  }, []);
  useEffect(() => {
    if (dialog) {
      modal.current?.showModal();
      modal.current?.querySelector<HTMLButtonElement>('[data-cancel]')?.focus();
    } else if (modal.current?.open) {
      modal.current.close();
      previousFocus.current?.focus();
    }
  }, [dialog]);

  function closePanel() {
    setOpen(false);
    launcher.current?.focus();
  }
  function showDialog(kind: DialogState['kind'], target = active) {
    previousFocus.current = document.activeElement as HTMLElement;
    setDialogError('');
    setName(kind === 'import' ? 'imported-workspace' : '');
    setImportTarget('new');
    setDetailsTab('volume');
    setDialog({ kind, volume: target });
  }
  async function selectVolume(value: string) {
    setActive(value);
    setSearch('');
    setPreviewSource(false);
    if (runtime) {
      try {
        const next = await runtime.connect(value);
        setVolumes([...next]);
        const first = next.find((v) => v.name === value)?.files.find((f) => !f.kind);
        if (first && !selected[value]) setSelected((paths) => ({ ...paths, [value]: first.path }));
        setNotice(`Connected to ${value}. Writes are off until enabled.`);
      } catch (error) {
        setNotice(String(error));
      }
      return;
    }
    const target = volumes.find((v) => v.name === value);
    if (target) {
      updateVolume(value, connect);
      if (!selected[value] && target.files[0]) setSelected((paths) => ({ ...paths, [value]: target.files[0].path }));
      setNotice(
        target.state === 'available'
          ? `Opened ${value} in a simulated worker. Other connections remain open.`
          : target.state === 'application'
            ? `Attached to ${value}. The application keeps ownership.`
            : status(target),
      );
    }
  }
  function addFromApplication() {
    const next = `app-created-${volumes.filter((v) => v.name.startsWith('app-created')).length + 1}.bin`;
    setVolumes((all) => [
      ...all,
      {
        name: next,
        state: 'application',
        connection: 'none',
        files: [{ path: '/new.txt', content: 'Created by the simulated application.\n', modified: Date.now() }],
      },
    ]);
    setNotice(`Discovered ${next} automatically. Select it to attach.`);
  }
  function loseOwner() {
    setWritable((all) => ({ ...all, 'workspace.bin': false }));
    updateVolume('workspace.bin', (v) => ({ ...v, state: 'disconnected', connection: 'none' }));
    setNotice('workspace.bin owner disconnected. Drafts are preserved; no commands will be replayed.');
  }
  function requireClean(volumeName: string, path: string) {
    if (
      Object.keys(drafts).some(
        (key) => key.startsWith(`${volumeName}:`) && within(path, key.slice(volumeName.length + 1)),
      )
    ) {
      throw new Error('Save the unsaved edits in this entry before continuing.');
    }
  }
  async function mutateFiles(volumeName: string, operation: FileOperation) {
    if (operation.kind === 'rename' || operation.kind === 'delete') requireClean(volumeName, operation.path);
    if (operation.kind === 'paste' && operation.clipboard.cut)
      requireClean(operation.clipboard.volume, operation.clipboard.path);
    const next = runtime
      ? await runtime.mutate(volumeName, operation)
      : applyFileOperation(volumes, volumeName, operation, writable);
    let oldPath = '';
    let newPath = '';
    let sourceVolume = volumeName;
    if (operation.kind === 'rename') {
      oldPath = operation.path;
      newPath = `${parentPath(oldPath) === '/' ? '' : parentPath(oldPath)}/${operation.name}`;
    } else if (operation.kind === 'paste' && operation.clipboard.cut) {
      sourceVolume = operation.clipboard.volume;
      oldPath = operation.clipboard.path;
      if (sourceVolume === volumeName)
        newPath = `${operation.parent === '/' ? '' : operation.parent}/${oldPath.split('/').at(-1)}`;
    }
    const remap = (values: Record<string, string>, folders: boolean) =>
      Object.fromEntries(
        Object.entries(values).map(([v, original]) => {
          let path =
            v === sourceVolume && oldPath && newPath && within(oldPath, original)
              ? newPath + original.slice(oldPath.length)
              : original;
          const files = next.find((item) => item.name === v)?.files ?? [];
          while (path !== '/' && !files.some((f) => f.path === path && (!folders || f.kind === 'directory')))
            path = parentPath(path);
          return [v, path];
        }),
      );
    setVolumes(next);
    setSelected((values) => remap(values, false));
    setDirectories((values) => remap(values, true));
    if (operation.kind === 'paste' && operation.clipboard.cut) setClipboard(null);
    setNotice(`${operation.kind} completed${runtime ? ' in OPFS' : ' in simulated data'}.`);
  }
  async function fileAction(action: FileAction, entry: MockFile) {
    if (!volume) return;
    try {
      const destination = entry.kind === 'directory' ? entry.path : parentPath(entry.path);
      if (action === 'preview' || action === 'edit') {
        if (entry.kind === 'directory') {
          setDirectories((all) => ({ ...all, [active]: entry.path }));
          setSearch('');
        } else {
          setSelected((all) => ({ ...all, [active]: entry.path }));
          setPreviewSource(action === 'edit');
          if (narrow) setMobileTab('preview');
        }
      } else if (action === 'copy' || action === 'cut') {
        requireClean(active, entry.path);
        setClipboard(
          runtime
            ? await runtime.clipboard(active, entry.path, action === 'cut')
            : captureClipboard(volume, entry.path, action === 'cut'),
        );
        setNotice(
          `${action === 'cut' ? 'Cut' : 'Copied'} ${entry.path}. Choose a folder and paste. Clipboard is internal to this panel.`,
        );
      } else if (action === 'paste' && clipboard)
        await mutateFiles(active, { kind: 'paste', parent: destination, clipboard });
      else if (action === 'file' || action === 'folder' || action === 'rename' || action === 'delete') {
        setFileRequest({
          volume: active,
          path: action === 'file' || action === 'folder' ? destination : entry.path,
          kind: action,
        });
      }
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : String(reason));
    }
  }
  async function runCommand() {
    if (working || !command.trim() || !volume || !enabled) return;
    const input = command.trim();
    let result = '';
    let code = 0;
    if (input === 'clear') {
      setOutputs((all) => ({ ...all, [active]: '' }));
      setCommand('');
      return;
    }
    if (runtime) {
      setWorking(true);
      try {
        const result = await runtime.run(active, input);
        setVolumes([...runtime.volumes]);
        setOutputs((all) => ({
          ...all,
          [active]:
            `${all[active] || ''}\n${terminalDirectory} $ ${input}\n${result.stdout}${result.stderr}\n[exit ${result.exitCode}]\n`.slice(
              -16000,
            ),
        }));
        setCommand('');
      } catch (error) {
        setNotice(String(error));
      } finally {
        setWorking(false);
      }
      return;
    }
    if (input === 'help')
      result =
        'Simulated commands: help, pwd, ls, ls -la, cat <path>, clear, touch <path>.\nThe integrated version will run just-bash.';
    else if (input === 'pwd') result = '/';
    else if (input === 'ls' || input === 'ls -la')
      result = volume.files
        .map((f) => `${input === 'ls -la' ? `${String(fileSize(f)).padStart(5)}  ` : ''}${f.path.slice(1)}`)
        .join('\n');
    else if (input.startsWith('cat ')) {
      const path = `/${input.slice(4).replace(/^\//, '')}`;
      const item = volume.files.find((f) => f.path === path);
      result = item?.bytes ? 'Binary file: use Preview.' : (item?.content ?? `cat: ${path}: No such file`);
      if (!item) code = 1;
    } else if (input.startsWith('touch ')) {
      const path = `/${input.slice(6).replace(/^\//, '')}`;
      if (!writeEnabled) {
        result = 'Inspection mode: enable writes to modify this mock volume.';
        code = 1;
      } else if (!/^\/[a-z0-9_.-]+$/i.test(path)) {
        result = 'Mock touch accepts one filename in the root directory.';
        code = 1;
      } else {
        updateVolume(active, (v) => ({
          ...v,
          files: v.files.some((f) => f.path === path)
            ? v.files.map((f) => (f.path === path ? { ...f, modified: Date.now() } : f))
            : [...v.files, { path, content: '', modified: Date.now() }],
        }));
        result = `Updated ${path} in simulated data.`;
      }
    } else {
      result = 'This mock only simulates a few commands. Type help. No real shell was executed.';
      code = 1;
    }
    setOutputs((all) => ({
      ...all,
      [active]: `${all[active] || ''}\n/ $ ${input}\n${result}\n[exit ${code}]\n`.slice(-16000),
    }));
    setHistory((all) => [...all, input]);
    historyIndex.current = history.length + 1;
    setCommand('');
  }
  function simulateTransfer(kind: 'import' | 'export') {
    const targetName = `${name.trim().replace(/\.bin$/i, '')}.bin`;
    if (
      kind === 'import' &&
      (!/^[a-z0-9][a-z0-9_-]{0,39}\.bin$/i.test(targetName) || volumes.some((v) => v.name === targetName))
    ) {
      setDialogError('Choose a unique name using letters, numbers, hyphens, or underscores.');
      return;
    }
    if (kind === 'import' && importTarget !== 'new') {
      setDialogError(
        'Existing-volume import needs exclusive application coordination. This mock demonstrates a conflict without changing files.',
      );
      return;
    }
    setDialog(null);
    let progress = 0;
    setJob({ percent: 0, label: kind === 'import' ? 'Validating simulated archive' : 'Reading simulated files' });
    cancelJob.current = setInterval(() => {
      progress += 20;
      setJob({
        percent: progress,
        label:
          progress < 60
            ? kind === 'import'
              ? 'Writing simulated files'
              : 'Reading simulated files'
            : kind === 'import'
              ? 'Flushing simulated volume'
              : 'Compressing simulated archive',
      });
      if (progress >= 100) {
        clearInterval(cancelJob.current);
        setJob(null);
        if (kind === 'import') {
          setVolumes((all) => [
            ...all,
            {
              name: targetName,
              state: 'available',
              connection: 'owned',
              files: [
                {
                  path: '/imported.md',
                  content: '# Imported workspace\n\nA simulated ZIP import completed.\n',
                  modified: Date.now(),
                },
              ],
            },
          ]);
          setActive(targetName);
          setSelected((all) => ({ ...all, [targetName]: '/imported.md' }));
        }
        setNotice(
          kind === 'import'
            ? `Imported ${targetName}. No actual ZIP or browser storage was used.`
            : 'Export simulation complete. No archive was downloaded.',
        );
      }
    }, 360);
  }
  async function submitDialog() {
    if (!dialog) return;
    if (runtime && dialog.kind !== 'details') {
      if (working) return;
      setWorking(true);
      const nextName = `${name.trim().replace(/\.bin$/i, '')}.bin`;
      try {
        if ((dialog.kind === 'new' || dialog.kind === 'import') && !/^[a-z0-9][a-z0-9_-]{0,39}\.bin$/i.test(nextName))
          throw new Error('Use letters, numbers, hyphens or underscores for the volume name.');
        if (dialog.kind === 'new') await runtime.create(nextName);
        if (dialog.kind === 'delete') {
          if (name !== dialog.volume) throw new Error('Type the exact volume name.');
          await runtime.delete(dialog.volume);
        }
        if (dialog.kind === 'import' || dialog.kind === 'export')
          await runtime.transfer(dialog.kind, dialog.kind === 'import' ? nextName : dialog.volume, archiveFile);
        setVolumes([...runtime.volumes]);
        if (dialog.kind === 'new' || dialog.kind === 'import') setActive(nextName);
        setDialog(null);
        setNotice(`${dialog.kind} completed in OPFS.`);
      } catch (error) {
        setDialogError(String(error));
        setVolumes([...runtime.volumes]);
      } finally {
        setWorking(false);
      }
      return;
    }
    if (dialog.kind === 'new') {
      const next = `${name.trim().replace(/\.bin$/i, '')}.bin`;
      if (!/^[a-z0-9][a-z0-9_-]{0,39}\.bin$/i.test(next) || volumes.some((v) => v.name === next)) {
        setDialogError('Choose a unique volume name using letters, numbers, hyphens, or underscores.');
        return;
      }
      setVolumes((all) => [...all, { name: next, state: 'available', connection: 'owned', files: [] }]);
      setActive(next);
      setDialog(null);
      setNotice(`Created ${next} in simulated data. Its worker stays open for this page.`);
    } else if (dialog.kind === 'delete') {
      const target = volumes.find((v) => v.name === dialog.volume);
      if (!target || !canDelete(target) || name !== target.name) return;
      setVolumes((all) => all.filter((v) => v.name !== target.name));
      setDialog(null);
      setNotice(`Deleted ${target.name} from simulated data only.`);
    } else if (dialog.kind === 'import' || dialog.kind === 'export') simulateTransfer(dialog.kind);
  }
  function startPointer(event: ReactPointerEvent<HTMLElement>, kind: 'move' | 'resize' | 'split' | 'terminal') {
    if (event.button !== 0 || (kind === 'move' && dock !== 'floating')) return;
    event.preventDefault();
    const target = event.currentTarget;
    target.focus();
    target.setPointerCapture(event.pointerId);
    const initial = {
      x: event.clientX,
      y: event.clientY,
      rect: clampRect(rect, viewport.width, viewport.height),
      dockSize,
      split,
      terminalHeight,
    };
    const move = (next: PointerEvent) => {
      const dx = next.clientX - initial.x,
        dy = next.clientY - initial.y;
      if (kind === 'move')
        setRect(
          clampRect(
            { ...initial.rect, x: initial.rect.x + dx, y: initial.rect.y + dy },
            viewport.width,
            viewport.height,
          ),
        );
      if (kind === 'resize') {
        if (dock === 'floating')
          setRect(
            clampRect(
              { ...initial.rect, width: initial.rect.width + dx, height: initial.rect.height + dy },
              viewport.width,
              viewport.height,
            ),
          );
        else
          setDockSize(
            Math.max(
              320,
              initial.dockSize + (dock === 'left' ? dx : dock === 'right' ? -dx : dock === 'top' ? dy : -dy),
            ),
          );
      }
      if (kind === 'split') setSplit(Math.min(70, Math.max(30, initial.split + (dx / panelWidth) * 100)));
      if (kind === 'terminal') setTerminalHeight(Math.min(300, Math.max(110, initial.terminalHeight - dy)));
    };
    const stop = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', stop);
      target.removeEventListener('pointercancel', stop);
      target.removeEventListener('lostpointercapture', stop);
      if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', stop);
    target.addEventListener('pointercancel', stop);
    target.addEventListener('lostpointercapture', stop);
  }
  const visibleRect = clampRect(rect, viewport.width, viewport.height);
  const geometry: CSSProperties =
    viewport.width < 600
      ? { inset: 8 }
      : dock === 'floating'
        ? { left: visibleRect.x, top: visibleRect.y, width: visibleRect.width, height: visibleRect.height }
        : dock === 'left' || dock === 'right'
          ? { top: 12, bottom: 12, [dock]: 12, width: Math.min(dockSize, viewport.width - 24) }
          : { left: 12, right: 12, [dock]: 12, height: Math.min(dockSize, viewport.height - 24) };
  const dialogVolume = volumes.find((v) => v.name === dialog?.volume);

  return (
    <div className="opfs-mock" data-theme={theme}>
      {!runtime && (
        <div className="mock-host">
          <header className="host-header">
            <div className="host-brand">
              <span className="host-mark">w</span> workspace<span className="host-tag">local first</span>
            </div>
            <span className="mock-label">INTERACTION PROTOTYPE · SIMULATED DATA</span>
            <button onClick={() => window.location.reload()}>Reset prototype</button>
          </header>
          <main className="host-main">
            <div className="host-kicker">YOUR APPLICATION, STILL RUNNING</div>
            <h1>
              A little room
              <br />
              to work things out.
            </h1>
            <p>Your documents live in your browser. Open the volume explorer to explore the storage underneath.</p>
            <div className="host-cards">
              {['Launch notes', 'Design system', 'Weekend ideas'].map((text, i) => (
                <article key={text}>
                  <FileText size={22} />
                  <h2>{text}</h2>
                  <p>
                    {
                      [
                        'A few things worth getting right.',
                        'Small details. Consistent choices.',
                        'Make something useful.',
                      ][i]
                    }
                  </p>
                  <span>Edited {i + 1} hours ago</span>
                </article>
              ))}
            </div>
            <section className="scenario-box">
              <div>
                <span className="host-kicker">TRY THE CONNECTION MODEL</span>
                <h2>What happens while the panel is open?</h2>
              </div>
              <div className="scenario-actions">
                <button onClick={addFromApplication}>
                  <Plus size={15} /> App creates a volume
                </button>
                <button onClick={loseOwner}>App owner disappears</button>
                <button
                  onClick={() => {
                    updateVolume('workspace.bin', (v) => ({ ...v, state: 'application', connection: 'none' }));
                    setWritable((all) => ({ ...all, 'workspace.bin': false }));
                    setNotice('Application owner returned with a new session. Reconnect explicitly.');
                  }}
                >
                  App owner returns
                </button>
              </div>
              <p>
                Open the panel, create a volume here, then find it in the volume menu. Try losing and restoring the
                application owner. Real OPFS, storage workers, archives, and just-bash are not connected.
              </p>
            </section>
          </main>
          <footer className="host-footer">
            <span>Mock host application</span>
            <span>All changes reset when you reload this page.</span>
          </footer>
        </div>
      )}
      <button
        ref={launcher}
        className="opfs-launcher"
        aria-label={open ? 'Hide OPFS VFS Volume Explorer' : 'Open OPFS VFS Volume Explorer'}
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        onClick={() => (open ? closePanel() : setOpen(true))}
      >
        <OpfsLogo size={22} />
        <span>OPFS</span>
        <span className="launcher-dot" />
      </button>
      {open && (
        <section
          ref={panel}
          id={`${id}-panel`}
          className="debug-panel"
          data-dock={dock}
          data-narrow={narrow}
          data-tab={mobileTab}
          role="dialog"
          aria-modal="false"
          aria-labelledby={`${id}-title`}
          tabIndex={-1}
          style={geometry}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !dialog && !fileRequest) {
              event.stopPropagation();
              closePanel();
            }
          }}
        >
          <header className="panel-titlebar">
            <div
              className="drag-title"
              role="button"
              tabIndex={0}
              aria-label="Move floating panel with arrow keys"
              onPointerDown={(event) => startPointer(event, 'move')}
              onKeyDown={(event) => {
                const amount = event.shiftKey ? 50 : 15;
                const offsets: Record<string, [number, number]> = {
                  ArrowLeft: [-amount, 0],
                  ArrowRight: [amount, 0],
                  ArrowUp: [0, -amount],
                  ArrowDown: [0, amount],
                };
                if (dock === 'floating' && offsets[event.key]) {
                  event.preventDefault();
                  const [dx, dy] = offsets[event.key];
                  setRect(clampRect({ ...rect, x: rect.x + dx, y: rect.y + dy }, viewport.width, viewport.height));
                }
              }}
            >
              <Grip size={14} />
              <OpfsLogo size={20} />
              <h2 id={`${id}-title`} aria-label="OPFS VFS Volume Explorer">
                OPFS VFS <span>Volume Explorer</span>
              </h2>
              {!runtime && <span className="prototype-chip">MOCK</span>}
            </div>
            <div className="title-actions">
              <div className="dock-controls" aria-label="Panel docking">
                {layouts.map(([value, Icon]) => (
                  <button
                    key={value}
                    title={`Dock ${value}`}
                    aria-label={`Dock ${value}`}
                    aria-pressed={dock === value}
                    onClick={() => setDock(value)}
                  >
                    <Icon size={15} />
                  </button>
                ))}
              </div>
              <button
                title="Reset panel layout"
                aria-label="Reset panel layout"
                onClick={() => {
                  setDock('floating');
                  setRect(
                    clampRect(
                      { x: (viewport.width - 1080) / 2, y: 100, width: 1080, height: 720 },
                      viewport.width,
                      viewport.height,
                    ),
                  );
                }}
              >
                <RefreshCw size={14} />
              </button>
              <button aria-label="Toggle panel theme" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
                {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
              </button>
              <button aria-label="Close volume explorer" onClick={closePanel}>
                <X size={18} />
              </button>
            </div>
          </header>
          <div className="volume-toolbar">
            <div className="volume-picker">
              <HardDrive size={17} />
              <Select.Root
                value={volume?.name ?? null}
                items={volumes.map((item) => ({ value: item.name, label: item.name }))}
                onValueChange={(value) => {
                  if (value !== null && value !== volume?.name) void selectVolume(value);
                }}
                disabled={volumes.length === 0}
              >
                <Select.Trigger className="volume-select-trigger" aria-label="Active volume">
                  <Select.Value placeholder={volumes.length ? 'Select a volume' : 'No volumes discovered'} />
                  <Select.Icon>
                    <ChevronDown size={14} />
                  </Select.Icon>
                </Select.Trigger>
                <Select.Portal>
                  <Select.Positioner
                    className="volume-select-positioner"
                    align="start"
                    alignItemWithTrigger={false}
                    side="bottom"
                    sideOffset={6}
                    collisionPadding={12}
                  >
                    <Select.Popup className="opfs-mock volume-select-menu" data-theme={theme}>
                      <Select.ScrollUpArrow className="volume-select-scroll">
                        <ChevronUp size={14} />
                      </Select.ScrollUpArrow>
                      <Select.List className="volume-select-list">
                        {volumes.map((v, index) => (
                          <Select.Item
                            key={v.name}
                            value={v.name}
                            label={v.name}
                            className="volume-select-item"
                            aria-label={v.name}
                            aria-describedby={`${id}-volume-status-${index}`}
                          >
                            <Select.ItemIndicator className="volume-select-check">
                              <Check size={14} />
                            </Select.ItemIndicator>
                            <Select.ItemText>{v.name}</Select.ItemText>
                            <small id={`${id}-volume-status-${index}`}>{status(v)}</small>
                          </Select.Item>
                        ))}
                      </Select.List>
                      <Select.ScrollDownArrow className="volume-select-scroll">
                        <ChevronDown size={14} />
                      </Select.ScrollDownArrow>
                    </Select.Popup>
                  </Select.Positioner>
                </Select.Portal>
              </Select.Root>
            </div>
            <span className={`connection-badge ${enabled ? 'online' : ''}`}>
              <span />
              {volume ? status(volume) : 'No volumes discovered'}
            </span>
            <div className="volume-actions">
              <button onClick={() => showDialog('new')} disabled={!!job}>
                <Plus size={15} /> New
              </button>
              <button onClick={() => showDialog('import')} disabled={!!job}>
                <ArrowDownToLine size={15} /> Import
              </button>
              <button onClick={() => showDialog('export')} disabled={!enabled || !!job}>
                <ArrowUpFromLine size={15} /> Export
              </button>
              <button
                aria-label="Refresh discovered volumes"
                title="Refresh discovered volumes"
                onClick={() => void refreshFiles()}
              >
                <RefreshCw size={15} />
              </button>
              <button
                aria-label="Volume details"
                title="Volume details"
                disabled={!volume}
                onClick={() => showDialog('details')}
              >
                <CircleHelp size={16} />
              </button>
            </div>
          </div>
          {enabled && (
            <div className="volume-access" aria-label="Volume write access">
              <div id={`${id}-write-access`}>
                <strong>{writeEnabled ? 'Read/write' : 'Read-only'}</strong>
                <span>
                  {writeEnabled
                    ? 'File actions and shell commands can change this volume.'
                    : 'Enable writes to create or edit files and folders, or run commands such as mkdir.'}
                </span>
              </div>
              {!runtime && volume?.connection === 'owned' ? (
                <span>Writes enabled</span>
              ) : (
                <button
                  className="access-toggle"
                  aria-pressed={writeEnabled}
                  aria-describedby={`${id}-write-access`}
                  onClick={() => {
                    runtime?.setWrites(active, !writable[active]);
                    setWritable((all) => ({ ...all, [active]: !all[active] }));
                    setNotice(`Writes ${writeEnabled ? 'disabled' : 'enabled'} for ${active}.`);
                  }}
                >
                  {writeEnabled ? 'Disable writes' : 'Enable writes'}
                </button>
              )}
            </div>
          )}
          <nav className="mobile-tabs" aria-label="Panel views">
            {['files', 'terminal', 'preview'].map((tab) => (
              <button key={tab} aria-pressed={mobileTab === tab} onClick={() => setMobileTab(tab)}>
                {tab}
              </button>
            ))}
          </nav>
          {!enabled ? (
            <div className="connection-empty">
              <Database size={34} />
              <h3>{volume ? status(volume) : 'Your volumes will appear here'}</h3>
              <p>
                {!volume
                  ? runtime
                    ? 'Volumes created by this origin appear automatically. You can also create a new volume here.'
                    : 'Create a mock volume, or use the application button to simulate automatic discovery.'
                  : volume.error
                    ? volume.error
                    : volume.state === 'application'
                      ? 'The owner is available. Connect to this new session to continue.'
                      : volume.state === 'disconnected'
                        ? 'The application owner disappeared. Drafts are preserved. No writes will be replayed.'
                        : volume.state === 'busy'
                          ? 'A holder is using this volume but does not expose a compatible attachment endpoint. No competing worker will start.'
                          : volume.state === 'available'
                            ? 'Connect to open this closed volume in a devtools worker.'
                            : 'This volume requires a compatible storage extension. It will not be opened automatically.'}
              </p>
              {volume && ['application', 'available', 'disconnected'].includes(volume.state) && (
                <button className="primary" onClick={() => selectVolume(active)}>
                  Connect to volume
                </button>
              )}
              <button onClick={() => showDialog('new')}>Create a new {runtime ? '' : 'mock '}volume</button>
            </div>
          ) : (
            <div
              className="panel-workspace"
              style={{ '--explorer-width': `${split}%`, '--terminal-height': `${terminalHeight}px` } as CSSProperties}
            >
              <div className="file-workspace">
                <aside className="explorer-pane">
                  <div className="pane-heading">
                    <span>
                      ENTRIES <small>{volume?.files.length}</small>
                    </span>
                    <div className="file-create-actions">
                      <button
                        className="text-action"
                        disabled={!writeEnabled}
                        title={writeEnabled ? undefined : 'Choose Enable writes above to create files and folders.'}
                        onClick={() => setFileRequest({ volume: active, path: directory, kind: 'file' })}
                      >
                        + File
                      </button>
                      <button
                        className="text-action"
                        disabled={!writeEnabled}
                        title={writeEnabled ? undefined : 'Choose Enable writes above to create files and folders.'}
                        onClick={() => setFileRequest({ volume: active, path: directory, kind: 'folder' })}
                      >
                        + Folder
                      </button>
                      <button
                        className="text-action"
                        disabled={
                          !writeEnabled || !clipboard || (!!runtime && clipboard.cut && clipboard.volume !== active)
                        }
                        onClick={() => {
                          if (clipboard)
                            void fileAction('paste', { path: directory, kind: 'directory', content: '', modified: 0 });
                        }}
                      >
                        Paste
                      </button>
                    </div>
                  </div>
                  <div className="file-search">
                    <Search size={14} />
                    <input
                      aria-label="Search filenames and paths"
                      placeholder="Search names or paths…"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                    <kbd>⌕</kbd>
                  </div>
                  <div className="explorer-path">
                    <Folder size={13} />
                    <button
                      className="text-action"
                      aria-label="Parent folder"
                      disabled={directory === '/'}
                      onClick={() => {
                        setDirectories((all) => ({ ...all, [active]: parentPath(directory) }));
                        setSearch('');
                      }}
                    >
                      ↑
                    </button>
                    <span>{search ? 'Search results' : directory}</span>
                    <select aria-label="Sort files" value={sort} onChange={(event) => setSort(event.target.value)}>
                      <option value="name">Name A-Z</option>
                      <option value="modified">Modified newest</option>
                      <option value="size">Size largest</option>
                      <option disabled value="created">
                        Created: not stored
                      </option>
                    </select>
                  </div>
                  <div className="file-table-scroll">
                    <table className="file-table">
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>Size</th>
                          <th>Modified</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((entry) => (
                          <tr key={entry.path} data-selected={currentFile?.path === entry.path}>
                            <td>
                              <FileActions
                                name={entry.path}
                                directory={entry.kind === 'directory'}
                                writable={writeEnabled}
                                pasteable={!!clipboard && (!runtime || !clipboard.cut || clipboard.volume === active)}
                                editable={entry.kind !== 'directory' && canEdit(entry)}
                                container={panel.current?.parentElement ?? null}
                                onAction={(action) => fileAction(action, entry)}
                              >
                                <button
                                  onClick={() => fileAction('preview', entry)}
                                  aria-pressed={currentFile?.path === entry.path}
                                >
                                  {entry.kind === 'directory' ? (
                                    <Folder size={15} />
                                  ) : entry.path.endsWith('.json') || entry.path.endsWith('.svg') ? (
                                    <FileCode2 size={15} />
                                  ) : (
                                    <FileText size={15} />
                                  )}
                                  <span>{search ? entry.path.slice(1) : entry.path.split('/').at(-1)}</span>
                                </button>
                              </FileActions>
                            </td>
                            <td>{entry.kind === 'directory' ? 'Folder' : size(entry.size ?? fileSize(entry))}</td>
                            <td>
                              <time
                                dateTime={new Date(entry.modified).toISOString()}
                                title={new Date(entry.modified).toLocaleString()}
                              >
                                {new Date(entry.modified).toLocaleDateString('en', { month: 'short', day: '2-digit' })}{' '}
                                ·{' '}
                                {new Date(entry.modified).toLocaleTimeString([], {
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })}
                              </time>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {!rows.length && (
                      <p className="pane-empty">
                        {search
                          ? 'No files match this path search.'
                          : writeEnabled
                            ? 'This folder is empty. Use + File or + Folder to add entries.'
                            : 'This folder is empty. Enable writes to add files or folders.'}
                      </p>
                    )}
                  </div>
                  <div className="explorer-foot">
                    {rows.length} entries · filename/path search
                    <span title="Current VFS metadata stores no creation time">No creation dates</span>
                  </div>
                </aside>
                <div
                  className="inner-divider vertical"
                  role="separator"
                  aria-label="Resize explorer"
                  aria-orientation="vertical"
                  aria-valuenow={Math.round(split)}
                  aria-valuemin={30}
                  aria-valuemax={70}
                  tabIndex={0}
                  onPointerDown={(event) => startPointer(event, 'split')}
                  onKeyDown={(event) => {
                    if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
                      event.preventDefault();
                      setSplit(Math.max(30, Math.min(70, split + (event.key === 'ArrowLeft' ? -3 : 3))));
                    }
                  }}
                />
                <Tabs.Root
                  value={previewMode}
                  onValueChange={(value) => setPreviewSource(value === 'source')}
                  render={<article className="preview-pane" />}
                >
                  <div className="pane-heading preview-heading">
                    <Tabs.List className="preview-tabs" aria-label="File view" activateOnFocus>
                      <Tabs.Tab value="preview" disabled={!currentFile}>
                        Preview
                      </Tabs.Tab>
                      <Tabs.Tab value="source" disabled={!sourceAvailable}>
                        Editor
                      </Tabs.Tab>
                    </Tabs.List>
                    {currentFile &&
                      (dirty ? (
                        <button
                          className="preview-save"
                          disabled={!writeEnabled || saving}
                          title={!writeEnabled ? 'Enable writes above to save changes.' : undefined}
                          onClick={() => void saveCurrentFile()}
                        >
                          {saving ? 'Saving…' : 'Save'}
                        </button>
                      ) : (
                        <span className="save-status">No changes</span>
                      ))}
                  </div>
                  <Tabs.Panel value={previewMode} className="preview-content">
                    {currentFile ? (
                      <>
                        <div className="preview-path">
                          <File size={13} />
                          {currentFile.path}
                          <span>{size(currentFile.size ?? fileSize(currentFile))}</span>
                        </div>
                        {currentFile.error ? (
                          <p role="alert" className="fp-empty">
                            {currentFile.error}
                          </p>
                        ) : runtime && !currentFile.loaded ? (
                          <p>Loading file…</p>
                        ) : previewMode === 'source' ? (
                          <div className="source-editor">
                            <Suspense fallback={<p>Loading editor…</p>}>
                              <TextEditor
                                key={draftKey}
                                path={currentFile.path}
                                readOnly={!writeEnabled || saving}
                                value={drafts[draftKey] ?? currentFile.content}
                                onChange={(value) => {
                                  if (value === currentFile.content) {
                                    delete draftBases.current[draftKey];
                                    setDrafts((all) => {
                                      const next = { ...all };
                                      delete next[draftKey];
                                      return next;
                                    });
                                  } else {
                                    draftBases.current[draftKey] ??= currentFile;
                                    setDrafts((all) => ({ ...all, [draftKey]: value }));
                                  }
                                }}
                              />
                            </Suspense>
                          </div>
                        ) : (
                          <FilePreview
                            key={draftKey}
                            file={
                              drafts[draftKey] === undefined
                                ? currentFile
                                : { ...currentFile, content: drafts[draftKey] }
                            }
                            extensions={previewExtensions}
                          />
                        )}
                      </>
                    ) : (
                      <div className="pane-empty">
                        <FileText size={26} />
                        <p>Select a file to inspect its contents.</p>
                      </div>
                    )}
                  </Tabs.Panel>
                </Tabs.Root>
              </div>
              <div
                className="inner-divider horizontal"
                role="separator"
                aria-label="Resize terminal"
                aria-orientation="horizontal"
                aria-valuenow={terminalHeight}
                aria-valuemin={110}
                aria-valuemax={300}
                tabIndex={0}
                onPointerDown={(event) => startPointer(event, 'terminal')}
                onKeyDown={(event) => {
                  if (['ArrowUp', 'ArrowDown'].includes(event.key)) {
                    event.preventDefault();
                    setTerminalHeight(
                      Math.max(110, Math.min(300, terminalHeight + (event.key === 'ArrowUp' ? 20 : -20))),
                    );
                  }
                }}
              />
              <section className="terminal-pane">
                <div className="pane-heading">
                  <span>
                    <Terminal size={14} /> TERMINAL <small>just-bash{runtime ? '' : ' · simulated'}</small>
                  </span>
                </div>
                <pre ref={terminalOutput} className="terminal-output" aria-label="Terminal output">
                  {outputs[active] ||
                    (runtime
                      ? 'OPFS VFS terminal. Commands run against this volume. Write access is controlled above the file browser.'
                      : 'OPFS VFS mock terminal. Try ls, pwd, cat README.md, or help.\nConnected files are simulated; no commands reach your real storage.')}
                </pre>
                <form
                  className="terminal-command"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void runCommand();
                  }}
                >
                  <span title={terminalDirectory} aria-label="Current directory">
                    {terminalDirectory} $
                  </span>
                  <input
                    aria-label="Terminal command"
                    placeholder="Type a command…"
                    autoComplete="off"
                    value={command}
                    onChange={(event) => setCommand(event.target.value)}
                    onKeyDown={(event) => {
                      if (['ArrowUp', 'ArrowDown'].includes(event.key)) {
                        event.preventDefault();
                        historyIndex.current = Math.max(
                          0,
                          Math.min(history.length, historyIndex.current + (event.key === 'ArrowUp' ? -1 : 1)),
                        );
                        setCommand(history[historyIndex.current] || '');
                      }
                    }}
                  />
                  <button type="submit" disabled={working}>
                    Run <kbd>↵</kbd>
                  </button>
                </form>
              </section>
            </div>
          )}
          {job && (
            <div className="job-row" role="status">
              <span>{job.label}</span>
              <progress value={job.percent} max={100} />
              <span>{job.percent}%</span>
              <button
                onClick={() => {
                  clearInterval(cancelJob.current);
                  setJob(null);
                  setNotice(
                    'Simulation cancelled. No files were changed. Real imports may leave partial writes after application begins.',
                  );
                }}
              >
                Cancel simulation
              </button>
            </div>
          )}
          <footer className="panel-footer">
            <span className="status-dot" />
            <span>{volumes.length} discovered</span>
            <span>{connected} connected</span>
            <span className="footer-note" role="status">
              {notice}
            </span>
            <span className="memory-only">{runtime ? 'Origin-private storage' : 'Memory-only mock'}</span>
          </footer>
          <div
            className="outer-resize"
            data-dock={dock}
            role="separator"
            tabIndex={0}
            aria-label="Resize volume explorer"
            aria-orientation={dock === 'top' || dock === 'bottom' ? 'horizontal' : 'vertical'}
            aria-valuemin={320}
            aria-valuemax={dock === 'top' || dock === 'bottom' ? viewport.height : viewport.width}
            aria-valuenow={
              dock === 'floating'
                ? Math.round(visibleRect.width)
                : Math.min(dockSize, dock === 'top' || dock === 'bottom' ? viewport.height - 24 : viewport.width - 24)
            }
            onPointerDown={(event) => startPointer(event, 'resize')}
            onKeyDown={(event) => {
              if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
                event.preventDefault();
                const amount = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -20 : 20;
                if (dock === 'floating')
                  setRect(
                    clampRect(
                      {
                        ...rect,
                        width: rect.width + (event.key === 'ArrowLeft' || event.key === 'ArrowRight' ? amount : 0),
                        height: rect.height + (event.key === 'ArrowUp' || event.key === 'ArrowDown' ? amount : 0),
                      },
                      viewport.width,
                      viewport.height,
                    ),
                  );
                else setDockSize(Math.max(320, dockSize + amount));
              }
            }}
          />
        </section>
      )}
      <dialog
        ref={modal}
        className="debug-modal"
        onCancel={(event) => {
          event.preventDefault();
          setDialog(null);
        }}
        aria-labelledby={`${id}-modal-title`}
      >
        {dialog && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submitDialog();
            }}
          >
            <div className="modal-heading">
              <Database size={21} />
              <button type="button" aria-label="Close dialog" onClick={() => setDialog(null)}>
                <X size={18} />
              </button>
            </div>
            <h2 id={`${id}-modal-title`}>
              {
                {
                  new: 'Create a volume',
                  import: 'Import a workspace',
                  export: 'Export a workspace',
                  delete: 'Delete a closed volume',
                  details: 'Volume details',
                }[dialog.kind]
              }
            </h2>
            <p className="modal-subtitle">
              {dialog.kind === 'details'
                ? dialog.volume
                : runtime
                  ? 'Changes affect real browser storage on this origin.'
                  : 'Interaction preview. This action only changes simulated data.'}
            </p>
            {dialog.kind === 'new' && (
              <label>
                Volume name
                <input
                  autoComplete="off"
                  aria-label="New volume name"
                  placeholder="my-workspace"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
                <small>.bin is added automatically. The new volume appears in discovery.</small>
              </label>
            )}
            {dialog.kind === 'import' && (
              <>
                {runtime ? (
                  <label>
                    ZIP archive
                    <input
                      type="file"
                      accept=".zip,application/zip"
                      aria-label="ZIP archive"
                      onChange={(event) => setArchiveFile(event.target.files?.[0])}
                    />
                  </label>
                ) : (
                  <div className="archive-fixture">
                    <ArrowDownToLine size={22} />
                    <div>
                      <strong>example-workspace.zip</strong>
                      <span>Simulated archive · 1 file · 84 B</span>
                    </div>
                  </div>
                )}
                <label>
                  Destination
                  <select
                    aria-label="Import destination"
                    value={importTarget}
                    onChange={(event) => setImportTarget(event.target.value)}
                  >
                    <option value="new">Create a new volume</option>
                    {!runtime &&
                      volumes.map((v) => (
                        <option key={v.name} value={v.name}>
                          {v.name}
                        </option>
                      ))}
                  </select>
                </label>
                {importTarget === 'new' && (
                  <label>
                    New volume name
                    <input
                      aria-label="Import volume name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </label>
                )}
                <div className="info-box">
                  Conflict policy: stop without overwriting. Replacing a volume is deferred. An existing destination
                  requires exclusive application coordination.
                </div>
              </>
            )}
            {dialog.kind === 'export' && (
              <>
                <label>
                  Source volume
                  <input readOnly value={dialog.volume} />
                </label>
                <label>
                  Root directory
                  <input readOnly value="/" />
                </label>
                <div className="info-box">
                  Live copy: the application has not supplied exclusive coordination. Files may represent different
                  moments.{' '}
                  {runtime
                    ? 'The downloaded ZIP is a live copy, not a consistent application snapshot.'
                    : 'This mock simulates progress without creating a ZIP.'}
                </div>
              </>
            )}
            {dialog.kind === 'delete' && (
              <>
                <p>
                  Type <strong>{dialog.volume}</strong> to remove this closed volume
                  {runtime ? ' from OPFS' : ' from the mock'}. Deletion is irreversible.
                </p>
                <input
                  aria-label="Confirm volume name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
                <div className="info-box">
                  Force-delete is not available. An open or unknown holder blocks deletion.
                </div>
              </>
            )}
            {dialog.kind === 'details' && (
              <>
                <div className="details-tabs">
                  <button type="button" aria-pressed={detailsTab === 'volume'} onClick={() => setDetailsTab('volume')}>
                    This volume
                  </button>
                  <button type="button" aria-pressed={detailsTab === 'all'} onClick={() => setDetailsTab('all')}>
                    All discovered volumes
                  </button>
                </div>
                {detailsTab === 'volume' ? (
                  <>
                    <dl className="volume-details">
                      <dt>Connection</dt>
                      <dd>{dialogVolume ? status(dialogVolume) : 'Missing'}</dd>
                      <dt>Known holder</dt>
                      <dd>
                        {dialogVolume?.connection === 'passive' || dialogVolume?.state === 'application'
                          ? runtime
                            ? 'Compatible application worker'
                            : 'Application tab · session app-01'
                          : dialogVolume?.connection === 'owned'
                            ? 'Devtools worker · retained'
                            : dialogVolume?.state === 'busy'
                              ? 'Unknown client · physical lock held'
                              : 'No holder observed'}
                      </dd>
                      <dt>Stored creation date</dt>
                      <dd>Unavailable</dd>
                      <dt>Storage</dt>
                      <dd>{runtime ? 'Origin Private File System' : 'Simulated, in memory'}</dd>
                      <dt>OPFS volume size</dt>
                      <dd>
                        {dialogVolume?.storageBytes === undefined
                          ? 'Unavailable'
                          : `${size(dialogVolume.storageBytes)} (${dialogVolume.storageBytes.toLocaleString()} bytes)`}
                      </dd>
                    </dl>
                    <p className="info-box">
                      Includes data, metadata, and journals. Updated during discovery; changes buffered in memory are
                      excluded. Live writes can change the total while it is measured.
                    </p>
                    <div className="info-box">
                      {dialogVolume?.connection === 'owned'
                        ? 'This worker stays alive until the page ends, including when you hide the panel. It cannot be deleted by this installation while retained.'
                        : 'The panel does not own the application worker. Losing its session disconnects the attachment and preserves unsaved drafts.'}
                    </div>
                  </>
                ) : (
                  <div className="volume-list">
                    {volumes.map((v) => (
                      <div key={v.name}>
                        <Database size={15} />
                        <span>
                          <strong>{v.name}</strong>
                          <small>{status(v)}</small>
                        </span>
                        <button
                          type="button"
                          aria-label={`Delete ${v.name}`}
                          disabled={!canDelete(v)}
                          title={
                            canDelete(v)
                              ? 'Delete closed volume'
                              : 'Cannot delete a connected, busy, or protected volume'
                          }
                          onClick={() => {
                            setName('');
                            setDialog({ kind: 'delete', volume: v.name });
                          }}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
            {dialogError && (
              <p className="dialog-error" role="alert">
                {dialogError}
              </p>
            )}
            <footer className="modal-footer">
              <button data-cancel type="button" onClick={() => setDialog(null)}>
                {dialog.kind === 'details' ? 'Done' : 'Cancel'}
              </button>
              {dialog.kind !== 'details' && (
                <button
                  type="submit"
                  className={dialog.kind === 'delete' ? 'danger' : 'primary'}
                  disabled={
                    working ||
                    (dialog.kind === 'delete' && (name !== dialog.volume || !dialogVolume || !canDelete(dialogVolume)))
                  }
                >
                  {
                    {
                      new: runtime ? 'Create volume' : 'Create mock volume',
                      import: runtime ? 'Import ZIP' : 'Simulate import',
                      export: runtime ? 'Download ZIP' : 'Simulate export',
                      delete: runtime ? 'Delete volume' : 'Delete mock volume',
                    }[dialog.kind]
                  }
                </button>
              )}
            </footer>
          </form>
        )}
      </dialog>
      {fileRequest && (
        <FileOperationDialog
          simulated={!runtime}
          request={fileRequest}
          onConfirm={mutateFiles}
          onClose={() => {
            setFileRequest(null);
            panel.current?.focus();
          }}
        />
      )}
    </div>
  );
}
