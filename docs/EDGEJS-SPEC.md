# EdgeJS live OPFS integration

Status: implemented and experimentally validated on 2026-09-22. The existing snapshot adapter remains supported. This specification covers an experimental live filesystem adapter, a static website demo, and a reproducible custom Wasmer SDK build.

## Outcome

A website visitor can run an editable EdgeJS program using `node:fs`, inspect its files, reload the page, and observe persistent data. An application developer can download the exact tested host assets or build them from immutable commits in the OPFS VFS forks, then use the public adapter with the unchanged `wasmer/edgejs@0.2.0` guest.

Use DuckDB PR #10 as the distribution pattern. OPFS VFS and ordinary website builds consume prepared assets; they do not compile Wasmer. No npm publication, deployment, or merge is part of this task.

## Source and upstream work

- Wasmer SDK: continue `opfs-vfs/wasmer-sdk` draft #1, exposing `SandboxOptions.syncMounts`. Keep the generic upstream API independent of OPFS VFS.
- Wasmer runtime: retain the tested base and apply the live descriptor-size fix from upstream #6940 and only the metadata/readlink errno-propagation changes from #6731. Record original authorship and exact source commits. Do not duplicate their upstream PRs.
- Fix concurrent non-exclusive file creation in a separate runtime commit and regression test. A stale missing-path lookup must not force `EPERM` when another create won. Preserve `O_EXCL`, no-follow, directory, rights, truncation, and append semantics. Resolve races through the normal existing-file path rather than bypassing its checks or unconditionally weakening exclusive creation. Review the exact retry/locking design before implementation.
- Publish a fork integration branch containing those dependencies and the isolated new fix, suitable for a pinned build. Keep the new fix separately reviewable for later upstream submission. Check contribution guidance and duplicate upstream proposals before opening any new draft.
- Record the SDK commit, runtime commit, submodule revisions, toolchain, guest artifact hash, build commands, output hashes, and license notices. Fork links and commit hashes are the source of truth. Separate hand-maintained patch downloads are unnecessary.
- Switch documentation to official packages only after released artifacts include the changes and pass the same checks. A merge alone does not replace the custom build.

## Public adapter

Add a separate live adapter export under `@opfs-vfs/opfs-vfs/wasmer-sync`. Its factory, `createWasmerFileSystem(vfs)`, returns the structural synchronous provider expected by the custom SDK. Keep the existing `/wasmer` snapshot adapter unchanged.

Reuse `OpfsVfs` synchronous operations. Create the VFS and SDK client in a dedicated owner worker, await readiness, and mount the provider at `/data`. Forward reads, writes, seek, live descriptor metadata, truncation, flush, close, directory operations, rename, and unlink. Preserve POSIX error codes and exclusive/append/truncate flags. Reject links and unsupported file kinds explicitly, checking every existing ancestor with `lstat` before a path operation. Validate paths at the adapter boundary.

Descriptor unlink must not remove a replacement file. Track descriptor identity and adapter-controlled renames; when identity cannot be established, return `ENOTSUP` rather than guessing. Arbitrary external namespace mutation and hard links remain unsupported. Close guest handles before closing the VFS. Successful writes alone do not promise a durable volume checkpoint; use the documented synchronization barriers.

Do not bundle the Wasmer SDK into the OPFS VFS npm output. The adapter uses structural types so ordinary builds and tests work without custom host assets. Include a changeset and API documentation.

## Static distribution

Build the SDK externally from the pinned fork revisions. Use a fresh versioned directory, initially `/vendor/edgejs/0.2.0-opfs-vfs.1/`, containing the matching SDK JavaScript, worker modules, Wasm, and declarations with their relative paths intact. Include a downloadable package/archive, `build.json` with SHA-256 checksums and provenance, and required license notices. Keep the archive separate from its extracted files to avoid recursive packaging.

The unchanged guest may be fetched from its pinned registry package. Prefer a locally served verified guest artifact for the website demo if the SDK loader can resolve its dependencies reliably. Document any remaining registry dependency instead of claiming offline operation. Do not host a custom EdgeJS guest or rebuild EdgeJS unnecessarily.

Compile with the SDK's existing external-runtime support. Pin the Rust nightly and matching wasm-bindgen CLI; verify the recipe from the fork checkout. The full SDK asset set must be served, not just a Wasm file. Reject incompatible hosts before running guest code; verify both the API and known build provenance rather than assuming a stock SDK silently honors `syncMounts`.

## Website guide

Add an experimental EdgeJS integration page and navigation links. Include:

1. A short explanation of live mounts and the unchanged guest.
2. Versioned downloads, sizes, checksums, source commits, and notices.
3. Optional build instructions in separate fork checkouts with exact toolchain and runtime selection.
4. A runnable worker example using the public adapter and documented asset URLs.
5. HTTPS/localhost, cross-origin isolation, SharedArrayBuffer, JSPI, and tested Chromium requirements.
6. Shutdown, persistence barriers, browser/network requirements, error handling, and unsupported operations.
7. Commands for optional integration tests; distinguish those from SDK tests and the broader upstream compatibility suite.
8. Upstream dependency links and a migration policy for official releases.

Do not claim full Node compatibility. The previous full SDK-hosted run had many failures in both filesystem modes. Retain that evidence and explain its launcher limitations; a passing persistence demo does not supersede it.

