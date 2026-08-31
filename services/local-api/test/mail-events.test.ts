import { describe, it, expect } from 'vitest';
import { decideMailEvent, buildMessageLookup, type MessageRef } from '../src/mail-events.js';
import { verpReturnPath, packVerpToken } from '@cdp/email';

const SECRET = 'verp-secret';
const MSG = '9a9a9a9a-1111-4222-8333-444444444444';
const WS = 'ws000000-0000-4000-8000-000000000001';
const TAB = '\t';

const verpAddr = verpReturnPath('bounce.journeys.on-grow.com', SECRET, MSG);

function bounce(status: string, action = 'failed', to = verpAddr): string {
  return [
    'From: MAILER-DAEMON@mail.journeys.on-grow.com',
    `X-Original-To: ${to}`,
    'Content-Type: multipart/report; report-type=delivery-status; boundary="X"',
    '',
    '--X',
    'Content-Type: message/delivery-status',
    '',
    'Final-Recipient: rfc822; person@example.com',
    `Action: ${action}`,
    `Status: ${status}`,
    '',
    '--X--',
  ].join('\n');
}

function complaint(to = verpAddr): string {
  return [
    'From: complaints@yahoo.com',
    `X-Original-To: ${to}`,
    'Content-Type: multipart/report; report-type=feedback-report; boundary="A"',
    '',
    '--A',
    'Content-Type: message/feedback-report',
    '',
    'Feedback-Type: abuse',
    'Original-Rcpt-To: person@example.com',
    '',
    '--A--',
  ].join('\n');
}

const found = async (): Promise<MessageRef> => ({ workspaceId: WS, recipient: 'person@example.com' });
const missing = async (): Promise<MessageRef | null> => null;

describe('decideMailEvent', () => {
  it('suppresses on a permanent failure', async () => {
    const d = await decideMailEvent({ raw: bounce('5.1.1') }, SECRET, found);
    expect(d.action).toBe('suppress');
    expect(d.classified?.category).toBe('hard_bounce');
    expect(d.workspaceId).toBe(WS);
    expect(d.messageId).toBe(MSG);
    expect(d.recipient).toBe('person@example.com');
  });

  // The rule that protects the list: the MTA is still retrying, so removing the
  // address now would discard a perfectly good recipient.
  it('records but does NOT suppress a transient failure', async () => {
    const d = await decideMailEvent({ raw: bounce('4.2.2', 'delayed') }, SECRET, found);
    expect(d.action).toBe('record');
    expect(d.classified?.category).toBe('soft_bounce');
    expect(d.reason).toMatch(/not suppressed/);
  });

  it('suppresses on a spam complaint', async () => {
    const d = await decideMailEvent({ raw: complaint() }, SECRET, found);
    expect(d.action).toBe('suppress');
    expect(d.classified?.category).toBe('complaint');
  });

  // Security: acting on an unverified token is exactly how someone would suppress
  // an arbitrary recipient.
  it('ignores a forged token', async () => {
    const forged = verpReturnPath('bounce.journeys.on-grow.com', 'attacker-secret', MSG);
    const d = await decideMailEvent({ raw: bounce('5.1.1', 'failed', forged) }, SECRET, found);
    expect(d.action).toBe('ignored');
    expect(d.reason).toMatch(/verification/i);
    expect(d.workspaceId).toBeNull();
  });

  it('ignores a report with no VERP token at all', async () => {
    const d = await decideMailEvent(
      { raw: bounce('5.1.1', 'failed', 'postmaster@journeys.on-grow.com') },
      SECRET,
      found,
    );
    expect(d.action).toBe('ignored');
    expect(d.reason).toMatch(/no VERP token/);
  });

  it('ignores a valid token whose message we do not have', async () => {
    const d = await decideMailEvent({ raw: bounce('5.1.1') }, SECRET, missing);
    expect(d.action).toBe('ignored');
    expect(d.messageId).toBe(MSG); // verified, but unattributable
    expect(d.workspaceId).toBeNull();
  });

  it('accepts the token via originalTo when headers were stripped', async () => {
    const d = await decideMailEvent(
      // No X-Original-To header, but the agent supplies it separately.
      { raw: 'Subject: failure notice\n\nAction: failed\nStatus: 5.1.1', originalTo: verpAddr },
      SECRET,
      found,
    );
    expect(d.action).toBe('suppress');
    expect(d.messageId).toBe(MSG);
  });

  it('records an unrecognised report without acting on it', async () => {
    const d = await decideMailEvent(
      { raw: 'Subject: vacation reply\n\nI am away', originalTo: verpAddr },
      SECRET,
      found,
    );
    expect(d.action).toBe('record');
    expect(d.classified?.category).toBe('other');
  });

  it('falls back to the message recipient when the report names none', async () => {
    const d = await decideMailEvent(
      { raw: `X-Original-To: ${verpAddr}\n\nStatus: 5.0.0`, originalTo: verpAddr },
      SECRET,
      found,
    );
    expect(d.recipient).toBe('person@example.com');
  });

  it('never throws on hostile input', async () => {
    for (const raw of ['', 'x'.repeat(100000), `${TAB}\r\n\r\n`, '\0\0\0']) {
      await expect(decideMailEvent({ raw }, SECRET, found)).resolves.toBeDefined();
    }
  });
});

