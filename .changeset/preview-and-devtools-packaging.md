---
'@opfs-vfs/file-preview': minor
'@opfs-vfs/devtools': minor
---

Breaking for some bundler setups: both packages import their dependencies instead of compiling them in.

- File previews import PDF.js, CodeMirror, react-markdown, and remark-gfm from your dependencies. The PDF worker is bundled by your bundler as a module worker instead of being inlined as a `data:` URL. Vite 8 and Vite 7 builds need no changes. The Vite 7 development server needs the new `setPdfWorkerSrc()` or the `optimizeDeps` entry described in the README.
- A PDF worker that cannot start shows an error instead of leaving the preview at "Rendering PDF…".
- The developer tools list `react` and `react-dom` ^19 as peer dependencies, so install them alongside if your application does not already. just-bash, JSZip, Base UI, and Lucide are imported from your dependencies.
