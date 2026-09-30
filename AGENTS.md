# AGENTS.md

## Website SEO surface (`apps/website`)

**Trigger.** Any change to page titles, descriptions, headings, hero or body copy, routes, docs pages (added, renamed, moved, removed), sidebar, logo, or social image.

**Steps.** Walk every surface below. For each one, decide whether the change alters what that surface states, then update it or record why it stays. Done means no surface is unaccounted for.

| Surface | Where it lives | Update when |
|---|---|---|
| Title and description | `SiteLayout` props on marketing pages, frontmatter on docs. Format `<Page> · OPFS VFS`, title ≤60 characters including suffix, description ≤160, unique per page. Homepage: `src/pages/index.astro`. | Copy or purpose of a page changes. |
| Hero summary | `src/components/Hero.tsx`. Names the Origin Private File System, matching the homepage description. | Homepage description changes. |
| HTML sitemap | `src/pages/sitemap.astro`. Marketing entries are hand-written; docs entries come from the collection. | A marketing page is added, renamed, or removed. |
| XML sitemap | `sitemap` filter in `astro.config.mjs`. Noindex pages are excluded here and in the HTML sitemap. | A page becomes or stops being noindex. |
| `llms.txt` | `public/llms.txt`. Docs links use `.md` URLs. `/llm.txt` is an alias, so it needs no edit. | Any linked page or its summary changes. |
| Markdown pages | `src/pages/[...slug].md.ts` builds one `.md` per docs entry from its title, description, and body. | A docs entry lacks a title or description, or uses MDX outside `import` lines and self-closing component tags. |
| Structured data | `src/components/StructuredData.astro`. Breadcrumb names are the page title minus the suffix. The `sections` map lists section index pages that exist. | A section index page is added or removed, or the homepage description changes. |
| Icons | `src/components/SiteIcons.astro`, `public/favicon.svg`, `favicon.ico`, `favicon-48x48.png`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `site.webmanifest`. | The logo changes. Render every raster file from `favicon.svg` with `sharp` (an Astro dependency). The Apple icon has square corners, and the ICO holds 16, 32, and 48 pixel PNGs. |
| Social image | `public/images/opfs-social.png`, wired in `SocialImage.astro`. | The brand or tagline changes. |
| `robots.txt` | `public/robots.txt`. Content-Signal is `search=yes, ai-input=yes, ai-train=yes`, an owner decision. | Crawler policy changes, only on the owner's instruction. |

**Verify.** Build the website, then read the output in `apps/website/.vercel/output/static`: titles, descriptions, JSON-LD, `sitemap-0.xml`, and the `.md` files for every page you touched.

**Report.** End the final message with a list naming each surface as *updated* or *checked, unchanged* with a one-line reason, so the user sees what else moved.
