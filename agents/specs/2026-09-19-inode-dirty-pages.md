# Preserve pending file data across hard-link namespace changes

## Why

The storage test extension found acknowledged writes lost after a memory-mode
sync and real worker termination. A minimal reproduction creates `/a`, syncs,
links `/b` to it, writes seven bytes through `/b` across offset 4095, unlinks
`/b`, and syncs again. Both reader modes return the old bytes at `/a`. Disk
writers and clean close pass; close rewrites all live files and masks the bug.

`dirtyPages` is keyed by pathname. Removing an alias deletes its pending-page
entry even when the shared inode remains live. Namespace replacement and writes
through descriptors whose original path was removed have the same identity risk.

## What

Fix pending memory-page ownership in `frachter-app/opfs-vfs` and
`opfs-vfs/opfs-vfs`, keeping storage formats and public APIs unchanged. Add focused
regressions alongside the deterministic sequences that exposed the bug. Include
a patch changeset for the runtime fix. No CI changes.

## How

Key pending page sets by shared inode identity rather than pathname. Writes,
replay, truncation, and full persistence use the same identity. Resolve a current
live path only when persisting data; skip inodes without any remaining pathname.
Path reuse must never redirect an old descriptor's pending writes to a new inode.
Rename and alias deletion no longer move or discard pending-page sets by path.
Descriptor writes/truncation must also mark metadata on the actual inode, not
its potentially reused original pathname; retain the normal-path fast path.
During data-WAL replay, a delete for a missing inode must not discard a buffer
that now belongs to a successor at the same pathname.
Persist each dirty inode once, avoiding duplicate writes through aliases.

Retain an empty dirty-page set after truncation to zero so persistence can release
its obsolete block mappings. Clear pending work only after successful persistence.
A narrower transfer-on-unlink patch was rejected because replacement, subtree
removal, and removed-descriptor writes share the underlying pathname problem.

## Verification

Keep the failing seeded sequences and add minimal cases for alias unlink,
rename-over-alias, subtree removal, writes through an unlinked descriptor with a
surviving alias and reused path, zero-length truncation, successor-buffer preservation during data-WAL replay,
and distinct dirty pages
written through multiple aliases. Require exact latest bytes after acknowledged
sync followed by native worker termination and repeated memory/disk reopens.
Check the relevant encrypted behavior and fault-retry suites. Run Chromium and
Firefox in the original repo, standalone browser tests, builds/typechecks, and
mutation checks. Obtain fresh-context design and implementation critique.

## Status

Implemented and independently reviewed with a SHIP verdict. The original package
passes 503 affected tests in each of Chromium and Firefox; the standalone passes
its 549-test full suite plus the two added nested-owner cases. Builds and changed
test typechecks pass. Reverting the inode fix reproduces 15 seeded failures;
individual metadata, replay, zero-truncate, and alias-deletion mutations are caught.
Merged in [PR #3](https://github.com/opfs-vfs/opfs-vfs/pull/3) after the
ten-minute review window. Independent critiques passed with no outstanding
findings; the original repository also received a clean GitHub review.
