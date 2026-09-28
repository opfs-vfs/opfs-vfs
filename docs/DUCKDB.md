# Experimental DuckDB adapter

`@opfs-vfs/opfs-vfs/duckdb` exports `createDuckDBRuntime(vfs)`, a synchronous filesystem adapter for DuckDB-Wasm. Database and WAL files use the mounted OPFS VFS volume. SQL runs inside a dedicated browser worker.

Use the prebuilt assets or build the engine in a separate DuckDB-Wasm checkout using the [adapter download, build, and usage guide](../apps/website/src/content/docs/docs/integrations/duckdb.md). It pins the compatible fork revision and toolchain, explains how to produce matching browser JavaScript/Wasm assets, and shows the runtime setup. The website hosts a versioned prebuilt JavaScript/Wasm pair; neither the repository nor its CI compiles DuckDB. Stock DuckDB-Wasm is not compatible with this adapter.

## Select assets for the example and tests

The compatible prebuilt assets are committed under `apps/website/public/vendor/duckdb/1.33.1-dev64.0-opfs-vfs.1/`. The website serves them at `/vendor/duckdb/1.33.1-dev64.0-opfs-vfs.1/`. From the repository root, link that directory into the optional test and example input path:

```sh
ln -s ../../apps/website/public/vendor/duckdb/1.33.1-dev64.0-opfs-vfs.1 packages/opfs-vfs/.duckdb
```

To test your own external build instead, use its absolute output path as the symlink target. The ignored `.duckdb` path is an input for the example and optional tests. It must contain `duckdb.js` and `duckdb.wasm` from the same build. You may copy the output directory here instead if symlinks are unavailable. If `.duckdb` already exists, move it aside before linking the new assets.

## Run the browser example

```sh
pnpm install --frozen-lockfile
pnpm --filter @opfs-vfs/opfs-vfs build
pnpm --filter @opfs-vfs/opfs-vfs exec vite ../../examples/duckdb --host localhost --port 5178
```

Visit `http://localhost:5178`. Reloading reopens the same database and increments its visit count. The [worker example](../examples/duckdb/worker.ts) uses the public adapter and the selected prebuilt engine. It serves the isolation headers required by OPFS VFS.

## Run persistence tests explicitly

The standard `pnpm test` suite and CI do not require DuckDB engine assets. Run its separate integration suite after linking the prebuilt assets or your own build:

```sh
pnpm --filter @opfs-vfs/opfs-vfs exec playwright install chromium
pnpm --filter @opfs-vfs/opfs-vfs test:duckdb
```

This runs all ten DuckDB persistence and failure-recovery tests. The command fails if assets are missing or incompatible; it does not build an engine or silently skip tests. Run it after changing the adapter or external engine. `PLAYWRIGHT_EXECUTABLE_PATH` can select an existing Chromium executable.
