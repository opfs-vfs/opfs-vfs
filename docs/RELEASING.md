# Releasing

Changesets manages every public package in the workspace:

| Package                          | Directory                       |
| -------------------------------- | ------------------------------- |
| `@opfs-vfs/opfs-vfs`             | `packages/opfs-vfs`             |
| `@opfs-vfs/plugin-subscriptions` | `packages/plugin-subscriptions` |
| `@opfs-vfs/react`                | `packages/react`                |
| `@opfs-vfs/effect`               | `packages/effect`               |
| `@opfs-vfs/devtools`             | `packages/devtools`             |
| `@opfs-vfs/file-preview`         | `packages/file-preview`         |

The workspace root and website are private and are not published. All public packages use PolyForm Noncommercial License 1.0.0.

## Changesets and release notes

Run `pnpm changeset` for a user-facing package change. Select each affected package and its version bump, then commit the generated Markdown file with the change. Documentation-only and tooling-only changes do not require a package release.

Describe the behavior consumers receive, the problem it solves, and any required migration. Use separate Changesets when packages need different explanations. Avoid generic notes such as "update dependencies" when a compatibility requirement or behavior change can be named.

After a merge to `main`, `release.yml` runs all checks, including the full browser test suite. With pending Changesets it opens or updates a version PR containing version bumps, package changelogs, and the lockfile. Merging a feature PR does not publish immediately: merge the generated version PR to release its packages.

When `main` has no pending Changesets, the publish job runs `pnpm release`, which builds the workspace and calls `changeset publish` without a package filter. It publishes every public package whose version is not yet on npm. Unchanged, already-published versions are skipped. Adding a public workspace package does not require editing a publishing allowlist.

For each published package, the Changesets action pushes a `<package-name>@<version>` tag and creates a GitHub release using that version's entry in the package's `CHANGELOG.md`. Review the generated changelog in the version PR: its content becomes the GitHub release notes. Versions are independent; a release need not bump all six packages.

The version job uses GitHub's built-in token. Enable **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests**. Bot-created version PRs do not automatically trigger PR workflows with this token. Run the **CI** workflow manually on the `changeset-release/main` branch before merging a version PR. Publication always waits for another successful verification of the merged commit on `main`.

CI on this repository's `changeset-release/main` PRs and manual runs on that branch skips browser installation and tests. It still installs with a frozen lockfile, builds, checks types, lint, formatting and unused code, and validates package contents and any pending Changesets. Keep this branch for generated release changes; source changes added there receive their browser tests only after merging to `main`. All other PRs and every release run on `main` run the full suite.

## npm setup

Enable GitHub Actions for the repository. Publishing is automatic after successful verification on `main`; no `NPM_PUBLISH_ENABLED` variable is needed. Manual release runs also require `main`.

Configure an npm trusted publisher for **each public package**, including newly added packages:

- Organization: `opfs-vfs`
- Repository: `opfs-vfs`
- Workflow filename: `release.yml`
- Environment: leave empty, since this workflow does not declare one
- Allow direct publication with `npm publish`

The package's `repository.url` must point to `git+https://github.com/opfs-vfs/opfs-vfs.git`. Initial publication of a new package must happen through an authorized maintainer before configuring its trusted publisher. Existing packages do not need another manual publication.

The publish job uses a GitHub-hosted Ubuntu runner, the workspace-pinned pnpm 12.4.2, and `id-token: write` for npm OIDC authentication. Changesets selects pnpm for this workspace, and pnpm handles OIDC directly. It needs no stored npm publishing token. Verification and versioning continue to use Blacksmith. Only the publish job receives OIDC permission; write access to repository contents allows the action to create tags and releases through the GitHub API.

## Package verification and recovery

Before a release, inspect each affected package:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @opfs-vfs/effect pack --pack-destination /tmp/opfs-release-check
```

Substitute the affected package name. Inspect the tarball's version, exports, runtime files, README where included, repository metadata, and `LICENSE.md`. The root and packaged copies of the PolyForm license must match.

If publishing fails, inspect the Release workflow logs before retrying it with **Run workflow** on `main`. Check trusted publisher settings for the affected package and confirm whether any packages were published before the failure. Never overwrite or unpublish a released version to retry. If npm publication succeeded but a GitHub release is missing, check its tag and create the missing release from the corresponding package changelog; do not bump a version just to repair release notes.

## References

- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [Changesets automation](https://changesets.dev/guide/automating)

## Website release notes

The changelog page reads published, stable GitHub releases at build time and displays the latest version’s Changesets-generated Markdown notes, grouped by public workspace package with React and Effect first. Each package links to its full changelog for history without GitHub releases. Existing tags can be backfilled with the matching changelog entry; do not invent tags or dates for older untagged versions. The website date is the GitHub release publication date, including for backfilled releases. Maintainer review confirmed the existing core 2.0.0 upgrade notes; those notes remain in the full changelog without a retroactive tag.

After the publish action creates releases, `release.yml` calls `rebuild-website.yml`. It posts to the Vercel production deploy hook stored in the repository secret `VERCEL_DEPLOY_HOOK_URL`. Configure the hook for the website project's `main` branch under Vercel Settings → Git → Deploy Hooks. Treat its URL as a credential. The ordinary Git deployment can finish before publication; this additional build picks up the completed release notes.

The hook workflow only requests a deployment. Check Vercel for a successful production deployment and verify `/changelog/` before considering a refresh complete. To recover from a failed hook or website build, or after manually backfilling release notes, run **Rebuild website** on `main`. This works even with pending Changesets and does not republish packages.

GitHub API failures stop the website build, retaining the previous production deployment. Requests have a 15-second timeout. CI on main and publishing builds use their built-in GitHub token. Pull-request, Vercel, and local builds use the public API unless an optional read-only `GITHUB_TOKEN` is configured in the build environment; configure it if unauthenticated API quotas become a problem. No token is sent to the browser.
