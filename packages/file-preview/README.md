# Shared file previews

Shared React package used by the website and real devtools. It accepts file contents and has no VFS, worker-client, website, or devtools dependency. The website reuses the basic previews and editor while retaining its specialized Office/HTML views.

```tsx
import { FilePreview, TextEditor, type PreviewExtension } from '@opfs-vfs/file-preview';
import '@opfs-vfs/file-preview/styles.css';

<FilePreview file={{ path: '/note.md', content: '# Hello' }} />;
<FilePreview file={{ path: '/photo.png', content: '', bytes: imageBytes }} />;

// Render inside React Suspense. The host owns drafts, permissions, and saving.
<TextEditor path="/note.md" value={draft} readOnly={!canWrite} onChange={setDraft} />;
```

Text previews use a read-only, wrapped reading view without line numbers or an active-line highlight. Syntax highlighting and virtual scrolling remain available.

The text editor uses CodeMirror 6 with virtual scrolling, line numbers, undo/redo, find/replace, and lazy syntax highlighting for recognized languages. `.conf`/`.cfg` use properties highlighting and `.env` variants use shell highlighting. Unknown languages remain plain text. Supported text types include common source, markup, shell, and configuration files, including `.conf`, `.env`, `.env.local`, TOML, INI, JSON, Python, Rust, Go, C/C++, Java, and TypeScript. Common filenames such as `Dockerfile`, `Makefile`, `README`, and `.gitignore` are also editable. HTML source is displayed as text. SVG is rendered as an image, never inserted into the DOM as markup. The built-in PDF preview renders one bounded canvas page at a time with Previous/Next navigation. PDF.js and its rendering worker load only when a PDF is selected. Raster images use the browser decoder. Unknown formats get a bounded hex preview.

`FilePreview` enforces a 16 MiB input limit before selecting any renderer. `canEdit` applies the same bound and explicit text extension/filename allowlists. Byte-backed inputs are read-only. The host must strictly decode UTF-8 before opting into text editing. The editor renders a window of lines, but retains the entire bounded document in memory. The editor also serializes drafts per edit; virtual scrolling is not streaming or an unlimited-file guarantee.

```tsx
const previews: PreviewExtension[] = [
  {
    id: 'palette',
    matches: (path) => path.endsWith('.palette'),
    load: () => import('./PalettePreview'), // default React component taking { file }
  },
];
<FilePreview file={file} extensions={previews} />;
```

Caller extensions run before built-ins, first match wins. Only the chosen renderer loads. A renderer gets file data, not a volume or mutation callback. Renderers and match functions run inside a preview error boundary. They are trusted application code, not sandboxed third-party plugins. They must clean up object URLs, effects and workers, and avoid executing file contents. Keep the extension array stable. See the devtools `CustomPreview` story for a working example.

Reuse sources inspected at `frachter-app/opfs-vfs` commit `4d88149`:

- `apps/bash-console/src/features/previews/lib/detect.ts`: filename extension handling, adapted here.
- `plugins/binary-raw.tsx`: hex formatting, reused with a 4 KiB cap.
- `plugins/text-code.tsx`: CodeMirror mount/disposal pattern. Its large-file fallback was deliberately replaced with CodeMirror virtual scrolling.
- `registry.ts`, `plugins/image.tsx`, `plugins/pdf.tsx`: lazy renderer selection, object-URL lifecycle and page-based PDF behavior inform this extraction.
- The website's `FilePreview.tsx` supplies the existing bounded canvas rendering approach.

The bash-console DOCX, spreadsheet and Excalidraw plugins depend on its UI shell and editor-host capabilities. They are candidates for subsequent extensions, not current exports. The full console workbench, Monaco and terminal integration are not dependencies of this package.

The build emits ES modules, declarations and a separate stylesheet. PDF, Markdown and editor implementations are lazy chunks.
