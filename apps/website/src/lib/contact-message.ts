export type ContactMessage = {
  email: string;
  name: string;
  company: string;
  message: string;
};

const limit = (value: unknown, max: number) => typeof value === 'string' && value.trim().length <= max;

export function parseContactMessage(value: unknown): ContactMessage | null {
  if (!value || typeof value !== 'object') return null;
  const { email, name, company = '', message } = value as Record<string, unknown>;
  if (
    typeof email !== 'string' ||
    typeof name !== 'string' ||
    typeof company !== 'string' ||
    typeof message !== 'string'
  )
    return null;
  if (
    !limit(email, 254) ||
    !/^\S+@\S+\.\S+$/.test(email.trim()) ||
    !limit(name, 120) ||
    !name.trim() ||
    !limit(company, 120) ||
    !limit(message, 10_000) ||
    !message.trim()
  )
    return null;
  return { email: email.trim(), name: name.trim(), company: company.trim(), message: message.trim() };
}

export function contactEmailHtml({ email, name, company, message }: ContactMessage) {
  const escape = (value: string) =>
    value.replace(
      /[&<>"']/g,
      (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
    );
  return `<p><strong>From:</strong> ${escape(name)} &lt;${escape(email)}&gt;</p>${company ? `<p><strong>Company:</strong> ${escape(company)}</p>` : ''}<p>${escape(message).replace(/\n/g, '<br>')}</p>`;
}
