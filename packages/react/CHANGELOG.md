# @opfs-vfs/react

## 0.0.3

### Patch Changes

- 5fc8f70: Document the existing React SDK preview capabilities in its release history. This release does not introduce new runtime behavior.

  - `VolumeProvider` manages a volume for a React tree, with a built-in subscriptions worker when no worker is supplied. Automatic transport chooses a compatible SharedWorker or falls back to a dedicated worker with an observable reason.
  - `useVolume` exposes lifecycle and transport state; `useVolumeClient` returns a generation-safe, path-based command handle while the selected volume is ready.
  - `useFile`, `useFileContent`, and `useFolder`, plus the matching `File`, `FileContent`, and `Folder` components, keep reads current through subscriptions.
  - `usePersistentStorage` requests and reports browser persistence permission. `VolumeError` classifies failures by kind and outcome.

  The preview requires React 19, the core package, and the subscriptions plugin. SharedWorker support depends on browser capabilities; global shutdown and deletion remain caller-owned.

## 0.0.2

### Patch Changes

- b4bccdf: Add generation-bound asynchronous descriptor operations and prevent a late `OPEN` result from escaping after its owner changes. React command handles continue to expose only path-based operations.
- c860528: Protected-volume initialization now reports `VFS_STORAGE_PLUGIN_REQUIRED` instead of `EINVAL`; React classifies that code as unsupported and recognizes `EVAULTFORMAT` and `EPLAINTEXTVOLUME` as encryption errors.
- Updated dependencies [b4bccdf]
- Updated dependencies [8e6e420]
- Updated dependencies [c860528]
- Updated dependencies [de5c621]
  - @opfs-vfs/opfs-vfs@2.1.0
  - @opfs-vfs/plugin-subscriptions@1.2.0

## 0.0.1

### Patch Changes

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
- Updated dependencies [5bddbcc]
- Updated dependencies [5a09a9d]
- Updated dependencies [2135bbd]
- Updated dependencies [346abc8]
- Updated dependencies [c22bc7b]
- Updated dependencies [9beeb96]
- Updated dependencies [540815b]
  - @opfs-vfs/opfs-vfs@2.0.0
  - @opfs-vfs/plugin-subscriptions@1.1.0
