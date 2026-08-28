import { describe, it, expect } from 'vitest';
import {
  parseBounceMessage,
  parseDeliveryStatus,
  classifyDeliveryStatus,
  classifyInboundReport,
  parseHeaders,
  splitMessage,
} from '../src/dsn.js';

const TOKEN = 'AbCdEf123456';
const TAB = '\t';

// A real Postfix hard bounce, as it arrives at the VERP address.
const HARD_BOUNCE = [
  'From: MAILER-DAEMON@mail.journeys.on-grow.com',
  `To: bounce+${TOKEN}@bounce.journeys.on-grow.com`,
  `X-Original-To: bounce+${TOKEN}@bounce.journeys.on-grow.com`,
  'Subject: Undelivered Mail Returned to Sender',
  'Content-Type: multipart/report; report-type=delivery-status;',
  `${TAB}boundary="XYZ"`,
  '',
  '--XYZ',
  'Content-Type: text/plain',
  '',
  'This is the mail system at host mail.journeys.on-grow.com.',
  '',
  '--XYZ',
  'Content-Type: message/delivery-status',
  '',
  'Reporting-MTA: dns; mail.journeys.on-grow.com',
  '',
  'Final-Recipient: rfc822; NoSuchUser@Gmail.com',
  'Action: failed',
  'Status: 5.1.1',
  'Diagnostic-Code: smtp; 550-5.1.1 The email account that you tried to reach does not exist.',
  '',
  '--XYZ--',
].join('\n');

const SOFT_BOUNCE = HARD_BOUNCE.replace('Status: 5.1.1', 'Status: 4.2.2').replace(
  'Action: failed',
  'Action: delayed',
);

// A Yahoo-style ARF complaint.
const COMPLAINT = [
  'From: complaints@yahoo.com',
  `X-Original-To: bounce+${TOKEN}@bounce.journeys.on-grow.com`,
  'Subject: Email Feedback Report',
  'Content-Type: multipart/report; report-type=feedback-report; boundary="ABC"',
  '',
  '--ABC',
  'Content-Type: message/feedback-report',
  '',
  'Feedback-Type: abuse',
  'User-Agent: Yahoo!-Mail-Feedback/2.0',
  'Version: 0.1',
  'Original-Rcpt-To: Person@Yahoo.com',
  '',
  '--ABC--',
].join('\n');

describe('header parsing', () => {
  it('unfolds continuation lines', () => {
    const h = parseHeaders(`Content-Type: multipart/report;\n${TAB}boundary="XYZ"\nTo: a@b.com`);
    expect(h['content-type']).toBe('multipart/report; boundary="XYZ"');
    expect(h['to']).toBe('a@b.com');
  });

  it('keeps the FIRST value of a repeated header', () => {
    const h = parseHeaders('Received: one\nReceived: two');
    expect(h['received']).toBe('one');
  });

  it('splits headers from body on the blank line', () => {
    const { headers, body } = splitMessage('A: 1\nB: 2\n\nthe body\nmore');
    expect(headers).toEqual({ a: '1', b: '2' });
    expect(body).toBe('the body\nmore');
  });
});

describe('delivery status', () => {
  it('reads status, action, recipient and diagnostic', () => {
    const d = parseDeliveryStatus(HARD_BOUNCE)!;
    expect(d.status).toBe('5.1.1');
    expect(d.action).toBe('failed');
    expect(d.recipient).toBe('nosuchuser@gmail.com'); // lowercased
    expect(d.diagnostic).toContain('does not exist');
  });

  it('returns null when there is no report at all', () => {
    expect(parseDeliveryStatus('just some text')).toBeNull();
  });

  // The rule that protects the list.
  it('classifies 5.x.x permanent and 4.x.x transient', () => {
    const at = (status: string | null, action: string | null) =>
      classifyDeliveryStatus({ status, action, recipient: null, diagnostic: null });
    expect(at('5.1.1', 'failed')).toBe('hard_bounce');
    expect(at('5.7.1', null)).toBe('hard_bounce');
    expect(at('4.2.2', 'delayed')).toBe('soft_bounce');
    expect(at('4.4.1', null)).toBe('soft_bounce');
  });

  it('falls back to the action verb when no enhanced status is present', () => {
    const at = (status: string | null, action: string | null) =>
      classifyDeliveryStatus({ status, action, recipient: null, diagnostic: null });
    expect(at(null, 'failed')).toBe('hard_bounce');
    expect(at(null, 'delayed')).toBe('soft_bounce');
    expect(at(null, 'delivered')).toBe('other');
    expect(classifyDeliveryStatus(null)).toBe('other');
  });
});

describe('parseBounceMessage', () => {
  it('recovers the VERP token from X-Original-To', () => {
    expect(parseBounceMessage(HARD_BOUNCE).verpToken).toBe(TOKEN);
  });

  it('parses a hard bounce', () => {
    const p = parseBounceMessage(HARD_BOUNCE);
    expect(p.isComplaint).toBe(false);
    expect(p.dsn?.status).toBe('5.1.1');
  });

  it('parses a soft bounce', () => {
    const p = parseBounceMessage(SOFT_BOUNCE);
    expect(classifyDeliveryStatus(p.dsn)).toBe('soft_bounce');
  });

  it('recognises an ARF complaint and its original recipient', () => {
    const p = parseBounceMessage(COMPLAINT);
    expect(p.isComplaint).toBe(true);
    expect(p.complaintRecipient).toBe('person@yahoo.com');
    expect(p.verpToken).toBe(TOKEN);
  });

  // This parses untrusted input arriving from the public internet.
  it('never throws, whatever arrives', () => {
    for (const bad of ['', 'x', '\n\n\n', ' ', 'Content-Type: multipart/report', 'x'.repeat(50000)]) {
      expect(() => parseBounceMessage(bad)).not.toThrow();
    }
    expect(parseBounceMessage('').verpToken).toBeNull();
  });
});

describe('classifyInboundReport', () => {
  const MSG = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  it('folds a hard bounce into the shared ClassifiedEvent shape', () => {
    const e = classifyInboundReport(parseBounceMessage(HARD_BOUNCE), MSG, null);
    expect(e.category).toBe('hard_bounce');
    expect(e.type).toBe('bounce');
    expect(e.subType).toBe('5.1.1');
    expect(e.sesMessageId).toBe(MSG);
    expect(e.recipients).toEqual(['nosuchuser@gmail.com']);
  });

  it('folds a complaint', () => {
    const e = classifyInboundReport(parseBounceMessage(COMPLAINT), MSG, null);
    expect(e.category).toBe('complaint');
    expect(e.type).toBe('complaint');
    expect(e.recipients).toEqual(['person@yahoo.com']);
  });

  it('uses the fallback recipient when the report names none', () => {
    const e = classifyInboundReport(parseBounceMessage('nothing useful'), MSG, 'known@example.com');
    expect(e.recipients).toEqual(['known@example.com']);
    expect(e.category).toBe('other');
  });
});
