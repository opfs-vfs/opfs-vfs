# Subscription acceptance evidence

Status: desktop acceptance evidence for the S7 documentation branch, recorded on 2026-09-25. This is not a publication record and does not close the physical-mobile gate.

## Artifact and environment

| Item                  | Value                                                              | Evidence kind                  |
| --------------------- | ------------------------------------------------------------------ | ------------------------------ |
| Core source           | `93244c6619af53487947450759fa48f56f43afa4`                         | selected source revision       |
| Core tarball          | `opfs-vfs-opfs-vfs-1.0.1.tgz`                                      | installed input                |
| SHA-256               | `2a25acc4e172ac0781552e563a0e41af3d30ec122ce2d509f81eaadcef29b72d` | verified input digest          |
| Host                  | macOS 26.6.2 (25G83), Apple M5 Pro, arm64, 64 GiB                  | measured host metadata         |
| Browser configuration | cross-origin isolated dedicated workers                            | measured harness configuration |

The original premium checkout verified the selected tarball with `core-artifact.json`. These are historical measurements, not results for the relocated package. A registry package with the same version is not substituted for this artifact.

## Manual desktop browser capability observations, 2026-09-25

| Engine   | Version       | Isolation, SAB, locks, BroadcastChannel | Native OPFS sync access                                                                | One-off observation            |
| -------- | ------------- | --------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------ |
| Chromium | 147.0.7727.15 | observed available                      | write/read probe passed                                                                | supported in this manual probe |
| Firefox  | 148.0.2       | observed available                      | write/read probe passed                                                                | supported in this manual probe |
| WebKit   | 26.4          | observed available                      | `navigator.storage.getDirectory()` raised `UnknownError` before access-handle creation | this local manual probe failed |

No committed harness reproduces these observations. The WebKit result is a concrete local environment failure, not a statement that WebKit browsers generally lack OPFS support. No full WebKit subscription suite was claimed.

## Acceptance gates

| Gate                                               | Status     | Basis                                                                               |
| -------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------- |
| Chromium subscription and packed-consumer behavior | met        | asserted by the committed browser and packed-consumer tests                         |
| Firefox subscription behavior                      | unverified | 2026-09-25 manual capability observation only; no committed Firefox harness         |
| WebKit local OPFS access                           | unmet      | the 2026-09-25 manual probe failed before access-handle creation                    |
| Per-subscription and aggregate reservation charges | unverified | inferred from configured limits and asserted scenarios, not allocation measurements |
| Owner metadata and transport-control high-water    | unverified | no telemetry seam reports these peaks                                               |
| Physical mobile WebKit or Android Chrome           | unverified | no physical-device run is recorded                                                  |

## Observed subscription checks

| Workload                                            | Result                          | Measured values                                                                                                                                                                                                                     |
| --------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chromium subscription suite                         | pass                            | 4 files, 57 tests; 3 opt-in workload tests skipped in the regular suite                                                                                                                                                             |
| Firefox owner, client, and completed-content routes | manual one-off pass, 2026-09-25 | no committed Firefox harness; this manual run covered 4 files and 57 tests across the route and recovery runs, including direct, worker, SAB, and two-follower memory/disk routes                                                   |
| Installed tarball consumer                          | pass                            | direct and worker/follower consumers, 2 browser tests; package README byte identity and TypeScript-fence compilation included                                                                                                       |
| Hard-link capture authorization and source I/O      | pass                            | two allowed recipients receive `included`; denied literal alias receives `unavailable`; each 4,096-byte disk operation observed one capture-scoped native read in each namespace order                                              |
| Two followers retaining A then B                    | pass                            | historical A/B arrays, recipient isolation, later delete/recreate, asymmetric release/termination in memory and disk browser routes                                                                                                 |
| Two subscriber rename burst                         | pass                            | 4,096 records delivered to each subscriber: 8,192 delivered recipient records                                                                                                                                                       |
| Owner-local worker producer to follower subscriber  | pass                            | 10,000 commands and deliveries, no errors; producer 3815.755 ms / 2620.7 commands/s; through final delivery 3832.557 ms                                                                                                             |
| Owner-local worker producer/subscriber              | pass                            | 10,000 commands and deliveries, no errors; producer 5893.805 ms / 1696.7 commands/s; through final delivery 5908.609 ms                                                                                                             |
| Follower producer/subscriber                        | pass                            | 10,000 commands and deliveries, no errors; producer 7762.565 ms / 1288.2 commands/s; through final delivery 7766.051 ms                                                                                                             |
| Direct dedicated-worker producer/subscriber         | bounded overflow observed       | 10,000 synchronous commands block that worker’s callback tasks; 0 deliveries and `SUBSCRIPTION_OVERFLOW` after 2,163.250 ms. This is the expected one-credit result for this baseline, not a failure of the owner-to-follower gate. |

