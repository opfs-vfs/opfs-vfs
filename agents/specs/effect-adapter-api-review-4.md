# Fourth review: Effect v4 adapter API after the third revision

Date: 2026-09-29
Reviews: the working-tree revision of [effect-adapter-api.md](./effect-adapter-api.md), compared with the staged revision reviewed in [review 3](./effect-adapter-api-review-3.md)
Checked against: this repository at `a16b899`, `effect@4.0.0-rc.118` published sources

## Verification of the applied changes

All four review 3 points were applied, several with more care than proposed. I checked the new factual claims:

| Claim in the revision | Verified at |
| --- | --- |
| Core's `ready` Promise is set once and doesn't cover later recovery | `this.ready = Promise.race([initChain, this.closedSignal])` at construction only (`worker-client.ts:641`) |
| Core can reject with `VFS_LEADER_NOT_READY` while no owner profile is negotiated | `worker-client.ts:2293, 2407, 2745` |
| Status states include `opening`/`recovering`/`closing`/`failed`/`closed` | `ClientStatusState` (`worker-client.ts:104`) |
| `Scope.fork`: the parent owns the child; closing the child detaches it | `effect@4.0.0-rc.118/src/Scope.ts:460-491` |
| `Stream.retry` accepts the `$ => schedule` form; `Schedule.while` metadata has `input` and `attempt` | `Stream.ts:10205-10213`, `Schedule.ts:1813` |
| `ManagedRuntime.disposeEffect` exists | `ManagedRuntime.ts:227` |

The admission rules are sound, and so is the recapture limited to calls refused before dispatch (proven not applied). So is the per-generation gate on retirement. A takeover interrupts every channel at once through `invalidateRouting` → `closeLocalChangeChannels` (`worker-client.ts:2059-2064`). Every active subscription therefore settles as `unknown` together. Allowing new registrations only on a new generation is the correct response.

One concern about correctness remains, and three smaller points.

## 1. `volume.sync` must not report durability across an owner change

Section 4 lets `volume.sync` wait for admission and recapture a generation, like any other single-command operation. `sync` differs from the others: its result is a statement about **earlier** writes, not about itself.

Consider this sequence on a dedicated follower:

1. The application writes `/doc.json`. Owner generation G1 applies it and replies. The write is dirty in G1's memory and journal. The default balanced mode syncs about 150 ms later, and "worker suspension or scheduling can delay it" ([docs/API.md:31](../../docs/API.md)).
2. The owner tab goes away before that sync. Its `pagehide`/`beforeunload` flush is best effort and can't propagate failure (`opfs-vfs.ts:3489-3498`). A crashed or killed tab doesn't run it at all.
3. This tab takes over as G2 and recovers from the last durable state. Depending on how far G1 got, the write may be missing.
4. The application calls `volume.sync`. Admission captures G2, `SYNC` succeeds on G2, and the save handler reports "saved".

Step 4 is a false durability receipt. The spec already warns that "successful writes … alone are not durability receipts", but here the adapter's own typed barrier gives one.

**Recommendation.** Track, per `Volume` service, the generation of the last mutation this service dispatched or had acknowledged (`lastMutationGeneration`). `volume.sync` then:

- runs pinned to `lastMutationGeneration`, **not** to the currently ready one, when there were mutations since the last successful sync;
- never uses the recapture allowance;
- fails if that generation is gone, with `VolumeError` of kind `persistence`, a new adapter code such as `VFS_SYNC_OWNER_CHANGED`, and `outcome: "unknown"`. The message says that writes accepted by the previous owner may not be durable. The application's answer is to reread and verify, as core's docs already advise after owner loss ("reread state, and verify possibly applied writes", [docs/API.md](../../docs/API.md)).

Once `sync` succeeds, reset the tracked generation. With no mutations since the last sync, `sync` may use normal admission against the current owner. It then promises nothing about earlier generations, because there is nothing to promise.

This tracks only this service's own mutations. Other tabs' writes are their concern, as today. Add it to prerequisite 6: a write on G1, a takeover before G1's sync, then `sync` fails with the new code. Also cover the case with no pending mutations, where `sync` succeeds on G2.

This isn't specific to Effect. The same gap exists for any core caller who calls `sync()` after a takeover. Record it as a possible core follow-up: `sync` could fail when the owner changed since the caller's last acknowledged mutation. The adapter can enforce the rule on its own side without waiting for core.

## 2. Smaller points

- **Retirements still pending at registration.** The gate says confirmed release allows new registrations and `unknown` blocks the same generation. It doesn't say what happens when an earlier registration on the current generation is still **retiring** (`closed` hasn't settled). Core's own setup gate waits for pending setup retirements before registering (`waitForSetups`, `plugin-subscriptions/src/client.ts:281-288`). Make the adapter do the same for its own records: wait within the admission deadline, then apply the released/unknown rule. Otherwise the result depends on timing.
- **`errorOf` versus "do not infer lifecycle solely from the encryption reason".** The section 9 example treats `CredentialsRejected` from `Volume.errorOf` as needing a new session, which is correct: that reason only occurs during initialization. So a live volume can see it only through a terminal takeover. The nearby sentence forbids inferring the lifecycle from the reason, and a careful reader will see the two as contradicting each other. State the rule once. `CredentialsRejected`, `KeyDerivationFailed`, `VaultCorrupt`, `UnsupportedFormat`, `SidecarCorrupt` and `PlaintextVolume` arise only while mounting or taking over, so seeing one after mount always means the service is terminal. `IntegrityFailure` can happen on a live volume. For anything else, check `error.reason.cause` for a lifecycle `VolumeError`.
- **Review history is incomplete.** [effect-adapter-api-review-history.md](./effect-adapter-api-review-history.md) says it covers "the first two review rounds", and section 12 of the spec summarizes the third in one paragraph. Add the third-round disposition to the history file, so that the spec's section 12 can shrink to a pointer.

## Not concerns

- **Waiting up to 15 s during a takeover.** User-visible calls can pause for up to `initTimeout` while a successor initializes. That's bounded, affects only the call and not the volume, and is better than failing unrelated code at every takeover.
- **Rescanning the whole view per hint** in the reconciliation example. The spec labels it as fitting small views and names the upgrade path.

## Evidence

| Claim | Source |
| --- | --- |
| Balanced sync is scheduled about 150 ms after the first dirty change, and can be delayed | `docs/API.md:31` |
| The owner's exit flush is best effort and can't propagate failure | `packages/opfs-vfs/src/opfs-vfs.ts:3489-3498` |
| `sync` is generation-pinnable | `GENERATION_METHODS` includes `'sync'` (`packages/opfs-vfs/src/worker-client.ts:79-99`) |
| A takeover interrupts all change channels at once | `invalidateRouting` → `closeLocalChangeChannels('SUBSCRIPTION_INTERRUPTED')` (`worker-client.ts:2059-2064`) |
| Core's subscription client waits for pending setup retirements before registering | `packages/plugin-subscriptions/src/client.ts:281-288, 315` |
