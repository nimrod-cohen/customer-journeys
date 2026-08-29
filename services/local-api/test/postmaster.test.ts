import { describe, it, expect } from 'vitest';
import {
  makePostmasterClient,
  judgeSpamRate,
  SPAM_RATE_WARN,
  SPAM_RATE_CRITICAL,
  type PostmasterHttp,
} from '../src/postmaster.js';

const DOMAIN = 'acme.com';

function fake(routes: Record<string, { status: number; body: string }>) {
  const calls: { method: string; url: string; auth?: string; body?: string }[] = [];
  const http: PostmasterHttp = {
    async request(method, url, headers, body) {
      calls.push({ method, url, auth: headers['authorization'], body });
      const key = `${method} ${url.replace('https://gmailpostmastertools.googleapis.com/v2', '')}`;
      return routes[key] ?? { status: 404, body: '{}' };
    },
  };
  const tokens = { accessToken: async () => 'tok-123' };
  return { calls, client: makePostmasterClient(tokens, http) };
}

describe('createDomain', () => {
  it('registers the domain under our account', async () => {
    const f = fake({ 'POST /domains': { status: 200, body: '{"name":"domains/acme.com"}' } });
    expect(await f.client.createDomain(DOMAIN)).toEqual({ name: 'domains/acme.com' });
    expect(f.calls[0]!.auth).toBe('Bearer tok-123');
  });

  // Onboarding gets retried; a domain already registered is not a failure.
  it('treats an already-registered domain as success', async () => {
    const f = fake({ 'POST /domains': { status: 409, body: '{"error":"exists"}' } });
    await expect(f.client.createDomain(DOMAIN)).resolves.toEqual({ name: 'domains/acme.com' });
  });

  it('throws on a real API failure', async () => {
    const f = fake({ 'POST /domains': { status: 500, body: 'boom' } });
    await expect(f.client.createDomain(DOMAIN)).rejects.toThrow(/500/);
  });
});

describe('getVerificationToken', () => {
  it('returns the value the customer must publish', async () => {
    const f = fake({
      'GET /domains/acme.com/verificationToken': { status: 200, body: '{"token":"google-site-verification=abc"}' },
    });
    expect(await f.client.getVerificationToken(DOMAIN)).toBe('google-site-verification=abc');
  });

  it('throws when Google returns no token', async () => {
    const f = fake({ 'GET /domains/acme.com/verificationToken': { status: 200, body: '{}' } });
    await expect(f.client.getVerificationToken(DOMAIN)).rejects.toThrow(/no verification token/);
  });
});

describe('verifyDomain', () => {
  it('reports success', async () => {
    const f = fake({ 'POST /domains/acme.com:verify': { status: 200, body: '{"verified":true}' } });
    expect(await f.client.verifyDomain(DOMAIN)).toEqual({ verified: true, detail: null });
  });

  // DNS propagation means "not yet" is the normal answer, not an error.
  it('reports a missing record as not-yet rather than throwing', async () => {
    for (const status of [400, 404, 412]) {
      const f = fake({ 'POST /domains/acme.com:verify': { status, body: '{}' } });
      const r = await f.client.verifyDomain(DOMAIN);
      expect(r.verified).toBe(false);
      expect(r.detail).toMatch(/not found yet/);
    }
  });

  it('still throws on an unexpected server error', async () => {
    const f = fake({ 'POST /domains/acme.com:verify': { status: 503, body: '' } });
    await expect(f.client.verifyDomain(DOMAIN)).rejects.toThrow(/503/);
  });
});

describe('getComplianceStatus', () => {
  it("reads SPF/DKIM/DMARC as Google sees them", async () => {
    const f = fake({
      'GET /domains/acme.com/complianceStatus': {
        status: 200,
        body: '{"spfStatus":"COMPLIANT","dkimStatus":"COMPLIANT","dmarcStatus":"NON_COMPLIANT"}',
      },
    });
    expect(await f.client.getComplianceStatus(DOMAIN)).toEqual({
      spf: 'COMPLIANT',
      dkim: 'COMPLIANT',
      dmarc: 'NON_COMPLIANT',
    });
  });

  it('degrades to nulls on an unexpected shape rather than throwing', async () => {
    const f = fake({ 'GET /domains/acme.com/complianceStatus': { status: 200, body: 'not json' } });
    expect(await f.client.getComplianceStatus(DOMAIN)).toEqual({ spf: null, dkim: null, dmarc: null });
  });
});

describe('getReputation', () => {
  it('maps Gmail stats including the spam ratio', async () => {
    const f = fake({
      'POST /domains/acme.com/domainStats:query': {
        status: 200,
        body: JSON.stringify({
          domainStats: [
            { date: '2026-08-28', domainReputation: 'HIGH', ipReputations: [{ reputation: 'HIGH' }], userReportedSpamRatio: 0.0004 },
            { date: '2026-08-27', domainReputation: 'MEDIUM', userReportedSpamRatio: 0.002 },
          ],
        }),
      },
    });
    const r = await f.client.getReputation(DOMAIN, 7);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ domainReputation: 'HIGH', ipReputation: 'HIGH', userReportedSpamRatio: 0.0004 });
    expect(r[1]!.ipReputation).toBeNull();
  });

  it('returns an empty list when Gmail has no data yet (low volume)', async () => {
    const f = fake({ 'POST /domains/acme.com/domainStats:query': { status: 200, body: '{}' } });
    expect(await f.client.getReputation(DOMAIN, 7)).toEqual([]);
  });
});

// Gmail's published bulk-sender rule: stay under 0.10%, never reach 0.30%.
describe('judgeSpamRate', () => {
  it('applies Gmail thresholds', () => {
    expect(judgeSpamRate(0)).toBe('ok');
    expect(judgeSpamRate(0.0005)).toBe('ok');
    expect(judgeSpamRate(SPAM_RATE_WARN)).toBe('warn');
    expect(judgeSpamRate(0.002)).toBe('warn');
    expect(judgeSpamRate(SPAM_RATE_CRITICAL)).toBe('critical');
    expect(judgeSpamRate(0.01)).toBe('critical');
  });

  it('is unknown rather than ok when there is no data', () => {
    expect(judgeSpamRate(null)).toBe('unknown');
    expect(judgeSpamRate(undefined)).toBe('unknown');
    expect(judgeSpamRate(Number.NaN)).toBe('unknown');
  });
});
