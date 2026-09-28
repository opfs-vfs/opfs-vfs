# Collect website benchmark results

Run `/benchmarks/collect/` once per browser on each device. On a deployed website, open `https://opfs.dev/benchmarks/collect/`; no installation is needed. The Benchmarks page links to the collector. For local collection, follow the setup below. Nothing is uploaded or published automatically. Send the original files back for review and the website tables.

## Install and start

- Install [Node.js 24 LTS](https://nodejs.org/en/download) and the repository's pinned pnpm: `npm install --global pnpm@12.4.2`.
- Use installed stable [Google Chrome](https://www.google.com/chrome/) and Safari, which comes with macOS. [Firefox](https://www.mozilla.org/firefox/new/) is optional. No browser drivers, Playwright downloads, Homebrew or Python are needed.
- Use the same clean repository commit on both Macs, including the collection page. Keep the lockfile unchanged and rebuild dependencies on each Mac. A `+dirty` source version needs its exact patch preserved and reviewed before publication.

From the repository directory:

```sh
pnpm install --frozen-lockfile
pnpm benchmark:collect
```

Wait for the build and preview to finish, then open <http://localhost:4325/benchmarks/collect/>. If the preview stays attached to the terminal, keep it open. If Astro starts it in the background, stop it later with `pnpm --filter @opfs-vfs/website exec astro preview stop`. The command builds the website and its workspace dependencies, with the isolation headers required by the workers. Use this production preview rather than the development server. Do not run another build during collection.

If pnpm cannot verify its pinned version because the registry is unreachable, restore network access and retry. Do not disable signature verification.

To prevent sleep while collecting, open a second terminal and run the macOS command:

```sh
caffeinate -di
```

Press Control-C in that terminal when finished. Keep the laptop plugged in and the lid open.

## Mobile devices

On iPhone and iPad, open the deployed HTTPS collector. Use a fresh regular profile where available; otherwise use a regular tab with extensions off and record that in Notes. Avoid private browsing. Plug in, disable Low Power Mode, let the device cool, and keep the tab visible and screen awake. Check the model and OS version in Settings. Desktop-mode iPads are detected using touch support as well as browser metadata; review all fields manually. Actual mobile benchmark validation remains pending.

## Browser profiles

Use a fresh **regular** profile named `OPFS benchmarks`, without sign-in or extensions. Private browsing is unsuitable for the published comparison. Firefox [disables OPFS in private browsing](https://bugzilla.mozilla.org/show_bug.cgi?id=1785125), and [getDirectory can fail in private browsing](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/getDirectory). Storage behavior is part of what we are measuring.

- Chrome: profile menu, Add profile, continue without an account. [Chrome profile instructions](https://support.google.com/chrome/answer/2364824).
- Safari: Settings, Profiles, create a profile and open its regular window. Check extensions are off. [Safari profile instructions](https://support.apple.com/105100).
- Firefox: open `about:profiles`, create a profile, and launch it in a new browser. [Firefox profile instructions](https://support.mozilla.org/en-US/kb/profile-manager-create-remove-switch-firefox-profiles).

Use actual Safari. Playwright WebKit is a separate browser build and its results must not be labelled Safari. No Safari developer setting or remote automation permission is required.

## Run on each device

1. Close other browsers and busy apps. Pause builds, backups and downloads. Allow the Mac to cool and idle before each browser. Use the same power mode throughout, preferably Automatic with Low Power Mode off. Leave developer tools closed.
2. Open the collection URL in the fresh profile. Enter the device model, chip and RAM if known, OS name and exact OS version. The optional Mac presets are editable. Review the detected browser and version against About or Settings; selecting another browser clears its version. Record power mode, approximate free disk space and unusual conditions in Notes.
3. Confirm the preparation checkbox and select **Run collection**. Keep the tab visible until it finishes. Run only one collection at a time. Allow about 20 minutes per browser; slower systems may need more. A single sample exceeding ten minutes stops the run.
4. Select **Download JSON**, even if the collection failed. Keep interrupted or failed files separate from publishable ones. Close the browser and repeat in the next browser.
5. Repeat on the other Mac. Match browser versions across machines where possible; otherwise report them separately. The presets reflect the supplied screenshots:

| Machine              | Chip   | Memory | macOS  |
| -------------------- | ------ | ------ | ------ |
| MacBook Pro, 16-inch | M5 Pro | 64 GB  | 26.6.2 |
| Mac Studio, 2022     | M1 Max | 64 GB  | 26.5.2 |

The OS versions differ, so these results compare complete systems, not chip performance alone. No device serial number is recorded. Update the OS field if either machine changes.

If you cancel, let the worker finish cleanup. If the page reports unconfirmed cleanup after an error or forced stop, close the benchmark tab and clear **only this benchmark origin's** website data in the disposable profile before retrying. A browser crash loses the in-page report. The runner never clears unrelated storage automatically.

## Fixed protocol `browser-collection-v2`

Each browser runs one excluded warm-up round and five measured rounds. The starting job rotates each round to reduce fixed-order bias. Each job uses a fresh worker and fresh uniquely named storage, runs sequentially, verifies correctness and deletes its own storage. Browser and OS caches are not cleared. The warm-up primes caches and storage paths; it does not preserve a worker's JIT state. Every SQL worker also performs untimed PGlite initialization, recorded as `preparationMs`.

| Workload                                  | Variants                                                                       | Settings                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| PGlite historic speed tests, 16 cases     | VFS disk buffer, VFS memory buffer, OPFS AHP, IndexedDB, memory-only reference | Fixed SQL revision; raw timings for every case                                |
| Transaction batch and retained-row reopen | Same variants                                                                  | 10,000 rows, insert and update in one transaction, count checked after reopen |
| Filesystem lifecycle                      | VFS disk buffer, VFS memory buffer                                             | 1,000 files, deterministic 1 KiB payloads                                     |

Safari and iOS/iPadOS omit OPFS AHP from both SQL workloads and records why. Desktop Chrome and Firefox have 12 variants, 72 total samples including warm-ups. Safari and iOS/iPadOS have 10 variants, 60 total samples. Detected Apple mobile devices keep AHP omitted even if the browser or OS field is corrected. AHP failures in other browsers remain failures; they are never converted into timings or silently removed.

VFS uses `balanced` local durability in both buffer modes. PGlite uses `relaxedDurability: false` for every backend. The memory-only PGlite backend is a nonpersistent reference and must have its own table section. VFS memory buffering still persists to OPFS.

SQL reports initialization, workload, subsequent explicit sync and reopen separately. The workload can already include synchronization, so the later sync timer is not total persistence cost. Close and final cleanup are excluded. The 16-case suite drops its tables and verifies their absence after reopen; the separate transaction job checks retained rows. Filesystem read includes byte verification, delete removes half the files, and reopen times mounting before verification of the surviving files. A clean reopen is not a crash or power-loss test, and identical option names do not establish equivalent durability across backends.

## Reading the JSON and preparing tables

The bundle has `kind: "opfs-vfs-benchmark-collection"`, schema version 1 and a protocol revision. It contains environment and package/source versions, workload revisions, the full job configuration, explicit skipped backends and ordered entries. Each entry references its `jobId`, stores `round` from 0 to 5, `warmup`, timestamps and raw worker samples. Worker-local `repetition` is always 1; use the entry's `round` for the collection repetition.

For publication, verify `status === "complete"`, `eligibleForReview === true`, no interruption, one successful warm-up plus five successful measured samples per job, and identical source/workload revisions. These flags qualify a file for review, not automatic publication. The browser profile and environment details are user declarations. `profile: "regular-extensions-off"` records the preparation confirmation, not proof of a fresh profile; Notes should record mobile profile limitations. Environment includes `os` and `osVersion`; the legacy `macOS` field is included only for macOS. Version 2 adds general device metadata and mobile AHP omission without changing the workload sizes or rounds from `mac-browser-v1`. Review notes, versions and raw errors too.

Compute median, minimum and maximum from the five measured samples only. Show `n=5`, units, settings, machine, OS and full browser version. Keep hardware/browser groups separate; do not pool all six files or average backend ratios. Keep initialization, SQL work, explicit sync, reopen, each SQL case and filesystem phases separate. Failed, unavailable or omitted results are text, never zero; absent memory persistence/reopen metrics remain null. If any required sample fails, retain the file for diagnosis and rerun the collection before producing a complete comparison table.

The existing website remains without published numbers until these files have been reviewed. Automated smoke-test results are not measurements for publication.

## Developer verification

The normal website tests cover scheduling, Safari omission, eligibility, cancellation and stopping after cleanup failure. To exercise the complete collection with real workers against a production build, run:

```sh
BENCHMARK_COLLECTION_FULL=1 pnpm --filter @opfs-vfs/website exec playwright test tests/benchmark-collection.spec.ts
```

This uses the installed Playwright test browser and can take several minutes. It checks functionality only; collect publishable measurements manually in the regular profiles described above.
