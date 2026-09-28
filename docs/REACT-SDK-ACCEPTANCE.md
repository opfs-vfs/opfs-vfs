# React SDK acceptance evidence

Status: P0 baseline, recorded on 2026-09-26. This index holds evidence only. It does not claim any P1–P7 result. Each work package appends its own section below and leaves earlier sections unchanged.

## Worker-client benchmark driver

`packages/opfs-vfs/scripts/benchmark-worker-client.mjs` is the one driver for the P1 no-observer performance gate. Run it on the baseline, on each P1 branch and on their combination with the same machine, browser build and default configuration, then compare the summaries.

```sh
pnpm install --frozen-lockfile
pnpm --filter @opfs-vfs/opfs-vfs exec playwright install chromium firefox webkit
# Gate run (defaults): writes docs/benchmarks/react-sdk/<run-id>/{samples,summary}.json
pnpm --filter @opfs-vfs/opfs-vfs benchmark:worker-client --label p1a
# Other engine, custom output directory (relative paths resolve from the repository root)
pnpm --filter @opfs-vfs/opfs-vfs benchmark:worker-client --browser firefox --out /tmp/p1a-firefox
# Quick diagnostic subset (never gate-eligible)
pnpm --filter @opfs-vfs/opfs-vfs benchmark:worker-client --runs 1 --ops 100 --transports follower --workloads read,write
# Compare a candidate with the baseline; exits 0 = all pass, 1 = regression, 2 = missing or inconclusive
node packages/opfs-vfs/scripts/benchmark-worker-client.mjs compare \
  docs/benchmarks/react-sdk/20260926T102457Z-497680095177-chromium-baseline <candidate-dir>
# Driver unit tests (also run by CI)
node --test packages/opfs-vfs/scripts/*.test.mjs
```

The driver needs no build: Vite serves the workspace source with `COOP: same-origin` and `COEP: require-corp`. `--help` lists every option. Browser tests on the shared agent machine must hold the browser lock described in the orchestration protocol.

| Option                                   | Default                                           | Meaning                                                                |
| ---------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------- |
| `--browser`                              | `chromium`                                        | Playwright engine: `chromium`, `firefox` or `webkit`                   |
| `--runs`                                 | `5`                                               | Independent runs; each uses a fresh browser context, pages and volumes |
| `--ops` / `--warmup`                     | `1000` / `100`                                    | Measured and excluded operations per fast case per run                 |
| `--large-ops` / `--large-warmup`         | `256` / `5`                                       | Measured and excluded operations per 1 MiB case per run                |
| `--cold` / `--cold-warmup` / `--no-cold` | `20` / `2` / off                                  | Open→ready→close cycles per transport and mode per run                 |
| `--modes`                                | `disk,memory`                                     | `bufferMode` of every client                                           |
| `--transports`                           | `leader,follower,sab`                             | See workloads below                                                    |
| `--workloads`                            | `read,write,metadata,sync,large-read,large-write` | See workloads below                                                    |
| `--tail-ratio`                           | `1.5`                                             | A case is `inconclusive` when max(run p95) / min(run p95) exceeds this |
| `--label`, `--out`, `--headed`           | `baseline`, generated, off                        | Run label, output directory, visible browser                           |

**Transports.** `leader`: an `OpfsVfsWorker` with the bundled worker, no plugins and no observers, in page A; it owns the volume. `follower`: a second `OpfsVfsWorker` for the same volume in page B of the same browser context; the fixture asserts it is not the leader, so every call is relayed to page A. `sab`: an `OpfsVfsWorker` hosted in a dedicated worker, called through the synchronous `*Sync` SAB API. Each run creates fresh volumes named `react-sdk-bench-<uuid>-…` and deletes them afterwards.

**Dataset.** Setup reuses the `perf-coalescing` recipe. It writes 64 single-block files, flushes, unlinks every even file and flushes again. It then writes the 1 MiB `/bench/data.bin` one 4 KiB block per write, with a flush after each block so disk and memory mode both fill the scattered holes. It creates the 1 MiB `/bench/write.bin` and verifies the whole dataset before measuring.

**Workloads.** Every timed sample is one awaited (or synchronous) client call, timed with `performance.now()` in the page or worker that issues it; Node and Playwright time is excluded. Calls are sequential (concurrency 1).

| Workload      | Timed call                                    | Untimed correctness check                                       |
| ------------- | --------------------------------------------- | --------------------------------------------------------------- |
| `read`        | 4 KiB `read` at block `(i·97) mod 256`        | bytes equal the deterministic dataset pattern                   |
| `write`       | 4 KiB `write` at block `(i·97) mod 256`       | returned count; every written block read back after the loop    |
| `metadata`    | `stat('/bench/data.bin')`                     | size is 1 MiB                                                   |
| `sync`        | `fsync` after an untimed 4 KiB dirty write    | dirty-write count; every written block read back after the loop |
| `large-read`  | 1 MiB `read` at offset 0                      | bytes equal the dataset                                         |
| `large-write` | 1 MiB `write` at offset 0, two payloads       | returned count; final content read back after the loop          |
| cold ready    | `new OpfsVfsWorker(…)` until `ready` resolves | leader or follower role asserted                                |
| cold close    | `closeVfs()`                                  | none                                                            |

A mismatch fails the driver after it writes the partial output with `complete: false`. Payload views never own their whole `ArrayBuffer`, so the client copies them instead of detaching them.

**Statistics.** The first `warmup` operations of each case in each run are excluded and kept in `warmupMs`. The median is nearest-rank p50 and p95 is nearest-rank: the value at index `ceil(p/100 · n) − 1` of the sorted samples. Per run, the driver reports `n`, median, p95, min, max, mean and throughput. Throughput is measured operations divided by the wall time of the measured loop, which includes the untimed per-operation checks. Across runs, it reports the median of run medians, the median of run p95s, min/max run p95, the p95 ratio, the coefficient of variation of run medians, and the median run throughput. Cold ready and close times are summarized separately with their cycle counts.

**Gate eligibility.** `gateEligible` is true only for a complete run of the full default mode/transport/workload matrix with cold samples, at least 5 runs, at least 1,000 measured fast operations and at least 1 warmup operation per case.

**Comparison rule.** It follows the proposed budgets in the design: 5% median latency, 5% throughput, 10% p95. Cold ready and close latency must also increase by more than 0.05 ms to exceed the budget. A metric is `regressed` only when it exceeds its budget and every candidate run is worse than every baseline run. It is `inconclusive` when it exceeds the budget but the run ranges overlap. An unstable tail on either side makes the p95 metric inconclusive. Different harness digests, configuration (except label and output), machine (`meta.os`), browser version, or a non-eligible side make every case inconclusive. Inconclusive is not a pass: rerun under controlled conditions. The 256-operation large-workload window spans multiple observed GC periods; earlier 50-operation runs require a new baseline before comparison.

**Outputs.** `samples.json` (compact) holds every raw measured and warmup duration, rounded to 0.1 µs, with per-case counts and mismatches. `summary.json` holds the statistics. Both carry `meta`: source commit, dirty flag and branch, SHA-256 of the driver and its three fixtures, Node, OS/CPU/memory, browser name and version, Playwright version, and the page's `crossOriginIsolated`/SAB state. The run id is `<UTC start>-<12-char commit>[-dirty]-<browser>-<label>`.

Fixtures: `packages/opfs-vfs/src/__tests__/benchmark-worker-client-workloads.ts` (dataset, workloads, measurement loops), `benchmark-worker-client-page.ts` (page API, `window.workerClientBenchmark`) and `benchmark-worker-client-sab-worker.ts` (SAB host). Observer and subscription load measurements for P1d/P3 stay in `plugin-subscriptions` (`test:load`, `test:load:two-tab`) and are not part of this no-observer baseline.

## P0 baseline, 2026-09-26

### Sources, artifacts and environment

