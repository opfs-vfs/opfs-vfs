# OPFS VFS website

Local first draft of the marketing site, documentation, and interactive demos. The approved direction and sitemap are in [the website spec](../../.scratch/website/spec.md).

## Run locally

Use the repository’s pinned pnpm and Node.js 22.12 or newer:

```sh
pnpm install
pnpm --filter @opfs-vfs/opfs-vfs build
pnpm --filter @opfs-vfs/website dev
```

Open <http://localhost:4325>. For a production preview:

```sh
pnpm --filter @opfs-vfs/website build
pnpm --filter @opfs-vfs/website preview --host localhost
```

Astro can run its server in the background in agent environments. Use `pnpm --filter @opfs-vfs/website exec astro preview status` or `astro preview stop` to inspect or stop that project’s preview.

## Content

For repeatable measurements across devices and browsers, follow [the collection guide](../../docs/benchmark-collection.md).
`pnpm benchmark:collect` builds a production preview. Open `/benchmarks/collect/` in each actual browser and download one JSON bundle per run.

- Marketing pages: `src/pages` and `src/components/Hero.tsx`.
- Documentation: Markdown/MDX under `src/content/docs/docs`, rendered with Starlight search and GitHub edit links.
- Changelog: read directly from `packages/opfs-vfs/CHANGELOG.md` at build time. No duplicated release notes. Entries are versioned notes, not proof that a release has been published. The existing Changesets publish workflow already creates GitHub Releases; missed historical releases require explicit reconciliation.
- Published benchmark results remain empty until reviewed samples exist. The live PGlite suite compares OPFS VFS, OPFS AHP, IndexedDB, and memory, includes correctness checks, and exports raw samples with settings and versions. A separate native filesystem suite measures create/write/read/rename/delete/flush/reopen for memory and disk buffering. DuckDB remains follow-up work.

## Themes and controls

The header offers System, Light, and Dark themes. The choice is shared with Starlight docs, persists across reloads, and synchronizes open tabs. The editable shadcn Base UI components live in `src/components/ui`, with Base UI handling dropdown and dialog behavior. `src/styles/controls.css` maps Tailwind tokens to the light/dark colors in `src/styles/theme.css`. Native file pickers and the browser navigation warning remain platform controls. The explorer, shell, chat, and PGlite REPL follow the active theme without reopening their volumes.

Root `pnpm lint` applies `@shadcn/lint` only to website TSX: component consumers may use layout classes, but must use theme colors and non-arbitrary appearance values. UI internals may use structural arbitrary values and own their styling, while still using theme colors. It deliberately excludes runtime inline styles and handwritten semantic CSS; devtools uses plain CSS and is outside this scope.

## Storage and tabs

Demos use namespaced OPFS volumes on this origin. The filesystem and AI explorers share their volume with their shell/chat within each demo; database storage uses separate volumes. Browser storage is not a backup.

Filesystem export/import uses a ZIP of logical files and directories, with path and size validation. PGlite uses its native compressed data-directory archive. These formats are intentionally distinct. Imported data creates a new volume. A reset cannot delete a volume still mounted by another tab; close that tab’s volume first. Filesystem operations use the library’s worker leader/follower protocol plus cross-tab operation locks. PGlite uses its official worker leader election and REPL.

HTML and DOCX previews are sandboxed with restricted network access. Markdown does not load remote images. PDF previews render the first page; spreadsheet previews show bounded worksheet data. Unsupported binary files have a bounded hex preview. The interactive shell operates only on its virtual filesystem.

## Local AI

Gemma 4 E2B uses the existing bash-console MediaPipe runtime, with an explicitly requested 2.00 GB download. The model artifact is pinned by revision, length, and SHA-256. Its native OPFS cache is separate from user volumes; no model is fetched automatically.

A compatible WebGPU adapter with shader-f16, cross-origin isolation, and several GB of available storage/memory is required. The model can create, edit, overwrite, append, copy, rename, move and delete files and folders within the selected virtual volume. Direct text writes are literal; the just-bash browser interpreter supports its full file-command set, pipes and compound commands. Deletion is permanent. Host files, network access, Python and JavaScript execution are not attached. The host bounds command sizes, outputs, execution time and the 12-step conversation, and stops consecutive repeated calls. Model instructions alone do not enforce these constraints. Qwen is not integrated.

Build/dev copies installed MediaPipe WASM assets and bundles its classic worker into ignored `public/ai-assets/`. These generated files must be present in deployment output. End-to-end model inference needs manual validation on a compatible GPU; automated checks exercise tool validation without downloading the model.

## Checks

