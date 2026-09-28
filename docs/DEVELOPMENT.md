# Development

Use Node.js 22.12 or newer and pnpm 12.4.2, pinned in the root `package.json`. Install that version with `npm install --global pnpm@12.4.2` if needed.

```sh
pnpm install
pnpm --filter @opfs-vfs/opfs-vfs exec playwright install chromium
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm fmt:check
pnpm deadcode
```

The root commands run across the workspace. `pnpm build` builds packages in dependency order. TypeScript 7 checks types and emits library declarations after Vite bundles the JavaScript. Oxlint performs type-aware linting, with test exceptions for unbound mock assertions and worker log stringification. Oxfmt formats the repository, and Fallow checks for unused code and dependencies. `pnpm duplicates` reports duplication separately.

Build before checking consumers that resolve workspace dependencies through their `dist` exports. Each package owns its runtime dependencies and build/test tools; common TypeScript, lint, formatting, and Fallow tools live at the root.

## Library

```sh
pnpm --filter @opfs-vfs/opfs-vfs build
pnpm --filter @opfs-vfs/opfs-vfs typecheck
pnpm --filter @opfs-vfs/opfs-vfs test
cd packages/opfs-vfs
npm pack --dry-run
```

Normal builds and CI do not compile DuckDB. The website serves a checked-in prebuilt engine as static files. Its optional persistence suite runs separately with `pnpm --filter @opfs-vfs/opfs-vfs test:duckdb` after linking the checked-in assets or a compatible external build. See [DuckDB integration testing](DUCKDB.md).

The browser tests use local OPFS storage with cross-origin isolation headers supplied by the test server. `PLAYWRIGHT_EXECUTABLE_PATH` can select an already installed Chromium executable. Demo and benchmark servers must also serve `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` for SharedArrayBuffer.

`pnpm --filter @opfs-vfs/opfs-vfs test:edgejs` runs the separate upstream EdgeJS persistence probe. It requires network access to the Wasmer registry, downloads `wasmer/edgejs@0.2.0`, and uses the unmodified `@wasmer/sdk@0.14.0` package. Ordinary adapter tests run with the regular suite without a registry download.

Fallow treats `@opfs-vfs/opfs-vfs` as a public package so exports intended for external consumers stay live even when no local demo imports them. The just-bash adapter and core deliberately export different `MkdirOptions` types from separate entry points; a named Fallow exception preserves that API. Review findings before deleting code, particularly worker entry points and Vite query imports.

## Website, demos, and benchmarks

The Astro website lives in `apps/website`. Build the library, then run `pnpm --filter @opfs-vfs/website dev` and open `http://localhost:4325`. Its filesystem, AI, PGlite, and benchmark routes share the public package exports. Editable documentation uses Astro Starlight and Markdown in `apps/website/src/content/docs/docs`.

See [the website guide](../apps/website/README.md) for browser tests, storage lifecycle, model requirements, and hosting headers. The [DuckDB adapter guide](DUCKDB.md) links to the external build instructions and covers the browser worker example and optional persistence tests.

## Releases

Run `pnpm changeset` for user-facing library changes and commit the generated file with the change. Keep the workspace root, demos, and benchmarks private. The [release guide](RELEASING.md) covers version PRs, first publication, and the npm publishing gate.

The npm package contains `dist`, package metadata, README, and the PolyForm Noncommercial license. Keep root and package license copies identical. Use the `PolyForm-Noncommercial-1.0.0` SPDX identifier in package metadata and preserve third-party notices.
