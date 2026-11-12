export type ContactMessage = {
  email: string;
  name: string;
  company: string;
  message: string;
};

const limit = (value: unknown, max: number) => typeof value === 'string' && value.trim().length <= max;

export function parseContactMessage(value: unknown): ContactMessage | null {
  if (!value || typeof value !== 'object') return null;
  const { email, name, company = '', message, website = '' } = value as Record<string, unknown>;
  // `website` is a hidden honeypot field: people never see it, so any value marks an automated submission.
  if (website !== '') return null;
  if (
    typeof email !== 'string' ||
    typeof name !== 'string' ||
    typeof company !== 'string' ||
    typeof message !== 'string'
  )
    return null;
  // The name reaches the Subject header, so control characters (including CR/LF) become spaces.
  const headerName = name.replace(/\p{Cc}+/gu, ' ').trim();
  if (
    !limit(email, 254) ||
    // A single address for the Reply-To header: no whitespace, list separators, or angle brackets.
    !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(email.trim()) ||
    !limit(headerName, 120) ||
    !headerName ||
    !limit(company, 120) ||
    !limit(message, 10_000) ||
    !message.trim()
  )
    return null;
  return {
    email: email.trim(),
    name: headerName,
    company: company.trim(),
    message: message.trim(),
  };
}

export function contactEmailHtml({ email, name, company, message }: ContactMessage) {
  const escape = (value: string) =>
    value.replace(
      /[&<>"']/g,
      (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
    );
  return `<p><strong>From:</strong> ${escape(name)} &lt;${escape(email)}&gt;</p>${company ? `<p><strong>Company:</strong> ${escape(company)}</p>` : ''}<p>${escape(message).replace(/\n/g, '<br>')}</p>`;
}
