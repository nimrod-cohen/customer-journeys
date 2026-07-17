import { describe, it, expect } from 'vitest';
import {
  signUnsubscribeToken,
  verifyUnsubscribeToken,
  unsubscribeLinkSecret,
  DEV_UNSUBSCRIBE_LINK_SECRET,
  buildUnsubscribeUrl,
  packSubscriptionToken,
  unpackSubscriptionToken,
} from '../src/unsubscribe.js';

// Tokenized, UNGUESSABLE unsubscribe links: a stateless HMAC over
// (workspace_id, lower(email)). The dispatcher signs; the handlers verify.
const secret = 'test-secret-abc';
const wsA = 'aaaaaaaa-0000-0000-0000-000000000001';
const wsB = 'bbbbbbbb-0000-0000-0000-000000000002';

describe('signUnsubscribeToken / verifyUnsubscribeToken', () => {
  it('round-trips: a freshly signed token verifies', () => {
    const t = signUnsubscribeToken(secret, wsA, 'a@x.com');
    expect(verifyUnsubscribeToken(secret, wsA, 'a@x.com', t)).toBe(true);
  });

  it('is deterministic — the same inputs always produce the same token (re-sent link verifies)', () => {
    expect(signUnsubscribeToken(secret, wsA, 'a@x.com')).toBe(signUnsubscribeToken(secret, wsA, 'a@x.com'));
  });

  it('is case-insensitive on the email (link casing does not matter)', () => {
    const t = signUnsubscribeToken(secret, wsA, 'A@X.com');
    expect(verifyUnsubscribeToken(secret, wsA, 'a@x.com', t)).toBe(true);
    expect(verifyUnsubscribeToken(secret, wsA, '  A@X.COM  ', t)).toBe(true);
  });

  it('rejects a TAMPERED email (cannot forge a link for someone else)', () => {
    const t = signUnsubscribeToken(secret, wsA, 'a@x.com');
    expect(verifyUnsubscribeToken(secret, wsA, 'victim@x.com', t)).toBe(false);
  });

  it('rejects a TAMPERED workspace (cross-tenant forgery impossible)', () => {
    const t = signUnsubscribeToken(secret, wsA, 'a@x.com');
    expect(verifyUnsubscribeToken(secret, wsB, 'a@x.com', t)).toBe(false);
  });

  it('rejects a TAMPERED token', () => {
    const t = signUnsubscribeToken(secret, wsA, 'a@x.com');
    expect(verifyUnsubscribeToken(secret, wsA, 'a@x.com', t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A'))).toBe(false);
  });

  it('rejects with the WRONG secret', () => {
    const t = signUnsubscribeToken(secret, wsA, 'a@x.com');
    expect(verifyUnsubscribeToken('other-secret', wsA, 'a@x.com', t)).toBe(false);
  });

  it('rejects a missing/empty token (constant-time length-mismatch path)', () => {
    expect(verifyUnsubscribeToken(secret, wsA, 'a@x.com', null)).toBe(false);
    expect(verifyUnsubscribeToken(secret, wsA, 'a@x.com', undefined)).toBe(false);
    expect(verifyUnsubscribeToken(secret, wsA, 'a@x.com', '')).toBe(false);
    // A token of a DIFFERENT length than expected hits the length-guard (no throw).
    expect(verifyUnsubscribeToken(secret, wsA, 'a@x.com', 'short')).toBe(false);
  });

  it('throws when signing without a secret or workspace (guards)', () => {
    expect(() => signUnsubscribeToken('', wsA, 'a@x.com')).toThrow(/secret/);
    expect(() => signUnsubscribeToken(secret, '', 'a@x.com')).toThrow(/workspaceId/);
  });

  it('unsubscribeLinkSecret falls back to the dev secret when env is unset', () => {
    const prev = process.env.UNSUBSCRIBE_LINK_SECRET;
    delete process.env.UNSUBSCRIBE_LINK_SECRET;
    expect(unsubscribeLinkSecret()).toBe(DEV_UNSUBSCRIBE_LINK_SECRET);
    process.env.UNSUBSCRIBE_LINK_SECRET = 'env-secret';
    expect(unsubscribeLinkSecret()).toBe('env-secret');
    if (prev === undefined) delete process.env.UNSUBSCRIBE_LINK_SECRET;
    else process.env.UNSUBSCRIBE_LINK_SECRET = prev;
  });

  it('buildUnsubscribeUrl (legacy, no secret) carries a signed token that verifies end-to-end', () => {
    const token = signUnsubscribeToken(secret, wsA, 'a@x.com');
    const url = buildUnsubscribeUrl({ baseUrl: 'https://api.cdp.example/manage-subscription', workspaceId: wsA, email: 'a@x.com', token });
    const parsed = new URL(url);
    const ws = parsed.searchParams.get('workspace_id')!;
    const email = parsed.searchParams.get('email')!;
    const tok = parsed.searchParams.get('token');
    expect(verifyUnsubscribeToken(secret, ws, email, tok)).toBe(true);
  });
});

describe('packSubscriptionToken / unpackSubscriptionToken (compact self-contained `t`)', () => {
  it('round-trips workspace_id + email', () => {
    const t = packSubscriptionToken(secret, wsA, 'a@x.com');
    expect(unpackSubscriptionToken(secret, t)).toEqual({ workspaceId: wsA, email: 'a@x.com' });
  });

  it('is deterministic — a re-sent link still verifies', () => {
    expect(packSubscriptionToken(secret, wsA, 'a@x.com')).toBe(packSubscriptionToken(secret, wsA, 'a@x.com'));
  });

  it('stores the email VERBATIM (does NOT lowercase)', () => {
    const t = packSubscriptionToken(secret, wsA, 'Mixed.Case+Tag@Example.COM');
    expect(unpackSubscriptionToken(secret, t)).toEqual({ workspaceId: wsA, email: 'Mixed.Case+Tag@Example.COM' });
  });

  it('handles emails with `+`, `.`, and unicode', () => {
    for (const email of ['a+b.c@x.io', 'first.last+promo@sub.domain.example', 'ünïcödé+tëst@exämple.com', 'δοκιμή@παράδειγμα.gr']) {
      const t = packSubscriptionToken(secret, wsB, email);
      expect(unpackSubscriptionToken(secret, t)).toEqual({ workspaceId: wsB, email });
    }
  });

  it('returns null for a TAMPERED byte', () => {
    const t = packSubscriptionToken(secret, wsA, 'a@x.com');
    const flipped = t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A');
    expect(unpackSubscriptionToken(secret, flipped)).toBeNull();
  });

  it('returns null for the WRONG secret (cannot forge)', () => {
    const t = packSubscriptionToken(secret, wsA, 'victim@x.com');
    expect(unpackSubscriptionToken('other-secret', t)).toBeNull();
  });

  it('returns null for a truncated / empty / garbled token', () => {
    const t = packSubscriptionToken(secret, wsA, 'a@x.com');
    expect(unpackSubscriptionToken(secret, t.slice(0, 8))).toBeNull();
    expect(unpackSubscriptionToken(secret, '')).toBeNull();
    expect(unpackSubscriptionToken(secret, null)).toBeNull();
    expect(unpackSubscriptionToken(secret, undefined)).toBeNull();
    expect(unpackSubscriptionToken(secret, '!!!not base64!!!')).toBeNull();
  });

  it('throws when packing without a secret or workspace, or a non-uuid workspace', () => {
    expect(() => packSubscriptionToken('', wsA, 'a@x.com')).toThrow(/secret/);
    expect(() => packSubscriptionToken(secret, '', 'a@x.com')).toThrow(/workspaceId/);
    expect(() => packSubscriptionToken(secret, 'not-a-uuid', 'a@x.com')).toThrow(/uuid/);
  });

  it('the encoded `t` contains NO raw uuid/email substring', () => {
    const email = 'someone@example.com';
    const t = packSubscriptionToken(secret, wsA, email);
    expect(t).not.toContain(wsA);
    expect(t).not.toContain(wsA.replace(/-/g, ''));
    expect(t).not.toContain(email);
    expect(t).not.toContain('example.com');
  });

  it('is COMPACT — the `?t=` querystring is shorter than the legacy `workspace_id=&email=&token=` triple', () => {
    const email = 'representative.user+promo@customer-domain.example';
    const newQs = `t=${packSubscriptionToken(secret, wsA, email)}`;
    const legacyQs =
      `workspace_id=${encodeURIComponent(wsA)}` +
      `&email=${encodeURIComponent(email)}` +
      `&token=${encodeURIComponent(signUnsubscribeToken(secret, wsA, email))}`;
    expect(newQs.length).toBeLessThan(legacyQs.length);
  });

  it('buildUnsubscribeUrl with a secret emits the `?t=` form that unpacks; attribution stays as b/c', () => {
    const url = buildUnsubscribeUrl({
      baseUrl: 'https://api.cdp.example/manage-subscription',
      workspaceId: wsA,
      email: 'a@x.com',
      secret,
      broadcastId: 'bbbb1111-0000-0000-0000-000000000001',
      automationId: null,
    });
    const parsed = new URL(url);
    const t = parsed.searchParams.get('t');
    expect(parsed.searchParams.get('workspace_id')).toBeNull();
    expect(parsed.searchParams.get('email')).toBeNull();
    expect(unpackSubscriptionToken(secret, t)).toEqual({ workspaceId: wsA, email: 'a@x.com' });
    expect(parsed.searchParams.get('b')).toBe('bbbb1111-0000-0000-0000-000000000001');
    expect(parsed.searchParams.get('c')).toBeNull();
  });
});
