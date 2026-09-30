import { getCollection } from 'astro:content';
import type { APIRoute, GetStaticPaths } from 'astro';

const slugOf = (id: string) => id.replace(/\/index$/, '');

export const getStaticPaths: GetStaticPaths = async () =>
  (await getCollection('docs'))
    .filter((entry) => !entry.data.draft)
    .map((entry) => ({ params: { slug: slugOf(entry.id) }, props: { entry } }));

// Drop MDX imports and component tags (outside code fences) so agents get plain Markdown.
const toMarkdown = (body: string) => {
  let fenced = false;
  return body
    .split('\n')
    .filter((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      return fenced || !/^(import\s.+from\s.+|<[A-Z][A-Za-z]*[^>]*\/>)\s*$/.test(line);
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
};

export const GET: APIRoute = ({ props }) => {
  const { title, description } = props.entry.data;
  const text = `# ${title}\n\n${description ? `> ${description}\n\n` : ''}${toMarkdown(props.entry.body ?? '').trim()}\n`;
  return new Response(text, { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
};
