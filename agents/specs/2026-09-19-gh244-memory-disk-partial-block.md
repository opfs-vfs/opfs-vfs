# Preserve files across a clean memory-to-disk reopen

## Why

[Issue #244](https://github.com/frachter-app/opfs-vfs/issues/244) reports that a
seven-byte file becomes empty after a clean memory-mode close and disk-mode
reopen. The reported mismatch is between memory persistence writing a partial
physical block and disk recovery accepting only complete physical blocks.

## What

Reproduce the report against the current source, then fix the storage contract
in `packages/opfs-vfs` if confirmed. Add browser regressions and a patch changeset.
Apply the resulting fix to both `frachter-app/opfs-vfs` and `opfs-vfs/opfs-vfs`.
No vendored forks or unrelated applications are in scope. Backward compatibility
is not required by the owner; no migration is planned.

## How

First run the reported clean-close scenario with real browser OPFS and workers.
Trace memory persistence, disk reconciliation, and their callers. Prefer making
memory persistence produce complete allocated blocks if this matches the disk
format, rather than accepting missing bytes during recovery. Keep the existing
nonempty memory-WAL `EBUSY` protection. Submit the concrete design and the final
implementation to separate fresh-context critiques before shipping.

## Verification

- Observe the seven-byte reproduction fail before changing production code.
- Cover sub-block files, exact block boundaries, partial multi-block tails, and
  actual physical truncation with real browser storage.
- Run the existing recovery and durability tests, package build/typecheck, and
  formatting/lint checks on changed files.
- Revert the fix temporarily and confirm the regression fails.
- Publish a PR, allow at least ten minutes for reviews, address and resolve all
  review findings, and check release automation after merge.

## Status

Merged in [PR #2](https://github.com/opfs-vfs/opfs-vfs/pull/2), following
[original PR #245](https://github.com/frachter-app/opfs-vfs/pull/245). The
standalone package build and all 337 Chromium tests passed. Both PRs remained
open for at least ten minutes and passed fresh-context implementation critiques.
The standalone repository remains private, with its patch changeset retained.
The requested [test-suite extension proposal](../../docs/TESTING-PLAN.md) records
follow-up coverage without implementing additional behavior.

Reproduced on Chromium: the seven persisted bytes are present before
disk reopen, which then truncates the file to zero. The boundary matrix also
fails for 1, 4095, 4097, and 8199 bytes; empty and exact-block files pass.

Design critique accepted completing the final physical block only when the
data handle's physical extent does not already cover it. This avoids resealing
an encrypted block twice, which would discard its previous durable nonce/tag.
Reuse `zeroSource` for the bounded padding write. Recovery and the WAL `EBUSY`
guard remain unchanged. The owner explicitly requires no legacy migration.
