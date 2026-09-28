export type PreviewFile = { path: string; content: string; bytes?: Uint8Array };

export const MAX_PREVIEW_BYTES = 16 * 1024 * 1024;
// Adapted from frachter-app/opfs-vfs bash-console/features/previews/lib/detect.ts.
export function extension(path: string): string {
  const fileName = path.split('/').filter(Boolean).at(-1) ?? path;
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === fileName.length - 1) return '';
  return fileName.slice(dotIndex + 1).toLowerCase();
}
export const fileSize = (file: PreviewFile) =>
  file.bytes?.byteLength ?? new TextEncoder().encode(file.content).byteLength;
const textTypes = new Set(
  `txt text log md markdown mdx rst adoc tex bib csv tsv
   json jsonc json5 jsonl ndjson yaml yml toml ini conf cfg config env properties prefs lock
   js jsx mjs cjs ts tsx mts cts vue svelte astro
   css scss sass less styl html htm xhtml xml xsl xslt xsd svg
   sh bash zsh fish ksh bat cmd ps1 psm1 psd1
   py pyi pyw rb rake gemspec php phtml pl pm r jl lua
   c h cc cpp cxx hpp hxx inl m mm cs fs fsx fsi vb
   java kt kts scala sc groovy gradle go mod sum rs swift dart
   ex exs erl hrl hs lhs ml mli clj cljs cljc edn elm lisp el scm
   sql graphql gql proto prisma tf tfvars hcl nix dhall cmake mk
   dockerfile makefile gitignore gitattributes editorconfig npmrc yarnrc
   csproj fsproj vbproj props targets sln slnx resx manifest
   diff patch s asm ignore service socket timer desktop reg inf`.split(/\s+/),
);
const textNames = new Set(
  `readme license licence copying authors contributors changelog notice
   dockerfile containerfile makefile gnumakefile justfile taskfile procfile gemfile rakefile brewfile vagrantfile
   .gitignore .gitattributes .gitmodules .gitconfig .gitkeep .editorconfig .npmrc .yarnrc .nvmrc .node-version
   .python-version .ruby-version .tool-versions .dockerignore .prettierignore .eslintignore .browserslistrc
   .babelrc .eslintrc .prettierrc .stylelintrc .npmignore .bashrc .bash_profile .profile .zshrc .zshenv`.split(/\s+/),
);
function isTextPath(path: string) {
  const name = path.split('/').at(-1)?.toLowerCase() ?? '';
  return (
    textTypes.has(extension(path)) ||
    textNames.has(name) ||
    name === '.env' ||
    name.startsWith('.env.') ||
    name.startsWith('dockerfile.') ||
    name.startsWith('containerfile.')
  );
}
// Byte-backed fixtures are always read-only. Production must decode UTF-8 strictly before offering editing.
export const canEdit = (file: PreviewFile) =>
  !file.bytes && !file.content.includes('\0') && isTextPath(file.path) && fileSize(file) <= MAX_PREVIEW_BYTES;
