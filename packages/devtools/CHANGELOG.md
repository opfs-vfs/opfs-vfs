# @opfs-vfs/devtools

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