describe('buildMessageLookup', () => {
  it('joins profiles for the recipient and scopes the join by workspace', () => {
    const q = buildMessageLookup(MSG);
    expect(q.values).toEqual([MSG]);
    expect(q.text).toContain('JOIN profiles');
    expect(q.text).toContain('p.workspace_id = m.workspace_id');
    expect(q.text).toContain('ses_message_id = $1');
  });
});

// A message with copies delivers ONE message to several addresses, all sharing one
// VERP token — so the token alone cannot say which address failed. The report names
// it. That name has to be used, and it has to be checked.
describe('decideMailEvent with cc/bcc copies', () => {
  const withCopies = async (): Promise<MessageRef> => ({
    workspaceId: WS,
    recipient: 'person@example.com',
    cc: ['accounts@acme.com'],
    bcc: ['archive@acme.com'],
  });

  // THE regression: without this the accountant's dead mailbox suppresses the
  // customer, who then silently stops receiving their own receipts.
  it('suppresses the CC address the report names, not the primary', async () => {
    const d = await decideMailEvent(
      { raw: bounce('5.1.1').replace('Final-Recipient: rfc822; person@example.com', 'Final-Recipient: rfc822; accounts@acme.com') },
      SECRET,
      withCopies,
    );
    expect(d.action).toBe('suppress');
    expect(d.recipient).toBe('accounts@acme.com');
    expect(d.recipient).not.toBe('person@example.com');
  });

  it('attributes a bounce for a BCC address to that address', async () => {
    const d = await decideMailEvent(
      { raw: bounce('5.1.1').replace('Final-Recipient: rfc822; person@example.com', 'Final-Recipient: rfc822; archive@acme.com') },
      SECRET,
      withCopies,
    );
    expect(d.recipient).toBe('archive@acme.com');
  });

  // The report body is written by a remote party. A named address that this message
  // never went to is not evidence about that address — honouring it would let a
  // forged DSN suppress anyone.
  it('ignores a named address the message never went to, falling back to the primary', async () => {
    const d = await decideMailEvent(
      { raw: bounce('5.1.1').replace('Final-Recipient: rfc822; person@example.com', 'Final-Recipient: rfc822; victim@somewhere.com') },
      SECRET,
      withCopies,
    );
    expect(d.recipient).toBe('person@example.com');
  });

  it('still attributes to the primary when the report names it', async () => {
    const d = await decideMailEvent({ raw: bounce('5.1.1') }, SECRET, withCopies);
    expect(d.recipient).toBe('person@example.com');
  });

  it('matches the named address case-insensitively', async () => {
    const d = await decideMailEvent(
      { raw: bounce('5.1.1').replace('Final-Recipient: rfc822; person@example.com', 'Final-Recipient: rfc822; Accounts@ACME.com') },
      SECRET,
      withCopies,
    );
    expect(d.recipient?.toLowerCase()).toBe('accounts@acme.com');
  });
});

describe('buildMessageLookup', () => {
  it('reads the copies alongside the primary recipient', () => {
    const q = buildMessageLookup(MSG);
    expect(q.text).toMatch(/cc_addresses/);
    expect(q.text).toMatch(/bcc_addresses/);
  });
});
