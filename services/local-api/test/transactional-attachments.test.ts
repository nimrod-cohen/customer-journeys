// Attachment validation for POST /v1/send. Pure — the bytes never leave the
// request here, so every rule below is decided without a database or a transport.
//
// The caller is a developer integrating against this, so each rejection has to say
// which file is wrong and why; "400 bad request" against a 20-file batch costs them
// an afternoon.
import { describe, it, expect } from 'vitest';
import {
  parseAttachments,
  parseTransactionalRequest,
  parseRecipientList,
  blocksCopy,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_RECIPIENTS,
} from '../src/transactional-send.js';

const b64 = (s: string) => Buffer.from(s).toString('base64');
const file = (over: Record<string, unknown> = {}) => ({
  filename: 'invoice.pdf',
  content: b64('%PDF-1.4'),
  ...over,
});

const okParse = (raw: unknown) => {
  const r = parseAttachments(raw);
  if ('error' in r) throw new Error(`unexpected error: ${r.error}`);
  return r.attachments;
};

describe('parseAttachments', () => {
  it('treats a missing or null list as no attachments', () => {
    expect(okParse(undefined)).toEqual([]);
    expect(okParse(null)).toEqual([]);
  });

  it('accepts a file and reports its decoded size', () => {
    const [a] = okParse([file()]);
    expect(a!.filename).toBe('invoice.pdf');
    expect(a!.contentType).toBe('application/pdf'); // inferred from the extension
    expect(a!.content).toBe(b64('%PDF-1.4'));
    expect(a!.bytes).toBe(8);
  });

  it('honours an explicit content type and falls back for an unknown extension', () => {
    expect(okParse([file({ content_type: 'application/x-thing' })])[0]!.contentType).toBe('application/x-thing');
    expect(okParse([file({ filename: 'data.wat' })])[0]!.contentType).toBe('application/octet-stream');
  });

  // A filename is used as a header parameter and shown to the recipient; a path in
  // it is either a mistake or an attempt at one.
  it('strips any directory part from the filename', () => {
    expect(okParse([file({ filename: '../../etc/passwd' })])[0]!.filename).toBe('passwd');
    expect(okParse([file({ filename: 'C:\\tmp\\report.csv' })])[0]!.filename).toBe('report.csv');
  });

  it('rejects a non-array', () => {
    expect(parseAttachments({ filename: 'x' })).toEqual({ error: expect.stringMatching(/must be an array/) });
  });

  it('rejects a file with no name, naming its position', () => {
    const r = parseAttachments([file(), { content: b64('x') }]);
    expect(r).toEqual({ error: expect.stringMatching(/attachments\[1\].*filename/i) });
  });

  it('rejects a file with no content', () => {
    expect(parseAttachments([file({ content: '' })])).toEqual({
      error: expect.stringMatching(/invoice\.pdf.*content/i),
    });
  });

  // Base64 is the only accepted encoding, so garbage has to be caught here rather
  // than reaching a transport that will quietly attach nonsense.
  it('rejects content that is not base64', () => {
    expect(parseAttachments([file({ content: 'not base64!!' })])).toEqual({
      error: expect.stringMatching(/invoice\.pdf.*base64/i),
    });
  });

  it('accepts base64 that arrived wrapped in newlines', () => {
    const wrapped = `${b64('%PDF-1.4')}\n`;
    expect(okParse([file({ content: wrapped })])[0]!.content).toBe(b64('%PDF-1.4'));
  });

  it('accepts a data: URI, which is what a browser FileReader hands you', () => {
    const [a] = okParse([file({ content: `data:application/pdf;base64,${b64('%PDF-1.4')}` })]);
    expect(a!.content).toBe(b64('%PDF-1.4'));
  });

  it('rejects more than the maximum number of files', () => {
    const many = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => file({ filename: `f${i}.pdf` }));
    expect(parseAttachments(many)).toEqual({ error: expect.stringMatching(new RegExp(`${MAX_ATTACHMENTS}`)) });
  });

  // The cap is on the DECODED total, because that is what the recipient's mailbox
  // provider measures — and it is computed from the base64 length, so an oversize
  // request is refused without ever allocating the bytes.
  it('rejects a total over the size cap', () => {
    const half = 'A'.repeat(Math.ceil((MAX_ATTACHMENT_BYTES * 0.6) / 3) * 4);
    const r = parseAttachments([file({ content: half }), file({ filename: 'b.pdf', content: half })]);
    expect(r).toEqual({ error: expect.stringMatching(/25 MB|too large/i) });
  });

  it('accepts a total just under the cap', () => {
    const nearly = 'A'.repeat(Math.floor((MAX_ATTACHMENT_BYTES * 0.9) / 3) * 4);
    expect(okParse([file({ content: nearly })])).toHaveLength(1);
  });
});

