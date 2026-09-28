# Releasing

The public package is `@opfs-vfs/opfs-vfs`. The next release is version 2.0.0 under PolyForm Noncommercial License 1.0.0. The workspace root and future demos and benchmarks remain private.

## Changesets

Run `pnpm changeset` for a user-facing change, select the library and its version bump, and commit the generated Markdown file. Documentation-only and tooling-only changes do not require a package release.

After a merge to `main`, `release.yml` runs all checks, including the full browser test suite. With pending changesets it opens or updates a version PR, including the changelog and lockfile. Without pending changesets it can publish unpublished versions, but only when the repository variable `NPM_PUBLISH_ENABLED` is exactly `true`. Leaving the variable unset disables the entire publish job. Manual release runs also require `main`.

The version job uses GitHub's built-in token. Enable **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests**. Bot-created version PRs do not automatically trigger PR workflows with this token. Run the **CI** workflow manually on the `changeset-release/main` branch before merging a version PR. Publication always waits for another successful verification of the merged commit on `main`.

CI on this repository's `changeset-release/main` PRs and manual runs on that branch skips browser installation and tests. It still installs with a frozen lockfile, builds, checks types, lint, formatting and unused code, and validates package contents and any pending changesets. Keep this branch for generated release changes; any source changes added there receive their browser tests only after merging to `main`. All other PRs and every release run on `main` run the full suite.

## Package verification

The version PR has assigned 2.0.0. Publish only after the release candidate is verified. Do not overwrite published artifacts.

Before publishing, confirm rights in included contributions and review the noncommercial terms and any planned commercial agreement with software-licensing counsel.

After the version PR merges, build and inspect the release candidate:

```sh
pnpm install --frozen-lockfile
pnpm build
cd packages/opfs-vfs
npm pack --dry-run
npm pack
```

Inspect the tarball's package version, `license` metadata, README, and `LICENSE.md`. The root and packaged copies of the PolyForm license must match. The metadata is `PolyForm-Noncommercial-1.0.0`.

Publication remains gated by `NPM_PUBLISH_ENABLED=true`, successful verification on `main`, npm publishing rights and a configured trusted publisher. Do not enable publication as part of a license-only edit. GitHub Actions trusted publishing uses organization `opfs-vfs`, repository `opfs-vfs`, workflow `release.yml`, and direct-publication permission.

Both workflows use GitHub-hosted runners. The release workflow grants OIDC permission only to the publish job. Repository visibility and publishing are separate owner actions.

## References

- [npm organizations](https://docs.npmjs.com/creating-an-organization/)
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [Changesets automation](https://changesets.dev/guide/automating)
