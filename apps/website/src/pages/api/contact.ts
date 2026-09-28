import type { APIRoute } from 'astro';
import { sendContactEmail } from '../../lib/contact-email';
import { parseContactMessage } from '../../lib/contact-message';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const message = parseContactMessage(await request.json().catch(() => null));
  if (!message) return Response.json({ error: 'Please complete the required fields.' }, { status: 400 });

  const apiKey = process.env.RESEND_API_KEY || import.meta.env.RESEND_API_KEY;
  if (!apiKey) return Response.json({ error: 'Email is not configured.' }, { status: 503 });

  try {
    const { error } = await sendContactEmail(message, apiKey);
    if (error) return Response.json({ error: 'We could not send your message. Please try again.' }, { status: 502 });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: 'We could not send your message. Please try again.' }, { status: 502 });
  }
};
