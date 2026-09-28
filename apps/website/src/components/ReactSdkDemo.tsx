import { FilePreview } from '@opfs-vfs/file-preview';
import '@opfs-vfs/file-preview/styles.css';
import { VolumeProvider, useFile, useFileContent, useFolder, useVolume, useVolumeClient } from '@opfs-vfs/react';
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import './react-sdk-demo.css';

const volumeName = 'demo-file-inbox.bin';
const todoVolumeName = 'demo-todo-list.bin';
const inboxPath = '/inbox';
const todoPath = '/todo-lists';
const previewLimit = 16 * 1024 * 1024;
const imageExtensions = new Set(['avif', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp']);
const imageMime: Record<string, string> = {
  avif: 'image/avif',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'That file operation failed.';
}

function isConflict(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'details' in error &&
    error.details &&
    typeof error.details === 'object' &&
    'code' in error.details &&
    error.details.code === 'EBUSY'
  );
}

function isAlreadyExists(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'details' in error &&
    error.details &&
    typeof error.details === 'object' &&
    'code' in error.details &&
    error.details.code === 'EEXIST'
  );
}

function validName(value: string) {
  const name = value.trim();
  return name && name !== '.' && name !== '..' && !/[\\/\0]/.test(name) ? name : null;
}

function pathFor(name: string) {
  return `${inboxPath}/${name}`;
}