describe('parseTransactionalRequest with attachments', () => {
  it('carries validated attachments through', () => {
    const r = parseTransactionalRequest({ template: 'receipt', to: 'a@b.com', attachments: [file()] });
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.attachments).toHaveLength(1);
    expect(r.attachments[0]!.filename).toBe('invoice.pdf');
  });

  it('has no attachments when the caller sends none', () => {
    const r = parseTransactionalRequest({ template: 'otp', to: 'a@b.com' });
    if ('error' in r) throw new Error(r.error);
    expect(r.attachments).toEqual([]);
  });

  it('surfaces an attachment problem as the request error', () => {
    const r = parseTransactionalRequest({ template: 'otp', to: 'a@b.com', attachments: 'nope' });
    expect(r).toEqual({ error: expect.stringMatching(/attachments/) });
  });
});

describe('parseRecipientList (cc / bcc)', () => {
  it('accepts a single address or a list, and treats absence as none', () => {
    expect(parseRecipientList('a@b.com', 'cc')).toEqual(['a@b.com']);
    expect(parseRecipientList(['a@b.com', 'c@d.com'], 'cc')).toEqual(['a@b.com', 'c@d.com']);
    expect(parseRecipientList(undefined, 'cc')).toEqual([]);
    expect(parseRecipientList(null, 'bcc')).toEqual([]);
    expect(parseRecipientList('', 'cc')).toEqual([]);
  });

  // The same address twice is one delivery; two copies of one message reads as a
  // bug in the sender.
  it('de-duplicates case-insensitively', () => {
    expect(parseRecipientList(['A@b.com', 'a@B.com', 'c@d.com'], 'cc')).toEqual(['A@b.com', 'c@d.com']);
  });

  // Addresses land in message headers, so a CRLF in one could append a header.
  it('rejects an address containing CRLF, before any transport sees it', () => {
    expect(parseRecipientList(['ok@b.com\r\nBcc: attacker@evil.com'], 'cc')).toEqual({
      error: expect.stringMatching(/invalid email/i),
    });
  });

  it('rejects malformed addresses and non-strings, naming the field', () => {
    expect(parseRecipientList(['not-an-email'], 'bcc')).toEqual({ error: expect.stringMatching(/'bcc'/) });
    expect(parseRecipientList([42], 'cc')).toEqual({ error: expect.stringMatching(/'cc'/) });
  });
});

describe('parseTransactionalRequest with copies', () => {
  const req = (over: Record<string, unknown>) =>
    parseTransactionalRequest({ template: 'receipt', to: 'a@b.com', ...over });

  it('carries cc and bcc through', () => {
    const r = req({ cc: 'x@y.com', bcc: ['z@y.com'] });
    if ('error' in r) throw new Error(r.error);
    expect(r.cc).toEqual(['x@y.com']);
    expect(r.bcc).toEqual(['z@y.com']);
  });

  it('defaults both to empty', () => {
    const r = req({});
    if ('error' in r) throw new Error(r.error);
    expect(r.cc).toEqual([]);
    expect(r.bcc).toEqual([]);
  });

  // The cap counts the primary too — the limit is on what one message costs.
  it('refuses more recipients than the cap, naming the limit', () => {
    const many = Array.from({ length: MAX_RECIPIENTS }, (_, i) => `c${i}@acme.com`);
    expect(req({ cc: many })).toEqual({ error: expect.stringMatching(new RegExp(`${MAX_RECIPIENTS}`)) });
  });

  it('allows exactly the cap', () => {
    const many = Array.from({ length: MAX_RECIPIENTS - 1 }, (_, i) => `c${i}@acme.com`);
    expect('error' in req({ cc: many })).toBe(false);
  });
});

describe('blocksCopy', () => {
  // Deliverability and complaints apply to any address on the wire…
  it('blocks a copy to a dead or complaining address', () => {
    expect(blocksCopy('hard_bounce')).toBe(true);
    expect(blocksCopy('permanent_soft_bounce')).toBe(true);
    expect(blocksCopy('complaint')).toBe(true);
  });

  // …consent does not: a cc'd accountant never subscribed, so their unsubscribe
  // from marketing says nothing about receiving an invoice copy.
  it('does NOT block a copy to someone who merely unsubscribed', () => {
    expect(blocksCopy('unsubscribe')).toBe(false);
    expect(blocksCopy('manual')).toBe(false);
    expect(blocksCopy(null)).toBe(false);
  });
});
