import { describe, it, expect } from 'vitest';
import {
  decideTransactionalSend,
  dataMerge,
  renderTransactional,
  parseTransactionalRequest,
} from '../src/transactional-send.js';

const base = { email: 'a@b.com', suppressionReason: null, emailStatus: 'active' };

describe('decideTransactionalSend — consent vs deliverability', () => {
  it('sends to a normal recipient', () => {
    expect(decideTransactionalSend(base)).toEqual({ send: true });
  });

  // Conservative by DEFAULT: the safe failure is not sending.
  it('BLOCKS an unsubscribed recipient by default, and says how to override', () => {
    const v = decideTransactionalSend({ ...base, suppressionReason: 'unsubscribe' });
    expect(v.send).toBe(false);
    expect(v).toHaveProperty('reason', expect.stringContaining('ignore_unsubscribe'));
  });

  it('BLOCKS a manually suppressed recipient by default', () => {
    expect(decideTransactionalSend({ ...base, suppressionReason: 'manual' }).send).toBe(false);
  });

  // The override exists for messages the recipient triggered and needs — not
  // sending a login code locks them out of their own account.
  it('SENDS to an unsubscribed recipient when the caller opts out explicitly', () => {
    expect(
      decideTransactionalSend({ ...base, suppressionReason: 'unsubscribe' }, { ignoreMarketingConsent: true }),
    ).toEqual({ send: true });
    expect(
      decideTransactionalSend({ ...base, suppressionReason: 'manual' }, { ignoreMarketingConsent: true }),
    ).toEqual({ send: true });
  });

  // The override is about CONSENT, never deliverability.
  it('the override does NOT unlock a dead mailbox or a spam complaint', () => {
    const on = { ignoreMarketingConsent: true };
    expect(decideTransactionalSend({ ...base, suppressionReason: 'hard_bounce' }, on).send).toBe(false);
    expect(decideTransactionalSend({ ...base, suppressionReason: 'permanent_soft_bounce' }, on).send).toBe(false);
    expect(decideTransactionalSend({ ...base, suppressionReason: 'complaint' }, on).send).toBe(false);
    expect(decideTransactionalSend({ ...base, emailStatus: 'bounced' }, on).send).toBe(false);
    expect(decideTransactionalSend({ ...base, emailStatus: 'complained' }, on).send).toBe(false);
  });

  // Deliverability still applies: mailing dead addresses burns the sending
  // reputation for every other tenant on the IP.
  it('BLOCKS a hard-bounced address', () => {
    const v = decideTransactionalSend({ ...base, suppressionReason: 'hard_bounce' });
    expect(v.send).toBe(false);
    expect(v).toHaveProperty('reason', expect.stringContaining('undeliverable'));
  });

  it('BLOCKS a permanently soft-bounced address', () => {
    expect(decideTransactionalSend({ ...base, suppressionReason: 'permanent_soft_bounce' }).send).toBe(false);
  });

  it('BLOCKS when the profile is marked bounced even with no suppression row', () => {
    expect(decideTransactionalSend({ ...base, emailStatus: 'bounced' }).send).toBe(false);
  });

  // A complaint is different from an unsubscribe: the mailbox provider has been
  // told not to accept our mail, and continuing damages the shared IP.
  it('BLOCKS someone who reported us as spam, by either signal', () => {
    expect(decideTransactionalSend({ ...base, suppressionReason: 'complaint' }).send).toBe(false);
    expect(decideTransactionalSend({ ...base, emailStatus: 'complained' }).send).toBe(false);
  });

  it('blocks a missing or malformed address', () => {
    expect(decideTransactionalSend({ ...base, email: '' }).send).toBe(false);
    expect(decideTransactionalSend({ ...base, email: 'not-an-email' }).send).toBe(false);
  });
});

describe('dataMerge', () => {
  it('flattens parameters under the data namespace', () => {
    expect(dataMerge({ code: '123456', name: 'Nimrod' })).toEqual({
      'data.code': '123456',
      'data.name': 'Nimrod',
    });
  });

  it('flattens nested objects and arrays', () => {
    expect(dataMerge({ order: { id: 7 }, items: ['a', 'b'] })).toEqual({
      'data.order.id': '7',
      'data.items.0': 'a',
      'data.items.1': 'b',
    });
  });

  it('stringifies numbers and booleans', () => {
    expect(dataMerge({ n: 42, ok: true })).toEqual({ 'data.n': '42', 'data.ok': 'true' });
  });

  it('skips null and undefined rather than printing them', () => {
    expect(dataMerge({ a: null, b: undefined, c: 'x' })).toEqual({ 'data.c': 'x' });
  });

  // A hostile or accidental deep structure must not blow the stack.
  it('stops at a depth limit', () => {
    let deep: Record<string, unknown> = { v: 'bottom' };
    for (let i = 0; i < 40; i++) deep = { n: deep };
    expect(() => dataMerge(deep)).not.toThrow();
  });

  // The namespace exists so a caller cannot shadow profile fields.
  it('cannot collide with customer.* keys', () => {
    const m = dataMerge({ email: 'attacker@evil.com' });
    expect(m['customer.email']).toBeUndefined();
    expect(m['data.email']).toBe('attacker@evil.com');
  });
});

