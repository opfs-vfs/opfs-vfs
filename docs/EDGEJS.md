# Experimental live EdgeJS integration

The [website guide](../apps/website/src/content/docs/docs/integrations/edgejs.md) is the download/build/application recipe. The [specification](EDGEJS-SPEC.md) records acceptance criteria. `createWasmerFileSystem` in `@opfs-vfs/opfs-vfs/wasmer-sync` implements live callbacks; the existing `/wasmer` export remains a snapshot adapter.

Prepared SDK assets live under `apps/website/public/vendor/edgejs/0.2.0-opfs-vfs.1/`. Ordinary library and website builds consume those files without compiling Rust or fetching a compiler. The guest package is unchanged and fetched from Wasmer's registry, so the live test and demo need network access on first use. Guest code itself runs with networking disabled.

## Run the integration checks

```sh
pnpm install --frozen-lockfile
pnpm --filter @opfs-vfs/opfs-vfs build
pnpm --filter @opfs-vfs/opfs-vfs exec playwright install chromium
pnpm --filter @opfs-vfs/opfs-vfs test:edgejs-live
```

This explicitly selected browser suite tests the public live adapter against the prepared SDK files. It covers bidirectional live edits, fresh descriptor sizes, binary data, append/truncate/rename/delete, injected I/O errors, concurrent file creation, exclusive creation, descriptor cleanup, and persistence through a new VFS and SDK runtime. Missing or incompatible assets fail the suite.

The regular library suite covers adapter semantics without requiring EdgeJS artifacts. The separate `test:edgejs` command continues to exercise the stock SDK's snapshot integration. SDK-owned tests and the full upstream compatibility suite are different checks and must not be represented as this suite.

## Run the website demo

```sh
pnpm --filter @opfs-vfs/website build
pnpm --filter @opfs-vfs/website preview --host localhost
```

Open `http://localhost:4325/demos/edgejs/`. Run the counter, reload, and run again; inspect `counter.txt`, try a program error, then reset the demo. The volume is named `opfs-vfs-website-edgejs.bin`. Reset affects only that volume's files. Completed runs synchronize storage; interrupted execution requires a fresh owner.

Run `pnpm --filter @opfs-vfs/website test:edgejs` after building for the automated browser flow and all hosted-asset checksum checks. This optional suite starts its own static preview on port 4339 and needs registry access on first use.

## Release evidence

The static release includes `build.json`, SDK license, third-party notices, and a matching installable archive. Every listed asset has a SHA-256 checksum. The exact fork pins are in the website guide and manifest. Preserve relative SDK paths when copying or packaging assets. The previous full upstream compatibility report remains evidence of wider limitations, not a passing conformance result.

The [SDK draft](https://github.com/opfs-vfs/wasmer-sdk/pull/1) preserves the full-run totals and launcher limitations. The [runtime draft](https://github.com/opfs-vfs/wasmer/pull/1) records the isolated concurrent-create correction and regression tests. The final targeted stream-test replays pass in both modes; the full multi-thousand-case suite has not been rerun or declared passing.
