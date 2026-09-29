# Effect adapter API review history

Historical decisions from all five review rounds. The [current spec](./effect-adapter-api.md) is authoritative; later entries supersede earlier acquisition/recovery choices.

## First review disposition

| Finding | Resolution after verification |
| --- | --- |
| B1 / C3: plugin-dependent mount errors | Adopt fixed `MountError`. Keep generic missing-provider errors under `VolumeError`; an encryption-specific class is not justified by a generic provider code. Verify/reclassify the actual premium throw sites before promising credential-specific recovery. |
| B2: bounded suspending queue | Adopt source acknowledgment backpressure, unsubscribe-before-queue-release ordering and owner overflow. Correct the claim that capacity affects only latency. Clarify that delayed acknowledgment does not backpressure filesystem writers; the first review did not claim otherwise. Account for rc.118 queue failure draining behavior. |
| B3 / C4 / C5: subscription handle | Adopt `{ changes, retired }`, early release and scope backstop. The original bare stream was not inherently unable to own a child scope, but the handle makes retirement explicit. `retired` settles on released or unknown, not only confirmed release. |
| B4: owner loss and descriptors | As corrected in the second review, ordinary dedicated takeover preserves services and invalidates generation-bound resources; terminal client failure requires remount. Reject the claim that current `forGeneration` includes file descriptors. Do not convert interruption into a fictional typed outcome or replay a mutating workflow. |
| I1 / C2: watch dependency and defaults | Adopt direct subscription dependency and bundled registration. Retain explicit activation; do not silently alter every mount profile. Node watch events are not guaranteed rename pairs, although OPFS logical rename records are. |
| I2: multiple volumes | Add the named-tag layer example and retain reference-based sharing semantics. |
| I3: configuration ergonomics | Accept plain options or Effects, and plugin thunks to capture factory throws. Eager factory exceptions occur before the adapter can catch them; arbitrary Effect defects remain defects. |
| I4: pre-readiness acquisition | Adopt early resource ownership; require a private failed-acquisition scope and deliberate interruption handling. Correct the claim of absent tests using `close-admission.test.ts`. Reject discarding cleanup failures before readiness. |
| I5: sync and closed state | Specify direct `syncSync` / worker `SYNC`, plus adapter liveness guards. Full FLUSH is a different operation. |
| I6: method/error conformance | Add method/mapping tables and pinned differential tests. Correct append races, numeric timestamp units, whole-file helper limits, recursive listing assumptions and unnecessary loss of available block metadata. Defer `glob` explicitly. |
| P1: Volume.layer also provides FileSystem | Retain separate outputs; the existing one-step composition is explicit and avoids implicit extra services. |
| P2: make naming | Adopt `make` / `makeDirect`; no shipped names need aliases. |
| P3: persistence snapshot | Adopt snapshot only, with current error. Direct public status has no failure revision, so do not invent one or promise common history semantics. |
| P4: checked shutdown | Keep typed sync and observable finalizer failures. No global shared-owner shutdown API. |
| P5: unsafe backend | Adopt a borrowed accessor with transport and ownership limits. |
| P6: share React classification | Reuse vocabulary/semantics. Defer code extraction until implementation demonstrates the common helper; no speculative framework or unrelated React refactor. |
| P7: direct operations | Synchronous VFS calls block their worker thread and cannot be preempted mid-call. Wrap fallible calls with typed `Effect.try`, not bare `Effect.sync`. |
| P8: Effect pin | Independently fetched published rc.118 sources and package metadata. Pin this target; no claim that the mutable main hash matches every published file. |
| Smaller corrections | Validate volume names and keep capabilities private. Adopt `VolumeError` for missing subscription capability, but extend the suggested subscription code union with a typed setup fallback. |
| Review's final composition example | Correct dependency direction: consumer layers receive `DocumentsVolume`, not the reverse. Keep `sync`'s declared error union consistent with post-mount encryption failures. |

Further corrections: React currently adds a subscription request beyond just its default-worker case, so its defaults are precedent rather than an exact recipe. Inspecting a file through an unlocked owner does not authenticate a follower's secret. The broader premium standalone operations are deferred; this document does not specify new wrappers for them.

## Second review disposition

| Finding | Resolution after source verification |
| --- | --- |
| 1: takeover lifetime | Adopt surviving services and per-operation/per-resource generation capture. Qualify terminal detection: `VFS_ATTACHMENT_LOST` also marks nonterminal routing invalidation. |
| 2: late credentials | Adopt terminal lifecycle wrapping, direct encryption failures for `sync`, status-error retention and a remount example outside the old scope. Earlier in-flight mutations retain their uncertainty. |
| 3: whole-file baseline | Adopt existing helpers for compatible calls and read-only fallback. Use helper `ax`, but route ordinary `a` through descriptors upfront because final size is unknown. Document direct backend differences and observable notification/intermediate-state differences. A helper is not a rollback guarantee. |
| 4: descriptor prerequisite | Start with the small list-extension spike and hazard tests. No untested claim that it suffices; the full adapter still requires proven descriptor safety. |
| 5: interruption pattern | Adopt masked ownership transitions and interruptible awaits. Complete child-scope transfer/failure cleanup, typed Promise rejection and joined late cleanup. Do not copy the detached Promise cleanup sketch. |
| 6: smaller corrections | Verify `Schema.TaggedError`/`Schema.is` through opensrc; document React profile interop, timeout codes, layer use of `unlockExisting`, actual credential retention and descriptor buffer transfer. Correct the first-review B2 attribution. |
| 7: retained decisions | Keep the private child scope, generic missing-provider classification, subscription setup fallback, content-memory bound, current wire fields and snapshot-only persistence API. |


## Third review disposition

