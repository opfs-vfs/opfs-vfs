# CI affected-test selection

Research date: 2026-09-23. Repository inspected at `346abc8`. GitHub Actions status sampled around 09:50–09:55 UTC. No CI configuration was changed.

## Measured runs

Read 86 run records through GitHub's Actions API, then inspected job steps and selected completed logs. Historical runs span different commits and workspace sizes, so they are examples rather than a controlled benchmark. Durations below use job/step start and completion timestamps, excluding workflow queue time.

| Successful CI run                                                            | Job duration | Test step | Other job time |
| ---------------------------------------------------------------------------- | ------------ | --------- | -------------- |
| [35842923863](https://github.com/opfs-vfs/opfs-vfs/actions/runs/35842923863) | 12m 29s      | 11m 09s   | 1m 20s         |
| [35776413408](https://github.com/opfs-vfs/opfs-vfs/actions/runs/35776413408) | 10m 32s      | 9m 06s    | 1m 26s         |
| [35760603013](https://github.com/opfs-vfs/opfs-vfs/actions/runs/35760603013) | 10m 58s      | 9m 19s    | 1m 39s         |
| [35740695200](https://github.com/opfs-vfs/opfs-vfs/actions/runs/35740695200) | 12m 42s      | 10m 50s   | 1m 52s         |

Tests consumed 85–89% of those jobs. Logs for the first two show core Vitest taking 162s and 141s, followed by 41 website browser tests taking 8.3m and 6.6m. A newer four-package run, [35843788035](https://github.com/opfs-vfs/opfs-vfs/actions/runs/35843788035), spent 144s in core, 15s in devtools, and 7.3m in website browser tests before failing two website assertions. The package test phases run in dependency order even though building has already finished.

Across the inspected recent jobs, dependency install took 8–13s, build 11–25s, typecheck 8–22s, and Chromium installation 23–38s. Build caching cannot remove the dominant browser-test time.

The [persistence-docs run 35791465941](https://github.com/opfs-vfs/opfs-vfs/actions/runs/35791465941) was cancelled after its 20-minute job limit. The check annotation explicitly says the maximum execution time was exceeded. Core and devtools had passed; the website browser suite was still running. Later [run 35843787863](https://github.com/opfs-vfs/opfs-vfs/actions/runs/35843787863) finished after 16m 47s with three PGlite status timeouts and two website assertions failing. These are observed failures, not proof that every failure is flaky. Fixing the underlying failures matters more than raising timeouts or adding retries. Current logs do not provide complete individual browser-test durations, so no single benchmark spec has been proven the main bottleneck.

At the status snapshot, eight CI runs were executing `pnpm test`, two runs each for the same performance, metadata, worker-transport, and filesystem branch heads. Those branches had already merged. Examples: [performance run A](https://github.com/opfs-vfs/opfs-vfs/actions/runs/35844533901) and [run B](https://github.com/opfs-vfs/opfs-vfs/actions/runs/35844532156). Same head SHA does not prove identical merge checkouts; base updates may differ. The [active Release run](https://github.com/opfs-vfs/opfs-vfs/actions/runs/35844138449) was also testing, while [the newer Release run](https://github.com/opfs-vfs/opfs-vfs/actions/runs/35844901508) was pending. Status can change after this snapshot.

## First changes to make

1. Add PR-scoped cancellation of superseded CI runs, keyed by workflow and PR number, with a unique fallback for non-PR invocations. The [current CI workflow](../../.github/workflows/ci.yml) has no concurrency policy. Keep the existing serialized release/publishing policy. This saves runner work; it does not make an individual suite faster. [GitHub concurrency syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency)
2. Select affected packages plus dependents, with the broad fallbacks described below. A website-only change can avoid roughly 2–3.5 minutes of core testing in the observed examples, plus devtools tests, but still pays for website E2E. A prose-only root documentation change can skip browser testing after an explicit safe classification. Website content still needs its build and appropriate link/render checks. Preserve a required check that reports success when no tests are applicable; workflow-level path skips can leave required checks pending. [GitHub path-filter behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onpushpull_requestpull_request_targetpathspaths-ignore)
3. Put core tests and website E2E in separate jobs so website testing need not wait for core tests. Start website E2E with two shards, preserving one worker per shard, then measure balance. Keep a fast checks job and an aggregate required check that propagates failures. Build prerequisites must exist in every testing job, either through a small rebuild or transferred outputs. An initial full-run target of 6–8 minutes is an estimate based on observed timings, not a demonstrated result; uneven files and runner overhead can limit the gain.
4. Record per-test duration and upload failure traces/results. The existing website configuration retains traces on failure, but CI does not upload them. Investigate PGlite readiness and website assertion failures. Benchmark suites with 2–5 minute test budgets are candidates for explicit path-based selection or a separate full benchmark check; retain bounded behavior checks on relevant PRs and full coverage for core storage changes. Do not simply remove crash/durability tests to make CI green.
5. Treat caches as secondary. Trial pnpm store caching only if restoration is cheaper than the current 8–13 second install; initialize pnpm before setup-node's explicit `cache: pnpm`. Downloading only the Chromium headless shell may reduce setup for these headless tests. Browser-binary caching is not Playwright's default recommendation because restore time can match download time. [setup-node caching](https://github.com/actions/setup-node#caching-global-packages-data), [headless-shell installation](https://playwright.dev/docs/browsers#chromium-headless-shell), [Playwright CI caching](https://playwright.dev/docs/ci#caching-browsers)

## Recommendation

Start with affected **packages** using pnpm, then shard the slow browser suites if measured test time warrants it. Adding Turborepo solely to select affected work is unnecessary here. It becomes useful if repeated builds and typechecks justify shared task caching.

Do not use automatic affected **test-file** selection as the only required check for this repository yet. Worker entry points, files read at runtime, served vendor assets, and website routes cross boundaries that a test import graph cannot reliably describe.

## What already exists

There are four workspace packages. Their manifests declare the following downstream relationships:

| Changed package | Packages whose tests should run                  |
| --------------- | ------------------------------------------------ |
| `opfs-vfs`      | `opfs-vfs`, `devtools`, `website`                |
| `file-preview`  | `file-preview`, `devtools`, `website`            |
| `devtools`      | `devtools`, `website`                            |
| `website`       | `website`, with the EdgeJS asset exception below |

Evidence: [core manifest](../../packages/opfs-vfs/package.json), [preview manifest](../../packages/file-preview/package.json), [devtools manifest](../../packages/devtools/package.json), and [website manifest](../../apps/website/package.json). Tests for devtools and website each combine Node tests with browser tests; filtering only Vitest would omit the Node part.

pnpm supports changed packages plus transitive dependents directly:

```sh
pnpm --filter "...[<base-sha>]" test
```

The prefix ellipsis includes dependents. This selects entire package scripts, not individual tests. `--test-pattern` can avoid propagating test-only edits to dependents, but requires accurate patterns covering shared fixtures. Use the fetched pull request base SHA, `github.event.pull_request.base.sha`, so stacked PRs compare against their actual target rather than a hardcoded `main`. Fail open to full checks if the comparison cannot be resolved. Building the selected packages also requires their upstream build prerequisites; selecting affected tests alone does not prepare fresh `dist` exports. [pnpm filtering](https://pnpm.io/filtering)

Keep full checks for root manifests, lockfile, workspace configuration, patches, shared TypeScript/build configuration, and CI changes. Root files need explicit handling beyond a package-directory filter. Preserve an always-reporting required check even when work is skipped. These are implementation recommendations, not verified current CI behavior.

## Why file-level inference is risky

Vitest supports `related` and `--changed`. Its documented related-file selection follows statically resolvable imports, including literal dynamic imports, but cannot follow computed imports. The installed Vitest 4.1.11 implementation builds related-test graphs from Vite's SSR transform dependencies. [Vitest CLI](https://vitest.dev/guide/cli.html#vitest-related), [versioned implementation](https://github.com/vitest-dev/vitest/blob/v4.1.11/packages/vitest/src/node/specifications.ts)

In this repository, [storage-fault.test.ts](../../packages/opfs-vfs/src/__tests__/storage-fault.test.ts) imports only Vitest and constructs `new Worker(new URL('./storage-fault-worker.ts', import.meta.url))`. The worker imports the implementation under test. Many persistence, crash-recovery, and worker suites follow this pattern. It is unsafe to assume an SSR import graph includes those worker URL edges. This is an inference from the code paths, not a measured false-negative experiment. A validation should explicitly prove that changing worker and storage sources selects every relevant suite before enabling file-level skipping.

Playwright has `--only-changed`, and its installed 1.59.1 implementation also considers recorded test dependencies. But the website tests mostly navigate routes served by a separately built Astro site; they do not import the application components they exercise. A change to `FilesystemDemo` cannot be safely mapped to `filesystem.spec.ts` just from the test imports. Runtime `readFile`, esbuild entry points, and public assets have similar limitations. [Playwright CLI](https://playwright.dev/docs/test-cli), [versioned dependency implementation](https://github.com/microsoft/playwright/blob/v1.59.1/packages/playwright/src/transform/compilationCache.ts), [website config](../../apps/website/playwright.config.ts), [filesystem tests](../../apps/website/tests/filesystem.spec.ts)

There is also a cross-package exception: [the core live EdgeJS config](../../packages/opfs-vfs/vitest.edgejs-live.config.ts) serves `apps/website/public`, and its probe dynamically imports that SDK. Changes to those vendor assets must trigger the live EdgeJS probe if it is part of the required checks. The ordinary manifest graph does not express this reverse dependency.

A safe first policy is full tests within affected packages, including all core browser tests for core source changes and all website E2E tests for website runtime changes. Later, explicit feature-to-suite mappings can narrow isolated website changes while shared UI, worker, storage, vendor, and configuration changes retain broad coverage. Keep a full suite on the default branch or a schedule as a backstop.

## What Turborepo would add

Default `--affected` selects package tasks. It does not infer which tests within a `vitest run` or `playwright test` command cover a changed source file. Current upstream documentation also describes the experimental `affectedUsingTaskInputs` flag, which selects tasks using declared input globs. That still requires defining safe task boundaries and does not remove this repository's runtime dependency problem. Verify availability in the pinned release before relying on that experimental option. [Turborepo run](https://github.com/vercel/turborepo/blob/main/apps/docs/content/docs/reference/run.mdx), [task-input selection](https://github.com/vercel/turborepo/blob/main/apps/docs/content/docs/reference/configuration.mdx#affectedusingtaskinputs)

Its useful addition would be cached build/typecheck task results shared across runs. This requires declared build outputs, complete inputs and dependency relationships, and cache persistence or remote caching. Browser tests should initially remain uncached; later caching must account for browser choice/version, runner environment, vendor assets, and other behavior-changing inputs. Turbo assumes tasks are deterministic with respect to the inputs it hashes. [Caching](https://turborepo.dev/docs/crafting-your-repository/caching), [environment inputs](https://turborepo.dev/docs/crafting-your-repository/using-environment-variables)

## Shortening full runs

The [website config](../../apps/website/playwright.config.ts) sets `workers: 1` and `fullyParallel: false`. Playwright can split existing test files across independent jobs with `--shard=1/2` and `--shard=2/2`, preserving serial execution inside each file. Uneven file durations limit the gain; `fullyParallel` changes test isolation assumptions and needs validation. Sharding lowers elapsed time but repeats setup and can increase total runner minutes. [Playwright sharding](https://playwright.dev/docs/test-sharding)

The [core](../../packages/opfs-vfs/vitest.config.ts) and [devtools](../../packages/devtools/vitest.config.ts) configurations also disable file parallelism. Separate CI shards are a conservative place to test concurrency because each runner gets its own browser storage and processes. Measure shard balance and repeated setup before choosing the shard count; do not predict a speedup from configuration alone.
