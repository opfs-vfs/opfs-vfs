# Third review: Effect v4 adapter API after the second revision

Date: 2026-09-29
Reviews: the working-tree revision of [effect-adapter-api.md](./effect-adapter-api.md), compared with the staged revision reviewed in [review 2](./effect-adapter-api-review-2.md)
Checked against: this repository at `a16b899`, `effect@4.0.0-rc.118` published sources

## Verification of the applied changes

Every point from review 2 was addressed, and I checked the new factual claims against the source. They hold:

| Claim in the revision | Verified at |
| --- | --- |
| `VFS_ATTACHMENT_LOST` also marks non-terminal routing invalidation, so it can't identify a terminal state by itself | `invalidateRouting` and the pinned-generation refusal both use it (`worker-client.ts:2035, 2043, 2060-2062`) |
| Pinned dispatch skips unbound-descriptor bookkeeping | `checkDescriptorGeneration` returns early when a generation is given, and `relayedFds.delete` runs only unpinned (`worker-client.ts:2045-2054`) |
| Direct core has `writeFileBufferSync` but no `readFileBufferSync` | `opfs-vfs.ts:2521` (no read counterpart) |
| The whole-file helper groups its change records into one logical operation | `withLogicalOperation` (`opfs-vfs.ts:2522-2523`) |
| Append's final size is limited by the helper | `finalSize` check (`opfs-vfs.ts:2546-2547`) |
| Worker `writeFileBuffer` already copies | `Uint8Array.from(bytes)` (`worker-client.ts:3160`) |
| `Scope.make`, `addFinalizer`, `addFinalizerExit`, `close` exist in rc.118 | `Scope.ts:239, 421, 455, 568` |

The routing rules for `a` and `ax` are more careful than what review 2 proposed. Keep them.

Four concerns remain. None is a blocker. The first is the one most likely to cause user-visible failures.

## 1. Pinning path operations per call: define the takeover window

Section 4 now says that "each new path operation captures the currently ready owner generation and dispatches through its `forGeneration()` facade." Pinning is worth it: only the facade produces `VfsCommandError.dispatch`, and `outcome` depends on that. But two cases are unspecified, and both occur at every takeover:

- **No owner is ready.** During a takeover, `getStatus()` reports `recovering`, and there's no generation to capture. The spec should say whether a call waits for the next `ready` (bounded by the client's `initTimeout`) or fails at once. Waiting matches what unpinned calls do today: `sendToWorker` awaits readiness before checking the generation (`worker-client.ts:2027-2029`). Failing at once would make every takeover visible as errors in unrelated code.
- **The generation changes between capture and dispatch.** `sendToWorker` then refuses the call before sending it (`worker-client.ts:2031-2035`), and the facade reports `dispatch: "refused"`. That is proven not applied. For a **single-command** operation, re-capturing the generation and dispatching once more is not a replay, because nothing reached any owner. Without that rule, every call that happens to race a takeover fails, even though core can prove it's safe to send again.

**Recommendation.** For single-command path operations: wait for `ready` if no owner is ready; if the pinned call is refused before dispatch, re-capture and dispatch once more. Anything that reached an owner (`sent` or `replied`) is never re-sent, as the spec already says. Multi-command operations (`copy`, chunked I/O) keep the current rule: one generation for the whole operation, and fail on a change. This doesn't conflict with "never replay automatically", because a refusal before dispatch is not an attempt. Add both cases to prerequisite 6.

## 2. Use `Scope.fork` instead of the hand-built child scope transfer

Section 4 builds the private acquisition scope from `Scope.make()` and later attaches it to the parent with `Scope.addFinalizerExit(parent, exit => Scope.close(child, exit))`. rc.118 already provides this: `Scope.fork(parent, strategy?)` creates a child registered with the parent. "Closing the parent closes the child with the same exit value, and closing the child detaches it from the parent" (`Scope.ts:460-491`).

That covers every property the spec wants:

