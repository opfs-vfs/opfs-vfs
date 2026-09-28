import { Resend } from 'resend';
import { contactEmailHtml, type ContactMessage } from './contact-message.ts';

type Mailer = {
  emails: {
    send: (message: {
      from: string;
      to: string;
      replyTo: string;
      subject: string;
      html: string;
    }) => Promise<{ error: unknown }>;
  };
};

export async function sendContactEmail(message: ContactMessage, apiKey: string, mailer: Mailer = new Resend(apiKey)) {
  return mailer.emails.send({
    from: 'website@opfs.dev',
    to: 'hello@opfs.dev',
    replyTo: message.email,
    subject: `eMail from opfs.dev website - ${message.name}`,
    html: contactEmailHtml(message),
  });
}
