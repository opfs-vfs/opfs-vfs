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
  ]) {
    assert.equal(parseContactMessage(value), null, label);
  }
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