The burst count is a measured delivery count, not an owner-ledger high-water measurement. The first held callbacks arrived after 12.663 ms. Producer timings cover only the separately awaited write loop in its page; time through final delivery also includes orchestration and draining. The same run recorded 38,192 acknowledgement RTT samples with mean 0.484381 ms and maximum 63.790 ms, and 30,000 command-start-to-callback samples with mean 1.484975 ms and maximum 63.825195 ms. These are single-run measurements, not latency or throughput guarantees.

## Accounting and timing interpretation

| Metric                                             | Value                                                                 | Classification and source                                                                                                                              |
| -------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Capture source reads                               | one per operation/inode for the hard-link test                        | measured by the test-only `FileSystemSyncAccessHandle.prototype.read` wrapper only while `operation.capture()` runs                                    |
| Historical payload copies                          | isolated recipient arrays in direct, worker, SAB, and follower routes | measured behavior: tests mutate one recipient’s held bytes and observe the other recipient and current filesystem state unchanged                      |
| Two followers with A and B at 16 MiB               | 128 MiB held (144 MiB peak during a completion)                       | asserted by the owner unit test: 64 MiB delivery + 64 MiB relay, plus one 16 MiB source while `completed` runs                                         |
| Per-subscription content retention                 | 32 MiB for two 16 MiB versions                                        | inferred from enforced configured limit and asserted scenario; not a heap measurement                                                                  |
| Owner metadata, queue, and transport-control peaks | unavailable                                                           | no public telemetry API or test-owned seam reports these exact peaks                                                                                   |
| Acknowledgement RTT and command-start callback lag | see two-tab workload above                                            | measured by a test-only `FileChangeSource` wrapper around channel acknowledgement requests and epoch timestamps embedded in each producer command path |
| Physical heap memory and tab stability near limits | unavailable                                                           | browser tests do not expose a reliable platform memory measurement                                                                                     |

Content disabled remains the metadata-only path and the owner tests assert that it does not call capture. Requested content is admitted and reserved before copy; unavailable content is omitted without changing the successful filesystem mutation.

The six-mode command probe runs modes sequentially, with 100 fixed 4 KiB writes followed by `chmod` and explicit `utimes`. For each active subscription it performs the first write, waits until its callback is held, then measures writes 2–100 and both metadata mutations. The hold is released afterward. Command timings exclude the wait and callback drain.

| Buffer mode | Subscription mode | First write, ms | Writes 2–100, ms | chmod, ms | utimes, ms |
| ----------- | ----------------- | --------------: | ---------------: | --------: | ---------: |
| memory      | none              |           0.195 |           12.980 |     0.045 |      0.015 |
| memory      | metadata          |           0.225 |           13.030 |     0.035 |      0.020 |
| memory      | content           |           0.355 |           16.525 |     0.050 |      0.025 |
| disk        | none              |           0.230 |           14.420 |     0.045 |      0.020 |
| disk        | metadata          |           0.230 |           12.090 |     0.040 |      0.020 |
| disk        | content           |           0.550 |           23.365 |     0.120 |      0.120 |

These are single-run diagnostic timings, not regression thresholds or isolated performance estimates. Host activity and scheduling affect them. Metadata delivered 102 records with zero measured capture calls. Content delivered 102 records with 102 measured capture calls, 417,792 captured bytes, and 417,792 included delivery bytes in both modes; disk had 102 capture-scoped native reads. No-plugin has no contribution seam, so its absence of subscription records is structural rather than a measured internal counter.

## Reproduction commands

The measurements above used the historical artifacts. To run the same workloads against the current workspace, build its core and subscriptions package first:

```sh
pnpm --filter @opfs-vfs/plugin-subscriptions... build
pnpm --filter @opfs-vfs/plugin-subscriptions test:acceptance
pnpm --filter @opfs-vfs/plugin-subscriptions test:load
pnpm --filter @opfs-vfs/plugin-subscriptions test:load:two-tab
```

## Remaining acceptance conditions

- **Physical mobile is unverified.** No connected Android or iOS device was available. Desktop emulation is not a substitute for mobile WebKit or Android Chrome.
- The local WebKit storage probe failed before a sync access handle could be opened. The environment therefore has no WebKit subscription-suite result.
- The report does not claim measured owner-ledger, reservation, transport-control, or physical-memory peaks where the current test seams do not expose them.

See the [specification](specs/file-subscriptions.md) and [design](designs/file-subscriptions.md) for the fixed contract, limits, recovery procedure, and complete acceptance map.
