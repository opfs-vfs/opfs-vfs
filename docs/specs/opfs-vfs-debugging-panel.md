# OPFS VFS - Debugging Panel

Status: implemented for real OPFS VFS use; website documentation and stacked PR authorized on September 21, 2026. The original interaction prototype remains available in Storybook alongside a real-storage story.

## Scope

The manually imported `@opfs-vfs/devtools` package mounts a launcher and floating/dockable debugging panel. TanStack informed the interaction and opt-in loading model only. There is no TanStack dependency. The website's OPFS mark is reused in the launcher and title.

`mountDevtools({ initialOpen?, initialDock?, initialTheme?, previewExtensions? })` receives no application volume references. It returns an idempotent `unmount()`. Repeated mounts return the same installation. Normal VFS imports never load devtools UI, previews, shell, or discovery code. Browser initialization requires a secure cross-origin-isolated document. Styles are explicitly imported from `@opfs-vfs/devtools/styles.css` inside the same development-only condition.

## Discovery and ownership

While visible, discovery groups reserved OPFS root filenames and combines read-only `peekVolume` inspection, Web Lock snapshots, and a versioned owner probe. Lock snapshots are observations, never proof that opening or deleting is safe. Unrecognized/headerless closed candidates remain unavailable. Protected or incompatible volumes are not opened.

Only the standard worker explicitly advertises observer support. A passive connection targets one randomly generated owner generation, uses a distinct envelope ignored by older clients, validates reply correlation, and never joins leadership election. Descriptor and lifecycle commands are denied to passive clients. Detach is local and does not flush or close an application's worker. Lost owners and timeouts invalidate attachments; uncertain operations are not replayed.

Idle opening uses a non-queued leadership lock request and `open-existing`. The physical volume lock remains the final exclusion mechanism. Failure never schedules takeover or falls back to creating a missing volume. A new volume uses `create-new`. Each volume has an independent worker connection; several can remain connected simultaneously.

Devtools-owned workers are retained for the page lifetime, including across hide/unmount, because later application followers may depend on them. Closed-volume deletion takes the physical ownership lock; connected, busy and protected volumes are not deletable from this panel. Force deletion is not implemented.

## File operations

Every connection starts with writes disabled. Owner loss resets write access and preserves drafts. Mutations and shell writes check permission at the filesystem boundary, not by parsing shell commands.

Whole-file read/write commands execute in the owning worker, enforce a 16 MiB ceiling and close descriptors in `finally`. They do not expose descriptors to passive clients. Editor saves compare expected content inside the same synchronous worker command before truncation. Creation and copied files use exclusive creation; renames use a conditional no-replace command. Collision checks cannot race a later truncating open.

The context menu offers preview, edit, new file/folder, copy/cut/paste, rename and delete. Copy snapshots are limited to 2,000 entries and 64 MiB total. Cut/paste uses one same-volume rename. Cross-volume cut is unavailable; cross-volume copying never deletes the source. Failed multi-entry copies report partial output and preserve it for inspection.

The explorer stores metadata separately from lazily loaded contents and is bounded to 10,000 entries. Symbolic links are visible but previews and copy refuse to follow them. User refresh rereads files without dropping drafts. Terminal commands use just-bash with bounded execution counts and output; each starts at `/`. No network capability is configured. Shell commands retain their own documented overwrite semantics.

## Previews and editor

`packages/file-preview` is the shared React package used by devtools and the website. CodeMirror virtualizes visible lines; the full bounded document remains in memory. Image/SVG previews use object URLs with cleanup, PDFs render page by page through lazy PDF.js, and Markdown uses the website's React Markdown/GFM renderer with remote images blocked. Large Markdown falls back to virtualized source. Binary previews show at most 4 KiB. A failed decoder or renderer reports an error.

Extensions have `{ id, matches(path), load() }`; custom matches precede built-ins and load lazily. Renderers receive read-only file data without a VFS instance or save callback. They are trusted application code, not a sandbox. Save authority remains with the host. The website retains its existing specialized HTML, Office and spreadsheet views alongside the shared basic previews.

## Archives

Import is supported into new volumes only. ZIP structure, paths, decompressed sizes, duplicate entries and ancestor/file conflicts are checked before volume creation. No implicit overwrite or import into a live application volume is offered. Limits: 2,000 entries, 16 MiB/file, 256 MiB expanded, 128 MiB compressed. Failed writes preserve and identify the partial volume. Export is explicitly a live copy; it does not promise a coordinated application snapshot. Host-exclusive coordination and cancellation after writes begin are outside this release.

## Verification and documentation

Storybook keeps isolated memory scenarios for UI development and a real-storage application harness. Core Chromium checks cover stale/legacy owners, no takeover, descriptor/lifecycle rejection, timeouts, byte bounds, expected-content conflicts and exclusive mutations. Devtools integration checks cover real attachment, write gating, safe copy/save, detach, and ZIP validation. Preview stories exercise raster/SVG/PDF rendering, custom extensions and a 20,000-line editor.

Website documentation covers explicit loading, connection states, ownership lifetime, write controls, data limits, archive semantics and extension registration. The developer-tools card links to a real-storage demo and is marked Available. npm publication remains part of the repository's release workflow, separate from creating this PR.
