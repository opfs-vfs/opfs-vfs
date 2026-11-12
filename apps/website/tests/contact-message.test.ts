import assert from 'node:assert/strict';
import test from 'node:test';
import { sendContactEmail } from '../src/lib/contact-email.ts';
import { contactEmailHtml, parseContactMessage } from '../src/lib/contact-message.ts';

void test('contact messages are validated and safely rendered for email', () => {
  const message = parseContactMessage({
    email: 'ada@example.com',
    name: 'Ada <Lovelace>',
    company: '',
    message: 'Hello <world>',
  });
  assert.ok(message);
  assert.match(contactEmailHtml(message), /Ada &lt;Lovelace&gt;/);
  assert.match(contactEmailHtml(message), /Hello &lt;world&gt;/);
  const valid = { email: 'ada@example.com', name: 'Ada', company: '', message: 'Hello' };
  for (const [label, value] of [
    ['non-string submission', null],
    ['missing message', { ...valid, message: undefined }],
    ['invalid email', { ...valid, email: 'invalid' }],
    ['blank name', { ...valid, name: ' ' }],
    ['blank message', { ...valid, message: ' ' }],
    ['email over limit', { ...valid, email: `${'a'.repeat(250)}@b.co` }],
    ['name over limit', { ...valid, name: 'a'.repeat(121) }],
    ['company over limit', { ...valid, company: 'a'.repeat(121) }],
    ['message over limit', { ...valid, message: 'a'.repeat(10_001) }],
    ['filled honeypot', { ...valid, website: 'https://spam.example' }],
    ['non-string honeypot', { ...valid, website: 1 }],
    ['email address list', { ...valid, email: 'ada@example.com,eve@example.com' }],
    ['email with angle brackets', { ...valid, email: 'Ada <ada@example.com>' }],
    ['name of control characters only', { ...valid, name: '\u0001\r\n' }],
  ]) {
    assert.equal(parseContactMessage(value), null, label);
  }
  assert.ok(parseContactMessage({ ...valid, website: '' }), 'empty honeypot is accepted');
});

void test('contact names cannot inject header lines into the subject', () => {
  const message = parseContactMessage({
    email: 'ada@example.com',
    name: 'Ada\r\nBcc: eve@example.com\u0000',
    message: 'Hello',
  });
  assert.equal(message?.name, 'Ada Bcc: eve@example.com');
});

void test('contact email has the requested recipient, subject, and reply-to', async () => {
  const message = parseContactMessage({ email: 'ada@example.com', name: 'Ada', message: 'Hello' });
  assert.ok(message);
  let sent: Record<string, string> | undefined;
  await sendContactEmail(message, 're_test', {
    emails: {
      send: async (email) => {
        sent = email;
        return { error: null };
      },
    },
  });
  assert.deepEqual(sent, {
    from: 'website@opfs.dev',
    to: 'hello@opfs.dev',
    replyTo: 'ada@example.com',
    subject: 'eMail from opfs.dev website - Ada',
    html: '<p><strong>From:</strong> Ada &lt;ada@example.com&gt;</p><p>Hello</p>',
  });
});
