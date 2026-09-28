---
title: EdgeJS
description: Set up experimental EdgeJS file access with a compatible custom Wasmer host.
---

The experimental `@opfs-vfs/opfs-vfs/wasmer-sync` export connects EdgeJS filesystem operations to OPFS VFS while your program is running. Files live in your browser's named volume and can be reopened later. [Try the EdgeJS demo](/demos/edgejs/).

Use the compatible Wasmer SDK build below. The official `wasmer/edgejs@0.2.0` guest is unchanged. The custom code is in the Wasmer SDK and runtime, whose published builds do not yet provide this complete integration. The existing `/wasmer` adapter remains an alternative for explicit copy-in/copy-out workspaces with the stock SDK.

## Download the compatible host

Asset release `0.2.0-opfs-vfs.1` contains one matching SDK build:

- [Installable SDK package](/vendor/edgejs/0.2.0-opfs-vfs.1/wasmer-sdk-0.14.0-opfs-vfs.1.tgz).
- [Browser entry point](/vendor/edgejs/0.2.0-opfs-vfs.1/sdk/dist/index.js) and [WebAssembly module](/vendor/edgejs/0.2.0-opfs-vfs.1/sdk/pkg/wasmer_sdk_js_bg.wasm).
- [Build provenance and SHA-256 checksums](/vendor/edgejs/0.2.0-opfs-vfs.1/build.json).
- [SDK license](/vendor/edgejs/0.2.0-opfs-vfs.1/sdk/LICENSE) and [third-party notices](/vendor/edgejs/0.2.0-opfs-vfs.1/sdk/THIRD_PARTY_NOTICES.txt).

Download and install the package archive in your application:

```sh
npm install ./wasmer-sdk-0.14.0-opfs-vfs.1.tgz @opfs-vfs/opfs-vfs
```

The archive contains the complete `dist/` and `pkg/` trees, including worker modules and declarations. Copy both directories together into your application's public SDK directory, preserving all relative paths. For example, copying them under `public/wasmer/` makes the browser entry `/wasmer/dist/index.js`. Copy the license and notices alongside them. A standalone Wasm file or entry-point JavaScript file is insufficient.

These are custom host assets, separate from the OPFS VFS npm package. Do not mix them with files from a stock SDK. The website serves the SDK statically; the unchanged EdgeJS guest and its package dependencies are downloaded from Wasmer's registry on first use. This is not an offline demo. Guest networking is independently disabled in the example below.

## Build from the forks

