# @opfs-vfs/devtools

## 0.3.0

### Minor Changes

- 453fe9a: Breaking for some bundler setups: both packages import their dependencies instead of compiling them in.

  - File previews import PDF.js, CodeMirror, react-markdown, and remark-gfm from your dependencies. The PDF worker is bundled by your bundler as a module worker instead of being inlined as a `data:` URL. Vite 8 and Vite 7 builds need no changes. The Vite 7 development server needs the new `setPdfWorkerSrc()` or the `optimizeDeps` entry described in the README.
  - A PDF worker that cannot start shows an error instead of leaving the preview at "Rendering PDF…".
  - The developer tools list `react` and `react-dom` ^19 as peer dependencies, so install them alongside if your application does not already. just-bash, JSZip, Base UI, and Lucide are imported from your dependencies.

### Patch Changes

- cc26a55: Type declarations resolve under TypeScript's `node16` and `nodenext` module resolution. Relative imports now carry file extensions.
- c775de1: The just-bash adapter gains `forJustBash()`, a filesystem you can pass straight to `new Bash({ fs })`. It has the synchronous path list just-bash requires, re-read after every path-changing call made through it. The developer tools shell uses it, so its path list follows changes made within a command line.

  The adapter's file methods no longer create parent directories for a path that contains `.` or `..`. The volume resolves such paths, so `/missing/../file` fails with `ENOENT` and creates nothing.

- cf048fd: The just-bash adapter's non-recursive `rm` removes an empty directory, so `rmdir` works in a shell. A non-empty directory fails with `ENOTEMPTY`, and a symlink to a directory is still only unlinked. The adapter also gains `createExclusive`, so `mktemp` works once its directory exists. The developer tools refuse both on read-only connections.
- 4b5fc7f: Update the developer tools to just-bash 3.6.0 and file previews to pdf.js 6.5.
- 442c399: Update runtime dependencies: React 19.3.1, Base UI 1.9.0, JSZip 3.10.2, and lucide-react 1.72.0 in the developer tools, and newer CodeMirror and Lezer releases in file previews.
- ab4834d: SVG previews load from a `data:` URL instead of a same-origin `blob:` URL, so opening a previewed SVG in a new tab can no longer run its scripts on your origin. Images larger than 50 megapixels show a message instead of being decoded.
- Updated dependencies [cc26a55]
- Updated dependencies [6010a8b]
- Updated dependencies [c775de1]
- Updated dependencies [cf048fd]
- Updated dependencies [4b5fc7f]
- Updated dependencies [452f840]
- Updated dependencies [998ca7c]
- Updated dependencies [453fe9a]
- Updated dependencies [cc37142]
- Updated dependencies [442c399]
- Updated dependencies [ab4834d]
- Updated dependencies [a3eba3e]
- Updated dependencies [19e80f5]
- Updated dependencies [99ed87a]
- Updated dependencies [3d32b9e]
  - @opfs-vfs/opfs-vfs@2.2.0
  - @opfs-vfs/file-preview@0.2.0

## 0.2.1

### Patch Changes

- e43b836: Include the source repository and package directory in npm metadata so published packages link to their source and support GitHub Actions trusted publishing with provenance.
- Updated dependencies [e43b836]
  - @opfs-vfs/file-preview@0.1.1

## 0.2.0

### Minor Changes

- ed1b7a2: Refresh the current folder automatically every 500 ms without scanning nested folders or discarding unsaved drafts. Add a translucent, blurred launcher that can be dragged to eight positions with animated snapping, keyboard positioning, and a configurable `initialPosition`.

### Patch Changes

- 513102b: Allow dragging the floating devtools panel from anywhere in its top bar except the controls, while preserving keyboard movement and control clicks.
- Updated dependencies [b4bccdf]
- Updated dependencies [8e6e420]
- Updated dependencies [c860528]
  - @opfs-vfs/opfs-vfs@2.1.0

## 0.1.0

### Minor Changes

- f073ed3: Add opt-in devtools with automatic volume discovery, generation-bound passive worker attachments, real file operations and a browser shell. Add shared lazy file previews and a virtualized text editor. Core provides bounded whole-file operations and conditional writes without exposing passive file descriptors.
- 59c68f4: Show total OPFS backing-file size in Volume details, including data, metadata, and journals. Refresh totals during discovery without connecting to the volume.

  Replace the native volume selector with a themed, keyboard-accessible menu positioned outside the trigger, with separate volume names and connection states.

### Patch Changes

- 2a7a6a8: Use Base UI for the explorer's volume selector, tabs, and file menus while preserving keyboard navigation and focus behavior.
- 16399d4: Replace the public storageFactory option with validated, single-mount storage plugins. Recognize incomplete imports in inspection, opening and deletion, and keep unavailable volumes visible in devtools. Bind follower replies to the current owner generation.

  Support application worker factories and statically registered plugins through the core worker client. Validate request constraints before election and negotiate non-secret plugin profiles on every owner generation.

- Updated dependencies [06f3ba8]
- Updated dependencies [f073ed3]
- Updated dependencies [f8741bc]
- Updated dependencies [34fd4ee]
- Updated dependencies [937aaa4]
- Updated dependencies [38268dc]
- Updated dependencies [4b53d24]
- Updated dependencies [2e99341]
- Updated dependencies [5c1fd40]
- Updated dependencies [70ca21e]
- Updated dependencies [16399d4]
- Updated dependencies [c22bc7b]
- Updated dependencies [4a93673]
- Updated dependencies [be4116a]
- Updated dependencies [6477482]
- Updated dependencies [148d7db]
- Updated dependencies [1d2c9db]
- Updated dependencies [95d90c8]
- Updated dependencies [34fd4ee]
- Updated dependencies [5a09a9d]
- Updated dependencies [2135bbd]
- Updated dependencies [346abc8]
- Updated dependencies [c22bc7b]
- Updated dependencies [9beeb96]
- Updated dependencies [540815b]
  - @opfs-vfs/opfs-vfs@2.0.0
  - @opfs-vfs/file-preview@0.1.0
