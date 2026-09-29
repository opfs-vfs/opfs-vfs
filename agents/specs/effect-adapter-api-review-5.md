# Fifth review: Effect v4 adapter API after the fourth revision

Date: 2026-09-29
Reviews: the working-tree revision of [effect-adapter-api.md](./effect-adapter-api.md), compared with the staged revision reviewed in [review 4](./effect-adapter-api-review-4.md)

## Verification of the applied changes

All review 4 points were applied:

- **Sync continuity** (section 3, "Sync and owner continuity"). `volume.sync` no longer turns a G2 barrier into a receipt for writes that G1 accepted. The design goes further than proposed, and correctly. It tracks the *oldest* unsynced generation, so later G2 writes can't overwrite a G1 marker. It latches `continuity-lost` so the failure can't be cleared by accident. It keeps a valid G1 `SYNC` reply even if the status changes afterwards. And `sync` never uses the recapture allowance.
- **Retirements still pending** now wait within the shared admission deadline, re-check before registering, and have their own timeout code.
- **The encryption-reason rule** is stated once and consistently: these reasons arise only during initialization, so after mount they mean the service is terminal. `IntegrityFailure` is the exception, and anything unclassified is checked through the lifecycle wrapper.
- **The review history** now covers all four rounds, and section 12 is a pointer.

What's left is about the cost of the new continuity state and one ordering gap it introduces. None of it changes the safety property, which should stay.

## 1. Recovering from continuity loss: remounting adds nothing, so allow an in-place acknowledgment

Once `continuity-lost(G1)` is latched, the spec requires the application to "deliberately close/remount to establish a new save baseline", with "no v1 method to dismiss the marker in place". The same paragraph says "remounting alone does not prove old writes survived." So remounting gives the application no information it doesn't already have after rereading and comparing. It only costs:

- every scope, `File`, subscription and runtime-owned fiber of the session;
- another takeover or attach cycle for other tabs, if this tab is the owner;
- application code that has to rebuild the session just to clear a flag.

It also happens often. The marker is cleared only by an explicit `volume.sync` ("Background flushes, status snapshots … do not clear the adapter's marker"). An application that writes and relies on balanced flushing (core's default, and what `fs.writeFile` users will do) stays in `pending(G1)` indefinitely. Any later takeover, which happens whenever another tab closes, then forces the verification flow and a remount. Many applications will hit this in normal use, not only after a crash.

**Recommendations.**

1. Add one explicit, typed acknowledgment instead of requiring a remount:

   ```ts
   interface VolumeService {
     // …
     /** After the application has reconciled, adopt the current owner as the new save baseline. */
     readonly acknowledgeOwnerChange: Effect<void, VolumeError>
   }
   ```

   It changes `continuity-lost(G1)` to `clean`, or to `pending(Gcurrent)` if this service mutated on the current owner after the loss. It takes the same gate as `sync`, so it can't race a barrier. It proves nothing about G1's writes. It records that the application has decided how to handle them, which is exactly what a remount records today, at a much lower cost. Unacknowledged, the state stays latched as it is now.

2. Document the common path next to the default durability mode: "if you don't call `volume.sync` at save boundaries, the next takeover after a write reports `VFS_SYNC_OWNER_CHANGED` on your next sync." Point applications that want to avoid that to calling `sync` at save boundaries, as the core docs already recommend.

3. Record a core follow-up that removes the false alarms without weakening the rule: an owner-reported **durable watermark** per generation, that is, the highest command sequence covered by a completed local sync. The adapter could then clear `pending(G1)` from G1's own evidence, even when a background flush did the work. Don't approximate it in v1 from persistence-status frames. Their ordering relative to command replies isn't guaranteed on follower relay paths.

## 2. Say in which order admission and the mutation gate run

Two new rules interact but aren't ordered against each other:

- A mutation records its tentative `pending(generation)` "under the gate" before dispatch.
- Admission waits, up to `initTimeout`, for a ready owner and captures its generation. "Gate waiting … consumes that same budget."

If the gate is acquired first, one call waiting through a takeover holds the gate for up to 15 s. Every other mutation and every `sync` of the service queues behind it, including calls that could have gone to the new owner as soon as it was ready. If admission happens first, the captured generation can be stale by the time the gate is acquired, and the pending marker then records the wrong owner.

**Recommendation.** Specify: admission → acquire the gate → **re-read and re-validate the ready generation under the gate** → record pending → dispatch. If the generation changed while waiting for the gate, treat it like a refusal before dispatch. That uses the existing one-recapture allowance for single-command operations, and gives a failure for `sync` and multi-command work, both within the original deadline. The gate is then never held during an admission wait, and the pending marker always names the generation that actually gets the command.

## 3. Name the gate's failure modes

- **A holder that never settles.** The gate is held "until the Promise settles even if the caller is interrupted". For followers, core's `LEADER_RESPONSE_TIMEOUT` bounds that. For a leader talking to its own dedicated worker, a command that never settles (a hung worker) holds the gate forever, and every later mutation and `sync` then fails at its deadline. That may be acceptable, since a hung owner is broken anyway. But say so, and check in the prerequisite 3 tests that the leader path has an in-flight bound, or that a worker crash rejects pending requests.
- **The error code for a busy gate is misleading.** Waiting for the gate is charged to the admission budget, and expiry "uses the admission-timeout mapping", which is `VFS_OWNER_READY_TIMEOUT`. When the owner is ready and the gate is merely busy, that code sends people debugging the wrong problem. Use a distinct adapter code (for example `VFS_MUTATION_QUEUE_TIMEOUT`), with the same `TimedOut` projection and `outcome: "not-applied"` (or `"unknown"` for `sync` with pending writes, as now).

## 4. Preference: separate the public API from the implementation contract

The spec is now 781 lines. Most of the recent growth is implementation contract rather than public API: the acquisition algorithm, admission, recapture, the continuity state machine, retirement gating. Those rules are necessary, and they are well reasoned. But a reviewer judging the **API** now has to read past them to find a surface that is still small:

- `Volume`: `make`/`layer`/`makeDirect`/`layerDirect`/`inspect`/`unsafeBackend`/`errorOf`, plus `sync` and `persistence`
- `OpfsFileSystem`: `make`/`layer`
- `Subscriptions`: `subscribe` → `{ changes, retired }`
- three error classes and their code or reason unions

Before this becomes the final design document, split it:

- **API** (sections 1–3, 5, 6 tables, 7 types, 8–10): the public surface, error vocabulary and user-visible guarantees, each guarantee in one sentence. For example: "`sync` never reports durability for writes accepted by a previous owner."
- **Implementation contract** (the acquisition algorithm, admission and recapture, the continuity state machine, retirement gating, queue ordering): the rules that make those guarantees true, and the section 11 tests that check them.

Nothing needs to be removed. The goal is that API reviewers and implementers each have one document that is complete for their purpose.

## Not concerns

- **Serializing mutation RPCs through one gate.** It is simpler than a watermark design and costs little in practice, because the owner executes commands on one worker thread anyway. The spec defers the concurrent design until measurements justify it, which is the right order.
- **`continuity-lost` staying latched after later G2 syncs** is correct without an explicit acknowledgment (point 1).

## Evidence

No new source claims. The points above follow from the revision's own text (section 3 "Sync and owner continuity", section 4 "Admission during takeover") and facts verified in earlier rounds: balanced flushing (`docs/API.md:31`) and `LEADER_RESPONSE_TIMEOUT` on follower relays (review 2, section 6).