```sh
pnpm --filter @opfs-vfs/website exec playwright install chromium
pnpm --filter @opfs-vfs/website build
pnpm --filter @opfs-vfs/website typecheck
pnpm --filter @opfs-vfs/website test
pnpm --filter @opfs-vfs/website test:benchmark-dev
pnpm lint
pnpm fmt:check
pnpm deadcode
```

The separate `test:benchmark-dev` check starts a fresh dependency cache on port 4337 and verifies that the first benchmark completes without a dev-server reload.

Browser tests run against a production preview on port 4325 with real OPFS. Each test context owns disposable storage. The full Chromium suite checks the four SQL backends, native workloads, storage lifecycles, previews, multi-tab handoff, responsive routes, and AI setup without a model download. Browser-specific validation limits are recorded below.

## Hosting on Vercel

The separate `opfs-vfs` project in `bastians-projects-7056af61` serves `https://opfs.dev`. `opfs-vfs.dev` redirects to the same path on `opfs.dev`.

Use Node.js 24 and Root Directory `apps/website`, with files outside the root included. Keep the Other framework preset; Astro builds the static `dist` output. Keep the whole monorepo in the build context: the website uses workspace packages and root pnpm patches. `vercel.json` builds those dependencies before Astro, including the generated AI assets. The pinned package manager is selected through Corepack with Vercel's `ENABLE_EXPERIMENTAL_COREPACK=1` build variable.

The website has no application-level access gate. Check Vercel's separate Deployment Protection setting before launch; this repository does not control it. Existing deployments retain their original configuration, so deploy this revision to remove the old gate from the current site.

The production branch is temporarily `codex/vercel-deployment`, which includes the complete PR stack. Change it to `main` after the stack is merged. This does not require merging the stack for the first deployment.

Vercel adds `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` to all routes, matching local dev and preview. Worker and WASM files stay on the same origin.

After deployment, verify unauthenticated access to HTML, JavaScript, WASM, and `/robots.txt`. Start a demo worker in a browser and verify `crossOriginIsolated`.

Spreadsheet previews use SheetJS 0.20.3 from the [official distribution](https://docs.sheetjs.com/docs/getting-started/installation/frameworks/); the npm `xlsx` endpoint is obsolete. The lockfile pins the tarball integrity.

## Pinned dependency fixes

Two small pnpm patches fix lifecycle races in the pinned PGlite releases: the worker client stops its leader probe once closed, and the REPL defers style extraction until its CodeMirror element exists. These patches fix the causes rather than suppressing browser errors. Recheck them when upgrading PGlite or its REPL. Browser tests cover queries and reopen/handoff.

## Reused source

The owner requested reuse of the refined explorer, preview, shell, AI runtime, and benchmark patterns from `frachter-app/opfs-vfs`, inspected at commit `4d881496`. The website uses Pierre Trees, just-bash, and the public OPFS VFS adapters. Focused Gemma runtime files retain provenance headers; no premium/encryption functionality is included.

Select an installed browser with `PLAYWRIGHT_BROWSER=firefox` or `PLAYWRIGHT_BROWSER=webkit` when running Playwright. On this machine, Firefox passes the filesystem, multi-tab, native benchmark, marketing, mobile, and AI setup checks. The installed Playwright WebKit fails a minimal native OPFS probe without this library (`UnknownError`), so its storage checks do not establish Safari compatibility. Validate the final site in actual Safari before publishing cross-browser performance claims.

### AI model setup

The AI dashboard opens after Gemma is ready. A first visit requires an explicit model download; a verified download loads automatically, including on later visits. Setup, cancellation, and retry occupy the full dashboard. The model runtime stays mounted when switching workspace volumes.

The MediaPipe prompt uses the Gemma 4 system/user/model turn format. Model tool requests are parsed before rendering and validated independently of the system prompt. Malformed requests get bounded correction attempts; raw tool JSON and thought channels are not chat answers. Run `node --experimental-strip-types --test tests/ai-response.test.ts tests/ai-tools.test.ts` from this app to check the reported response and command restrictions.

## Website content and discovery

The [copy map](../../docs/website-copy-map.md) records the pre-edit route purposes and text sources. Product motivation lives at `/motivation/`; backend and durability guidance stays at `/benchmarks/storage/`. The old `#motivation` anchor links to the new page.

`/sitemap/` lists product pages and derives documentation entries from the content collection. Astro's sitemap integration generates `/sitemap-index.xml` and its child sitemap. The internal hero study and embedded explorer are excluded and marked `noindex`. `/robots.txt` points crawlers to the XML index.

`public/llms.txt` is the curated LLM guide. `/llm.txt` serves the same source for the requested alternate spelling. Update the guide and human sitemap when adding product pages; documentation entries and XML routes are generated. Run the discovery browser test after building to check route coverage, canonical URLs, exclusions, and links.
