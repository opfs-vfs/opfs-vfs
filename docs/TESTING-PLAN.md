# Storage regression coverage

Issue #244 exposed a gap between memory and disk modes. The follow-up tests below cover transitions, real worker termination, physical truncation, failure recovery, and short deterministic operation sequences. They also exposed lost acknowledged writes after deleting a hard-link alias; the runtime fix tracks pending pages by inode identity.

## Core suites

- `memory-disk-reopen.test.ts`: the original partial-block regression, boundary sizes, reused blocks, and repeated reopens.
- `storage-lifecycle.test.ts`: all 36 writer/reader mode, durability, and close/sync/fsync combinations. Each checks sizes 0, 1, 7, 4095, 4096, 4097, and 8199. Sync and fsync are followed by native worker termination. Eighteen seeded sequences compare exact bytes and the complete namespace against a shared-inode model after acknowledged barriers and reopens.
- `plaintext-owner-crash.test.ts`: native termination of an outer owner with a nested VFS worker, lock release, and exact recovery of acknowledged strict-mode WAL writes.
- `inode-persistence.test.ts`: focused hard-link deletion, pathname reuse, unlinked-descriptor, zero-truncation, and WAL replay regressions.
- `physical-recovery.test.ts`: 15 physical truncation cases. The `[3, 5, 2]` mapping checks a missing middle page followed by a surviving low block; recovery must stop at the hole. Every case checks an independent file and a second remount.
- `storage-fault.test.ts`: payload, padding, metadata, and WAL checkpoint write/flush failures, exact retry results, and real OPFS backends that materialize 16 KiB or 64 KiB blocks. Assertions follow publication order: a checkpoint fault can occur after metadata is committed.
- `recovery-audit`, `storage-audit`, `durability-fixes`, and `volume-audit`: plaintext cases ported from the original repository, including allocation rollback, torn metadata-log repair, pending-WAL mode rejection, short/invalid I/O, initialization and close failures, and volume ownership.

The existing crash-consistency, sync-access-handle, worker-audit, binary-metadata, and data-wal suites remain in place. Tests use Vitest, Playwright, real OPFS, and existing injection hooks. No new dependency or framework is needed.

## Encryption

The original repository tests its actual encryption implementation with partial tails, repeated writes before a durability barrier, and crypto block sizes 4096, 16384, and 65536. Distinct VFS blocks share a crypto block only in the larger configurations. The matrix restores old ciphertext with a newer sidecar and vice versa, checks the neighboring file, and remounts twice. The disk one-seal case must return the exact previous committed bytes; other cases use their specific integrity-error contract.

The core repository contains no encryption implementation. Its transformed-storage fixture tests the public storage interface. The encryption cases belong in the premium package when its repository is available; they must run against that implementation rather than a substitute cipher.

## Running and extending

Run `pnpm test` and `pnpm build` at the workspace root. Tests live in `packages/opfs-vfs/src/__tests__`. In the original package, run the corresponding Vitest suites in Chromium and Firefox. Mutation checks should reject suffix-only recovery, rounded-up physical extents, lost dirty-page identity, and stale-path metadata/replay changes.

Keep seeds bounded and print the operation trace on failure. Increase seed counts when a concrete defect or runtime budget warrants it. An acknowledged durability barrier requires the latest exact state; only genuine crash windows may admit an earlier state.

CI is explicitly deferred to later owner-created tasks. This change adds no workflows or CI configuration.