## Demo

Add `/demos/edgejs/` using existing website layout, controls, and styles. Provide a JavaScript textarea, Run button, output panel, file listing and selected text preview, plus Reset demo files. The default program increments `/data/counter.txt` through `node:fs` and prints the value. Reloading and running again increments the persisted value.

One owner worker and one active execution per page. Disable conflicting actions during startup, execution, inspection, reset, and shutdown. Serialize operations, cap captured output and file previews, and show loading/errors accessibly. Use a named demo volume only; reset must never touch other application volumes. Handle another tab holding the volume lock with a useful message.

Set a bounded guest execution timeout. On failure, await stopped execution before touching or closing storage. If stopped execution cannot be confirmed, disable further operations and require page teardown/reopen; do not inspect, reset, retry mutations, or close the live VFS. A worker must not terminate while the bridge is known to be mutating storage merely to implement a cosmetic Cancel button; omit Cancel initially. Page teardown may terminate a worker and must not be advertised as an orderly flush. Running programs use disabled guest networking. The page must not auto-run user code on load.

Browser capability failures should explain the requirement before downloading large assets. Avoid runtime/build internals in the normal demo UI; link to the guide for details.

## Verification and acceptance

- Runtime regression: reproduce the concurrent-create failure before the fix; verify repeated concurrent non-exclusive creates, preserved exclusive-create errors, and relevant existing runtime tests after the fix. Revert the fix to prove the regression test detects it.
- Adapter tests: binary data, offsets, append/truncate, live size, directory operations, errno propagation, cleanup, rejected links, and rename/replacement-safe descriptor unlink.
- Optional real EdgeJS browser tests against the exact public asset directory: write/read, reload persistence, live bidirectional edits, live `fstat`, concurrent create regression, `O_EXCL`, injected errors, cleanup, and fresh runtime reopen. Missing assets must fail this optional command clearly, not silently skip it. Keep this suite separate from the existing stock-SDK snapshot probe.
- Replay the upstream write-stream regressions and targeted compatibility checks with the final host build. Preserve the previous full-run report; rerun the entire multi-thousand-case suite only if the change warrants it.
- Demo browser checks: initial capability state, first run, reload/second run, file preview, code error recovery, timeout recovery where safe, reset, and mobile layout. Inspect screenshots and browser errors.
- Verify every download link, JavaScript import, worker loading, Wasm MIME/compilation, and built-site byte equality/checksums. Test the packaged artifact independently of loose development files.
- Run library/website builds and type checks, repository lint/format/dead-code checks, appropriate unit/browser suites, and independent implementation critique. Existing verify scripts are authoritative.

## Completion record

- SDK: `3bc6d7513ae1cc0db82a4ccf6e70b5f107788be0`, [draft #1](https://github.com/opfs-vfs/wasmer-sdk/pull/1). Runtime: `68a240a5c22a8ad9cfb127a06f805a058339d9b7`, [draft #1](https://github.com/opfs-vfs/wasmer/pull/1), based on the SDK's tested `e53822d23a842b1d602356cd8151f742703fdb43` pin. Borrowed fixes retain authorship and source references; the new create-race correction is a separate commit.
- Static release: `0.2.0-opfs-vfs.1`. Wasm: 4,698,104 bytes; SHA-256 `ea3b15b1cf963e4aec7bf50313775e92b772c722755f300cbb5d923753efff12`. The installable archive's 67 files match the loose assets. Fresh npm installation of both SDK and OPFS VFS archives passes with the tested custom SDK prerelease explicitly allowed by the optional peer range. `build.json` records all asset hashes, the resolved build lockfile, guest hash, submodule revision and toolchain.
- Runtime: three race tests covering eleven scenarios and eleven existing filesystem tests pass. Reverting the race correction fails all three new tests. SDK default tests: 38/38. The original two upstream stream tests pass three runs each in both filesystem modes, also repeated against the independently extracted archive (12/12 in each host build check).
- `test:edgejs-live`: passes against the static release. On the combined DuckDB/EdgeJS branch, the regular library suite passes 569 tests, including six real-OPFS adapter cases; the optional DuckDB suite passes all ten engine tests. Four adapter guard mutations are detected in both buffer modes. Frozen install, builds, workspace type checks, lint, format, dead-code, package dry-run and release-plan checks pass.
- Website `test:edgejs`: 2/2 pass again after stacking and rebuilding, covering persistence, preview, another-tab lock, normal error recovery, bounded output, nested reset confinement, timeout/reopen, restored-page handling, all hosted hashes and Wasm compilation. Desktop and mobile screenshots were inspected. Website unit tests: 20/20; existing browser tests: 41/41.
- Design critiques and independent runtime/site implementation reviews completed; final verdicts were SHIP. Browser validation caught a dot-entry traversal error in the demo, corrected by using the existing `readdirNamesSync` API for listing and reset.
- The prior full upstream compatibility run remains unsuccessful: default filesystem 1,757 pass / 2,264 fail / 307 skip; synchronous native mounts 1,754 / 2,267 / 307. Its scope and limitations remain in the SDK draft. Focused regressions passing does not establish full Node compatibility.
- The demo still downloads the unchanged guest and dependencies from Wasmer's registry; guest networking is disabled. Chromium is the only validated browser. No release, deployment, merge or npm publication is performed.