| Item                       | Value                                                                                                                                        | Evidence kind            |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Core and subscriptions     | `5bddbcce97b6442f073c5fcbced0b5a201af1f4e` (`main`); the P0 branch adds only docs, the driver and fixtures                                   | merge base               |
| Measured commit            | `497680095177bc2603eabc8d47d76bece44a8f43` (`react-sdk/p0-baselines`), clean tree                                                            | recorded by the driver   |
| Package versions           | `@opfs-vfs/opfs-vfs` 1.0.1, `@opfs-vfs/plugin-subscriptions` 1.0.0, workspace source via Vite 8.2.2; no tarball                              | workspace manifest       |
| Premium                    | not used in P0 (`dd24f15` is the design's historical reference only)                                                                         | not measured             |
| Harness SHA-256            | driver `95780ca5…f697`, page `36a3c081…6bc8`, SAB worker `32adb338…64ce`, workloads `6fe17b92…ed7a` (full digests in each `summary.json`)    | recorded by the driver   |
| Host                       | macOS 26.6.2 (25G83, Darwin 25.6.0), Apple M5 Pro, arm64, 18 cores, 64 GiB, on AC power; other agents' builds and browser tests may have run | measured metadata        |
| Runtime                    | Node 26.8.1, pnpm 12.4.2, Playwright 1.59.1, headless                                                                                        | measured metadata        |
| Browsers                   | Chromium 147.0.7727.15 (headless shell), Firefox 148.0.2, WebKit 26.4 (Playwright builds)                                                    | reported by Playwright   |
| Isolation                  | `crossOriginIsolated: true` and `SharedArrayBuffer` present in all three engines                                                             | measured in page         |
| Timer resolution           | smallest nonzero step between samples: 5 µs in Chromium, 20 µs in Firefox                                                                    | derived from raw samples |
| Storage modes and datasets | `disk` and `memory`; the fragmented 1 MiB dataset above; default durability                                                                  | driver configuration     |

### Raw samples

| Run                                                                                                                        | Engine   | Complete | Gate-eligible | SHA-256 of `samples.json`                                          |
| -------------------------------------------------------------------------------------------------------------------------- | -------- | -------- | ------------- | ------------------------------------------------------------------ |
| [`20260926T102457Z-497680095177-chromium-baseline`](benchmarks/react-sdk/20260926T102457Z-497680095177-chromium-baseline/) | Chromium | yes      | yes           | `e12852e366a46f906edd0992120464bf785e92434bc18bca3a0b330fc6de7760` |
| [`20260926T102545Z-497680095177-chromium-repeat`](benchmarks/react-sdk/20260926T102545Z-497680095177-chromium-repeat/)     | Chromium | yes      | yes           | `6006b951bc9021522a4a8230ebefe01016e7523c1cdb9744910cf91db38ed7ff` |
| [`20260926T102634Z-497680095177-firefox-baseline`](benchmarks/react-sdk/20260926T102634Z-497680095177-firefox-baseline/)   | Firefox  | yes      | yes           | `7931701013301cd51837a42dcac35fc4f37fe049126f97b184359e927d46bf47` |
| [`20260926T102721Z-497680095177-webkit-baseline`](benchmarks/react-sdk/20260926T102721Z-497680095177-webkit-baseline/)     | WebKit   | no       | no            | `97682d5c5c299965d2aa42dd7f462e16105083b3e39d4bfb3e379bcc4221f2cc` |

Each complete run holds 123,000 measured operations (36 cases × 5 runs; 1,000 per fast case, 50 per large case) plus 600 cold cycles. The Chromium baseline run is the reference for P1 comparisons in Chromium; the Firefox run is the reference in Firefox.

### Engine coverage

| Engine   | Driver result                                                                                    | Coverage claimed                     |
| -------- | ------------------------------------------------------------------------------------------------ | ------------------------------------ |
| Chromium | complete, all correctness checks passed                                                          | local driver run and existing suites |
| Firefox  | complete, all correctness checks passed                                                          | local driver run only                |
| WebKit   | failed at leader readiness: `UnknownError: The operation failed for an unknown transient reason` | none                                 |

A separate probe on the same host showed that `navigator.storage.getDirectory()` itself raises this `UnknownError` in Playwright WebKit 26.4 on a cross-origin-isolated `http://127.0.0.1` page. This matches the 2026-09-25 observation in the [subscription evidence](SUBSCRIPTIONS-ACCEPTANCE.md). It is a local environment failure before any OPFS handle is opened, not a statement about WebKit browsers generally. The existing core and subscription suites were run in Chromium only.

`.github/workflows/sdk-acceptance.yml` is the reproducible three-engine job. It is manual (`workflow_dispatch`), runs the driver per engine on the CI runner with `fail-fast: false`, and uploads the output for 90 days. It has not run yet: this branch is not pushed. CI-runner timings are not comparable with this host's baseline. P2+ add the React package's acceptance tests to that job.

### Chromium baseline

Median and p95 are the median across the five runs of each run's nearest-rank value. Values at or below 0.02 ms are within a few timer ticks.

| Transport | Mode   | Workload    | Ops/run | Median ms | p95 ms | Run p95 range ms | Throughput ops/s | CV of run medians | Tail         |
| --------- | ------ | ----------- | ------: | --------: | -----: | ---------------: | ---------------: | ----------------: | ------------ |
| leader    | disk   | read        |    1000 |     0.080 |  0.090 |      0.090–0.095 |           11,592 |             0.000 | stable       |
| leader    | disk   | write       |    1000 |     0.115 |  0.125 |      0.125–0.130 |            8,719 |             0.000 | stable       |
| leader    | disk   | metadata    |    1000 |     0.010 |  0.020 |      0.015–0.020 |           86,957 |             0.000 | stable       |
| leader    | disk   | sync        |    1000 |     0.170 |  0.190 |      0.190–0.190 |            3,417 |             0.000 | stable       |
| leader    | disk   | large-read  |      50 |     2.345 |  2.420 |      2.385–2.435 |              358 |             0.004 | stable       |
| leader    | disk   | large-write |      50 |     0.615 |  0.665 |      0.640–0.700 |            1,602 |             0.009 | stable       |
| follower  | disk   | read        |    1000 |     0.150 |  0.165 |      0.165–0.170 |            6,498 |             0.000 | stable       |
| follower  | disk   | write       |    1000 |     0.185 |  0.210 |      0.205–0.215 |            5,280 |             0.013 | stable       |
| follower  | disk   | metadata    |    1000 |     0.080 |  0.090 |      0.090–0.090 |           12,327 |             0.025 | stable       |
| follower  | disk   | sync        |    1000 |     0.235 |  0.255 |      0.255–0.260 |            2,341 |             0.000 | stable       |
| follower  | disk   | large-read  |      50 |     3.130 |  3.365 |      3.325–3.490 |              276 |             0.005 | stable       |
| follower  | disk   | large-write |      50 |     1.395 |  1.575 |      1.430–1.825 |              703 |             0.035 | stable       |
| sab       | disk   | read        |    1000 |     0.080 |  0.090 |      0.090–0.095 |           11,535 |             0.000 | stable       |
| sab       | disk   | write       |    1000 |     0.115 |  0.130 |      0.130–0.135 |            8,427 |             0.017 | stable       |
| sab       | disk   | metadata    |    1000 |     0.015 |  0.020 |      0.020–0.020 |           66,423 |             0.000 | stable       |
| sab       | disk   | sync        |    1000 |     0.170 |  0.190 |      0.190–0.195 |            3,453 |             0.000 | stable       |
| sab       | disk   | large-read  |      50 |     2.875 |  2.990 |      2.970–3.425 |              298 |             0.003 | stable       |
| sab       | disk   | large-write |      50 |     1.065 |  1.110 |      1.110–1.135 |              909 |             0.005 | stable       |
| leader    | memory | read        |    1000 |     0.010 |  0.020 |      0.015–0.020 |           66,028 |             0.000 | stable       |
| leader    | memory | write       |    1000 |     0.135 |  0.145 |      0.145–0.155 |            7,460 |             0.015 | stable       |
| leader    | memory | metadata    |    1000 |     0.010 |  0.020 |      0.020–0.020 |           88,339 |             0.000 | stable       |
| leader    | memory | sync        |    1000 |     0.365 |  0.385 |      0.385–0.390 |            2,014 |             0.005 | stable       |
| leader    | memory | large-read  |      50 |     0.090 |  0.230 |      0.100–0.290 |            1,693 |             0.022 | inconclusive |
| leader    | memory | large-write |      50 |     3.715 |  5.435 |      5.280–5.460 |              257 |             0.003 | stable       |
| follower  | memory | read        |    1000 |     0.080 |  0.090 |      0.090–0.095 |           12,114 |             0.025 | stable       |
| follower  | memory | write       |    1000 |     0.200 |  0.225 |      0.220–0.230 |            4,858 |             0.012 | stable       |
| follower  | memory | metadata    |    1000 |     0.075 |  0.090 |      0.090–0.090 |           12,457 |             0.026 | stable       |
| follower  | memory | sync        |    1000 |     0.425 |  0.455 |      0.450–0.460 |            1,576 |             0.006 | stable       |
| follower  | memory | large-read  |      50 |     0.840 |  1.080 |      1.070–1.190 |              754 |             0.008 | stable       |
| follower  | memory | large-write |      50 |     4.440 |  4.925 |      4.875–4.970 |              222 |             0.003 | stable       |
| sab       | memory | read        |    1000 |     0.010 |  0.020 |      0.020–0.020 |           59,312 |             0.000 | stable       |
| sab       | memory | write       |    1000 |     0.130 |  0.145 |      0.145–0.150 |            7,438 |             0.015 | stable       |
| sab       | memory | metadata    |    1000 |     0.010 |  0.020 |      0.020–0.020 |           77,071 |             0.204 | stable       |
| sab       | memory | sync        |    1000 |     0.365 |  0.385 |      0.380–0.390 |            2,012 |             0.005 | stable       |
| sab       | memory | large-read  |      50 |     0.620 |  0.645 |      0.640–0.670 |              921 |             0.005 | stable       |
| sab       | memory | large-write |      50 |     4.180 |  5.275 |      5.250–5.665 |              232 |             0.002 | stable       |

| Transport | Mode   | Cycles/run | Ready median ms | Ready p95 ms | Close median ms | Close p95 ms | Tail   |
| --------- | ------ | ---------: | --------------: | -----------: | --------------: | -----------: | ------ |
| leader    | disk   |         20 |          12.255 |       12.635 |           1.550 |        1.615 | stable |
| follower  | disk   |         20 |           0.305 |        0.360 |           0.150 |        0.180 | stable |
| sab       | disk   |         20 |          12.185 |       12.720 |           1.560 |        1.610 | stable |
| leader    | memory |         20 |          17.190 |       17.735 |           1.685 |        1.760 | stable |
| follower  | memory |         20 |           0.290 |        0.310 |           0.145 |        0.165 | stable |
| sab       | memory |         20 |          17.090 |       17.370 |           1.685 |        1.725 | stable |

Follower cold readiness runs while page A's leader stays open, so it covers attaching to a live owner, not owner startup. The follower close is a flush plus local disposal.

**Repeatability.** A second full Chromium run on the same commit and host ([compare output](benchmarks/react-sdk/20260926T102545Z-497680095177-chromium-repeat/compare-to-baseline.md)) compared against the baseline: 45 cases pass, 3 inconclusive, 0 regressed (exit code 2). The inconclusive cases are `leader/memory/large-read` and `sab/memory/large-write`, whose p95 tails vary, and `sab/memory/metadata`, whose median moved from 0.010 to 0.015 ms, one timer tick.

### Firefox baseline

All 36 warm cases and 12 cold phases completed and passed their correctness checks. Firefox samples are quantized to 20 µs, so most fast-case tails sit on one or two ticks. Nine warm cases and five cold phases exceed the 1.5 p95 ratio and are inconclusive in this run: `leader/disk/large-read`, `sab/disk/write`, `sab/disk/metadata`, `leader/memory/large-read`, `follower/memory/write`, `follower/memory/sync`, `sab/memory/read`, `sab/memory/metadata`, `sab/memory/sync`; cold `leader/disk/close`, `sab/disk/ready`, `sab/disk/close`, `follower/memory/ready`, `sab/memory/ready`. Use the Firefox gate only for cases that are stable on both sides. The full table is in [`summary.json`](benchmarks/react-sdk/20260926T102634Z-497680095177-firefox-baseline/summary.json).

| Transport | Mode   | Median ms (read / write / metadata / sync) | Large read / write median ms | Cold ready / close median ms |
| --------- | ------ | ------------------------------------------ | ---------------------------- | ---------------------------- |
| leader    | disk   | 0.04 / 0.06 / 0.02 / 0.12                  | 0.44 / 0.16                  | 19.98 / 2.84                 |
| follower  | disk   | 0.12 / 0.14 / 0.10 / 0.18                  | 0.96 / 0.64                  | 0.26 / 0.16                  |
| sab       | disk   | 0.02 / 0.06 / 0.02 / 0.10                  | 0.52 / 0.18                  | 20.16 / 2.84                 |
| leader    | memory | 0.02 / 0.10 / 0.02 / 0.22                  | 0.10 / 7.12                  | 21.12 / 2.90                 |
| follower  | memory | 0.10 / 0.18 / 0.10 / 0.28                  | 0.58 / 7.60                  | 0.26 / 0.16                  |
| sab       | memory | 0.02 / 0.08 / 0.02 / 0.20                  | 0.18 / 7.14                  | 21.14 / 2.84                 |

### Existing checks

Commands were run in the P0 worktree on the host above between 2026-09-26 11:30 and 12:30 local time.

| Command                                                               | Result                                                      |
| --------------------------------------------------------------------- | ----------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                      | pass                                                        |
| `pnpm build`                                                          | pass                                                        |
| `pnpm typecheck`                                                      | pass                                                        |
| `pnpm lint`                                                           | pass after `pnpm build` (see below)                         |
| `pnpm fmt:check`                                                      | pass                                                        |
| `pnpm deadcode`                                                       | pass, no issues                                             |
| `node --test scripts/*.test.mjs packages/opfs-vfs/scripts/*.test.mjs` | pass, 7 tests                                               |
| `pnpm --filter @opfs-vfs/opfs-vfs test` (Chromium)                    | pass, 45 files, 699 tests                                   |
| `pnpm --filter @opfs-vfs/plugin-subscriptions test` (Chromium)        | pass, 4 files and 66 tests; 2 opt-in files, 3 tests skipped |
| `pnpm --filter @opfs-vfs/plugin-subscriptions test:packed`            | pass, 2 files, 2 tests                                      |
| benchmark driver, full default configuration                          | Chromium and Firefox pass; WebKit fails as recorded above   |

Pre-existing issues and their disposition:

- **Lint before build.** On a fresh checkout `pnpm lint` reports `no-redundant-type-constituents` in `packages/plugin-subscriptions/examples/current-view.ts`, because type-aware lint resolves `@opfs-vfs/opfs-vfs` through its unbuilt `dist` types. It passes after `pnpm build`, which CI runs first. Disposition: ordering requirement, no change.
- **WebKit OPFS unavailable locally.** Disposition: recorded above. The manual `SDK acceptance` workflow supplies the reproducible CI run. No WebKit coverage is claimed until that run or another WebKit environment succeeds.
- **Not run in P0.** Website Playwright tests (P0 does not touch the website; P6 owns them), the opt-in subscription load and acceptance workloads (observer measurements for P1d/P3), and the core suites in Firefox/WebKit. The existing Vitest configurations still run Chromium only.

### Harness mutation checks

Each check temporarily broke the harness, confirmed the failure, and restored the file.

| Mutation                                                              | Observed result                                                                    |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `write` records the wrong expected payload per slot                   | driver exit 1: `leader/disk/write had 55 mismatches`                               |
| follower fixture asserts the leader role instead of the follower role | driver exit 1: `Expected benchmark client to be leader`                            |
| SAB worker module throws on load                                      | with the fix: exit 1 and output written; before the fix: hung until a 90 s timeout |
| `compareSummaries` lets a regression win over an incompatible harness | node test fails; passes when restored                                              |

### Limitations

- The baseline is one host, one headless browser build per engine, and one session. Background load from other agents may have affected some runs; the repeat run and the tail check expose that variability but do not remove it.
- Timer resolution (5 µs Chromium, 20 µs Firefox) limits fast cases near 10–40 µs. Ratios there move in whole ticks and are often inconclusive.
- Concurrency is 1. Throughput is sequential-call throughput, not parallel capacity.
- Disk-mode physical fragmentation follows the recipe that `perf-coalescing.test.ts` asserts for direct `OpfsVfs`. The driver cannot inspect block lists through the worker client, so it does not re-assert fragmentation.
- Heap memory and transport-control peaks are not measured.

## Work package evidence

Append one section per work package (`## P1a …`, `## P1b …`, …) with the commands, the environment, the driver run ids and compare output against the baseline above, mutation checks, and limitations. Do not edit the P0 section.

## P1a. Local core contracts and dispatch errors

Recorded on 2026-09-26 on branch `react-sdk/p1a-core-contracts`, based on `ba6e48d` (later rebased onto P0 by the orchestrator; source changes unchanged).

### Environment and artifacts

| Item                         | Value                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Host                         | macOS 26.6.2 (25G83), Apple M5 Pro, arm64                                                                          |
| Node / pnpm / Playwright     | Node 26.8.1, pnpm 12.4.2, Playwright 1.59.1, Chromium only (repository Vitest browser configuration)               |
| Legacy core tarball          | built from `ba6e48d`, SHA-256 `3244b33ac464afe1420fc0350cb38e5844d562ff6fc036d655e99018bf3bbf62`                   |
| Legacy subscriptions tarball | built from `ba6e48d`, SHA-256 `4e58924734468f44fcb2795b1772b2ae22dbf83d3097e1e12db7a468296453d7`                   |
| Candidate core tarball       | built from the P1a code head `49c3c26`, SHA-256 `f010e829ce42d05d7b55690f37b3d134d2d594168b1cc8a854f2bf28fae3e111` |
| Candidate subscriptions      | unchanged by P1a, SHA-256 `4e58924734468f44fcb2795b1772b2ae22dbf83d3097e1e12db7a468296453d7`                       |
| Premium source               | `opfs-vfs-premium` `dd24f15`, in a scratch clone; nothing committed there                                          |

The legacy core tarball is byte-identical to the artifact pinned by premium `core-artifact.json` (commit `4de9faa`, same SHA-256), so the premium baseline run used an unmodified pin. Tarball digests change with every candidate commit; re-record them for the stacked head.

### Commands and results

| Command                                                                                | Result                                                                                               |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                                       | pass                                                                                                 |
| `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`, `pnpm deadcode`         | pass                                                                                                 |
| `node --test scripts/*.test.mjs`                                                       | pass                                                                                                 |
| `pnpm --filter @opfs-vfs/opfs-vfs test` (base `ba6e48d`)                               | pass, 45 files, 699 tests                                                                            |
| `pnpm --filter @opfs-vfs/opfs-vfs test` (candidate)                                    | pass, 51 files, 756 tests                                                                            |
| `pnpm --filter @opfs-vfs/plugin-subscriptions test`                                    | pass, 66 tests, 3 opt-in skipped                                                                     |
| `pnpm --filter @opfs-vfs/plugin-subscriptions test:packed`                             | pass, 2 tests                                                                                        |
| `pnpm --filter @opfs-vfs/opfs-vfs test:mixed-build` (new, opt-in)                      | pass, 7 tests                                                                                        |
| `pnpm --filter @opfs-vfs/opfs-vfs exec vitest run src/__tests__/worker-status.test.ts` | pass, 12 tests; invalid `sabSize` opens no channel and a valid client closes its channel on disposal |
| Premium `pnpm test` with the legacy core (baseline)                                    | pass, 19 files, 331 tests, 1 skipped                                                                 |
| Premium `pnpm typecheck` and `pnpm test` with the candidate core                       | pass, 20 files, 335 tests, 1 skipped (19 existing files plus a temporary P1a file)                   |
| Premium `pnpm test:packed` with the candidate core and subscriptions                   | pass, 13 + 2 tests                                                                                   |

Every browser command ran while holding the shared browser lock. Each commit typechecks on its own.

### Mixed-build matrix

`test:mixed-build` builds and packs the legacy core and subscriptions from a temporary worktree of `OPFS_VFS_LEGACY_REF` (default `ba6e48d`), packs the candidate, installs each pair into its own `.packed/<side>/node_modules`, typechecks the per-side fixtures and runs `tests/mixed-build.test.ts`. Page clients and worker bundles resolve only their own side's artifacts.

| Case                                                            | Result                                                                                                                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Legacy owner, candidate follower (bundled and subscriptions)    | candidate `ready` rejects `VFS_PROTOCOL_MISMATCH` in under 5 s with a 15 s init timeout; status `failed` with that code; the legacy owner keeps working |
| Candidate owner, legacy follower (bundled and subscriptions)    | legacy `ready` rejects `VFS_PLUGIN_MISMATCH`; the candidate owner stays `ready`/`leader` and keeps working                                              |
| Candidate page, legacy worker bundle                            | `VFS_PROTOCOL_MISMATCH`, client disposed, status `failed`                                                                                               |
| Legacy page, candidate worker bundle                            | `VFS_PLUGIN_MISMATCH`, client disposed                                                                                                                  |
| Sequential ownership across builds                              | each build reads the data the previous owner wrote; a candidate started against a live legacy owner is refused                                          |
| Legacy page joining a candidate owner with a candidate follower | the legacy page is refused; the candidate follower still writes through the owner                                                                       |

### Mutation checks

Each guard was removed or bypassed, the listed tests were run, and the source was restored. Every mutant failed at least one test. `M3` and `M8` survived at first. Their tests were then strengthened: the leader test now parks at `await this.workerReady` before the generation changes, and a status test holds renegotiation after a reply from another generation. After that, both mutants failed.

| Mutant                                                       | Failing tests                                                                                 |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| M1 first generation check not role-aware                     | 6 in `worker-generation.test.ts` (follower routing, replies, evidence)                        |
| M2 first generation check removed                            | 4 (stale methods, paused follower with another successor, no replay, per-invocation evidence) |
| M3 leader check after `await this.workerReady` removed       | leader paused at the dispatch await                                                           |
| M4 first check removed and captured generation not threaded  | 4, including the paused-follower successor case                                               |
| M5 `sent` set before `postMessage`                           | dispatch record test, synchronous `DataCloneError` refusal                                    |
| M6 `replied` never classified                                | 2 remote-failure evidence tests                                                               |
| M7 response-generation check removed                         | response from another generation                                                              |
| M8 status not refreshed in `invalidateRouting`               | recovering while a follower renegotiates                                                      |
| M9 failures published as `closed`                            | 5 status, initialization and sanitization tests                                               |
| M10 envelope parser accepts extra keys                       | 3 (unit parser, malformed replies, forged `CHANGE_ERROR`)                                     |
| M11 serializer copies `stack`                                | 7 envelope, relay, SAB and sanitization tests                                                 |
| M12 version-1 profile accepted                               | 3 profile tests                                                                               |
| M13 status listener exception not isolated                   | listener isolation                                                                            |
| M14 `getSupport()` constructs a `BroadcastChannel`           | allocation-free support check                                                                 |
| M15 SAB code-only fallback dropped                           | tiny-SAB `ENOENT` test                                                                        |
| M16 protocol check after the `create-new` `EEXIST` check     | create-new against a legacy owner                                                             |
| M17 unsubscribed listener still called during a flush        | mid-flush unsubscribe                                                                         |
| M18 validated SAB error without a code wrapped               | SAB corruption error keeps name, category and offset                                          |
| M19, M22 leader or relayed shutdown failure not recorded     | failed shutdown keeps its close error in status                                               |
| M20 facade calls the instance method, not the base prototype | a bound-method override cannot bypass the dispatch context                                    |
| M21 `replied` inferred from the client-wide error set        | a shared disposal error stays `sent`                                                          |
| M23 no early `ready` rejection before `init()`               | incompatible announcement during the storage preflight                                        |
| M24 open `BroadcastChannel` before allocating the messenger  | invalid `sabSize` opens a channel before throwing                                             |
| Mixed build: candidate accepts a version-1 profile           | 4 legacy-owner and legacy-worker cases in `test:mixed-build`                                  |
| Mixed build: candidate owner advertises the legacy profile   | 5 legacy-follower and legacy-page cases in `test:mixed-build`                                 |

The captured generation threaded into follower sends cannot be mutated on its own: the role-aware check and the send read the same value synchronously. M4 shows its effect once the first check is also removed.

### Premium regressions

The scratch clone followed `scripts/prepare-core.mjs`, with `core-artifact.json` and the workspace override re-pinned to the candidate tarball. A temporary test file, not committed anywhere, added four cases to the existing suite:

- Wrong secret on reopen: `ready` rejects with `code: 'EVOLUMELOCKED'` and `name: 'VolumeLockedError'` over the INIT envelope. Status is `failed` with the same fields, the INIT reply carries only envelope keys, and neither secret appears in the error, the status or any worker message.
- Wrong-secret follower takeover: status becomes `failed` with `EVOLUMELOCKED`, with no secret in status or broadcasts.
- Forged `encryptionRequest` options (`mode: 'plain'`, an unknown KDF, an empty secret): the message stays `Invalid worker plugin options: encryption` with a string code, status carries only envelope keys, and no secret text appears anywhere.
- Encrypted leader and follower `forGeneration` handles write, report `replied` with `ENOENT`, `errno` 2 and `VfsError`, and a stale handle is `refused`.

### No-observer performance against the P0 baseline

The orchestrator ran the P0 driver, unchanged (harness SHA-256 identical to the baseline), at `29a643fd2814` on the same machine and browser as the P0 Chromium baseline (Chromium 147.0.7727.15, Apple M5 Pro). The run used the default gate configuration and was compared against `docs/benchmarks/react-sdk/20260926T102457Z-497680095177-chromium-baseline`.

Result: **45 pass, 3 inconclusive, 0 regressed** (`compare` exit 2 because some cases are inconclusive). The inconclusive cases are timer-resolution effects: the medians move by one 5 µs Chromium tick (for example 10 → 15 µs), or the baseline p95 was noisy, with throughput within budget. P0's own baseline repeat run showed the same pattern (45 pass, 3 inconclusive).

| Inconclusive case        |         median ratio |            p95 ratio | throughput ratio |
| ------------------------ | -------------------: | -------------------: | ---------------: |
| leader/disk/metadata     |         1.000 (pass) | 0.750 (inconclusive) |     1.002 (pass) |
| leader/memory/large-read |         0.889 (pass) | 0.435 (inconclusive) |     1.065 (pass) |
| sab/memory/metadata      | 1.500 (inconclusive) |         1.000 (pass) |     0.979 (pass) |

Raw samples are gzip-compressed (`samples.json.gz`, decompress before inspection). `summary.json` and `compare-to-baseline.md` are in `docs/benchmarks/react-sdk/20260926T135034Z-29a643fd2814-chromium-p1a/`. Firefox was not rerun for this layer.

### Limitations and dispositions

- Performance was not measured here. The orchestrator runs the P0 driver comparison after restacking P1a onto P0. Hot paths to watch: async dispatch in `sendToWorker`, `requestWorker` and `sendToLeader` (one extra optional argument and a dispatch-record write after `postMessage`); `forGeneration` calls (one `Object.create` context and one record per call, while ordinary methods allocate neither); error serialization and parsing (`toRemoteErrorDetails`, `parseRemoteError`) on every error reply, relay and SAB error header; status refreshes on election and routing transitions only. Success replies are unchanged.
- Only Chromium was run. Firefox and WebKit were not run for P1a.
- Passive observer attachments keep protocol 1 and are outside the build negotiation. The SDK does not use them.
- Idle followers learn about owner loss only at takeover or renegotiation. `OBSERVER_GONE` is broadcast only by bundled-worker owners and is not used for status.
- Errors thrown by `validateConfiguredPlugins` while it reads a configured plugin object are forwarded as before. This is pre-existing and outside P1a.
- No pre-existing failures were observed in the affected suites.

## P1b. Close admission and initialization cancellation

Branch `react-sdk/p1b-close-admission`, based on `ba6e48d` (the orchestrator later squashed it and rebased it onto P1a). Environment: macOS (Darwin 25.6), Node 26.8.1, pnpm 12.4.2, headless Chromium through `@vitest/browser-playwright`, real OPFS with cross-origin isolation.

### Contract as implemented

- `closeVfs()` calls `beginClosing()` synchronously before its first await. `checkAvailable()` refuses public work with `VFS_SHUTTING_DOWN` while closing. The type-based `CLOSE_VFS` exemption is gone. The private close paths call `requestWorker('CLOSE_VFS')` and `sendToLeader(..., owner)` directly.
- Checked barriers: `sendToWorker` before and after each await, including the wait on a takeover `workerReady`; `sendToLeader`; `syncCall`; `openFileChangeChannel`; and file-change `request()` after its options are snapshotted. A closing owner also refuses relayed `CHANGE_OPEN` and `CHANGE_COMMAND`. Once close starts, local channel `close()` does not send a remote close.
- Public `ready` is `Promise.race([initialization, closedSignal])`. Close and disposal reject it at once. While closing, an initialization failure does not dispose resources, because the close path owns cleanup.
- A leader close awaits the worker's own `workerReady`, never the public `ready`. If INIT was never sent, close terminates the worker. If INIT succeeds late, close sends `CLOSE_VFS`, reports any failure, and always terminates the worker. If INIT fails, nothing is mounted, so close resolves. Close waits for an in-flight INIT response, which is bounded by the INIT request deadline. It never waits for the public readiness timer.
- A follower captures its owner generation synchronously. It flushes only that generation and never re-sends the flush. If the owner lock is granted while the follower is closing, the follower rejects its routed work with `VFS_ATTACHMENT_LOST` and does not take over. A follower that was never ready does not flush. A ready follower whose owner is gone rejects with `VFS_ATTACHMENT_LOST`.
- Close settles only after this client's owner and client lock requests have settled. A pending passive-attachment probe closes its channel and clears its timer when the client is disposed.
- Concurrent `closeVfs()` calls share one promise. After it settles, a later close finds the client disposed and resolves.
- Cancellation does not roll back storage creation or recovery that already ran.

### Tests

`packages/opfs-vfs/src/__tests__/close-admission.test.ts` runs 17 browser tests. Every client under test uses `initTimeout: 60_000`, and every settlement is asserted within about 1 s:

| Pause point                                 | Tests                                                                                                                                                                                                     |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| After election, INIT held                   | leader admission and late mount; late `CLOSE_VFS` failure; late INIT failure                                                                                                                              |
| After election, PING held                   | does not mount; close resolves and the lock is free while PING is still held                                                                                                                              |
| Takeover INIT held                          | a command waiting on `workerReady` rejects once close starts                                                                                                                                              |
| During follower readiness (queued election) | no relayed command; election and client lock requests are cancelled                                                                                                                                       |
| Before close flush dispatch (same tick)     | a command waiting on `ready` is refused; the only COMMAND is FLUSH to the captured generation                                                                                                             |
| Flush held, then owner replaced or gone     | no successor flush and no takeover; `VFS_ATTACHMENT_LOST`; lock free                                                                                                                                      |
| Other                                       | close-flush failure; external disposal before and during close; already-sent write; relayed change open, channel close and channel request during close; option-getter re-entrancy; pending passive probe |

`adapter.test.ts` "closes the leader worker VFS before terminating the worker" now asserts the private `requestWorker('CLOSE_VFS')` path.

### Mutation checks

Each guard was removed in turn and `close-admission.test.ts` was run under the browser lock. The file was restored afterwards.

| Mutation                                                        | Failing tests                                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Admission ignores `closing`                                     | same-tick captured FLUSH                                                       |
| `beginClosing` does not settle readiness                        | leader INIT hold, follower readiness, takeover waiter, passive probe           |
| No `CLOSE_VFS` after late INIT                                  | 7 tests, including late mount, late `CLOSE_VFS` failure and already-sent write |
| Close waits for pre-INIT PING (`initSent` ignored)              | PING hold                                                                      |
| Close resolves before lock release                              | PING hold, owner gone without successor                                        |
| Closing follower takes over on lock grant                       | both successor tests                                                           |
| Lock grant does not reject the pending flush                    | owner gone without successor                                                   |
| Follower re-targets its flush after routing loss                | both successor tests                                                           |
| Closing owner admits relayed change opens (both guards removed) | relayed change open                                                            |
| Channel close posts remotely during close                       | channel close                                                                  |
| No shared in-flight close                                       | leader INIT hold                                                               |
| Channel request not gated                                       | channel request, option getter                                                 |
| Gate checked before snapshot                                    | option getter                                                                  |
| Takeover waiters ignore close                                   | takeover waiter                                                                |
| Passive probe not abortable                                     | passive probe                                                                  |

The relayed `CHANGE_OPEN` refusal has two guards. Removing only the first leaves the tests green, because the post-liveness-check guard still refuses. Removing both fails the test.

### Commands and results at the final HEAD

| Command                                                                        | Result                                                      |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`, `pnpm deadcode` | pass                                                        |
| `node --test scripts/*.test.mjs`                                               | 2 passed                                                    |
| `pnpm --filter @opfs-vfs/opfs-vfs test`                                        | 46 files, 716 passed (base `ba6e48d`: 45 files, 699 passed) |
| `pnpm --filter @opfs-vfs/plugin-subscriptions test`                            | 66 passed, 3 skipped (the existing skips)                   |
| `close-admission.test.ts`, repeated 3 times                                    | 17 of 17 each time                                          |

### Premium encryption regressions

Setup: a temporary copy of the premium repository at `dd24f15`, made with `git archive`. Nothing was committed there. The copy's `core-artifact.json` and `pnpm-workspace.yaml` override were pointed at a `pnpm pack` of this branch's core (commit and SHA-256 of that tarball). `scripts/prepare-core.mjs` then ran with `OPFS_VFS_CORE_TARBALL`, followed by `pnpm install` and `pnpm build`. The installed dist was checked to contain the P1b code.

| Command                                                                                                                                                              | Result                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `pnpm test` (core-artifact node test plus plugin-encryption browser suite, including multitab takeover, plugin lifecycle, owner-crash remount and passkey lifecycle) | 19 files, 331 passed, 1 skipped                  |
| `pnpm test:packed` (with `OPFS_VFS_SUBSCRIPTIONS_TARBALL` from this branch)                                                                                          | 13 passed, plus 2 passed in subscriptions-packed |

### Limitations

- Performance comparison was deferred to the orchestrator, which benchmarks on the P0 harness. The only per-command hot-path changes are the extra `this.closing` test in `checkAvailable()` and the `this.leaderReady ? … : Promise.race(…)` predicate in `sendToWorker()`. On a ready leader that predicate still awaits `workerReady`, as before.
- P1a envelopes and `forGeneration` are not available on this base. Refusals use the existing `VFS_SHUTTING_DOWN` and `VFS_ATTACHMENT_LOST` codes.
- If INIT hangs, close waits for the INIT request deadline, which equals `initTimeout`. Close must see the INIT outcome to give a late mount orderly cleanup.

### No-observer performance against the P0 baseline (P1b)

The orchestrator ran the P0 driver, unchanged (harness SHA-256 identical to the baseline), at `4bf005728a6a` on the same machine and browser as the P0 Chromium baseline (Chromium 147.0.7727.15, Apple M5 Pro). The run used the default gate configuration and was compared against `docs/benchmarks/react-sdk/20260926T102457Z-497680095177-chromium-baseline`.

Result: **46 pass, 2 inconclusive, 0 regressed** (`compare` exit 2 because some cases are inconclusive). The inconclusive cases are timer-resolution effects: the medians move by one 5 µs Chromium tick (for example 10 → 15 µs), or the baseline p95 was noisy, with throughput within budget. P0's own baseline repeat run showed the same pattern (45 pass, 3 inconclusive).

| Inconclusive case        |         median ratio |            p95 ratio | throughput ratio |
| ------------------------ | -------------------: | -------------------: | ---------------: |
| leader/memory/large-read |         0.889 (pass) | 0.413 (inconclusive) |     1.098 (pass) |
| sab/memory/metadata      | 1.500 (inconclusive) |         1.000 (pass) |     0.960 (pass) |

Raw samples are gzip-compressed (`samples.json.gz`, decompress before inspection). `summary.json` and `compare-to-baseline.md` are in `docs/benchmarks/react-sdk/20260926T144556Z-4bf005728a6a-chromium-p1b/`. Firefox was not rerun for this layer.

### P1b integration with P1a (orchestrator, 2026-09-26)

The orchestrator squashed P1b and rebased it onto P1a. It resolved the `worker-client.ts` conflicts as follows:

- The constructor `ready` chain combines P1a's early-disposal race with P1b's `closedSignal`.
- `sendToLeader(type, payload, data?, generation?, dispatch?, closePath = false)` replaces P1b's separate `owner` argument.
- P1a's status refreshes run inside P1b's guarded leader-ready block.

Integration changes (terra implemented, sol/astra reviewed):

- `ClientStatusState` adds `closing`. `beginClosing()` publishes it synchronously, and `refreshStatus()` keeps it during routing or election transitions.
- An explicit close always ends `closed`. Any close failure is kept in `error`: a late INIT failure, a worker crash during `CLOSE_VFS`, or a close/shutdown error after a concurrent `dispose()`. `recordCloseFailure()` never overwrites a more specific disposal error (for example `VFS_PLUGIN_MISMATCH`).
- Public `ready` is marked handled at construction, restoring P1a's behavior. Awaiting callers still receive the error.
- `dispose()` of a pending client rejects `ready` with an `Error` instead of `undefined`.
- Plan and design wording: close during an in-flight INIT settles on that INIT's own response, bounded by its deadline, and never terminates the worker mid-mount.

Reviews:

- sol, 3 rounds: 2 MEDIUM findings fixed (late INIT failure status; unhandled `ready`). One HIGH finding was answered as the accepted INIT contract above. Round 3: no findings.
- astra (high), 3 rounds: close-failure retention after concurrent disposal, fixed in 3 follow-up findings. Final round: no actionable findings.

Mutation checks. Each guard was removed; each row lists the tests that then failed:

| Guard removed                                                                          | Failing tests |
| -------------------------------------------------------------------------------------- | ------------- |
| `closing` publish in `beginClosing()`                                                  | 3             |
| `closing` guard in `refreshStatus()` (checked by the new owner-loss-during-close test) | 1             |
| constructor `void this.ready.catch()`                                                  | 2             |
| `rejectReady(error)` reverted to `rejectReady(disposalError)`                          | 1             |
| `!this.closing` in `disposeLocalResources()` failed selection                          | 2             |
| `recordCloseFailure()` null-error guard                                                | 1             |
| close-failure recording in `closeVfs()` catch                                          | 1             |
| close-failure recording in `shutdownSharedVfs()` leader branch                         | 1             |
| close-failure recording in the follower `shutdownSharedVfs()` branch                   | 1             |

Final checks on this layer: build, typecheck, lint, fmt, deadcode ok. Core 781/781 and subscriptions 66 passed (3 opt-in skipped), Chromium.

## P1c. Owner persistence observation

Branch `react-sdk/p1c-persistence-status`, based on `750b30d` (top of the P1a, P1b and P1d stack). Recorded September 26, 2026 on macOS 26.6.2, Apple M5 Pro, Node.js 26.8.1, pnpm 12.4.2, Playwright Chromium (headless, cross-origin isolated, repository Vitest browser configuration).

### Contract as implemented

`ClientStatus.persistence` is `ClientPersistenceStatus | null`, exported from `@opfs-vfs/opfs-vfs/worker` and `/worker-client`:

```ts
interface ClientPersistenceStatus {
  readonly state: LocalPersistenceState;
  readonly lastError: RemoteErrorDetails | null; // retained last failure of this owner generation
  readonly failureRevision: number; // +1 per recorded failure, 0 = none
  readonly lastSalvage: DataWalSalvageEvent | null;
}
```

It is non-null only for the snapshot's current `ownerGeneration`. It is null while opening, recovering, after routing loss, after page resume until the resync, and when closed or failed. It is the owner's reported state, not a durability receipt for a command.

- **Source.** `OpfsVfs.setLocalPersistenceState` counts each recorded failure once. Re-recording the same error object, as the timer and pagehide catches do after `syncSync`/`flushVfs`, does not count again. The retained failure survives later `clean`/`dirty` transitions. A repeated identical state returns after one comparison, so the per-write `markLocalDirty` path adds no work. Recording boundaries: sync/flush/close, balanced timer, swallowed pagehide/beforeunload flush, quota mapping, disk data writes, and (new) `appendDataWal`, `writeMeta` (including compaction) and `checkpointDataWal` (including the retry from the next write). `LocalPersistenceStatus` and `getLocalPersistenceStatusSync()` are unchanged, except that the new boundaries now also report `error` where a per-operation WAL or metadata failure used to leave the volume reported as `clean` or `dirty`.
- **Worker.** A private `persistenceSources` hook (`mount-context.ts`) exposes the source to the worker runtime. After a `PERSISTENCE_STATUS { version: 1, generation }` command for the active generation, the worker returns a fresh frame as the reply result. Worker transitions are coalesced per event-loop turn. Transitions while handling a command ride on that reply. Other transitions post one unsolicited `PERSISTENCE_FRAME` after the turn, skipped when state and revision are unchanged. The worker sends nothing without a request. The request is handled outside the SAB command table.
- **Frame.** `{ version: 1, generation, sequence, state, failureRevision, lastError, lastSalvage }`. It is validated strictly: plain object, exact keys, bounds, `lastError` present exactly when the revision is nonzero, and `error` only with a nonzero revision.
- **Receivers.** A frame is accepted only for the current owner generation, with a higher sequence, and without a lower revision. The sequence and revision floor survives routing invalidation within a generation.
- **Leader.** It requests the snapshot during spawn, after the MountProfile check (so `ready` usually already has a value). Once a follower sent `PERSISTENCE_REQUEST { version, generation, request }`, it forwards accepted frames on the next relayed command response or in one task-coalesced broadcast. It broadcasts each snapshot reply tagged with the request id.
- **Follower.** It requests on `LEADER_READY` while its value is unknown. Until the tagged reply arrives it accepts no other frame, so a frame queued before its request cannot fill it. It also accepts a frame attached to any relayed response when no snapshot is pending.
- **Resume.** `document` `resume`, or `pageshow` with `persisted`, nulls the value. A follower then calls `invalidateRouting()` (`recovering`, handles and pending relayed work invalidated) and renegotiates through `LEADER_PING`. A leader ignores worker frames until the reply to a request sent after the resume.
- **Capability.** `MOUNT_CAPABILITIES` is `['error-details', 'persistence-status']`. New clients require it, so an owner or worker without it is refused before ready with `VFS_PROTOCOL_MISMATCH`, and no frame or request is exchanged.

### Acceptance coverage

All in `packages/opfs-vfs/src/__tests__/persistence-status.test.ts` unless noted. Fixtures: `persistence-fault-plugin.ts` (a storage plugin whose `beforeDataCommit` fails on demand, plus a double pagehide in one task), `persistence-status-worker.ts`, `persistence-status-sab-worker.ts` (nested SAB client) and `persistence-source-worker.ts` (direct `OpfsVfs` with the handle-wrap seam).

| Plan check                                | Test                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Idle subscriber, no file reads            | "reports a frozen, stable idle leader…"; "forwards idle, dirty, and clean persistence to a follower without follower commands"                                                                                                                                                                        |
| Failure then clean before delivery        | "coalesces swallowed pagehide failure and cleanup into one clean frame" (one frame: `clean`, revision +1, `EIO`, no `error` snapshot); "retains a timer-flush failure…"                                                                                                                               |
| Timer flush, async operation, SAB         | "retains a timer-flush failure…" (leader and follower); "reports an asynchronous command failure…"; "reports a synchronous SAB failure…"                                                                                                                                                              |
| Sources at their boundary                 | "records a {strict-data-wal, data-wal-write, strict-meta-log, snapshot, checkpoint-retry} failure at its source and keeps it after a clean sync"                                                                                                                                                      |
| Late subscription during a transition     | "gives a late subscriber only changed, final transition snapshots"                                                                                                                                                                                                                                    |
| Malformed/duplicate/reversed/old frames   | "rejects malformed, duplicate, reversed, and old-generation persistence frames" (leader and follower; every malformed case uses a higher sequence; revision cannot decrease)                                                                                                                          |
| Follower sleep/resume                     | "nulls a sleeping follower and accepts only a fresh post-resume snapshot"; "accepts only the reply to its own snapshot request after a follower resumes"                                                                                                                                              |
| Leader resume                             | "ignores an in-flight stale worker frame while a leader resumes"                                                                                                                                                                                                                                      |
| Owner loss and replacement                | "drops old persistence when a sleeping follower takes over" (new generation, revision 0, never old data with the new generation)                                                                                                                                                                      |
| Salvage                                   | "includes mount-time WAL salvage in the initial persistence snapshot"                                                                                                                                                                                                                                 |
| Capability gate                           | "requires the persistence capability and gates raw worker frames behind a request"                                                                                                                                                                                                                    |
| Opening/listeners                         | "keeps persistence null while a follower is still opening"; "coalesces persistence notifications and isolates throwing listeners"                                                                                                                                                                     |
| Mixed build (`tests/mixed-build.test.ts`) | candidate owners report persistence before and after refusing legacy followers; the candidate follower keeps receiving frames (`dirty` then `clean`) after a legacy page is refused; candidate page with legacy worker fails with `persistence: null`; sequential candidate owner reports persistence |

Existing tests updated for the new capability list and the extra startup request: `worker-generation`, `worker-plugin-client`, `worker-registry`, `close-admission`, `worker-status` (ready snapshot now has a clean projection) and `changes-transport` (waits for the snapshot before counting 30 s deadlines).

### Commands and results (HEAD `ce13c1a`)

| Command                                                                                                          | Result                                |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`, `pnpm deadcode` | pass                                  |
| `node --test scripts/*.test.mjs`                                                                                 | pass                                  |
| `pnpm --filter @opfs-vfs/opfs-vfs test`                                                                          | pass, 53 files, 802 tests (base: 781) |
| `pnpm --filter @opfs-vfs/plugin-subscriptions test` / `test:packed`                                              | pass, 94 (3 opt-in skipped) / 2       |
| `pnpm --filter @opfs-vfs/opfs-vfs test:mixed-build`                                                              | pass, 7 tests; legacy `ba6e48d`       |
| Premium `pnpm typecheck`, `pnpm test` (candidate core)                                                           | pass, 20 files, 335 passed, 1 skipped |
| Premium `pnpm test:packed` (candidate core and subscriptions)                                                    | pass, 13 + 2                          |

Every browser command ran under the shared browser lock. Tarballs at `ce13c1a`: candidate core SHA-256 `6b7cf60b2ad154e4faaa45fafc99500190e113634e87701149763ffd11660008`, subscriptions `628c5bed35cc80d7006d3ed03fd481dcebcd6d04a38fb030b19d777e3a3d8761` (unchanged by P1c); legacy core `3244b33a…bbf62`, legacy subscriptions `4e589247…453d7`.

Premium ran in a `git archive` copy of `dd24f15`, re-pinned (`core-artifact.json` and the workspace override) to the candidate tarball through `scripts/prepare-core.mjs`. Nothing was committed there. A temporary test file added four cases to the 331 existing ones: encrypted disk and memory leader plus follower observing `clean → dirty → clean` with no secret in status or broadcasts; a wrong-secret reopen failing with `EVOLUMELOCKED` and `persistence: null`; and encrypted takeover reporting only the new generation's persistence.

### Mutation checks

Each guard was removed or bypassed, the listed tests were run, and the source was restored. Every mutant failed at least one test. M11 survived at first; the opening-follower test was then added and kills it.

| Mutant                                                                | Failing tests                                                    |
| --------------------------------------------------------------------- | ---------------------------------------------------------------- |
| M1 retained failure cleared when leaving `error`                      | timer-flush retention, pagehide coalescing                       |
| M2 revision bumped when the same error is re-recorded                 | timer-flush retention, pagehide coalescing, takeover             |
| M3 synchronous emission instead of per-turn coalescing                | pagehide coalescing                                              |
| M4 worker emits without a request                                     | capability gate (raw worker)                                     |
| M5 sequence guard removed                                             | malformed/duplicate/reversed frames                              |
| M6 generation check removed                                           | malformed/old-generation frames                                  |
| M7 frame version check removed                                        | malformed frames                                                 |
| M8 `lastError`/revision consistency removed                           | malformed frames                                                 |
| M9 leader resync gate removed                                         | leader resume with an in-flight stale frame                      |
| M10 follower resume does not invalidate routing                       | follower resume, sleeping-follower takeover                      |
| M11 snapshot ignores the owner generation                             | opening follower                                                 |
| M12 capability not required                                           | capability gate                                                  |
| M13 leader never forwards to followers                                | 6 follower tests                                                 |
| M14 follower never requests a snapshot                                | 6 follower tests; mixed build "legacy page … candidate follower" |
| M15 floor dropped on routing invalidation                             | resumed follower's own-request test                              |
| M16/M18/M19 recording removed at WAL append, metadata, checkpoint     | the matching source-boundary tests                               |
| M17 follower accepts untagged frames while its request is outstanding | resumed follower's own-request test                              |

### Hot paths for the benchmark

- Per write: `setLocalPersistenceState('dirty')` from `markLocalDirty` returns after one comparison while the state is unchanged. On a real transition it calls the worker listener, which sets a flag. The worker attaches the frame to a command reply when it can. Other transitions post after the event-loop turn.
- Per transition: one worker-to-page message, either the reply carrying the frame or one standalone `PERSISTENCE_FRAME` after the turn. The leader parses it, compares it and republishes status. When followers asked, it puts the latest frame on the next relayed response or sends one task-coalesced broadcast.
- New try/catch wrappers around `appendDataWal`, `writeMeta` and `checkpointDataWal` (no work on success).
- Startup: one extra worker round trip during leader spawn, awaited before `ready`. One `PERSISTENCE_REQUEST` and tagged reply per follower negotiation.
- No change to `requestWorker`, `sendToWorker`, `sendToLeader`, the SAB bridge or storage scheduling.

### Limitations and dispositions

- Performance was not measured here; the orchestrator runs the P0 driver.
- Only Chromium was run.
- A sleeping follower detects owner loss only when it resumes or takes over. There is no heartbeat, by design.
- Passive observer attachments keep `persistence: null`.
- `ready` does not wait for a successful snapshot. If the startup request fails, `persistence` stays null (unknown) until a later frame or request.
- Direct handle failures on paths not listed above still surface through the command's rejection only, as before, unless they are quota errors.
- The resume trigger is the `document` `resume` and persisted `pageshow` events. Clients inside a worker have no `document` and do not resync on resume.
- No pre-existing failures were observed in the affected suites.

### Sync regression fix (62e89a7)

Orchestrator runs showed follower and leader `fsync` 5–8% slower than P1d: every write or sync posted a standalone frame ahead of its reply, and the leader re-broadcast it. Frames now ride on the command reply and on the next relayed response. They are sent as standalone messages only outside a command or relay. Measured with `benchmark:worker-client --browser chromium --workloads sync --no-cold`, alternating with the P1d worktree under the browser lock; ratios are P1c over P1d, medians of run medians and throughput:

| Pair | leader/disk | follower/disk | sab/disk    | leader/memory | follower/memory | sab/memory  |
| ---- | ----------- | ------------- | ----------- | ------------- | --------------- | ----------- |
| 1    | 1.000/0.986 | 1.021/0.986   | 1.000/0.988 | 1.014/0.990   | 1.012/0.991     | 1.000/0.991 |
| 2    | 1.000/0.989 | 1.021/0.980   | 1.000/0.983 | 1.014/0.986   | 1.000/0.986     | 1.000/0.990 |
| 3    | 1.000/0.990 | 1.021/0.983   | 1.000/0.982 | 1.014/0.989   | 1.012/0.984     | 1.000/0.988 |
| 4    | 1.000/0.988 | 1.021/0.978   | 1.000/0.986 | 1.000/1.002   | 1.012/0.988     | 1.000/1.001 |
| 5    | 1.000/0.995 | 1.021/0.982   | 1.000/0.995 | 1.000/0.999   | 1.000/0.987     | 0.986/0.997 |

Medians move in 5 µs timer steps (for example 240 → 245 µs gives 1.021). Checks after the fix: core 804 tests, subscriptions 94 (3 opt-in skipped), `test:mixed-build` 7, all passing.

### Independent continuation verification

The Codex orchestrator reran the checks at `f3d4fdc` on September 26, 2026. Install, build, typecheck, lint, formatting and dead-code checks passed. Node scripts passed 7 tests; Chromium core passed 804, subscriptions 94 with 3 opt-in skips, packed subscriptions 2, mixed-build 7, acceptance 2 and load 1. Independent Sol and Terra reviews found no blocking issue.

A disposable premium copy used the candidate core and subscriptions tarballs, including the four P1c encrypted persistence cases preserved in the handover. Build and typecheck passed; premium passed 335 tests with 1 skip, and packed tests passed 13 plus 2 composition cases. The real premium repository's pin was unchanged. Artifact SHA-256 digests:

- Core `1.0.1`: `463b9417f4b361b4483f911159d5b08f266e984635ee68b2881095bfebb59ca1`.
- Subscriptions `1.0.0`: `628c5bed35cc80d7006d3ed03fd481dcebcd6d04a38fb030b19d777e3a3d8761`.

Three additional same-session alternating P1d/P1c sync-only pairs used the unchanged driver under the shared browser lock. Median ratios across the six cases ranged from 0.986 to 1.028; all reduced-workload comparisons remain diagnostically inconclusive, not release-gate passes. Historical P0 measurements drifted with the host, so future comparisons use an adjacent parent measured in the same session.

The user deferred further benchmarks and optimization until implementation is complete. Full-workload performance and remaining browser coverage are still pending; no performance waiver or release pass is implied. The durable handover retains the verification logs and these diagnostic samples.

## P1d. Acknowledged subscription retirement

Branch `react-sdk/p1d-subscription-retirement`, based on `ba6e48d` (the orchestrator later rebased it onto P1b). Recorded September 26, 2026 on macOS 26.6.2 (25G83), Apple M5 Pro, Node.js 26.8.1, pnpm 12.4.2, Playwright Chromium 147.0.7727.15 (headless, cross-origin isolated).

### Contract

`Subscription.closed` never rejects. It resolves `{ status: 'released' }` after one of these:

- the owner replied to `terminal-ack`, which it sends only after its `closed` or `terminal` frame;
- the channel's `closed()` callback, which fires after the owner mount closed and core cleared the ledger;
- an owner or core admission rejection of `register`, which reserves nothing.

It resolves `{ status: 'unknown', error }` after a failed control request or the channel's `interrupted()` callback. The error is a `SubscriptionError` carrying the interruption code, with the transport error as `cause`. A cancel reply or local removal never settles `released`. Entries stay in the shared channel until they settle, so a local channel close cannot race an in-flight `terminal-ack`.

If a setup fails before a handle is returned, it retires through the same path. Later `subscribe()` calls on that source wait for the cleanup. If the cleanup settles `unknown`, later calls on the same channel generation reject with code `SUBSCRIPTION_RETIREMENT_UNKNOWN`, with the retirement error as `cause`. A new owner generation is not blocked. No wire, reply or frame shape changed, and `owner.ts` is unchanged.

Known conservative case: a follower sees an owner close only as `interrupted()`, because `worker-runtime.ts` maps follower-route close to `FILE_CHANGES_INTERRUPTED`. Takeover (`invalidateRouting`) is also an interruption. In both cases `closed` resolves `unknown` even though the old generation is gone. This is safe, because P3 resumes on a new generation, but it does not report every definitive retirement as `released`. Removing it needs a core signal that distinguishes confirmed teardown from generic interruption on follower and replacement routes.

### Acceptance coverage

| Plan check                                        | Test                                                                                                                                                                                                                                                            |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Held terminal acks, 32-per-client owner count     | `subscription-retirement.test.ts` "keeps all 32 client reservations…" (owner probe count stays 32, the 33rd subscribe fails with `ENOSPC`, and after release all 32 settle `released`, the count is 0 and 32 new subscriptions succeed)                         |
| Lost terminal acks                                | `subscription-retirement.test.ts` "reports lost terminal acknowledgements as unknown…"; `subscriptions.test.ts` rejected/lost ack tests                                                                                                                         |
| Delayed cancellation                              | `subscription-retirement.test.ts` "does not release after cancellation…"; `subscriptions.test.ts` "does not release while a cancel acknowledgement is held"                                                                                                     |
| Rapid unsubscribe/reacquire                       | `subscription-retirement.test.ts` "reuses capacity only after callers await closed": 200 awaited cycles with owner count ≤ 1, then unawaited reacquire with held acks hits `ENOSPC`. The real follower test runs 50 cycles.                                     |
| 128-per-mount owner count                         | `subscription-retirement.test.ts` "holds the mount-wide 128 reservations…" (4×32 held: mount count 128, a fifth client gets `ENOSPC`, and after one client's acks the count is 96 and the fifth client registers 32)                                            |
| Owner generation end                              | `subscription-retirement.test.ts` "releases every reservation when the owner generation ends"; direct mount `closeVfs()`; leader `closeVfs()` (leader handle `released`, follower handle `unknown`)                                                             |
| Failed initial registration                       | owner-rejected target, and 40 real-core rejected registrations followed by 32 successes in `subscription-retirement-direct-worker.ts`                                                                                                                           |
| Failed replacement registration                   | `subscription-retirement.test.ts` "serializes a failed replacement setup…"; "blocks a generation after interrupted setup cleanup…" (same source recovers after `nextGeneration()`)                                                                              |
| Deferred activation failure                       | `subscription-retirement.test.ts` and `subscriptions.test.ts` activation-failure tests (`unknown`, `SUBSCRIPTION_INTERRUPTED`, owner count 0)                                                                                                                   |
| Real core transports                              | Direct mount in a dedicated worker: held acks keep 32 reserved, the 33rd subscribe gets `ENOSPC`, and release settles `released`. `OpfsVfsWorker` follower relay: held acks keep 32 reserved, the 33rd subscribe gets `ENOSPC`, and release settles `released`. |
| No unhandled rejections                           | `subscription-retirement.test.ts` checks `unhandledrejection` after every test, and one `subscriptions.test.ts` test does the same                                                                                                                              |
| Synchronous idempotent unsubscribe, frozen handle | `subscriptions.test.ts` "returns a frozen handle…"                                                                                                                                                                                                              |

### Commands and results

| Command                                                                                                                               | Result                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`, `pnpm deadcode`                      | pass                                                                                                                                                                                                                                                 |
| `node --test scripts/*.test.mjs`                                                                                                      | pass, 2 tests                                                                                                                                                                                                                                        |
| `pnpm --filter @opfs-vfs/plugin-subscriptions test`                                                                                   | pass: 5 files, 91 tests, 3 opt-in skipped. The base was 4 files, 66 tests. The retirement and unit files passed 3 consecutive runs.                                                                                                                  |
| `pnpm --filter @opfs-vfs/plugin-subscriptions test:acceptance`                                                                        | pass, 2 tests (memory/disk; metadata and content each 102 deliveries)                                                                                                                                                                                |
| `pnpm --filter @opfs-vfs/plugin-subscriptions test:load`                                                                              | pass: 8,192 burst recipients, a 10,000-command owner-to-follower stream, no errors, and the direct baseline overflow as documented                                                                                                                   |
| `pnpm --filter @opfs-vfs/plugin-subscriptions test:load:two-tab`                                                                      | pass at `d66ed78` (clean): 4,096 + 4,096 burst, 10,000 in each of three stream modes, no errors                                                                                                                                                      |
| `pnpm --filter @opfs-vfs/plugin-subscriptions test:packed`                                                                            | pass, 2 packed browser tests, README fences compiled                                                                                                                                                                                                 |
| Premium `pnpm --filter @opfs-vfs/plugin-encryption test:subscriptions-packed` in a temporary clone of `opfs-vfs-premium` at `dd24f15` | pass, 2 tests. The core tarball packed from this branch matched the premium `core-artifact.json` SHA-256 `3244b33a…bf62`, so the pin was unchanged. Subscriptions tarball SHA-256 `628c5bed…8761`. The clone had no edits and nothing was committed. |

### Mutation checks

Each mutation was applied to `src/client.ts`, then `subscriptions.test.ts` and `subscription-retirement.test.ts` were run, and the file was restored.

| Mutation                                                               | Failing tests                                                                                      |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Release when `terminal-ack` is sent instead of replied                 | 12+ (held/lost ack, cancel, 32/128 counts, direct core)                                            |
| Release on the cancel reply                                            | 8                                                                                                  |
| `interrupted()`/request failure settles `released`                     | 8                                                                                                  |
| `closed()` callback settles `unknown`                                  | 4 (generation end, direct and worker core)                                                         |
| Remove setup serialization (`waitForSetups`)                           | 2                                                                                                  |
| Remove the same-generation `SUBSCRIPTION_RETIREMENT_UNKNOWN` block     | 2 (fake source and owner-backed same-source recovery)                                              |
| Remove the `terminalAcked` guard in `retire()` (cancel after terminal) | 1                                                                                                  |
| Drop the entry (and close the channel) before the terminal-ack reply   | 1 after the terminal-frame test gained a close assertion; 0 before                                 |
| `!context.closed` guard in the register-rejection handler              | 0. Interruption and close settle every entry synchronously, so the guard was dead and was removed. |

### Overhead with no subscribers

No subscriber means no measured overhead, for structural reasons. `owner.ts` is unchanged, and the new client code runs only inside `subscribe()` and on frames for registered entries. The only module-level addition is one empty `WeakMap`. In `test:acceptance`, the no-plugin runs measured memory writes 2–100 in 23.325 ms and disk writes 2–100 in 13.400 ms. These are single-run diagnostics, not thresholds. No isolated before/after comparison was run, because the base and branch execute the same code in that mode.

### Limitations

- Retirement waits on core delivering a `closed`/`terminal` frame after `cancel`. The plugin adds no timeout. Core control requests already time out and interrupt the channel.
- The register-rejection path relies on core queueing `interrupted()` before an uncertain transport rejection is observed. Code review traced this for the direct, leader and follower paths. No real-core test forces a register timeout.
- Only Chromium was run.

### No-observer performance of the combined P1a, P1b and P1d stack

The orchestrator ran the P0 driver, unchanged (harness SHA-256 identical to the baseline), at `2ac786faf844` on the same machine and browser as the P0 Chromium baseline (Chromium 147.0.7727.15, Apple M5 Pro). The run used the default gate configuration and was compared against `docs/benchmarks/react-sdk/20260926T102457Z-497680095177-chromium-baseline`.

Result: **47 pass, 1 inconclusive, 0 regressed** (`compare` exit 2 because some cases are inconclusive). The inconclusive cases are timer-resolution effects: the medians move by one 5 µs Chromium tick (for example 10 → 15 µs), or the baseline p95 was noisy, with throughput within budget. P0's own baseline repeat run showed the same pattern (45 pass, 3 inconclusive).

| Inconclusive case        | median ratio |            p95 ratio | throughput ratio |
| ------------------------ | -----------: | -------------------: | ---------------: |
| leader/memory/large-read | 0.944 (pass) | 0.435 (inconclusive) |     1.075 (pass) |

Raw samples are gzip-compressed (`samples.json.gz`, decompress before inspection). `summary.json` and `compare-to-baseline.md` are in `docs/benchmarks/react-sdk/20260926T144649Z-2ac786faf844-chromium-p1d-stack/`. Firefox was not rerun for this layer.

## P2. Package, providers and commands

Branch `react-sdk/p2-provider`, based on `react-sdk/p1d-subscription-retirement` at `750b30d` (P1a, P1b and P1d). Recorded on September 26, 2026 on macOS 26.6.2 (25G83), Apple M5 Pro, Node.js 26.8.1, pnpm 12.4.2, Playwright 1.59.1 with headless Chromium 147.0.7727.15, cross-origin isolated, real OPFS and real application workers. React 19.2.4 and react-dom 19.2.4 (dev dependencies). P2 changes no core or subscriptions source, so it has no no-observer performance delta.

### Contract as implemented

- `@opfs-vfs/react` is public (no `private` flag). React `>=19.0.0 <20`, core and `@opfs-vfs/plugin-subscriptions` are peer dependencies, with workspace dev dependencies. There are no runtime dependencies. The entry exports `DEFAULT_VOLUME`, `VolumeProvider`, `useVolume`, `useVolumeClient` and `VolumeError`, plus types. The `persistentStorage` prop, read hooks and components are not exported yet (P3/P4).
- Lookup uses immutable linked contexts with nearest exact-key lookup. Omitted selectors mean the one module-local `DEFAULT_VOLUME` symbol. Empty names, other symbols and missing bindings throw a `configuration` `VolumeError` during render.
- Render validates and snapshots the provider props: basename, worker factory, allowlisted option values, and core's plugin-request shape rules. Core re-validates all of these. The managed identity is the basename, the normalized options (core's effective defaults, `initTimeout` 0, `maxFileSize` clamp) and the sorted plugin profiles, including the appended `subscriptionsRequest()`. Plugin `options` are never read or compared. Changed identity throws and requires a keyed remount.
- Acquisition happens synchronously in the committed effect: `getSupport()`, reservation in a page-realm `Map` by basename, then construction. A render captures construction inputs only until the binding consumes one. The SDK keeps no worker factory, plugin request or option after hand-off.
- Unsupported, construction and terminal core failures (including takeover and `VFS_PLUGIN_MISMATCH`/`VFS_PROTOCOL_MISMATCH`) dispose the client and remove the reservation before publishing. Aliases see the new snapshot before any `onError` runs. Reporters run once per event per binding and never replay for a newly attached provider. Reporter exceptions are swallowed.
- Managed `close()` shares one promise. It stops core admission and invalidates every alias synchronously (`closed`, `isClosing: true`). The flush error stays in the closed state. Settlement evicts only the matching entry. A provider meeting a closing entry binds to its closed outcome. Closed and failed bindings stay tombstones, including across `<Activity>` reveal. A close requested before acquisition tombstones the binding without constructing a client.
- Borrowed providers share one source per client object and are never closed or disposed by the SDK. External disposal invalidates their state and handles. One `ClientStore` exists per actual client object (`WeakMap`).
- The provider forwards P1c owner persistence snapshots. Each attached binding reports a newly observed `failureRevision` once as a `persistence` `VolumeError`, after all aliases receive the snapshot; late attachments baseline the current revision without replaying it.
- `useVolumeClient` returns a frozen object with exactly core's 19 `GENERATION_METHODS`, built from `forGeneration()`, cached per SDK generation token, and `null` outside `ready` or while closing. Rejections are `VolumeError`s: `refused` becomes `not-applied`, `sent` on a mutation becomes `possibly-applied`, anything else becomes `unknown`. Each error is reported once to the producing binding.

### Acceptance coverage

All tests are in `packages/react/src/__tests__/`.

| Plan item                                                                                       | Test                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two roots, compatible aliases, one client per basename                                          | `managed.test.tsx` "shares one compatible client across roots and aliases", "shares compatible aliases despite different opaque plugin options"                                                                  |
| Conflicting aliases                                                                             | `managed.test.tsx` "rejects conflicting retained configuration without disturbing the original"                                                                                                                  |
| Default, string `"default"`, shadowing, missing and invalid keys                                | `lookup.test.tsx` (5 tests)                                                                                                                                                                                      |
| Unsupported environments                                                                        | `managed.test.tsx` "publishes unsupported without retaining an entry…" (`crossOriginIsolated` overridden; `cross-origin-isolation` reported; no worker)                                                          |
| Invalid options                                                                                 | `managed.test.tsx` "rejects invalid input before constructing a worker" (over 20 cases; messages carry no option or secret values)                                                                               |
| Equivalent inline options, construction-only factories                                          | `managed.test.tsx` "accepts equivalent inline construction inputs…", "normalizes core defaults…", "uses the render-time options snapshot…", "uses the latest hidden construction input…"                         |
| Changed physical identity, keyed remount of a retained client                                   | `managed.test.tsx` "requires a keyed remount for changed identity and retains compatible clients"                                                                                                                |
| Wrong secret, immediate keyed remount (fake `test-lock` plugin failing with `EVOLUMELOCKED`)    | `managed.test.tsx` "retries locked aliases from the first visible error…" (remounts with `flushSync` inside the first reporter, Strict Mode, one report per alias)                                               |
| Terminal takeover failure                                                                       | `managed.test.tsx` "evicts a follower whose takeover fails and allows corrected credentials"                                                                                                                     |
| Mixed-build or profile mismatch as a typed error                                                | `managed.test.tsx` "surfaces an incompatible raw owner before timeout…" (`VFS_PLUGIN_MISMATCH`, kind `lifecycle`); `errors.test.ts` maps `VFS_PROTOCOL_MISMATCH`                                                 |
| Strict Mode and abandoned renders                                                               | `managed.test.tsx` "constructs once in Strict Mode and does not construct abandoned renders"                                                                                                                     |
| Close and alias invalidation                                                                    | `close.test.tsx` (6 tests, including flush failure, closing-entry binding, Activity tombstone and pre-acquisition close)                                                                                         |
| External borrowed disposal, borrowed ownership                                                  | `borrowed.test.tsx` (6 tests)                                                                                                                                                                                    |
| Reporting order and attribution                                                                 | `managed.test.tsx` "updates every alias before running lifecycle error reporters"; `borrowed.test.tsx` two reporting tests; `commands.test.tsx` "reports command errors only to the alias that made the call"    |
| Persistence failure reporting                                                                   | `managed.test.tsx` real P1c fault-worker aliases plus binding-state test (late baseline, same-generation resync, coalesced revision and new-generation floor); `borrowed.test.tsx` real P1c fault-worker aliases |
| Node import without browser globals; server and first-hydration snapshots                       | `server.node.test.mjs`; `hydration.test.tsx`                                                                                                                                                                     |
| React Actions capturing handle, path and bytes, keyed by generation; write succeeds, sync fails | `commands.test.tsx` "keeps a React Action pinned…" (injected `SYNC` failure) and "refuses queued Actions that captured a prior follower generation"                                                              |
| Allowlisted command object, buffers preserved, outcome mapping                                  | `commands.test.tsx` handle-shape and round-trip tests; `errors.test.ts`                                                                                                                                          |
| Compile-time consumer checks                                                                    | `types.test.tsx` (checked by `pnpm typecheck`); `scripts/test-packed.mjs` consumer                                                                                                                               |
| Packed public contents                                                                          | `pnpm --filter @opfs-vfs/react test:packed`: files, license, no `private`, workspace peer-specifier rewriting and candidate tarball composition, Node SSR import, `tsc` consumer                                 |

CI: `scripts/ci-packages.test.mjs` now asserts that a core change selects subscriptions and react, and that a subscriptions change selects react. `ci.yml` runs `test:packed` for the React package. The manual `sdk-acceptance.yml` builds `@opfs-vfs/react...` and runs `pnpm --filter @opfs-vfs/react test` per engine through `OPFS_VFS_TEST_BROWSER`.

### Commands and results at `2ad2f9c`

| Command                                                                                                          | Result                                                                         |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm fmt:check`, `pnpm deadcode` | pass                                                                           |
| `node --test scripts/*.test.mjs`                                                                                 | pass, 2 tests                                                                  |
| `pnpm --filter @opfs-vfs/react test`                                                                             | pass: Node 1 test; Vitest 8 files, 42 tests; three consecutive full runs green |
| `pnpm --filter @opfs-vfs/react test:packed`                                                                      | pass                                                                           |

Core and subscriptions suites were not rerun because P2 changes neither package.

### Mutation checks

Each guard was changed in turn by an uncommitted script in the orchestration scratch directory (`p2/mutate.py`). It runs the named test files under the browser lock and restores the source afterwards. Every mutation failed at least one test.

| Mutation                                                        | Failing tests                                                                 |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Evict a failed entry after publishing instead of before         | locked retry (remount inside the reporter)                                    |
| Reserve the entry only after the client is ready                | shares one client; locked retry; reporting order                              |
| Skip the managed identity comparison                            | conflicting configuration                                                     |
| A tombstone re-binds to the current registry entry on re-attach | Activity tombstone                                                            |
| No synchronous closing publication                              | alias invalidation; closing-entry binding                                     |
| A closing entry conflicts instead of binding                    | closing-entry binding                                                         |
| Borrowed attach before refresh (error replay)                   | failed borrowed client without replay                                         |
| One-phase alias publication                                     | managed reporting order                                                       |
| Pre-acquisition close ignored by attach                         | child layout-effect close                                                     |
| `sent` mutation mapped to `unknown`                             | `errors.test.ts`                                                              |
| `refused` mapped to `unknown`                                   | `errors.test.ts`; alias invalidation; external borrowed close; queued Actions |
| Borrowed detach closes the client                               | borrowed unmount                                                              |
| Command object exposes `closeVfs`                               | handle shape                                                                  |
| Command object kept across generations (both redundant guards)  | queued Actions                                                                |
| `initTimeout` default not normalized                            | default normalization                                                         |
| Plugin options included in the identity                         | opaque plugin options; hidden first acquisition                               |
| Support check skipped                                           | unsupported                                                                   |
| Lookup accepts the first link of the same key type              | outer string key through an inner provider                                    |
| One borrowed source per binding                                 | borrowed reporting order                                                      |
| Input kept after a pre-acquisition close                        | pre-attach input consumption                                                  |
| First acquisition uses the first render's input                 | hidden first acquisition                                                      |

Not mutation-tested: the attachment token (React never runs a stale cleanup after a newer setup, so no test can reach it) and the synchronous terminal re-check in acquisition (it covers the window between a core status change and core's microtask notification, which a test cannot open deterministically).

### Limitations and dispositions

- Only Chromium was run locally. Firefox and WebKit are wired into the manual `sdk-acceptance.yml` job; no result is claimed.
- Wrong-secret behavior uses a fake storage plugin; real premium is P5. `VFS_PROTOCOL_MISMATCH` is covered by the classification unit test and the P1a mixed-build matrix; the real-worker test covers `VFS_PLUGIN_MISMATCH`.
- Core constructor cleanup is included from P1a; P2 continues to validate the known managed inputs at render time.
- `@opfs-vfs/opfs-vfs/worker` bundles core's inline default worker (about 130 kB) into React consumers, although managed providers always use the application's worker. This is recorded for the P7 bundle review.
- The packed test does not select or prove minimum released core/subscriptions peer versions. Those versions remain unselected until the P7 release gate; the `persistentStorage` prop and its request helper belong to P4.

### P2 persistence callback verification

After integrating P1c, the provider now reports retained persistence failures to each attached binding once per observed revision. Real managed and borrowed fault-worker tests exercise background failure callbacks. The binding transition test covers late attachment, null resynchronization, repeated revisions and replacement generations. Sol and independent Terra reviews approved the fix.

The orchestrator independently mutation-checked four paths: suppressing persistence reporting, discarding the late-attachment baseline, removing revision deduplication, and retaining the prior generation's revision floor. Each mutation caused the transition test's assertions to fail; the original source was restored after each run.

A stale Vite optimized dependency cache initially loaded a pre-P1c client despite rebuilt core artifacts. Refreshing only the generated React cache restored the current persistence protocol and made the real integration tests pass. Rebuild workspace dependencies and refresh generated dependency caches when verifying a rebased client contract.

At integrated commit `4536fb1`, the orchestrator reran install, build, typecheck, lint, formatting, dead-code checks and all 7 Node script tests successfully. React passed its Node SSR test and 45 Chromium tests; the packed consumer passed. The core parent had separately passed 805 core tests, subscriptions 94 with 3 opt-in skips, packed subscriptions 2, mixed-build 7, acceptance 2 and load 1. No benchmark was rerun.

## P3. Live reads and recovery

Recorded September 26, 2026 on macOS 26.6.2 with headless Chromium 147.0.7727.15, real OPFS and real application workers.

| Command                                                                                                                               | Result                                          |
| ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `node_modules/.bin/tsc --noEmit -p packages/react/tsconfig.json`                                                                      | pass                                            |
| `packages/react/node_modules/.bin/vitest run --config vitest.config.ts src/__tests__/resources.test.tsx src/__tests__/reads.test.tsx` | pass: Chromium, 29 tests                        |
| `node --test packages/react/src/__tests__/*.node.test.mjs`; `packages/react/node_modules/.bin/vitest run`                             | pass: Node SSR; Chromium, 10 files and 71 tests |
| `packages/react/node_modules/.bin/vite build --config vite.lib.config.ts`; TypeScript declarations                                    | pass                                            |

The focused resource suite uses real workers for ordinary reads and adds a deterministic subscription-control case for terminal ordering. It proves both `onError` before confirmed retirement and confirmed retirement before a deferred `onError` publish the terminal error, wait the one-second first recovery interval, register a replacement root watch, and converge through a real read. A confirmed-close candidate is discarded on replacement, inactive resources, or generation end, so callbacks from unknown, retired, or superseded watches cannot trigger recovery. Mutating the confirmed-close grace path to finalize before a deferred callback made the `closed-first terminal error` case time out; the guard was restored before the recorded pass.

The resource suite also proves that one manual retry after a normal root-registration failure rescans every active key, including an untouched content key. Recovery delays are observed through a delegating timer spy while reads still run through the real worker: 1 then 2 seconds, then 1 second only after a settled scan has stayed healthy for 60 seconds. A real follower takeover produces a new owner generation and resets the next delay to 1 second. Mutating the healthy-reset guard produced 4 seconds where the test requires 1; removing the new-generation reset produced 2 seconds. Both mutations were restored. Public status reports page resume and owner loss as `recovering` with no owner generation, so the SDK conservatively clears resource data and waiters in either case. A same-generation ready return rescans after confirmed retirement; unknown retirement remains a visible actionable stop.

The existing direct lower-layer anchors are `changes-transport.test.ts`'s “delivers change callbacks after a worker-owned synchronous mutation returns” and `subscription-retirement.test.ts`'s “serializes a failed replacement setup until its terminal acknowledgement retires it”, which invokes `session.invalidated({ kind: 'all' }, 'partial-mutation')`. The SDK test separately starts an elected application-worker owner, mounts a borrowed page follower, performs the owner's `openSync`/`writeSync`, then reaches that real subscriptions session through a test-only worker wrapper to force `partial-mutation`. It proves the hook observes the sync update and rereads after resync; it does not fake a file event or treat a direct mount as follower coverage.

Real-worker checks cover symlink and hard-link content refreshes, `chmod`, `utimes`, a parent rename, and a compatible follower write. A 100-key resolved-content scan makes exactly 100 initial content reads and makes none after an unrelated file update. The hook suite proves a changed path, format, byte limit, selected volume, or `enabled` option publishes a new pending or idle result without data from the prior selection. It also writes the shared `Uint8Array` returned by a content hook through a captured command handle and proves the cached buffer remains intact.

No performance benchmark was run for P3; it is deferred by the implementation request. Firefox and WebKit remain CI coverage, not locally claimed results.

### Independent integration verification

Sol and an independent Terra reviewer approved `d429275`. After replaying only P3 commits onto the verified P2 branch, the orchestrator verified `4beba76`: full build, typecheck, lint, formatting and dead-code checks passed; Node SSR, 74 Chromium React tests and the installed packed consumer passed. The earlier pnpm signature-fetch failure was caused by sandboxed network access. The pinned pnpm 12.4.2 resolved and the packed check passed with network access; no signature bypass was needed.

The orchestrator independently removed each new guard and reran its named regression. Removing per-entry folder freezing failed the shared-hook immutable snapshot assertion. Disabling targeted invalidation made the 100 × 1 MiB test perform 200 content reads instead of 100. Both guards were restored, and both targeted checks passed again. No performance comparison was run.

## P4. Persistent storage grants

### Contract as implemented

- `usePersistentStorage()` is a page-local `useSyncExternalStore` hook. Its server and initial client snapshot is `checking`; the initial `navigator.storage.persisted()` call starts only from the hook's committed effect.
- The hook reports `checking`, `requesting`, `granted`, `not-granted`, `unsupported`, or `error`, with the browser exception retained only for `error`. Missing `persisted` or `persist` methods report `unsupported`.
- `request()` first checks the existing grant, shares a live check or prompt, and resolves after its state settles. A terminal state releases the current operation before notifying listeners, so a manual retry or the automatic entry point arriving in the same microtask starts the next request rather than joining a completed one.
- `VolumeProvider` accepts `persistentStorage="manual" | "request-on-mount"`; invalid runtime values throw the existing configuration error during render. The automatic path consumes its module-local page opportunity before calling `request()`, so Strict Mode, aliases, remounts, and manual races produce at most one automatic prompt. Grant state neither delays acquisition nor changes volume durability.

### Acceptance coverage

- `persistent-storage.test.tsx` covers SSR `checking`, commit-only initial checking, manual retries at the initial-check and denial publication boundaries, automatic retry at the denial boundary, browser rejection plus manual retry, and unsupported coalescing. The isolated `persistent-storage-auto.test.tsx` starts the first automatic opportunity while a manual prompt is live, verifies one shared prompt under Strict Mode and multiple providers, then verifies a denial does not re-arm it on remount.
- `managed.test.tsx` rejects an invalid runtime `persistentStorage` value without constructing a worker. `types.test.tsx`, `server.node.test.mjs`, and `test:packed` cover the public hook export and consumer surface.

### Commands and results

| Command                                     | Result                                                  |
| ------------------------------------------- | ------------------------------------------------------- |
| `pnpm --filter @opfs-vfs/react typecheck`   | pass                                                    |
| `pnpm --filter @opfs-vfs/react build`       | pass                                                    |
| `pnpm --filter @opfs-vfs/react test`        | pass: Node SSR export test; Chromium 10 files, 44 tests |
| `pnpm --filter @opfs-vfs/react test:packed` | pass                                                    |

All browser commands held the shared browser lock. Logs are in `scratch/codex-p4`.

### Mutation check

Changing the terminal `pending` release to leave the completed operation in place caused `persistent-storage.test.tsx` to time out before `requesting` at the queued initial-denial retry. Restoring the release made the focused Chromium test pass. This exercises the terminal publication race directly.

### Limitation

The browser test replaces `navigator.storage` with a deterministic `StorageManager` stub; it does not automate a browser permission prompt.

### Independent P4 integration verification

At `c898733`, after integration with P2, the orchestrator passed install, build, typecheck, lint, formatting, dead-code checks and 7 Node script tests. React passed its Node SSR test and all 47 Chromium tests; the packed consumer passed. Independent Sol and Terra reviews approved P4. Removing the terminal pending release caused the queued retry test to time out, independently reproducing the author's mutation result. The reviewed source was restored. Browser performance remains deferred.

After stacking P4 above the final live-read implementation, the orchestrator independently verified `06a3b8c`: full build, typecheck, lint, formatting, dead-code checks and 7 Node script tests passed. The combined SDK passed Node SSR, 76 Chromium tests and the installed packed consumer. Subsequent restacking only updated inherited P3 verification prose; the P4 runtime and tests are unchanged.

## P6. Installed consumers

`pnpm --filter @opfs-vfs/react test:packed` packs this checkout, installs the three tarballs into a disposable consumer, and builds Vite 8.3.1, webpack 5.111.1, and Next 16.3.6. It records each resolved package manifest path, version, and SHA-256; verifies one React/SDK/core/subscriptions resolution; and checks the selected page and worker source-map graphs. Each `sourcesContent` module is byte-compared with its resolved installed `dist` file and the matching file extracted from its exact packed tarball. The webpack worker selector follows its emitted bootstrap dependency (`77` to `861`); it does not aggregate unrelated maps. A deliberately mismatched source-map module is asserted to fail that identity check. It extracts the immutable `ba6e48d` source with `git archive`, builds and records legacy core/subscriptions tarball hashes in its disposable directory, and uses that old worker for each cached-worker refusal. The served production fixtures return COOP `same-origin` and COEP `require-corp`, SSR the Next client boundary without storage, then Chromium hydrates each fixture and performs write, sync, direct readback, a live content-hook update, and an exact `VFS_PROTOCOL_MISMATCH` assertion. The P1a `test:mixed-build` matrix remains a separate core gate.

The command passed locally on September 26, 2026 with Node 26.8.1 and React 19.2.4. `pnpm build`, `pnpm typecheck`, `pnpm lint`, and `pnpm deadcode` also passed. `CI=1 WEBSITE_TEST_PORT=4397 pnpm --filter @opfs-vfs/website exec playwright test react-sdk-demo.spec.ts` passed both Chromium cases through the shared browser-lock wrapper: the two-page case saves a real file, preserves a dirty follower draft while the owner closes, then explicitly reloads it. Chromium is the only local browser result. Firefox and WebKit remain P7 acceptance work; WebKit OPFS remains an explicit local limitation rather than a pass.

### Independent P6 integration verification

Sol and independent Terra approved `d478ffee`. After replaying only P6 commits onto final P4, the orchestrator independently verified `136c4bc`: build, typecheck, lint, formatting, dead-code checks and all three packed consumers passed. The isolated full website run passed 68 tests, skipped the existing opt-in benchmark collection test, and exposed one missing React demo link in the HTML sitemap. The one-line fix in `1083f30` passed Sol review. After rebuilding, all five discovery and React demo tests passed with `CI=1 WEBSITE_TEST_PORT=4397`. No SDK performance comparison was run.

## P7. Release evidence and publication readiness

Status: implementation and final-candidate evidence are recorded below. This is not release approval: compatible published prerequisite versions and ranges remain unselected, and the core benchmark budget has recorded exceptions. No React release changeset is selected, and no merge or publication is authorized. Earlier P7 entries remain historical evidence; the final-candidate outcome at the end of this section supersedes their current-status statements.

### Correctness matrix

On September 26, 2026, `npm view react@19 version --json` reported `19.3.0` as the latest stable React 19 release. The public `.github/workflows/react-sdk-correctness.yml` runs on pull requests affecting the SDK, core, subscriptions, workspace dependencies, tests, or workflows. Its six cells install and assert the actual package-local `react` and `react-dom` versions before running the Node SSR and Chromium/Firefox/WebKit browser suite:

| React versions     | Browsers                  | Assertions                                                                                        |
| ------------------ | ------------------------- | ------------------------------------------------------------------------------------------------- |
| `19.0.0`, `19.3.0` | Chromium, Firefox, WebKit | Browser-visible `React.version` and `react-dom.version`, including the existing Strict Mode cases |

The workflow changes the React package manifest only inside its disposable runner before a lockfile-free install, restores the tracked manifest with an exit trap, asserts the package-local resolved versions, and clears Vite's generated dependency cache before testing. It therefore tests the selected versions rather than treating matrix labels as evidence. It uses only public workspace packages and public registry dependencies.

The separate `pnpm --filter @opfs-vfs/react test:release-artifact` command packs core, subscriptions, and React; records the source commit, dirty state, requested browser label, package versions, and SHA-256 tarball hashes in `packages/react/.release-artifacts/release-artifacts.json`; validates the React tarball contents and export map; rejects premium/encryption/query imports and React/query/crypto dependencies in core; and imports the installed package to assert the exact runtime allowlist. CI uploads that JSON for every matrix cell. The browser test logs its actual user agent plus React and React DOM versions. It is intentionally distinct from P6's installed-consumer runner. Run it locally with an explicit selected version:

```sh
OPFS_VFS_REACT_VERSION=19.3.0 pnpm --filter @opfs-vfs/react test:release-artifact
```

On the P7 worktree, the artifact check passed for both `OPFS_VFS_REACT_VERSION=19.0.0` and `19.3.0`. Under the shared browser lock, the real Node/SSR and Chromium browser suite passed with HeadlessChrome `147.0.7727.15`: React 19.0.0 passed 76 browser tests with one Activity-only skip because that host release has no `Activity` export, while React 19.3.0 passed all 77 browser tests. The 19.0.0 run still exercises Strict Mode and the closed-alias/fresh-key lifecycle assertion; only the hidden-construction case needs Activity. After the temporary matrix installs, `pnpm install --frozen-lockfile` restored the package manifest and resolved package-local React and React DOM to the default `19.2.4`; after clearing Vite's generated cache, that default browser suite passed all 77 browser tests. The first public matrix run made both Chromium and Firefox version cells green. Both WebKit cells were red while the test page was served over HTTP and `navigator.storage` was unavailable, so those outcomes are not recorded as coverage. The matrix then created an ephemeral localhost certificate, required HTTPS, and added a browser preflight that logs origin, secure-context status, OPFS, and Web Locks before the suite. In CI run `36275258814`, all four Chromium and Firefox version cells passed again, but both WebKit cells still failed the preflight with `secureContext: true`, origin `https://localhost:63315`, Web Locks available, and `navigator.storage` undefined. The log is `/private/tmp/claude-501/react-sdk-orchestration/scratch/codex-p7/webkit-https-failed.log`. HTTPS therefore did not establish a cause or repair the WebKit capability gap; no WebKit pass is claimed. Locally, the HTTPS preflight passed in Playwright WebKit but the full suite failed with an `UnknownError`, so that environment also supplies no WebKit coverage.

At `93235b5`, the orchestrator's combined runtime verification passed: core 805 tests; subscriptions 94 tests with 3 opt-in skips; packed subscriptions 2; mixed-build 7; opt-in acceptance 2; load 1; and two-tab load 1. The log is `/private/tmp/claude-501/react-sdk-orchestration/scratch/codex-p4/root-final-runtime`. This is Chromium-only browser evidence and does not replace the P7 browser matrix or final-candidate reruns.

For the clean exact-public-source candidate `5efb07bcb3f7f27853ceb80181d72882b94c77b7`, the P5 composition used the public artifacts recorded in `/private/tmp/claude-501/react-sdk-orchestration/scratch/codex-p5/artifacts-5efb07b/artifacts.json`: `@opfs-vfs/opfs-vfs@1.0.1` SHA-256 `405f0261564b7854713e828c1742c0e946a43d4283010d1b8c5cc4e4488b0126`, `@opfs-vfs/plugin-subscriptions@1.0.0` SHA-256 `628c5bed35cc80d7006d3ed03fd481dcebcd6d04a38fb030b19d777e3a3d8761`, and `@opfs-vfs/react@0.0.0` SHA-256 `44896b7ff95efef5533f3694d206b79d9996ffe7627975ad82bf680b350dca22`. The clean disposable validation passed static checks, six Node artifact checks, 331 browser tests with one existing skip, 13 packed subscription-composition tests plus two packed-node tests, and 14 React packed-composition tests. Logs are in `/private/tmp/claude-501/react-sdk-orchestration/scratch/codex-p5/root-5efb07b-clean`.

### Deferred performance and remaining release gates

The user deferred benchmarks and performance optimization during implementation. This historical note is superseded by the final-candidate evidence below; it remains here to distinguish earlier preparation from the completed measurements. The manual `sdk-acceptance.yml` workflow is named **SDK performance acceptance** and remains opt-in; correctness runs separately in the pull-request matrix.

`pnpm --filter @opfs-vfs/react benchmark:sdk --out docs/benchmarks/react-sdk/<run-id>` is the final-candidate fixture. It serves one React page fixture through Vite with the same COOP/COEP headers as the existing browser suites and compares direct `OpfsVfsWorker` plus `subscribe()` with the SDK for 1 and 100 active resources, 100 same-folder consumers, a 10,000-entry folder, and 1 KiB/1 MiB/16 MiB content. It records one warmup and five raw measured samples per mode, burst and paced writes, startup and post-write convergence, and the same warmup/sample schedule for two-tab owner/follower observation. Each output directory contains `samples.json` and `environment.json`, including the candidate commit/dirty state, browser and machine information, fixture SHA-256 digests, all raw page timings, and the two-tab assertion.

The page fixture instruments only its Worker factories and page `BroadcastChannel` instances. Its transport byte counters are observed binary payload bytes crossing those page boundaries; they exclude structured-clone framing and worker-internal traffic. One `BroadcastChannel` `MessageEvent` is counted once per channel even when multiple handlers receive it; raw delivery and suppressed-duplicate counts remain in the sample. Logical read/write bytes are separate application `Uint8Array` sizes. Both paths use a separate compatible writer, and the unrelated-read gate waits for the `/unrelated` hook to observe byte `1` before requiring zero `/content/*` reads. Page `PerformanceObserver` long-task entries are timestamped but not attributed to SDK code. Chromium additionally records CDP `Runtime.getHeapUsage` (`usedSize`, `backingStorageSize`, and `embedderHeapUsedSize`) after requested-GC baseline and teardown points and at 50 ms peak-sampling cadence, while the page deliberately retains the old/new 16 MiB refresh overlap. Those heap values cover the calling page only; they do not cover workers or assign bytes precisely to SDK buffers. If the protocol does not expose the metric, the raw result has `heap.available: false` rather than inventing memory precision.

The public fixture contains no encryption import. The private final-candidate composition must run the same selected workload with the actual encryption worker and record its exact public tarball identities beside the private result. Before a release change, run the full fixture only after the final integrated candidate is available, retain the raw outputs under `docs/benchmarks/react-sdk/`, and review a narrower contract if a required browser metric remains unavailable. This preparation does not waive any performance, memory, browser, private-integration, or release gate.

Release preparation remains deliberately concrete but incomplete: inspect packed core, subscriptions, and React artifacts; verify selected public artifact SHA-256 values in the installed consumer and private composition; rerun the P1 mixed page/worker owner/follower matrix and the final browser matrix; then select only already published core/subscriptions ranges, add the separately approved React changeset and release notes, and validate `pnpm changeset status`. No range, version, changeset, merge, publication, or waiver is selected by this branch.

Before a release change can select versions or add a changeset, record the public matrix's final browser outcomes against the candidate artifacts; select actual released core/subscriptions ranges with compatibility evidence; complete the P1 mixed page/worker owner/follower matrix; and record the deferred performance results. No package has been published and no release action is authorized by this evidence.

### Final-candidate handoff, 2026-09-27

This replaces the earlier P7 fixture description for the next candidate run; the historical browser outcomes above remain historical evidence. It records no new benchmark or browser result and does not make a release claim.

Run the public candidate only on the final integrated source and a quiet locked browser host:

```sh
pnpm --filter @opfs-vfs/react benchmark:sdk --out docs/benchmarks/react-sdk/<run-id>
```

The fixture seeds each volume before the measured run. Chromium requests GC and starts its calling-page heap baseline and 50 ms peak polling only after that seed; `measurementPhase: "post-seed workload only"` labels the resulting heap series. While the SDK retains its bounded old/new resource-0 overlap, it explicitly takes one `old-new-overlap` CDP heap sample before cleanup, so a short overlap cannot be missed by the polling cadence. Page workload time ends before that awaited heap capture, so the sample does not charge CDP sampling time to the workload. Each path separately records one unchanged content phase after convergence: the SDK awaits resource-0 `refresh()`, measures it, flushes a settled React snapshot, and requires the same `Uint8Array` identity; direct records one unchanged control read and requires its final byte. Their commands and transport bytes are separate from the convergence phase, and the delivery-deduplication assertion reads the captured update transport rather than this reset phase. The fixture takes one excluded warmup and five raw samples for each SDK/direct case and repeats that schedule for the two-tab owner/follower case. Both single-page paths start timing before the measured client is constructed; `readyMs` ends at that client's readiness and `resourcesMs` ends after the identical initial folder/content workload. The separate compatible writer is created only after that initial snapshot in both paths, so its construction is excluded from the initial phase. Direct transport accounting starts before client construction, including initialization and the subscription setup, as the SDK path does. Cleanup closes every client and subscription, collects failures while attempting all cleanup, and then deletes the volume; a cleanup or deletion failure fails the sample.

For the private P5 check, use the same runner with one encrypted 1 MiB case and a private pre-page setup module:

```sh
pnpm --filter @opfs-vfs/react benchmark:sdk --case one-1MiB --setup-module <absolute-private-setup-module> --out docs/benchmarks/react-sdk/<run-id>
```

That module supplies `globalThis.__OPFS_VFS_BENCHMARK_RUNTIME`, with fresh `worker()` and `plugins()` values, before the public page loads. A setup-module run rejects before measuring unless both runtime functions exist, so it cannot silently fall back to the public unencrypted runtime. It must also expose `__OPFS_VFS_BENCHMARK_SETUP` with the label and absolute installed React, core, subscriptions, and encryption artifact paths. The runner records SHA-256 digests for the private setup module and each declared artifact in `environment.json`; it records no secret. Vite permits only the workspace root plus the setup-module and declared alias directories, allowing relative worker imports without opening arbitrary filesystem paths. The public fixture has no encryption import or private dependency.

The final candidate must preserve the existing artifact, browser-matrix, P1 owner/follower, and published-range prerequisites above. The pinned Playwright Linux WebKit build does not expose OPFS. On public PR 85 at `618b2f1`, correctness run `36338128789` passed all six matrix cells, including the real WebKit SharedWorker fixture on macOS 15; that replaces the earlier Linux WebKit non-coverage for this candidate. The completed benchmark evidence below adds performance observations but does not select a range, changeset, merge, publication, or waiver.

### Recorded final candidate, 2026-09-27

The public final candidate is `a5f3778e9ee2d1343619919fa295a611f3f296f9`, measured in Chromium `147.0.7727.15` with Node `26.8.1` and Playwright `1.59.1` on an 18-core Apple M5 Pro host. The [raw SDK samples](benchmarks/react-sdk/20260927T202258Z-a5f3778-react-sdk/samples.json.gz) are gzip-compressed and the adjacent [environment record](benchmarks/react-sdk/20260927T202258Z-a5f3778-react-sdk/environment.json) holds the fixture, package, browser, and machine identities. The source was clean. The environment records complete built-tree hashes for React `33188519…63de`, core `8e42a8c4…3514`, and subscriptions `0de247d5…c604`; the orchestrator independently confirmed all 65 built files match the final public tarballs. Those tarballs use runtime `618b2f1` and the React manifest from `c15dcc2`: core `b1eb71f9d47561541fc2fa90309620284b0fe73e7d32c2d4ed7e763319cd2b75`, subscriptions `628c5bed35cc80d7006d3ed03fd481dcebcd6d04a38fb030b19d777e3a3d8761`, and React `de6ea2e6e9c15db4c4d119a4f82c3727d4df2bf1bcbb8da0950d36741f9bcfde`.

All 20 measured SDK samples passed the structural assertions: one shared initial listing, no resolved-content read after the unrelated update barrier, deduplicated broadcast accounting, and observed old/new buffer overlap. The 100-resource case had no long tasks. The 16 MiB case recorded 40 SDK long tasks (maximum 240 ms) and 45 direct long tasks (maximum 252 ms). The page observer cannot attribute either set to SDK code, so this is a workload warning, not an SDK-causation finding.

| Scenario             | Direct median workload / initial resources / unchanged read | SDK median workload / initial resources / unchanged refresh |
| -------------------- | ----------------------------------------------------------: | ----------------------------------------------------------: |
| 1 KiB, one resource  |                               1062.335 / 998.050 / 0.035 ms |                                720.495 / 662.580 / 0.195 ms |
| 1 MiB, one resource  |                               1562.895 / 999.860 / 6.830 ms |                              1189.795 / 647.835 / 11.575 ms |
| 16 MiB, one resource |                            2319.310 / 1121.650 / 114.195 ms |                             2054.730 / 757.140 / 183.765 ms |
| 1 MiB, 100 resources |                              2279.125 / 1748.720 / 7.015 ms |                             1851.095 / 1408.015 / 11.185 ms |

`readyMs` was about 620–661 ms in these development-worker runs and is not comparable with the core P0 command timings. Two-tab follower convergence medians were 7.4765 ms direct and 7.912708 ms SDK. The raw heap series contains baseline, 50 ms peak, retained, and explicit SDK old/new-overlap samples. They cover only the calling page; worker memory and ownership are not inferred from them.

The three alternating public core comparisons are preserved with their six gzip-compressed raw sample sets and summaries in [the core A/B record](benchmarks/react-sdk/20260927T175158Z-618b2f1-core-ab/). Every comparison was gate-eligible with identical harness, configuration, browser, and machine. They do not pass the proposed core budget: follower disk close was 1.100× in all three pairs; follower memory close was 1.103× and 1.069× in two pairs; leader disk ready was 1.066× and 1.056× in two pairs; SAB disk ready was 1.061× and 1.051× in two pairs, with 1.056× inconclusive in the third; and the leader-memory large-read tail was unstable, including one regression. The observed startup differences were roughly 0.6–0.8 ms for leaders and follower close differences roughly 10–15 µs. The user authorized a follow-up optimization investigation; this evidence does not waive the budget or mark that gate passed.

The private P5 composition ran the same one-resource encrypted 1 MiB workload and two-tab path with actual encryption plus subscriptions, exact packed aliases, and recorded private artifact hashes. Its structural and two-tab checks passed, with no task over 50 ms. Its [private acceptance record](https://github.com/opfs-vfs/opfs-vfs-premium/blob/bb5f994/docs/REACT-SDK-ACCEPTANCE.md) retains the raw samples and setup; this public index records only that result and does not import or expose private source.

Public correctness remains the six-cell PR 85 matrix above. Core prerequisite PR 86 (`c627d9c`) is a core-only prerequisite with a green hosted macOS WebKit SharedWorker result; React is not included in that PR. The private PR 23 final check also completed successfully before the user paused Actions. The user then disabled Actions for both repositories, so no new hosted final-evidence CI was run; the previously green PR 85, PR 86, and PR 23 results remain historical evidence. The prerequisite packages must be published and paired with actual published compatible core and subscriptions versions before a separate release change can select ranges. That release change must add the approved React changeset and release notes, recheck installed artifacts against those published versions, and receive merge and publication authorization. P7 completion records implementation and evidence; it does not publish a package.

### Issue #89 follow-up, 2026-09-28

The [new public SDK baseline](benchmarks/react-sdk/issue-89-public-sdk-baseline/README.md) skips binary payload enumeration in the fixture and uses word-wise byte equality. Across five Chromium runs, the 16 MiB unchanged refresh median was 3.035 ms and neither the SDK nor direct path recorded a long task. The earlier `a5f3778` SDK timings used the old fixture and remain historical only.

The [core rebaseline](benchmarks/react-sdk/issue-89-core-rebaseline/README.md) uses 256 large operations and a 50 µs absolute floor for cold ready/close phases. The leader/memory large-read tail and follower close cases pass. Leader/disk ready still regresses in the full-matrix comparison; an [alternating targeted check](benchmarks/react-sdk/issue-89-core-rebaseline/ready-alternating.md) found a 0.645–0.965 ms median gap in three pairs, two over the 5% budget. No core budget waiver or all-pass claim is made. The optional `INIT` snapshot shortcut was rejected because raw workers must request persistence frames explicitly. A [three-tab relay probe](benchmarks/react-sdk/issue-89-relay-probe/README.md) confirms that an idle follower receives large replies, but found no idle-tab long tasks in three short runs.
