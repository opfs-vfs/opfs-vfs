# @opfs-vfs/file-preview

## 0.2.0

### Minor Changes

- 453fe9a: Breaking for some bundler setups: both packages import their dependencies instead of compiling them in.

  - File previews import PDF.js, CodeMirror, react-markdown, and remark-gfm from your dependencies. The PDF worker is bundled by your bundler as a module worker instead of being inlined as a `data:` URL. Vite 8 and Vite 7 builds need no changes. The Vite 7 development server needs the new `setPdfWorkerSrc()` or the `optimizeDeps` entry described in the README.
  - A PDF worker that cannot start shows an error instead of leaving the preview at "Rendering PDF…".
  - The developer tools list `react` and `react-dom` ^19 as peer dependencies, so install them alongside if your application does not already. just-bash, JSZip, Base UI, and Lucide are imported from your dependencies.

### Patch Changes

- cc26a55: Type declarations resolve under TypeScript's `node16` and `nodenext` module resolution. Relative imports now carry file extensions.
- 4b5fc7f: Update the developer tools to just-bash 3.6.0 and file previews to pdf.js 6.5.
- 442c399: Update runtime dependencies: React 19.3.1, Base UI 1.9.0, JSZip 3.10.2, and lucide-react 1.72.0 in the developer tools, and newer CodeMirror and Lezer releases in file previews.
- ab4834d: SVG previews load from a `data:` URL instead of a same-origin `blob:` URL, so opening a previewed SVG in a new tab can no longer run its scripts on your origin. Images larger than 50 megapixels show a message instead of being decoded.

## 0.1.1

### Patch Changes

- e43b836: Include the source repository and package directory in npm metadata so published packages link to their source and support GitHub Actions trusted publishing with provenance.

## 0.1.0

### Minor Changes

- f073ed3: Add opt-in devtools with automatic volume discovery, generation-bound passive worker attachments, real file operations and a browser shell. Add shared lazy file previews and a virtualized text editor. Core provides bounded whole-file operations and conditional writes without exposing passive file descriptors.
