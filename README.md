# OPFS VFS

A browser filesystem backed by the Origin Private File System, with POSIX-style file operations, write-ahead logging, crash recovery, and shared worker transport.

This pnpm workspace contains the [opfs-vfs library](packages/opfs-vfs/README.md), its browser tests, and optional PGlite and just-bash adapters. Ordinary filesystem use has no runtime dependencies.

New mounts default to disk buffering and balanced background synchronization. See [storage defaults](docs/API.md#storage-defaults) for save boundaries and switching buffer modes.

## Packages

| Directory                       | Package                          | Contents                                    |
| ------------------------------- | -------------------------------- | ------------------------------------------- |
| `packages/opfs-vfs`             | `@opfs-vfs/opfs-vfs`             | Library and browser tests                   |
| `packages/plugin-subscriptions` | `@opfs-vfs/plugin-subscriptions` | Bounded file-change notifications           |
| `apps/website`                  | `@opfs-vfs/website`              | Marketing, docs, demos, and live benchmarks |

The private website consumes the library through `workspace:*` and its public exports. See [website development](apps/website/README.md) to run it locally. The [experimental DuckDB adapter](docs/DUCKDB.md) persists analytics databases through OPFS VFS using separately built, compatible DuckDB-Wasm assets.

## Development

Use Node.js 22.12 or newer and the pnpm version pinned in `package.json`.

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

Run `pnpm fmt` to format files and `pnpm duplicates` for an advisory duplication report. See [development](docs/DEVELOPMENT.md) for package commands and [API](docs/API.md) for the library exports.

## License

This working tree uses the source-available [PolyForm Noncommercial License 1.0.0](LICENSE.md). It permits noncommercial use, modification, and distribution. Commercial use requires separate permission from the copyright holder. The license is not OSI-approved open source.

See the [subscriptions package](packages/plugin-subscriptions/README.md) and [subscriptions API](docs/SUBSCRIPTIONS.md) for optional live file-change notifications.
