import content from '../../public/llms.txt?raw';

export function GET() {
  return new Response(content, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