// The body is an HTML sink and the subject is not — the same `data.*` value
// rendering differently in the two halves is the whole point.
describe('renderTransactional escaping', () => {
  const merge = { 'data.who': 'Smith & Sons', 'data.markup': '<b>bold</b>' };

  it('escapes a value in the body but not in the subject', () => {
    const out = renderTransactional({ subject: 'Hi {{data.who}}', html: '<p>Hi {{data.who}}</p>' }, merge);
    expect(out.subject).toBe('Hi Smith & Sons');
    expect(out.html).toBe('<p>Hi Smith &amp; Sons</p>');
  });

  it('renders markup as visible text unless the template asks for it raw', () => {
    expect(renderTransactional({ subject: '', html: '{{data.markup}}' }, merge).html).toBe('&lt;b&gt;bold&lt;/b&gt;');
    expect(renderTransactional({ subject: '', html: '{{{data.markup}}}' }, merge).html).toBe('<b>bold</b>');
  });

  // The composed-HTML case an integrator actually has: they build the body
  // themselves and pass it in, which is what the triple brace is for.
  it('lets a caller pass a whole composed body through', () => {
    const html = '<div>{{{data.body_html}}}</div>';
    const out = renderTransactional({ subject: 'x', html }, { 'data.body_html': '<h1>Report</h1><p>Ready.</p>' });
    expect(out.html).toBe('<div><h1>Report</h1><p>Ready.</p></div>');
  });

  it('drops a javascript: URL passed into an href', () => {
    const out = renderTransactional(
      { subject: 'x', html: '<a href="{{data.link}}">Open</a>' },
      { 'data.link': 'javascript:alert(1)' },
    );
    expect(out.html).not.toContain('javascript:');
    expect(out.html).toContain('Open');
  });
});

describe('renderTransactional', () => {
  it('renders BOTH the subject and the body', () => {
    const out = renderTransactional(
      { subject: 'Your code is {{data.code}}', html: '<p>Hi {{customer.first_name}}, use {{data.code}}</p>' },
      { 'data.code': '123456', 'customer.first_name': 'Nimrod' },
    );
    expect(out.subject).toBe('Your code is 123456');
    expect(out.html).toBe('<p>Hi Nimrod, use 123456</p>');
  });

  // An unresolved token reaching an inbox looks broken; empty is the safe failure.
  it('resolves an unknown token to empty rather than leaving {{...}} visible', () => {
    const out = renderTransactional({ subject: 'Hi {{data.nope}}', html: '{{data.nope}}' }, {});
    expect(out.subject).toBe('Hi ');
    expect(out.html).toBe('');
  });

  it('handles missing parts without throwing', () => {
    expect(() => renderTransactional({ subject: '', html: '' }, {})).not.toThrow();
  });
});

describe('parseTransactionalRequest', () => {
  it('accepts a valid request', () => {
    expect(parseTransactionalRequest({ template: 'otp', to: 'a@b.com', data: { code: '1' } })).toEqual({
      template: 'otp',
      to: 'a@b.com',
      data: { code: '1' },
      ignoreUnsubscribe: false,
      attachments: [],
      cc: [],
      bcc: [],
    });
  });

  // Opting out of consent must be deliberate, so only an explicit true counts.
  it('reads ignore_unsubscribe only when explicitly true', () => {
    const r = (v: unknown) =>
      parseTransactionalRequest({ template: 'otp', to: 'a@b.com', ignore_unsubscribe: v });
    expect(r(true)).toMatchObject({ ignoreUnsubscribe: true });
    for (const v of [false, 'true', 1, undefined, null]) {
      expect(r(v)).toMatchObject({ ignoreUnsubscribe: false });
    }
  });

  it('defaults data to an empty object', () => {
    expect(parseTransactionalRequest({ template: 'otp', to: 'a@b.com' })).toMatchObject({ data: {} });
  });

  // The caller is a developer integrating against this; a vague 400 costs an hour.
  it('names the specific problem', () => {
    expect(parseTransactionalRequest({ to: 'a@b.com' })).toMatchObject({
      error: expect.stringContaining('template'),
    });
    expect(parseTransactionalRequest({ template: 'otp' })).toMatchObject({
      error: expect.stringContaining("'to'"),
    });
    // What a valid `to` looks like depends on the medium, which is not known until
    // the key resolves — so shape validation happens there, not here.
    expect(parseTransactionalRequest({ template: 'otp', to: 'nope' })).toMatchObject({ to: 'nope' });
    expect(parseTransactionalRequest({ template: 'otp', to: 'a@b.com', data: ['x'] })).toMatchObject({
      error: expect.stringContaining('object'),
    });
  });

  it('trims surrounding whitespace', () => {
    expect(parseTransactionalRequest({ template: '  otp  ', to: '  a@b.com ' })).toMatchObject({
      template: 'otp',
      to: 'a@b.com',
    });
  });
});
