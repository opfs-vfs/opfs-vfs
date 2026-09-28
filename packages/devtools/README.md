# OPFS VFS Volume Explorer

Explore and manage real OPFS VFS volumes, with opt-in developer tools for debugging running applications. Automatic same-origin discovery, passive application attachments, independent workers for recognized closed volumes, file actions, a write-gated just-bash terminal, shared previews and a virtualized source editor.

```ts
if (import.meta.env.DEV) {
  await import('@opfs-vfs/devtools/styles.css');
  const { mountDevtools } = await import('@opfs-vfs/devtools');
  const panel = mountDevtools();
  import.meta.hot?.dispose(() => panel.unmount());
}
```

The standard application worker must support observer protocol 1. Requires a secure cross-origin-isolated browser context. No volume prop or application registration is needed. Older/custom/direct workers remain unavailable while busy. Protected volumes require their application.

Writes start disabled. Choose **Enable writes** below the volume selector to enable file creation, editing, and shell commands that modify the selected volume. An owner loss invalidates the attachment and clears write access; uncertain mutations are never replayed. Passive detach does not close or flush the app worker. Devtools-owned workers remain alive for the page lifetime because other application clients may attach to them.

File actions refuse overwrites, editor saves reject concurrent content changes, and cut/paste is limited to one volume. ZIP import creates a new volume; export is a live copy. Multi-entry errors can leave partial output. Previews/read/write calls are limited to 16 MiB per file; ZIP limits are 2,000 entries, 256 MiB expanded and 128 MiB compressed.

See the [usage guide](../../apps/website/src/content/docs/docs/guides/devtools.mdx), [preview extension guide](../../apps/website/src/content/docs/docs/guides/file-previews.md), and [implementation specification](../../docs/specs/opfs-vfs-debugging-panel.md).

**Volume details → OPFS volume size** shows the sum of the volume's data, metadata, and journal file lengths, with a readable unit and exact byte count. Discovery updates it while the panel is open, even without a connection; Refresh also updates it. This measures OPFS backing files, not browser-wide quota usage or the sum of visible file contents. Changes buffered in memory are excluded, and live writes can change the total during measurement. An unavailable size is never shown as zero.

## Development

Build the core and file-preview workspaces first. `pnpm --filter @opfs-vfs/devtools storybook` serves port 4326 with isolation headers. The **Real Storage** story uses a real application worker and creates disposable, persistent OPFS test volumes. Other stories use in-memory fixtures for layout, owner states, previews and file actions. The UI and CSS are shared; memory fixtures are not part of the public entry's dependency graph.

Run `pnpm --filter @opfs-vfs/devtools test`, `test:browser`, `typecheck`, `build`, and `build-storybook` for the relevant checks. Browser tests use Chromium and real OPFS.
