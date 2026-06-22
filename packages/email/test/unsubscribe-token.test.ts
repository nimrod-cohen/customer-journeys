import { describe, it, expect } from 'vitest';
import {
  signUnsubscribeToken,
  verifyUnsubscribeToken,
  unsubscribeLinkSecret,
  DEV_UNSUBSCRIBE_LINK_SECRET,
  buildUnsubscribeUrl,
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

  it('buildUnsubscribeUrl carries a signed token that verifies end-to-end', () => {
    const token = signUnsubscribeToken(secret, wsA, 'a@x.com');
    const url = buildUnsubscribeUrl({ baseUrl: 'https://api.cdp.example/manage-subscription', workspaceId: wsA, email: 'a@x.com', token });
    const parsed = new URL(url);
    const ws = parsed.searchParams.get('workspace_id')!;
    const email = parsed.searchParams.get('email')!;
    const tok = parsed.searchParams.get('token');
    expect(verifyUnsubscribeToken(secret, ws, email, tok)).toBe(true);
  });
});