The build uses the [SDK fork PR](https://github.com/opfs-vfs/wasmer-sdk/pull/1), [commit `3bc6d7513ae1cc0db82a4ccf6e70b5f107788be0`](https://github.com/opfs-vfs/wasmer-sdk/commit/3bc6d7513ae1cc0db82a4ccf6e70b5f107788be0), and the [runtime integration PR](https://github.com/opfs-vfs/wasmer/pull/1), [commit `68a240a5c22a8ad9cfb127a06f805a058339d9b7`](https://github.com/opfs-vfs/wasmer/commit/68a240a5c22a8ad9cfb127a06f805a058339d9b7). The runtime draft uses the SDK's pinned runtime as its base; its final commit isolates the new concurrent-create fix for later upstream submission. The downloadable provenance records both commits and the exact guest hash. Arbitrary fork branch tips or upstream releases are not claimed compatible.

Build in separate checkouts outside OPFS VFS. You need Git, Node.js and npm, Rustup, and several GB of disk space. The tested compiler is Rust `nightly-2026-09-17`, with `wasm-bindgen-cli 0.2.126`. The CLI version must match the SDK's Rust lockfile.

```sh
set -eu
git clone https://github.com/opfs-vfs/wasmer.git wasmer-opfs
git -C wasmer-opfs checkout --detach 68a240a5c22a8ad9cfb127a06f805a058339d9b7
git -C wasmer-opfs submodule update --init --recursive lib/napi
export WASMER_REPO="$(cd wasmer-opfs && pwd)"

git clone https://github.com/opfs-vfs/wasmer-sdk.git wasmer-sdk-opfs
cd wasmer-sdk-opfs
git checkout --detach 3bc6d7513ae1cc0db82a4ccf6e70b5f107788be0

rustup toolchain install nightly-2026-09-17 --profile minimal --component rust-src --target wasm32-unknown-unknown
cargo install --locked wasm-bindgen-cli --version 0.2.126
export WASMER_RUST_TOOLCHAIN=nightly-2026-09-17
cd js
npm ci
npm run build
npm version 0.14.0-opfs-vfs.1 --no-git-tag-version
npm pack --ignore-scripts
```

`WASMER_REPO` selects the local runtime through the SDK's existing build support. Without it, the SDK uses its original runtime pin and misses required fixes. Compilation stays in these external repositories; neither the OPFS VFS website build nor its normal CI compiles Wasmer. Preserve third-party notices when redistributing your build. Checksums identify the tested download; they do not promise identical output on every build machine.

## Connect EdgeJS to OPFS VFS

Serve HTTPS or localhost with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. Use a recent Chromium browser with WebAssembly JSPI and SharedArrayBuffer support. Serve Wasm with `application/wasm`. Create the VFS and SDK in the same dedicated owner worker; the SDK creates its guest workers separately.

This example assumes the downloaded SDK's `dist/` and `pkg/` are served under `/wasmer/`. Bundle the worker with your application so its OPFS VFS import resolves.

```ts
import { OpfsVfs } from '@opfs-vfs/opfs-vfs';
import { createWasmerFileSystem } from '@opfs-vfs/opfs-vfs/wasmer-sync';

const sdkUrl = new URL('/wasmer/dist/index.js', self.location.origin).href;
const { Wasmer, SYNC_FILESYSTEM_ABI } = await import(/* @vite-ignore */ sdkUrl);
if (SYNC_FILESYSTEM_ABI !== 1) throw new Error('Use the compatible Wasmer host build');

const vfs = new OpfsVfs('edgejs-files.bin', { bufferMode: 'disk' });
await vfs.ready;
const wasmer = new Wasmer();
const guest = await wasmer.packages.load('wasmer/edgejs@0.2.0');
const sandbox = await wasmer.sandboxes.create({
  packages: [guest],
  network: { mode: 'disabled' },
  syncMounts: [{ path: '/data', fs: createWasmerFileSystem(vfs) }],
});
const result = await sandbox
  .command(guest, [
    '-e',
    `
  const fs = require('node:fs');
  const path = '/data/counter.txt';
  const count = fs.existsSync(path) ? Number(fs.readFileSync(path, 'utf8')) : 0;
  fs.writeFileSync(path, String(count + 1));
  console.log('Counter:', count + 1);
`,
  ])
  .run({ check: false, timeoutMs: 15000, outputBytes: 65536 });

if (result.reason !== 'exited') {
  // Keep this owner unavailable until it is torn down. Do not inspect/reset
  // storage or retry a write whose completion is uncertain.
  throw new Error('Execution was interrupted. Reopen in a fresh owner worker.');
}
console.log(result.stdout.text(), result.stderr.text());
await sandbox.close();
await wasmer.close();
vfs.syncSync();
await vfs.closeVfs();
```

The worker must catch rejected execution and report it to its caller. A timeout, bridge failure, or uncertain spawn/wait rejection must disable further operations; do not use an unconditional `finally` that closes storage while a guest may still use it. After the owner is torn down and its volume lock is released, a fresh worker can reopen the volume. An interrupted program may have made partial changes. Ordinary completed nonzero exits can be reported and closed normally.

The ABI marker checks the callback contract. It does not prove runtime compatibility; use the matching pinned build. Paths supplied to the adapter are relative to its mount root. The guest sees `/data`, while OPFS VFS sees `/`. This live adapter does not copy the volume into `sandbox.fs`.

## Persistence and limits

Await `vfs.ready` before mounting. Finish guest execution and close its sandbox before closing the SDK or volume. Call `fsyncSync`, `syncSync`, or orderly `closeVfs` at save boundaries. A successful write or file close alone is not a volume checkpoint. Reloading during execution is an abrupt interruption.

Use one owner for each volume. Another tab cannot simultaneously mount the same named volume. The adapter handles ordinary files/directories, binary I/O, append, truncation, rename, live descriptor sizes, and error propagation. It rejects symlinks, hard links, and unsupported file kinds. Arbitrary namespace changes outside the adapter while guest descriptors remain open are unsupported; it refuses an unsafe descriptor unlink instead of deleting a replacement file.

This integration is experimental. Only Chromium has been validated. The full SDK-hosted upstream EdgeJS compatibility run did not pass in either filesystem configuration; this guide makes no claim of full Node.js compatibility. Permissions, very large files, multiple simultaneous guests, and other browsers need further validation. The demo caps program time, captured output, storage, and file previews.

## Validate and upgrade

The repository's `docs/EDGEJS.md` describes the optional `test:edgejs-live` suite and demo checks against these exact static assets. The older `test:edgejs` command tests the stock SDK snapshot adapter. They verify different integrations.

Runtime dependencies include upstream [#6940](https://github.com/wasmerio/wasmer/pull/6940) for live descriptor sizes, the metadata/readlink error-propagation portions of [#6731](https://github.com/wasmerio/wasmer/pull/6731), and the separately committed concurrent-create fix in our runtime fork. The integration preserves attribution for existing upstream work.

Keep each tested release at its own immutable asset path. Validate a new host against the adapter, browser demo, and runtime regressions before updating the guide. Switch to official packages only after upstream releases contain the required behavior and pass those checks.
