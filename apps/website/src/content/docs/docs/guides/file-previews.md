---
title: File preview extensions
description: Add custom file previews and reuse the shared React renderers and text editor.
---

`@opfs-vfs/file-preview` supplies the React previews and virtualized text editor used by the website and devtools. Custom extensions are trusted application code, supplied when you mount the panel. The first matching custom extension takes precedence over built-in renderers.

## Register a lazy renderer

```ts
import type { PreviewExtension } from '@opfs-vfs/devtools';

const palette: PreviewExtension = {
  id: 'palette',
  matches: (path) => path.toLowerCase().endsWith('.palette'),
  load: () => import('./PalettePreview'),
};

if (import.meta.env.DEV) {
  await import('@opfs-vfs/devtools/styles.css');
  const { mountDevtools } = await import('@opfs-vfs/devtools');
  mountDevtools({ previewExtensions: [palette] });
}
```

The module exports a React component as its default export:

```tsx
// PalettePreview.tsx
import type { PreviewProps } from '@opfs-vfs/devtools';

export default function PalettePreview({ file }: PreviewProps) {
  const source = file.bytes ? new TextDecoder('utf-8', { fatal: true }).decode(file.bytes) : file.content;
  const colors = source.split(/\s+/).filter((s) => /^#[0-9a-f]{6}$/i.test(s));
  return (
    <ul>
      {colors.map((color, index) => (
        <li key={index}>
          <span style={{ background: color, display: 'inline-block', width: 24, height: 24 }} />
          {color}
        </li>
      ))}
    </ul>
  );
}
```

`file` contains `path`, `content`, and optional `bytes`. When bytes are present they are authoritative. Do not mutate the input. Devtools decodes supported UTF-8 text files for editing; unknown and binary formats retain their bytes. Match by path only; loading and rendering happen after selection and the 16 MiB preview check.

A failed matcher, import or renderer displays a preview error. Extensions are not sandboxed: validate their input, avoid inserting raw HTML, and release object URLs or workers during cleanup. Extensions do not receive save privileges. Editing remains a separate action controlled by the host.

## Use previews in another React application

```tsx
import { FilePreview, TextEditor } from '@opfs-vfs/file-preview';
import '@opfs-vfs/file-preview/styles.css';
import { Suspense } from 'react';

<FilePreview file={{ path: '/notes.md', content: '# Notes' }} extensions={[palette]} />;

<Suspense fallback={<p>Loading editor…</p>}>
  <TextEditor path="/notes.txt" value={draft} readOnly={false} onChange={setDraft} />
</Suspense>;
```

The host owns file reads, permissions, drafts and persistence. `TextEditor` is read-only by default and rejects edits larger than 16 MiB. Scrolling virtualizes the rendered lines; the bounded document still resides in memory. Markdown larger than 256 KiB uses the virtualized source view.

The built-in PDF renderer uses a bundled PDF.js worker. Your content security policy must permit its worker asset and the image previews' `blob:` URLs. No renderer uploads file contents to a server.
