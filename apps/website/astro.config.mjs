import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import starlight from '@astrojs/starlight';
import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';

const manifest = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const packageVersion = manifest('../../packages/opfs-vfs/package.json').version;
const pgliteVersion = manifest('./package.json').dependencies['@electric-sql/pglite'];
let sourceCommit = 'unavailable';
try {
  const root = new URL('../../', import.meta.url);
  sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()) sourceCommit += '+dirty';
} catch {
  /* Source archives may not contain Git metadata. */
}

export default defineConfig({
  site: 'https://opfs.dev',
  server: {
    port: 4325,
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
  },
  vite: {
    plugins: [tailwindcss()],
    define: {
      'import.meta.env.PUBLIC_SOURCE_COMMIT': JSON.stringify(sourceCommit),
      'import.meta.env.PUBLIC_OPFS_VFS_VERSION': JSON.stringify(packageVersion),
      'import.meta.env.PUBLIC_PGLITE_VERSION': JSON.stringify(pgliteVersion),
    },
    server: {
      headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
    },
    preview: {
      port: 4325,
      strictPort: true,
      headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
    },
    // Worker-only imports otherwise trigger dependency discovery and a reload on the first benchmark run.
    optimizeDeps: { include: ['@electric-sql/pglite', '@electric-sql/pglite/basefs'] },
    worker: { format: 'es' },
  },
  integrations: [
    react(),
    sitemap({
      filter: (page) =>
        ![
          '/design/hero/',
          '/demos/devtools/embed/',
          '/demos/mobile-owner-probe/',
          '/demos/dedicated-owner-probe/',
          '/demos/shared-volume-probe/',
        ].includes(new URL(page).pathname),
    }),
    starlight({
      title: 'OPFS VFS',
      head: [{ tag: 'link', attrs: { rel: 'describedby', href: '/llms.txt', type: 'text/markdown' } }],
      components: {
        ThemeSelect: './src/components/ThemeControl.astro',
        SiteTitle: './src/components/docs/SiteTitle.astro',
      },
      customCss: ['./src/styles/docs.css'],
      description: 'A browser virtual filesystem backed by OPFS.',
      editLink: { baseUrl: 'https://github.com/opfs-vfs/opfs-vfs/edit/main/apps/website/' },
      sidebar: [
        { label: '← Website', link: '/' },
        { label: 'Why OPFS VFS', link: '/motivation/' },
        { label: 'Sitemap', link: '/sitemap/' },
        { label: 'Start here', items: [{ label: 'Getting started', slug: 'docs/getting-started' }] },
        { label: 'Concepts', items: [{ label: 'Volumes and lifecycle', slug: 'docs/concepts' }] },
        {
          label: 'Guides',
          items: [
            { label: 'Browser setup', slug: 'docs/guides/browser-setup' },
            { label: 'Files and directories', slug: 'docs/guides/files-and-directories' },
            { label: 'Persistence', slug: 'docs/guides/persistence' },
            { label: 'Volume Explorer', slug: 'docs/guides/devtools' },
            { label: 'File preview extensions', slug: 'docs/guides/file-previews' },
          ],
        },
        {
          label: 'Plugins',
          items: [
            { label: 'Overview', slug: 'docs/plugins' },
            { label: 'File subscriptions', slug: 'docs/plugins/subscriptions' },
          ],
        },
        {
          label: 'Integrations',
          items: [
            { label: 'just-bash', slug: 'docs/integrations/just-bash' },
            { label: 'PGlite', slug: 'docs/integrations/pglite' },
            { label: 'DuckDB (experimental)', slug: 'docs/integrations/duckdb' },
            { label: 'EdgeJS (experimental)', slug: 'docs/integrations/edgejs' },
          ],
        },
        {
          label: 'React SDK',
          items: [
            { label: 'React SDK preview', slug: 'docs/react' },
            { label: 'API reference', slug: 'docs/react/reference' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Public API', slug: 'docs/reference' },
            { label: 'Troubleshooting', slug: 'docs/troubleshooting' },
            { label: 'Licensing', link: '/licensing/' },
          ],
        },
      ],
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/opfs-vfs/opfs-vfs' }],
    }),
  ],
});
