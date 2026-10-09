---
'@opfs-vfs/react': patch
---

Document the existing React SDK preview capabilities in its release history. This release does not introduce new runtime behavior.

- `VolumeProvider` manages a volume for a React tree, with a built-in subscriptions worker when no worker is supplied. Automatic transport chooses a compatible SharedWorker or falls back to a dedicated worker with an observable reason.
- `useVolume` exposes lifecycle and transport state; `useVolumeClient` returns a generation-safe, path-based command handle while the selected volume is ready.
- `useFile`, `useFileContent`, and `useFolder`, plus the matching `File`, `FileContent`, and `Folder` components, keep reads current through subscriptions.
- `usePersistentStorage` requests and reports browser persistence permission. `VolumeError` classifies failures by kind and outcome.

The preview requires React 19, the core package, and the subscriptions plugin. SharedWorker support depends on browser capabilities; global shutdown and deletion remain caller-owned.
