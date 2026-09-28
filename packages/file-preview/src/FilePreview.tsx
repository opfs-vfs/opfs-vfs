import { Component, lazy, Suspense, useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import type { PreviewFile } from './preview-policy';
import { canEdit, extension, fileSize, MAX_PREVIEW_BYTES } from './preview-policy';

export const TextEditor = lazy(() => import('./TextEditor'));
const BinaryPreview = lazy(() => import('./BinaryPreview'));
export type PreviewProps = { file: Readonly<PreviewFile> };
// Trusted application code, not a sandbox. Renderers get data, never a volume or save callback.
export type PreviewExtension = {
  id: string;
  matches: (path: string) => boolean;
  load: () => Promise<{ default: ComponentType<PreviewProps> }>;
};
const imageMime: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
};
function ImagePreview({ file }: PreviewProps) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState(false);
  useEffect(() => {
    const next = URL.createObjectURL(
      new Blob([file.bytes?.slice() ?? file.content], { type: imageMime[extension(file.path)] }),
    );
    setUrl(next);
    setError(false);
    return () => URL.revokeObjectURL(next);
  }, [file.bytes, file.content, file.path]);
  return error ? (
    <p role="alert" className="fp-empty">
      This image could not be decoded.
    </p>
  ) : (
    <div className="fp-image">
      <img src={url || undefined} alt={file.path} onError={() => setError(true)} />
    </div>
  );
}
function PlainTextPreview({ file }: PreviewProps) {
  return canEdit(file) ? <TextEditor path={file.path} value={file.content} preview /> : <BinaryPreview file={file} />;
}
const builtins: PreviewExtension[] = [
  { id: 'image', matches: (path) => !!imageMime[extension(path)], load: async () => ({ default: ImagePreview }) },
  { id: 'pdf', matches: (path) => extension(path) === 'pdf', load: () => import('./PdfPreview') },
  {
    id: 'markdown',
    matches: (path) => ['md', 'markdown'].includes(extension(path)),
    load: () => import('./MarkdownPreview'),
  },
  { id: 'text', matches: () => true, load: async () => ({ default: PlainTextPreview }) },
];
class PreviewBoundary extends Component<{ children: ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? (
      <p role="alert" className="fp-empty">
        Preview failed. Select another file or use the editor if available.
      </p>
    ) : (
      this.props.children
    );
  }
}
function SelectedPreview({ file, extensions }: PreviewProps & { extensions: PreviewExtension[] }) {
  const renderer = [...extensions, ...builtins].find((item) => item.matches(file.path))!;
  const View = useMemo(() => lazy(renderer.load), [renderer]);
  return (
    <Suspense fallback={<p className="fp-empty">Loading preview…</p>}>
      <View file={file} />
    </Suspense>
  );
}
const noExtensions: PreviewExtension[] = [];
export function FilePreview({ file, extensions = noExtensions }: PreviewProps & { extensions?: PreviewExtension[] }) {
  if (fileSize(file) > MAX_PREVIEW_BYTES) return <p className="fp-empty">Preview exceeds the 16 MiB limit.</p>;
  return (
    <div className="opfs-file-preview">
      <PreviewBoundary key={file.path}>
        <SelectedPreview file={file} extensions={extensions} />
      </PreviewBoundary>
    </div>
  );
}
