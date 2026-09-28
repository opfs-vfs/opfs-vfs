import { FilePreview as SharedPreview, TextEditor } from '@opfs-vfs/file-preview';
import '@opfs-vfs/file-preview/styles.css';
import { Button } from './ui/button';
import { Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { Download, Save } from 'lucide-react';
import type { OpfsVfsJustBashAdapter } from '@opfs-vfs/opfs-vfs/just-bash';
import type { ExplorerEntry } from '../lib/filesystem';
import './file-preview.css';

const image = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif']);
const text = new Set(['txt', 'js', 'jsx', 'ts', 'tsx', 'json', 'css', 'csv', 'sql', 'sh', 'yaml', 'yml', 'xml']);
const switchable = new Set(['md', 'markdown', 'html', 'htm']);
const MAX_PREVIEW_BYTES = 16 * 1024 * 1024;
const imageMime: Record<string, string> = {
  avif: 'image/avif',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};

export function FilePreview({
  entry,
  onDirtyChange,
  onSave,
  read,
  revision,
}: {
  entry: ExplorerEntry | null;
  onDirtyChange: (dirty: boolean) => void;
  onSave: (path: string, text: string) => Promise<void>;
  read: <T>(operation: (fs: OpfsVfsJustBashAdapter) => Promise<T>) => Promise<T>;
  revision: number;
}) {
  const [bytes, setBytes] = useState<Uint8Array>();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'preview' | 'source'>('preview');
  const [docxHtml, setDocxHtml] = useState('');
  const dirty = useRef(false);
  const previousPath = useRef('');
  const ext = entry?.name.split('.').pop()?.toLowerCase() || '';
  useEffect(() => {
    let live = true;
    const path = entry?.kind === 'file' ? entry.path : '';
    const pathChanged = previousPath.current !== path;
    if (pathChanged) {
      previousPath.current = path;
      dirty.current = false;
      onDirtyChange(false);
      setBytes(undefined);
      setError('');
      setMode('preview');
    }
    if (!path) {
      setBytes(undefined);
      return;
    }
    if (!pathChanged && dirty.current) return;
    if ((entry?.size ?? 0) > MAX_PREVIEW_BYTES) {
      setError('This file is larger than the 16 MiB preview limit. Download it to inspect it.');
      return;
    }
    read((fs) => fs.readFileBuffer(path)).then(
      (value) => {
        if (live) {
          setBytes(value);
          setDraft(new TextDecoder().decode(value));
          setError('');
        }
      },
      (reason) => {
        if (live) setError(String(reason));
      },
    );
    return () => {
      live = false;
    };
  }, [entry?.kind, entry?.path, entry?.size, onDirtyChange, read, revision]);
  const mime = ext === 'pdf' ? 'application/pdf' : imageMime[ext] || 'application/octet-stream';
  useEffect(() => {
    let live = true;
    setDocxHtml('');
    if (ext !== 'docx' || !bytes) return;
    const body = document.createElement('div');
    const styles = document.createElement('div');
    import('docx-preview')
      .then(async ({ renderAsync }) => {
        await renderAsync(bytes, body, styles, { renderAltChunks: false, useBase64URL: true });
        if (live)
          setDocxHtml(
            `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>${styles.textContent || ''}</style>${body.innerHTML}`,
          );
      })
      .catch((reason) => {
        if (live) setError(String(reason));
      });
    return () => {
      live = false;
    };
  }, [bytes, ext]);
  if (!entry) return <div className="preview-empty">Select a file to preview it.</div>;
  if (entry.kind === 'directory') return <div className="preview-empty">{entry.path}</div>;
  if (error && !bytes) return <div className="demo-error">{error}</div>;
  if (!bytes) return <div className="preview-empty">Loading {entry.name}…</div>;
  const download = () => {
    const href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
    const link = document.createElement('a');
    link.href = href;
    link.download = entry.name;
    link.click();
    URL.revokeObjectURL(href);
  };
  const save = async () => {
    try {
      await onSave(entry.path, draft);
      dirty.current = false;
      onDirtyChange(false);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const edit = (value: string) => {
    dirty.current = true;
    onDirtyChange(true);
    setDraft(value);
  };
  let content: ReactNode;
  if (mode === 'source' && switchable.has(ext))
    content = <Editor name={entry.name} value={draft} onChange={edit} onSave={save} />;
  else if (ext === 'md' || ext === 'markdown' || image.has(ext) || ext === 'pdf')
    content = (
      <div className={ext === 'md' || ext === 'markdown' ? 'markdown-preview' : ''}>
        <SharedPreview
          key={entry.path}
          file={
            ext === 'md' || ext === 'markdown'
              ? { path: entry.path, content: draft }
              : { path: entry.path, content: '', bytes }
          }
        />
      </div>
    );
  else if (ext === 'docx')
    content = docxHtml ? (
      <iframe className="document-preview" sandbox="" srcDoc={docxHtml} title={entry.name} />
    ) : (
      <div className="preview-empty">Rendering document…</div>
    );
  else if (ext === 'xlsx' || ext === 'xls') content = <Spreadsheet bytes={bytes} />;
  else if (ext === 'html' || ext === 'htm')
    content = (
      <iframe
        className="document-preview"
        sandbox=""
        srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:">${safeHtml(draft)}`}
        title={entry.name}
      />
    );
  else if (text.has(ext) || !bytes.includes(0))
    content = <Editor name={entry.name} value={draft} onChange={edit} onSave={save} />;
  else
    content = (
      <pre className="binary-preview">
        {Array.from(bytes.slice(0, 4096), (byte) => byte.toString(16).padStart(2, '0')).join(' ')}
      </pre>
    );
  return (
    <div className="preview-content">
      <div className="preview-actions">
        <span>{entry.name}</span>
        {switchable.has(ext) ? (
          <div className="preview-mode" aria-label="Preview mode">
            <Button variant="outline" size="sm" aria-pressed={mode === 'preview'} onClick={() => setMode('preview')}>
              Preview
            </Button>
            <Button variant="outline" size="sm" aria-pressed={mode === 'source'} onClick={() => setMode('source')}>
              Source
            </Button>
          </div>
        ) : null}
        <Button variant="ghost" size="sm" onClick={download}>
          <Download aria-hidden="true" />
          Download
        </Button>
      </div>
      {error ? (
        <div className="demo-error" role="alert">
          {error}
        </div>
      ) : null}
      {content}
    </div>
  );
}

function safeHtml(source: string) {
  const document = new DOMParser().parseFromString(source, 'text/html');
  document
    .querySelectorAll('script, iframe, object, embed, base, meta[http-equiv="refresh" i]')
    .forEach((node) => node.remove());
  document.querySelectorAll('style').forEach((node) => {
    node.textContent = (node.textContent || '').replace(
      /@import[^;]+;?|url\(\s*(['"]?)(?:https?:)?\/\/.*?\1\s*\)/gi,
      '',
    );
  });
  document.querySelectorAll('*').forEach((node) => {
    for (const attribute of Array.from(node.attributes)) {
      const value = attribute.value.trim();
      if (
        attribute.name.startsWith('on') ||
        (/^(src|href|action|formaction)$/i.test(attribute.name) && /^(https?:)?\/\//i.test(value))
      )
        node.removeAttribute(attribute.name);
      if (attribute.name === 'srcset') node.removeAttribute(attribute.name);
      if (attribute.name === 'style')
        node.setAttribute('style', value.replace(/url\(\s*(['"]?)(?:https?:)?\/\/.*?\1\s*\)/gi, ''));
    }
  });
  return document.documentElement.outerHTML;
}

function Editor({
  name,
  onChange,
  onSave,
  value,
}: {
  name: string;
  onChange: (value: string) => void;
  onSave: () => Promise<void>;
  value: string;
}) {
  return (
    <div className="editor-shell">
      <Suspense fallback={<p>Loading editor…</p>}>
        <TextEditor path={name} value={value} readOnly={false} onChange={onChange} />
      </Suspense>
      <Button variant="default" size="sm" onClick={() => void onSave()}>
        <Save aria-hidden="true" />
        Save
      </Button>
    </div>
  );
}

function Spreadsheet({ bytes }: { bytes: Uint8Array }) {
  const [rows, setRows] = useState<string[][]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    void import('xlsx')
      .then((xlsx) => {
        const book = xlsx.read(bytes);
        if (live) {
          setRows(
            xlsx.utils
              .sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1, raw: false })
              .slice(0, 200) as string[][],
          );
          setError('');
        }
      })
      .catch((reason) => {
        if (live) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      live = false;
    };
  }, [bytes]);
  return error ? (
    <div className="demo-error" role="alert">
      {error}
    </div>
  ) : (
    <div className="sheet-preview">
      <table>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r}>
              {row.slice(0, 40).map((cell, c) => (
                <td key={c}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
