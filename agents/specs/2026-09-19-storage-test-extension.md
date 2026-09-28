# Extend storage regression coverage across the repository split

## Why

Issue #244 exposed a mode-transition gap despite passing same-mode persistence
tests. The [test proposal](https://github.com/opfs-vfs/opfs-vfs/blob/main/docs/TESTING-PLAN.md)
also identified core recovery suites omitted from the standalone extraction.
The owner requests the proposed tests in the old and new repositories, including
the premium encryption implementation, and explicitly defers CI to later tasks.

## What

Extend tests in `frachter-app/opfs-vfs` and `opfs-vfs/opfs-vfs`. Locate the premium
encryption package and run encryption-specific cases against its actual public
implementation. Keep all CI/workflow configuration unchanged. Add changesets
for the review branches. The tests exposed the runtime defect documented in
[the inode dirty-page spec](2026-09-19-inode-dirty-pages.md), requiring a patch
changeset rather than the originally planned test-only entry.

## How

- Port the existing plaintext recovery, partial-I/O, close/init-failure, volume
  ownership, and abrupt-owner-remount cases into the standalone suite. Keep
  encrypted cases in their encryption-owning package.
- Add writer/reader mode and durability tables for clean close, sync followed by
  worker termination, and fsync followed by termination. Verify exact latest
  acknowledged bytes, sizes, EOF, and a second reopen at boundary payload sizes.
- Exercise storage failures at payload/padding, metadata, and WAL checkpoint
  boundaries using real OPFS and existing injection hooks. Include a backend
  that materializes complete physical blocks; do not count sidecar writes as
  data writes. Preserve existing recovery and pending-WAL contracts.
- Add truncation cases around physical block boundaries, fragmented mappings,
  and missing/stale commit markers. Assert exact surviving file prefixes and
  unchanged independent files on repeated mounts. Include the nonmonotonic
  mapping [3, 5, 2], where cutting at physical block 5 leaves exactly the first
  logical page. Stale markers must record a different physical extent.
- Extend encryption sidecar/data skew cases to partial tails, repeated seals,
  and shared crypto blocks at 4096, 16384, and 65536 bytes. Permit only a valid
  committed version or the contract's explicit integrity error, without weakening
  the existing disk one-seal requirement for the previous committed bytes. Prove
  shared blocks at 16384/65536; 4096 is the separate-block control.
- Add bounded deterministic operation sequences using the existing byte-pattern
  approach and a small byte-array reference model. Require the latest content
  after an acknowledged durability barrier; print seed/operations on failure.
  Hard-link aliases share model identity; check the exact namespace too.
- Fault assertions follow the actual publication phase: payload/padding failure
  cannot publish referencing metadata; WAL checkpoint failure can occur after
  publication. Require the injected fault to fire and exact bytes after retry.

Reuse Vitest, Playwright, and existing worker helpers. No new dependencies or
test framework. If tests expose a production defect, retain the failing case
and document its fix before changing runtime code. Existing unrelated working
trees, including the standalone monorepo conversion, must remain untouched.

## Verification

Run the added/ported browser cases and relevant existing recovery tests, package
builds/declaration typechecks, and changed-file formatting checks. Run original
tests in Chromium and Firefox and the standalone/premium supported browser
configuration. Mutation-check representative content, durability, and failure
assertions. Obtain fresh-context design and implementation critiques, then
publish review branches and follow the established review/merge workflow.

## Status

Merged in [PR #3](https://github.com/opfs-vfs/opfs-vfs/pull/3) after the
ten-minute review window and independent SHIP reviews. Design critique accepted
with the named recovery, shared-inode, encryption, and phase-specific assertions
incorporated above. The seeded tests exposed an inode dirty-page defect, covered
by the linked fix spec. Encryption tests run against the original implementation;
the separate premium package location is still unresolved. CI is explicitly deferred
and must not be added by this task.