- Takeover admission: adopt bounded live-status waiting and one local generation-refusal recapture. Core's initial `ready` Promise does not reset; the adapter owns the readiness deadline. Sent/replied commands and multi-command operations never recapture.
- Scope: use verified `Scope.fork`; retain explicit close/abort guards because scope linkage is not automatic fiber cancellation.
- Error access: add `Volume.errorOf`, unwrapping one adapter lifecycle wrapper and leaving the original error intact.
- Sessions: show a long-lived ManagedRuntime, with replacement orchestrated after the save fiber exits and no mutation replay.
- Watches: map takeover failure to Unknown/SubscriptionError and keep explicit recovery. Standard watch lacks a readiness signal; demonstrate scoped rich-subscription registration, scan, consumption, retirement and bounded retry.
- Retirement: core takeover produces unknown retirement. Block same-generation reuse but allow confirmed new-generation registration, without changing the old retirement result to released.
- History: move prior tables here; keep current decisions in the spec.

## Fourth review disposition

- Sync continuity: adopt generation-pinned barriers for pending mutations and exclude sync from automatic recapture. Strengthen the proposed last-mutation field to retain the oldest unresolved generation and latch continuity loss: later G2 writes cannot hide G1 uncertainty. Use a private mutation-command/barrier gate for a simple concurrency contract. File.sync, interruption, save UI and verification-before-remount are covered explicitly. A raw-core continuity check is a possible follow-up, not a dependency.
- Pending retirement: wait for same-generation retiring handles within the existing admission deadline, recheck before registration, and report a typed timeout without rewriting the old retirement result. New-generation admission remains allowed.
- Encryption lifecycle: verified initialization-only reasons in premium mount/unlock/sidecar paths and corrected the earlier broad claim about live KDF/sidecar failures. Integrity failure remains possible during live I/O; retain the original lifecycle wrapper for ambiguous/future cases.
- History: the third-round disposition was already present. Correct the stale introduction and reduce the spec's review-status section to a pointer.

## Fifth review disposition

- Acknowledgment: add `acknowledgeOwnerChange` so a deliberate reconciliation decision can adopt the current owner without destroying the session. Preserve current-owner pending mutations; acknowledgment is neither verification nor a durability receipt, and is not automatic. Guard a generation change during acknowledgment without recapture.
- Defaults: document conservative continuity warnings when an application relies only on balanced background flushing. Defer an owner-reported, generation-specific durable command watermark to core; current persistence frames are insufficient evidence.
- Ordering: admit outside the mutation gate, acquire within the same deadline, then revalidate generation under the gate before tracking/dispatch. Release before any renewed admission; share one recapture budget across local checks and facade refusals.
- Gate errors: distinguish `VFS_MUTATION_QUEUE_TIMEOUT`. Core already bounds leader requestWorker calls and rejects pending requests on worker crash/timeout; document the verified 30s/300s paths and event-loop limitations instead of treating leader requests as unbounded.
- Split: the API file now holds the public surface, guarantees and examples; the companion implementation contract holds algorithms, source evidence and acceptance tests. Existing review documents are unchanged.

## Sol review of the fifth-round changes

- Corrected a false-save gap: acknowledging loss must establish `pending(G)` even with no G writes. Otherwise a takeover between acknowledgment and the required sync could turn a later-owner barrier into a save receipt. This removes the need for a separate latest-pending-generation field. The acceptance tests include the G1 loss → acknowledge G2 → G3 before sync sequence.
- Sol re-reviewed the saved correction and returned **ACCEPT**, with no remaining blocker. Clarified that pending state can represent an acknowledgment barrier without a mutation.
- Validation: local document links, heading anchors, code fences and whitespace checks passed. An isolated TypeScript fixture against Effect `4.0.0-rc.118` compiled and ran the acknowledgment example with a stub service, confirming that a later sync failure propagates. These checks do not validate the unimplemented adapter state machine or browser behavior.

## Earlier decisions moved from the API spec

> Decision: accept the review's dependency simplification, but retain the discussion's opt-in plugin behavior. Registering a bundled factory makes it available; it does not activate it. Automatic subscriptions would change mount profiles and prevent some existing-owner attachments.

> Correction to review I3: an adapter cannot catch a factory call that executes before `Volume.layer(...)` is called. Nor should it turn every defect in a caller's Effect into a configuration error. Use the plugin thunk for automatic wrapping, or an explicit typed Effect boundary for fallible caller code.

## Sixth review disposition

- Removed the mutation-queue deadline and `VFS_MUTATION_QUEUE_TIMEOUT`. Queue waiting is interruptible; core bounds dispatched commands. Ready-owner waits retain a cumulative `initTimeout` budget across recapture, excluding gate waiting and command execution. Subscription retirement still shares the readiness budget. Caller timeouts do not classify mutation outcomes or release another command's gate.
- Kept under-gate liveness/generation checks and specified that closure/terminal failure wakes queued callers without dispatch. Acceptance cases cover a healthy long sync, queued cancellation and readiness recapture after a long queue wait.
- Moved acquisition/persistence/error-classification/derivation mechanics into the implementation contract and prior review dispositions into this history. Shortened the API introduction and organized the session-replacement checklist.
- Fixed the watch-example link, prerequisite-table link and admission's platform-mapping link. Prior review inputs remain unchanged.

- Sol reviewed the sixth-round changes and returned **ACCEPT**, with no blocker. Applied its terminology correction: subscription retirement uses the remaining shared readiness/retirement budget.
- Validation: document links, heading anchors, code fences and whitespace checks passed. An isolated fixture compiled and ran against Effect `4.0.0-rc.118`, confirming that caller `Effect.timeout` interrupts its source and reports `TimeoutError`. The adapter remains unimplemented; queue/lifecycle behavior is specified in acceptance tests, not claimed as verified runtime behavior.
