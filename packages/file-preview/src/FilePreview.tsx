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
// A small file can declare huge dimensions; 50 megapixels is about 200 MB of decoded RGBA.
const MAX_IMAGE_PIXELS = 50_000_000;
const undecodable = 'This image could not be decoded.';
const dataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
function ImagePreview({ file }: PreviewProps) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    const type = imageMime[extension(file.path)];
    const blob = new Blob([file.bytes?.slice() ?? file.content], { type });
    // SVG can carry script. A same-origin blob: URL opened as a document ("Open image in new tab") would run it
    // with this origin; browsers refuse top-level navigation to data: URLs, so SVG never gets a blob: URL.
    const blobUrl = type === 'image/svg+xml' ? '' : URL.createObjectURL(blob);
    setUrl('');
    setError('');
    void (blobUrl ? Promise.resolve(blobUrl) : dataUrl(blob)).then(
      (next) => {
        // Read the dimensions off-screen before an <img> in the document paints (and fully decodes) the image.
        const probe = new Image();
        probe.onload = () => {
          if (!live) return;
          if (probe.naturalWidth * probe.naturalHeight > MAX_IMAGE_PIXELS)
            setError(`This image is ${probe.naturalWidth} × ${probe.naturalHeight} pixels, over the preview limit.`);
          else setUrl(next);
        };
        probe.onerror = () => {
          if (live) setError(undecodable);
        };
        probe.src = next;
      },
      () => {
        if (live) setError(undecodable);
      },
    );
    return () => {
      live = false;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [file.bytes, file.content, file.path]);
  return error ? (
    <p role="alert" className="fp-empty">
      {error}
    </p>
  ) : (
    <div className="fp-image">
      <img src={url || undefined} alt={file.path} onError={() => setError(undecodable)} />
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
