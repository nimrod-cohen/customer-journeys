// The session token is HMAC-SIGNED so a client cannot forge or alter its claims
// (sub, workspace_id) — the authentication boundary for the containerized API.
// PURE unit test (no DB): round-trip + forgery/tamper/expiry rejection.
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { encodeDevToken, decodeDevToken } from '../src/auth.js';

describe('signed session token', () => {
  it('round-trips sub + workspace_id', () => {
    const t = encodeDevToken({ sub: 'u1', workspace_id: 'w1' });
    expect(decodeDevToken(t)).toEqual({ sub: 'u1', workspace_id: 'w1' });
  });

  it('round-trips a null (workspace-less) claim', () => {
    const t = encodeDevToken({ sub: 'u1', workspace_id: null });
    expect(decodeDevToken(t)).toEqual({ sub: 'u1', workspace_id: null });
  });

  it('REJECTS a tampered payload that keeps the old signature (forged workspace)', () => {
    const t = encodeDevToken({ sub: 'u1', workspace_id: 'w1' });
    const sig = t.slice(t.lastIndexOf('.') + 1);
    const forged = Buffer.from(
      JSON.stringify({ sub: 'u1', workspace_id: 'SOMEONE_ELSE', exp: 9999999999 }),
      'utf8',
    ).toString('base64url');
    expect(decodeDevToken(`${forged}.${sig}`)).toBeNull();
  });

  it('REJECTS an unsigned/legacy token (base64 JSON, no signature)', () => {
    const unsigned = Buffer.from(JSON.stringify({ sub: 'u1', workspace_id: 'w1' }), 'utf8').toString('base64url');
    expect(decodeDevToken(unsigned)).toBeNull();
  });

  it('REJECTS a wrong signature', () => {
    const t = encodeDevToken({ sub: 'u1', workspace_id: 'w1' });
    const payload = t.slice(0, t.lastIndexOf('.'));
    expect(decodeDevToken(`${payload}.not-the-real-signature`)).toBeNull();
  });

  it('REJECTS an expired token', () => {
    process.env.SESSION_JWT_SECRET = 'unit-test-secret';
    try {
      const past = Math.floor(Date.now() / 1000) - 10;
      const payload = Buffer.from(
        JSON.stringify({ sub: 'u1', workspace_id: 'w1', iat: past - 100, exp: past }),
        'utf8',
      ).toString('base64url');
      const sig = createHmac('sha256', 'unit-test-secret').update(payload).digest('base64url');
      expect(decodeDevToken(`${payload}.${sig}`)).toBeNull();
    } finally {
      delete process.env.SESSION_JWT_SECRET;
    }
  });
});
