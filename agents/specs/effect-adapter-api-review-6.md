# Sixth review: split API spec and implementation contract

Date: 2026-09-29
Reviews: [effect-adapter-api.md](./effect-adapter-api.md) (working tree) and [effect-adapter-implementation-contract.md](./effect-adapter-implementation-contract.md) (new, untracked)
Earlier round: [review 5](./effect-adapter-api-review-5.md)

## Verification of the applied changes

All review 5 points were applied:

- **In-place acknowledgment.** `acknowledgeOwnerChange` exists, and it doesn't clear a failure on its own authority. It re-pins the pending barrier to the admitted owner even without writes on that owner, so a G→H takeover before the follow-up `sync` still fails. That is stricter than review 5 proposed, and correct. Acceptance test 7 covers the G1 → G2 → G3 case.
- **Admission and gate ordering** are fixed: admission, then the gate, then re-validation under the gate, then tracking, then dispatch. The gate is never held while waiting for an owner, and one recapture allowance covers both refusal paths.
- **The gate's failure modes** are named, with a distinct `VFS_MUTATION_QUEUE_TIMEOUT`. The claims about core's own bounds hold: `DEFAULT_COMMAND_TIMEOUT_MS = 30_000` and `LONG_COMMAND_TIMEOUT_MS = 300_000` for `FLUSH`/`SYNC`/`FSYNC`/`CLOSE_VFS`/`LIST_PATHS` (`worker-client.ts:196-203`). `failWorker` sets `VFS_WORKER_FAILED` (`worker-client.ts:2201-2202`), and the `messageerror` handler is at `worker-client.ts:1122`.
- **The split** puts the public surface in the API spec and the mechanics in the contract. The contract's anchors resolve (`#persistence-continuity`, `#acquisition-shutdown-and-owner-changes`, `#error-classification-prerequisites`, `#filesystem-routing-and-conformance`, `#subscription-delivery-and-retirement`, `#acceptance-tests-and-release-gates`, `#evidence-and-source-references`).

One design point remains, plus cleanup that's worth doing before the final version.

## 1. Drop the deadline on waiting for the mutation queue

The contract charges gate waiting to the admission budget (`initTimeout`, 15 s by default) and fails the call with `VFS_MUTATION_QUEUE_TIMEOUT` on expiry. With the timeouts verified above, that deadline mostly produces errors that neither core nor the application would otherwise see:

- A `SYNC` may legitimately run for up to 300 s before core gives up. While it holds the gate, every write the application issues through this volume fails after 15 s with an adapter-invented error, even though the owner is healthy and would have processed it.
- The waiting it guards against is already bounded. Every holder settles within core's command timeout, or `failWorker` rejects all pending requests and marks the client terminal. The contract says this itself ("Core already bounds leader-to-worker `requestWorker` calls…"). The only unbounded case is an injected endpoint that breaks core's settlement contract, which the contract already treats as a broken backend.
- Without the gate, those same writes would have queued inside the worker behind the `SYNC` and succeeded. The deadline makes a correctness mechanism (ordering against barriers) behave differently from the plain client.

**Recommendation.** Wait for the gate interruptibly, **with no adapter deadline**. The holder's lifetime is bounded by core. Callers who want a limit use `Effect.timeout`, which gives interruption and not an invented `outcome`, and nothing has been dispatched while the call waits. Keep the admission deadline for *owner readiness* only, where the adapter really is the only thing deciding how long to wait.

This removes `VFS_MUTATION_QUEUE_TIMEOUT` and its row in the platform mapping, one branch of the gate ordering (step 2), and a row of the test matrix. It changes no safety property. The same reasoning applies to the retirement wait in subscriptions, but that one stays bounded by the admission deadline, and it should: a pending retirement has no core-side bound comparable to the command timeouts.

## 2. Content that still belongs to the contract or the history

The API spec is 603 lines. Its public surface would fit in about half of that. What remains is mostly implementation or history that the split left behind:

| API spec location | Content | Move to |
| --- | --- | --- |
| §2, blockquote "Decision: accept the review's dependency simplification…" | Review disposition | History |
| §3, blockquote "Correction to review I3…" | Review disposition | History |
| §3, "Guard adapter liveness before all operations: direct `syncSync()` silently returns…" | Implementation | Contract, persistence |
| §3, `persistence` paragraph: `getLocalPersistenceStatusSync()` / `getStatus().persistence` sources, "do not expose a fabricated failure revision" | Implementation. The public part is the `PersistenceSnapshot` type and "snapshot, not a stream" | Contract |
| §5, "This release exports `Schema.TaggedError`, not `Schema.TaggedErrorClass`… schema classes do not receive a static `.is`" | Implementation and verification note. The public part is "use `Schema.is(ErrorClass)`" | Contract, evidence |
| §5, "Latch the terminal status error… Check `getStatus()` at operation boundaries… status notifications are coalesced" | Implementation | Contract, owner changes |
| §5, "Reuse React's `kind`/`outcome` vocabulary… a common dependency-free classifier can be extracted" | Implementation plan | Contract |
| §6, "Reuse upstream derivation instead of `makeNoop` stubs" | Implementation | Contract, filesystem routing |
| §8, the paragraph after the session example (line 409, ~170 words) | An application checklist written as prose | Bullet list, or a short "session replacement" subsection |

There are also two wording contradictions from the split:

- The API spec calls itself "the self-contained API proposal" (line 15). The contract says "implementers need both documents." Say instead that the API spec is complete for API review and the contract is complete for implementation.
- The API spec's title is still "revised review draft". Rename it to match the contract, for example "Effect v4 adapter: API".

## 3. Broken cross-references in the contract

- **Contract, watch semantics:** "Section 9 shows the registration-aware reconciliation pattern." Section 9 is in the API spec. Link it: `[API §9](./effect-adapter-api.md#recovering-a-watched-view)`.
- **Contract, acceptance test 1:** "Land/test the bounded core and premium error-code corrections from [API error contract](./effect-adapter-api.md#5-error-api-and-decoding)." That table is in the contract's own [error classification prerequisites](#error-classification-prerequisites) section, so the link goes to the wrong document.
- **Contract, admission:** it links the lifecycle mapping to `./effect-adapter-api.md#5-error-api-and-decoding`. The target is correct, but the platform-mapping table is under `#platform-error-mapping`. Link there, since that's the table the sentence relies on.

## Not concerns

- **`acknowledgeOwnerChange` accepts uncertainty from every earlier owner at once**, and doesn't scan and acknowledge atomically. It says so explicitly and doesn't claim more.
- **Acknowledging with no unresolved loss is a no-op on a clean or direct mount.** That's correct and keeps the method safe to call from UI code.
- **The 30 s default command timeout makes a slow worker command terminal.** That's core behavior, correctly inherited. It's outside the adapter's API.

## Evidence

| Claim | Source |
| --- | --- |
| Command timeouts: 30 s default, 300 s for long commands | `packages/opfs-vfs/src/worker-client.ts:196-203` |
| `failWorker` sets `VFS_WORKER_FAILED` | `worker-client.ts:2201-2202` |
| Worker `messageerror` handler | `worker-client.ts:1122` |