- **Failed acquisition:** `Scope.close(child, exit)` runs the partial cleanup and detaches, so nothing leaks into the parent.
- **Success:** nothing more to do. The child is already owned by the parent.
- **Parent closes during acquisition:** the child closes with the parent's exit. The hand-built version has to handle that separately, because the transfer finalizer isn't registered yet.

This removes one masked step and one ordering hazard from step 4 of the algorithm. Keep the masking around discovery and finalizer registration unchanged.

## 3. Export one unwrapping helper instead of documenting three-level nesting

A terminal unlock failure seen from the filesystem is now `PlatformError` → `reason.cause: VolumeError(lifecycle)` → `cause: EncryptionError`. The example in section 9 needs two guards and a four-part condition just to recognize it. Each application will write that chain again, and some will skip the middle level.

The adapter already knows every shape it produces, so export one function:

```ts
/** The adapter error behind a PlatformError, unwrapping one lifecycle wrapper. */
Volume.errorOf(error: PlatformError): VolumeError | EncryptionError | SubscriptionError | undefined
```

The section 9 example then becomes:

```ts
const cause = Volume.errorOf(error)
if (isEncryptionError(cause)) {
  // Only IntegrityFailure appears on a live volume; CredentialsRejected etc. arrive after a terminal takeover.
}
```

Keep the nested structure: it records what actually happened, and `kind: "lifecycle"` still tells callers that the volume is gone. The helper only saves callers from walking it by hand. This is separate from the revision's decision that no extra *guard* export is needed. `Schema.is` covers guards, but unwrapping still has to be written somewhere.

## 4. Documentation fixes in the new examples

- **The late-credential example mounts once per save.** In `saveBarrier` (section 8), `mountEncrypted` sits inside `Effect.scoped` around `waitForUserSave()`, so every save mounts and closes the volume. That doesn't match how the section describes the failure ("minutes after mounting", inside a long-lived session), and readers will copy the structure. Show a long-lived runtime instead. The application's save handler runs `volume.sync` against the `Volume` from its `ManagedRuntime`, catches `EncryptionError`, and then calls `replaceSessionWithCredentials`, which disposes the runtime and builds a new one.
- **`fs.watch` across a takeover.** Section 4's table says active subscriptions end with `SUBSCRIPTION_INTERRUPTED` and that the application resubscribes. For the standard `watch`, also state the `PlatformError` reason (`Unknown`, with the `SubscriptionError` in `reason.cause`). Say that the adapter does not resubscribe by itself, because events between the two subscriptions would be lost silently. Show the pattern a generic consumer needs: `Stream.retry` with a schedule, followed by a rescan. Without this, code written against `NodeFileSystem.watch` sees an unexplained stream failure whenever another tab closes.
- **Section 12 history.** The "Second review disposition" table is useful now, but by the next revision sections 12 and 13 will be longer than several API sections. Before the final design document, move the disposition tables into the review files or into a short changelog. Keep the spec to the current decisions.

## Not concerns

- **Upfront descriptor routing for `a`.** Core checks the append final size before mutating (`opfs-vfs.ts:2546-2547`), so an `EFBIG` from the helper would, in principle, be a safe signal to fall back. But the reply alone doesn't show which check failed, and later write stages can also fail with size or quota errors. Routing `a` to descriptors upfront is the right conservative choice.
- **Waiting for aborted discovery to settle** is correct. It keeps late cleanup failures observable. The requirement that every discovery path must settle on abort or timeout is the right test gate.

## Evidence

| Claim | Source |
| --- | --- |
| Pinned dispatch awaits readiness, then refuses on generation mismatch before sending | `packages/opfs-vfs/src/worker-client.ts:2020-2046` |
| Routing invalidation uses `VFS_ATTACHMENT_LOST` and interrupts change channels | `worker-client.ts:2056-2070` |
| `Scope.fork`: parent close closes the child; child close detaches | `effect@4.0.0-rc.118/src/Scope.ts:460-491` |
| Helper checks append final size before opening | `packages/opfs-vfs/src/opfs-vfs.ts:2533-2549` |
