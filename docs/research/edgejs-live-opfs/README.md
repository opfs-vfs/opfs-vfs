# Live OPFS mount verification

Verified on 2026-09-21 in Chromium 147.0.7727.15 with Playwright 1.59.1. The official `wasmer/edgejs@0.2.0` guest runs unchanged against a custom Wasmer browser host. This is an experimental proof, not the shipped snapshot adapter or a production integration.

## Result

[Recorded browser results](results.json) show both guest runs exiting successfully. The [runnable probe](probe.ts) checks:

- Without a mount, EdgeJS cannot read the OPFS input. Invalid, duplicate and reserved mount paths are rejected.
- With `/opfs` mounted, EdgeJS reads an OPFS seed and writes a result visible to the host while the guest is still running.
- The host then changes the input from 4 to 19 bytes. EdgeJS reads the new contents through its existing descriptor and `fstatSync` reports 19 bytes.
- A 150,000-byte binary round trip, append, truncation, directory listing, rename and deletion succeed. Append is checked before truncation.
- Missing files report `ENOENT`; an injected metadata failure reports `EIO`.
- After the guest exits, sandbox cleanup leaves zero provider descriptors. The volume is closed, reopened, mounted in a fresh Wasmer runtime, and read by a fresh EdgeJS process. The changed contents and deletion persist.

No OPFS files are copied into `sandbox.fs` or copied back. Only the test program is placed in Wasmer's `/workspace`. All mounted filesystem operations go through synchronous callbacks to the owner worker, which holds the actual OPFS `SyncAccessHandle`s in disk mode.

## What had to change

The [SDK patch](wasmer-sdk.patch) exposes `SandboxOptions.syncMounts`, applies synchronous mounts in browser builds, and bridges worker calls to an owner-local JavaScript filesystem. Rust objects carry numeric registry IDs, not JavaScript objects shared between workers. Callback exceptions preserve POSIX error codes. The transport uses bounded shared-memory requests and closes leaked descriptors after execution stops.

The [runtime patch](wasmer-runtime.patch) fixes two problems found by the real test:

1. `fd_filestat_get` returned cached inode metadata. The first live run read the new 19-byte content but reported the old 4-byte size. The patch refreshes metadata through the already-checked open descriptor.
2. Path lookup discarded every metadata error and returned `ENOENT`. The injected I/O error therefore initially failed its assertion. The patch preserves the underlying error, including the adjacent readlink lookup.

This requires changes in both `wasmerio/wasmer-sdk` and `wasmerio/wasmer`, so upstreaming would naturally involve coordinated PRs. No EdgeJS source or guest artifact changes are required. Building only new JavaScript bindings is insufficient.

## Reproduce

Inputs:

| Input                   | Pin                                                                  |
| ----------------------- | -------------------------------------------------------------------- |
| Wasmer SDK              | `9ca7da8a3b34c4073a068231cc89b4a8416084b2` (`wasmer-sdk-js-v0.14.0`) |
| Wasmer runtime          | `f9b88e70b3822779ccb79d97134296b5120f3818`                           |
| Runtime N-API submodule | `38834f059fea9df3585e2d76d31c255fa13f5dc9`                           |
| Rust                    | `nightly-2026-09-17`                                                 |
| wasm-bindgen CLI        | `0.2.126`                                                            |
| Guest                   | `wasmer/edgejs@0.2.0`                                                |

From this repository, choose temporary checkout directories. The recipe assumes Node.js, npm, Rustup, Git, and the repository's normal pnpm dependencies are installed. The build downloads Rust dependencies and the test fetches the guest from Wasmer's registry.

```sh
export PROOF_DIR="$PWD/docs/research/edgejs-live-opfs"
export WASMER_SDK_DIR="$(mktemp -d)/wasmer-sdk"
export WASMER_REPO="$(mktemp -d)/wasmer"

git clone --branch wasmer-sdk-js-v0.14.0 --depth 1 https://github.com/wasmerio/wasmer-sdk.git "$WASMER_SDK_DIR"
git -C "$WASMER_SDK_DIR" checkout 9ca7da8a3b34c4073a068231cc89b4a8416084b2
git clone https://github.com/wasmerio/wasmer.git "$WASMER_REPO"
git -C "$WASMER_REPO" checkout f9b88e70b3822779ccb79d97134296b5120f3818
git -C "$WASMER_REPO" submodule update --init lib/napi

git -C "$WASMER_SDK_DIR" apply "$PROOF_DIR/wasmer-sdk.patch"
git -C "$WASMER_REPO" apply "$PROOF_DIR/wasmer-runtime.patch"

rustup toolchain install nightly-2026-09-17 --profile minimal --component rust-src --target wasm32-unknown-unknown
cargo install --locked wasm-bindgen-cli --version 0.2.126
npm --prefix "$WASMER_SDK_DIR/js" ci
npm --prefix "$WASMER_SDK_DIR/js" run build:wasm
npm --prefix "$WASMER_SDK_DIR/js" run build:ts

pnpm --filter @opfs-vfs/opfs-vfs exec playwright install chromium
node "$PROOF_DIR/check-sync-fs.mjs"
node "$PROOF_DIR/check-sync-timeout.mjs"
node "$PROOF_DIR/verify.mjs"
```

`WASMER_REPO` selects the pinned local runtime through the SDK's existing build support. The SDK patch pins its nightly invocation. The CLI version must match the Rust lockfile; it can alternatively be installed from the official platform binary. On the verification machine, the optimized custom Wasm artifact had SHA-256 `24d62a69baabc08072409530811a4b55d94dcaaa6c53adca4b6d630f910b0172`. This records the tested artifact, not a claim of cross-platform byte-for-byte reproducibility.

The browser driver uses port 4337, supplies COOP/COEP headers, launches Chromium, and shuts down its browser and server. It exits nonzero for missing success, guest failures, page errors or incomplete cleanup. It overwrites `results.json`. The timeout transport check takes approximately 30 seconds.

## Limits before shipping

This proves ordinary file and directory operations in one Chromium owner-worker topology. Networking is disabled. Symlinks, hard links, permission fidelity, multiple simultaneous guests, other browsers, performance and closing a sandbox during active execution are not established. Stop and await guest execution before closing the mount or OPFS volume.

Directory RPC replies are capped at 4 MiB and read/write chunks at 64 KiB. Calls time out after 30 seconds. A timed-out mutation that already started has an uncertain outcome; its bridge fails closed and must not be retried. The underlying runtime's scalar metadata accessors cannot return errors, which remains a contract limitation.

The OPFS adapter in the probe tracks file paths for unlinking open handles. It is sufficient for this experiment's rename/delete sequence; arbitrary external renames, hard-linked aliases and production lifecycle handling need a dedicated adapter contract review. The retained patches are reviewable prototype source, not proposed final upstream API design.

No website integration, package publication, repository fork or upstream PR was performed as part of this verification. Custom-build documentation can be retired once upstream releases include the required host API and runtime behavior, and the adapter passes this probe against those releases. A PR merge alone does not update published artifacts.