function extension(name: string) {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ImageThumbnail({ name }: { name: string }) {
  const content = useFileContent(pathFor(name), { format: 'bytes' });
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!content.data) return;
    const next = URL.createObjectURL(new Blob([content.data.slice()], { type: imageMime[extension(name)] }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [content.data]);
  return url ? <img className="react-inbox-thumbnail" src={url} alt="" /> : <span className="react-inbox-thumbnail" />;
}

function FileRow({ name, selected, onSelect }: { name: string; selected: boolean; onSelect: () => void }) {
  const info = useFile(pathFor(name));
  return (
    <li>
      <button type="button" className={selected ? 'selected' : ''} onClick={onSelect} aria-pressed={selected}>
        {imageExtensions.has(extension(name)) ? (
          <ImageThumbnail name={name} />
        ) : (
          <span className="react-inbox-file-icon">File</span>
        )}
        <span>
          <strong>{name}</strong>
          <small>{info.data ? formatBytes(info.data.size) : 'Loading…'}</small>
        </span>
      </button>
    </li>
  );
}

function previewFile(path: string, bytes: Uint8Array) {
  if (imageExtensions.has(extension(path))) return { path, content: '', bytes };
  try {
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return content.includes('\0') ? { path, content: '', bytes } : { path, content };
  } catch {
    return { path, content: '', bytes };
  }
}

function Inbox() {
  const volume = useVolume();
  const fs = useVolumeClient();
  const folder = useFolder(inboxPath);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const selectedPath = selectedName ? pathFor(selectedName) : inboxPath;
  const selected = useFileContent(selectedPath, {
    format: 'bytes',
    enabled: selectedName !== null,
  });
  const [rename, setRename] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('Opening your local inbox…');
  const files = useMemo(
    () => (folder.data ?? []).filter((entry) => entry.is_file).sort((a, b) => a.name.localeCompare(b.name)),
    [folder.data],
  );

  useEffect(() => {
    if (!fs || volume.status !== 'ready') return;
    void fs
      .mkdir(inboxPath, { recursive: true })
      .then(() => fs.sync())
      .then(folder.refresh)
      .then(() =>
        setNotice((current) => (current === 'Opening your local inbox…' ? 'Your local inbox is ready.' : current)),
      )
      .catch((error) => setNotice(errorMessage(error)));
  }, [folder.refresh, fs, volume.status]);

  useEffect(() => {
    if (selectedName && !files.some((file) => file.name === selectedName)) setSelectedName(files[0]?.name ?? null);
    else if (!selectedName && files[0]) setSelectedName(files[0].name);
  }, [files, selectedName]);

  useEffect(() => setRename(selectedName ?? ''), [selectedName]);

  const addFiles = async (incoming: FileList | File[]) => {
    if (!fs || volume.status !== 'ready' || busy) return;
    const uploads = Array.from(incoming);
    const invalid = uploads.find((file) => !validName(file.name));
    const tooLarge = uploads.find((file) => file.size > previewLimit);
    if (invalid) return setNotice(`${invalid.name || 'This file'} needs a simple file name.`);
    if (tooLarge) return setNotice(`${tooLarge.name} is larger than the 16 MiB inbox limit.`);
    if (!uploads.length) return;
    setBusy(true);
    let saved = 0;
    let firstAdded = '';
    try {
      const used = new Set(files.map((file) => file.name));
      for (const file of uploads) {
        const original = validName(file.name)!;
        const dot = original.lastIndexOf('.');
        const stem = dot > 0 ? original.slice(0, dot) : original;
        const suffix = dot > 0 ? original.slice(dot) : '';
        const bytes = new Uint8Array(await file.arrayBuffer());
        for (let number = 1; ; number++) {
          const name = number === 1 ? original : `${stem} (${number})${suffix}`;
          if (used.has(name)) continue;
          try {
            await fs.writeFileBuffer(pathFor(name), bytes, { exclusive: true });
          } catch (error) {
            if (isAlreadyExists(error)) {
              used.add(name);
              continue;
            }
            throw error;
          }
          await fs.sync();
          used.add(name);
          firstAdded ||= name;
          saved++;
          break;
        }
      }
      await folder.refresh();
      setSelectedName(firstAdded || selectedName);
      setNotice(`${saved === 1 ? 'File added' : `${saved} files added`} and saved locally.`);
    } catch (error) {
      await folder.refresh().catch(() => {});
      setNotice(
        saved
          ? `${saved} file${saved === 1 ? '' : 's'} saved; the next save may be uncertain: ${errorMessage(error)}`
          : errorMessage(error),
      );
    } finally {
      setBusy(false);
    }
  };

  const pickFiles = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) void addFiles(event.target.files);
    event.target.value = '';
  };
  const dropFiles = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    void addFiles(event.dataTransfer.files);
  };
  const renameFile = async () => {
    if (!fs || !selectedName) return;
    const next = validName(rename);
    if (!next) return setNotice('Use a simple file name without slashes.');
    if (next === selectedName) return;
    setBusy(true);
    try {
      await fs.renameNoReplace(pathFor(selectedName), pathFor(next));
      await fs.sync();
      await folder.refresh();
      setSelectedName(next);
      setNotice('File renamed.');
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const deleteFile = async () => {
    if (!fs || !selectedName) return;
    setBusy(true);
    try {
      await fs.unlink(selectedPath);
      await fs.sync();
      setSelectedName(null);
      await folder.refresh();
      setNotice('File deleted.');
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const download = () => {
    if (!selectedName || !selected.data) return;
    const url = URL.createObjectURL(new Blob([selected.data.slice()]));
    const link = document.createElement('a');
    link.href = url;
    link.download = selectedName;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <section className="react-inbox" aria-labelledby="react-inbox-heading">
      <header className="react-inbox-heading">
        <div>
          <p className="kicker">React SDK demo</p>
          <h2 id="react-inbox-heading">Local file inbox</h2>
          <p>Drop files here and they stay in this browser. Open another tab to see live changes.</p>
        </div>
        <a className="react-inbox-open" href={window.location.href} target="_blank" rel="noreferrer">
          Open in another tab
        </a>
      </header>
      <div
        className="react-inbox-dropzone"
        onDragOver={(event) => event.preventDefault()}
        onDrop={dropFiles}
        aria-label="Drop files here"
      >
        <strong>Drop files here</strong>
        <span>or</span>
        <label className="react-inbox-add">
          Add files
          <input type="file" multiple onChange={pickFiles} disabled={busy || volume.status !== 'ready'} />
        </label>
      </div>
      <p className="react-inbox-status" role="status" aria-live="polite">
        {volume.status === 'ready' ? notice : `Inbox ${volume.status}…`}
      </p>
      {(volume.error || folder.error || selected.error) && (
        <p className="react-inbox-error" role="alert">
          {volume.error?.message ?? folder.error?.message ?? selected.error?.message}
        </p>
      )}
      <div className="react-inbox-layout">
        <ul className="react-inbox-files" aria-label="Inbox files">
          {files.map((file) => (
            <FileRow
              key={file.name}
              name={file.name}
              selected={file.name === selectedName}
              onSelect={() => setSelectedName(file.name)}
            />
          ))}
          {folder.status === 'success' && !files.length && <li className="react-inbox-empty">No files yet.</li>}
        </ul>
        <div className="react-inbox-preview">
          {selectedName && selected.data ? (
            <>
              <div className="react-inbox-file-actions">
                <button type="button" onClick={download}>
                  Download
                </button>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void renameFile();
                  }}
                >
                  <label htmlFor="react-inbox-rename">Rename</label>
                  <input
                    id="react-inbox-rename"
                    value={rename}
                    onChange={(event) => setRename(event.target.value)}
                    disabled={busy}
                  />
                  <button type="submit" disabled={busy || !rename.trim()}>
                    Save
                  </button>
                </form>
                <button type="button" className="react-inbox-danger" onClick={() => void deleteFile()} disabled={busy}>
                  Delete
                </button>
              </div>
              <FilePreview file={previewFile(selectedPath, selected.data)} />
            </>
          ) : (
            <p className="react-inbox-empty">
              {selected.error ? 'Could not load this file.' : 'Select a file to preview it.'}
            </p>
          )}
        </div>
      </div>
      <details className="react-inbox-diagnostics">
        <summary>Storage details</summary>
        <p>
          Volume: {volumeName}. Transport: {volume.transport ?? 'opening'}.
        </p>
      </details>
    </section>
  );
}

type Todo = { title: string; description: string; tasks: { text: string; done: boolean }[] };
type TodoBaseline = { bytes: Uint8Array; text: string; generation: string | null };

const emptyTodo = (): Todo => ({ title: 'Untitled list', description: '', tasks: [] });

function todoText(todo: Todo) {
  const tasks = todo.tasks.map((task) => `- [${task.done ? 'x' : ' '}] ${task.text}`).join('\n');
  return `---\ntitle: ${JSON.stringify(todo.title)}\ndescription: ${JSON.stringify(todo.description)}\n---\n${tasks ? `${tasks}\n` : ''}`;
}

function decodeTodo(bytes: Uint8Array) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function parseTodo(text: string): Todo | null {
  const match = /^---\ntitle: (.+)\ndescription: (.+)\n---\n([\s\S]*)$/.exec(text);
  if (!match || (match[3] && !match[3].endsWith('\n'))) return null;
  try {
    const title = JSON.parse(match[1]);
    const description = JSON.parse(match[2]);
    const lines = match[3] ? match[3].slice(0, -1).split('\n') : [];
    const tasks = lines.map((line) => /^- \[([ xX])\] (.+)$/.exec(line));
    if (
      typeof title !== 'string' ||
      typeof description !== 'string' ||
      /[\r\n]/.test(title) ||
      tasks.some((task) => task?.[2].includes('\r')) ||
      tasks.some((task) => !task)
    )
      return null;
    return {
      title,
      description,
      tasks: tasks.map((task) => ({ done: task![1].toLowerCase() === 'x', text: task![2] })),
    };
  } catch {
    return null;
  }
}

function TodoLists({
  onDirtyChange,
  onBusyChange,
}: {
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const volume = useVolume();
  const fs = useVolumeClient();
  const folder = useFolder(todoPath);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const content = useFileContent(selectedPath ?? todoPath, { format: 'bytes', enabled: selectedPath !== null });
  const [draft, setDraft] = useState<Todo>(emptyTodo);
  const [baseline, setBaseline] = useState<TodoBaseline | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [taskText, setTaskText] = useState('');
  const [saving, setSaving] = useState(false);
  const [autosaveBlocked, setAutosaveBlocked] = useState(false);
  const [notice, setNotice] = useState('Opening your local lists…');
  const draftRef = useRef(draft);
  const baselineRef = useRef(baseline);
  const selectedPathRef = useRef(selectedPath);
  const savingRef = useRef(saving);
  const observedTextRef = useRef<string | null>(null);
  const staleTextRef = useRef<string | null>(null);
  draftRef.current = draft;
  baselineRef.current = baseline;
  selectedPathRef.current = selectedPath;
  savingRef.current = saving;
  const lists = useMemo(
    () =>
      (folder.data ?? [])
        .filter((entry) => entry.is_file && entry.name.endsWith('.md'))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [folder.data],
  );
  const dirty = baseline !== null && todoText(draft) !== baseline.text;

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => onBusyChange(saving), [saving, onBusyChange]);

  useEffect(() => {
    if (!fs || volume.status !== 'ready') return;
    void fs
      .mkdir(todoPath, { recursive: true })
      .then(() => fs.sync())
      .then(folder.refresh)
      .then(() =>
        setNotice((current) => (current === 'Opening your local lists…' ? 'Your local lists are ready.' : current)),
      )
      .catch((error) => setNotice(errorMessage(error)));
  }, [folder.refresh, fs, volume.status]);

  useEffect(() => {
    if (saving) return;
    if (selectedPath && !lists.some((list) => `${todoPath}/${list.name}` === selectedPath)) {
      if (dirty) {
        setAutosaveBlocked(true);
        setNotice(
          'This list changed outside the editor. Your draft is still here; reload or discard it before leaving.',
        );
      } else setSelectedPath(lists[0] ? `${todoPath}/${lists[0].name}` : null);
    } else if (!selectedPath && lists[0]) setSelectedPath(`${todoPath}/${lists[0].name}`);
  }, [saving, dirty, lists, selectedPath]);

  useEffect(() => {
    if (!selectedPath || !content.data) return;
    if (savingRef.current) return;
    const text = decodeTodo(content.data);
    if (text === staleTextRef.current) {
      staleTextRef.current = null;
      return;
    }
    if (text === observedTextRef.current) return;
    observedTextRef.current = text;
    const saved = baselineRef.current;
    if (text === saved?.text) return;
    if (saved && todoText(draftRef.current) !== saved.text) {
      setAutosaveBlocked(true);
      setNotice('A newer saved version is available. Reload it before saving your draft.');
      return;
    }
    const parsed = text === null ? null : parseTodo(text);
    setBaseline({ bytes: content.data.slice(), text: text ?? '', generation: volume.generation });
    setInvalid(parsed === null);
    if (parsed) setDraft(parsed);
  }, [content.data, saving, selectedPath, volume.generation]);

  const selectList = (path: string) => {
    if (savingRef.current) return;
    if (dirty) return setNotice('Wait for autosave or reload your draft before opening another list.');
    setSelectedPath(path);
    setBaseline(null);
    setInvalid(false);
    setAutosaveBlocked(false);
    observedTextRef.current = null;
    setDraft(emptyTodo());
    setNotice('Loading list…');
  };

  const newList = async () => {
    if (!fs || savingRef.current || dirty || autosaveBlocked) {
      if (dirty || autosaveBlocked) setNotice('Wait for autosave or reload your draft before creating another list.');
      return;
    }
    savingRef.current = true;
    setSaving(true);
    let wrote = false;
    try {
      const text = todoText(emptyTodo());
      const highest = lists.reduce(
        (max, list) => Math.max(max, Number(/^list-(\d+)\.md$/.exec(list.name)?.[1]) || 0),
        0,
      );
      let path = '';
      for (let number = highest + 1; ; number++) {
        path = `${todoPath}/list-${String(number).padStart(3, '0')}.md`;
        try {
          await fs.writeFileBuffer(path, new TextEncoder().encode(text), { exclusive: true });
          wrote = true;
          break;
        } catch (error) {
          if (!isAlreadyExists(error)) throw error;
        }
      }
      await fs.sync();
      await folder.refresh();
      setSelectedPath(path);
      setBaseline({ bytes: new TextEncoder().encode(text), text, generation: volume.generation });
      setInvalid(false);
      setAutosaveBlocked(false);
      observedTextRef.current = text;
      setDraft(emptyTodo());
      setNotice('New list saved.');
    } catch (error) {
      setNotice(
        wrote
          ? 'New list may have reached storage but did not finish syncing. Reload before retrying.'
          : errorMessage(error),
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const save = useCallback(
    async (nextDraft = draftRef.current) => {
      const saved = baselineRef.current;
      const path = selectedPathRef.current;
      if (!fs || !path || savingRef.current || !saved || invalid || autosaveBlocked) return;
      if (saved.generation !== volume.generation)
        return setNotice('The storage connection changed. Reload the saved version before saving your draft.');
      const next = todoText(nextDraft);
      if (next === saved.text) return;
      savingRef.current = true;
      setSaving(true);
      let wrote = false;
      try {
        const bytes = new TextEncoder().encode(next);
        await fs.writeFileBuffer(path, bytes, { expected: saved.bytes });
        wrote = true;
        await fs.sync();
        if (selectedPathRef.current === path && baselineRef.current === saved) {
          const nextBaseline = { bytes, text: next, generation: volume.generation };
          staleTextRef.current = saved.text;
          baselineRef.current = nextBaseline;
          setBaseline(nextBaseline);
        }
        await content.refresh();
        setNotice('List saved locally.');
      } catch (error) {
        setAutosaveBlocked(true);
        setNotice(
          wrote
            ? 'Save may have reached storage but did not finish syncing. Reload the saved version before retrying.'
            : isConflict(error)
              ? 'This list changed in another tab. Your draft is still here; reload to use the saved version.'
              : errorMessage(error),
        );
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
    [autosaveBlocked, content.refresh, fs, invalid, volume.generation],
  );

  useEffect(() => {
    if (!dirty || saving || autosaveBlocked || invalid || !baseline || !fs) return;
    setNotice('Changes waiting to save…');
    const timer = window.setTimeout(() => void save(), 400);
    return () => window.clearTimeout(timer);
  }, [autosaveBlocked, baseline, draft, dirty, fs, invalid, save, saving]);

  const reload = async () => {
    if (!fs || !selectedPath || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const bytes = await fs.readFileBuffer(selectedPath);
      const text = decodeTodo(bytes);
      const parsed = text === null ? null : parseTodo(text);
      setBaseline({ bytes, text: text ?? '', generation: volume.generation });
      setInvalid(parsed === null);
      setAutosaveBlocked(false);
      observedTextRef.current = text;
      if (parsed) setDraft(parsed);
      await content.refresh();
      setNotice(
        parsed
          ? 'Reloaded the saved version.'
          : 'This Markdown file is not a todo list made by this demo and is read-only.',
      );
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const discardDraft = () => {
    if (savingRef.current) return;
    setAutosaveBlocked(false);
    setBaseline(null);
    setInvalid(false);
    setDraft(emptyTodo());
    setSelectedPath(null);
    observedTextRef.current = null;
    void folder.refresh();
    setNotice('Draft discarded.');
  };

  const deleteList = async () => {
    if (
      !fs ||
      !selectedPath ||
      savingRef.current ||
      dirty ||
      autosaveBlocked ||
      !window.confirm('Delete this todo list?')
    )
      return;
    savingRef.current = true;
    setSaving(true);
    let removed = false;
    try {
      await fs.unlink(selectedPath);
      removed = true;
      await fs.sync();
      setSelectedPath(null);
      setBaseline(null);
      setDraft(emptyTodo());
      observedTextRef.current = null;
      await folder.refresh();
      setNotice('List deleted.');
    } catch (error) {
      setAutosaveBlocked(true);
      setNotice(
        removed
          ? 'Delete may have reached storage but did not finish syncing. Reload before retrying.'
          : errorMessage(error),
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const addTask = () => {
    const text = taskText.trim();
    if (!text || /[\r\n]/.test(text)) return setNotice('Task text must stay on one line.');
    const next = { ...draft, tasks: [...draft.tasks, { text, done: false }] };
    setDraft(next);
    setTaskText('');
    void save(next);
  };

  const toggleTask = (index: number) => {
    const next = {
      ...draft,
      tasks: draft.tasks.map((task, taskIndex) => (taskIndex === index ? { ...task, done: !task.done } : task)),
    };
    setDraft(next);
    void save(next);
  };

  return (
    <section className="react-todos" aria-labelledby="react-todos-heading">
      <header className="react-inbox-heading">
        <div>
          <p className="kicker">React SDK demo</p>
          <h2 id="react-todos-heading">Local todo lists</h2>
          <p>Each list is a Markdown file. Open this view in another tab to see saved changes arrive live.</p>
        </div>
        <a
          className="react-inbox-open"
          href={`${window.location.pathname}?example=todos`}
          target="_blank"
          rel="noreferrer"
        >
          Open in another tab
        </a>
      </header>
      <p className="react-inbox-status" role="status" aria-live="polite">
        {volume.status === 'ready' ? notice : `Lists ${volume.status}…`}
      </p>
      {(volume.error || folder.error || content.error) && (
        <p className="react-inbox-error" role="alert">
          {volume.error?.message ?? folder.error?.message ?? content.error?.message}
        </p>
      )}
      <div className="react-todos-layout">
        <aside>
          <button
            type="button"
            className="react-todos-new"
            onClick={() => void newList()}
            disabled={saving || dirty || autosaveBlocked || volume.status !== 'ready'}
          >
            New list
          </button>
          <ul aria-label="Todo list files">
            {lists.map((list) => {
              const path = `${todoPath}/${list.name}`;
              return (
                <li key={path}>
                  <button
                    type="button"
                    className={path === selectedPath ? 'selected' : ''}
                    onClick={() => selectList(path)}
                    disabled={saving}
                  >
                    {list.name}
                  </button>
                </li>
              );
            })}
            {folder.status === 'success' && !lists.length && <li className="react-inbox-empty">No lists yet.</li>}
          </ul>
        </aside>
        <div className="react-todos-editor">
          {selectedPath && !invalid ? (
            <>
              <label>
                Title
                <input
                  value={draft.title}
                  onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
                />
              </label>
              <label>
                Description
                <textarea
                  value={draft.description}
                  onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
                />
              </label>
              <fieldset disabled={saving}>
                <legend>Tasks</legend>
                {draft.tasks.map((task, index) => (
                  <label className="react-todos-task" key={`${task.text}-${index}`}>
                    <input type="checkbox" checked={task.done} onChange={() => toggleTask(index)} />
                    {task.text}
                  </label>
                ))}
              </fieldset>
              <form
                className="react-todos-add"
                onSubmit={(event) => {
                  event.preventDefault();
                  addTask();
                }}
              >
                <label htmlFor="react-todos-new-task">Add task</label>
                <input
                  id="react-todos-new-task"
                  value={taskText}
                  onChange={(event) => setTaskText(event.target.value)}
                  disabled={saving}
                />
                <button type="submit" disabled={saving || !taskText.trim()}>
                  Add
                </button>
              </form>
              <div className="react-todos-actions">
                <button type="button" onClick={() => void deleteList()} disabled={saving || dirty || autosaveBlocked}>
                  Delete list
                </button>
                {(autosaveBlocked || invalid) && (
                  <button type="button" onClick={() => void reload()} disabled={saving}>
                    Reload saved
                  </button>
                )}
                {autosaveBlocked && (
                  <button type="button" onClick={discardDraft} disabled={saving}>
                    Discard draft
                  </button>
                )}
              </div>
              <pre className="react-todos-markdown" aria-label="Saved Markdown">
                {content.data ? (decodeTodo(content.data) ?? 'This file is not valid UTF-8.') : ''}
              </pre>
            </>
          ) : selectedPath ? (
            <>
              <p className="react-inbox-empty">
                This Markdown file is not a todo list made by this demo and is read-only.
              </p>
              <pre className="react-todos-markdown" aria-label="Saved Markdown">
                {content.data ? (decodeTodo(content.data) ?? 'This file is not valid UTF-8.') : ''}
              </pre>
            </>
          ) : (
            <p className="react-inbox-empty">Create a list to begin.</p>
          )}
        </div>
      </div>
    </section>
  );
}

function DemoDevtools() {
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    let panel: { unmount(): void } | undefined;
    void (async () => {
      try {
        await import('@opfs-vfs/devtools/styles.css');
        const { mountDevtools } = await import('@opfs-vfs/devtools');
        if (!active) return;
        panel = mountDevtools({
          initialOpen: false,
          initialTheme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
        });
      } catch (cause) {
        if (active) setError(errorMessage(cause));
      }
    })();
    return () => {
      active = false;
      panel?.unmount();
    };
  }, []);
  return error ? <span role="alert">{error}</span> : null;
}

export default function ReactSdkDemo() {
  const [example, setExample] = useState(() =>
    new URLSearchParams(window.location.search).get('example') === 'todos' ? 'todos' : 'inbox',
  );
  const [todoDirty, setTodoDirty] = useState(false);
  const [todoBusy, setTodoBusy] = useState(false);
  const switchExample = (next: 'inbox' | 'todos') => {
    if (next === example || (example === 'todos' && (todoDirty || todoBusy))) return;
    const url = new URL(window.location.href);
    if (next === 'todos') url.searchParams.set('example', 'todos');
    else url.searchParams.delete('example');
    window.history.replaceState(null, '', url);
    setExample(next);
  };
  return (
    <>
      <div className="react-demo-switcher" role="group" aria-label="React SDK examples">
        <button
          type="button"
          onClick={() => switchExample('inbox')}
          aria-pressed={example === 'inbox'}
          disabled={example === 'todos' && (todoDirty || todoBusy)}
        >
          File inbox
        </button>
        <button type="button" onClick={() => switchExample('todos')} aria-pressed={example === 'todos'}>
          Todo lists
        </button>
        <DemoDevtools />
      </div>
      <p className="react-inbox-status">
        Volume: <code>{example === 'todos' ? todoVolumeName : volumeName}</code>
      </p>
      {example === 'inbox' ? (
        <VolumeProvider key={volumeName} fileName={volumeName} transport="dedicated">
          <Inbox />
        </VolumeProvider>
      ) : (
        <VolumeProvider key={todoVolumeName} fileName={todoVolumeName} transport="dedicated">
          <TodoLists onDirtyChange={setTodoDirty} onBusyChange={setTodoBusy} />
        </VolumeProvider>
      )}
    </>
  );
}
