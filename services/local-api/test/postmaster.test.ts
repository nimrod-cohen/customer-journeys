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
  // The real v2 payload, captured from the live API: a rowData array of
  // requirement/status pairs plus three separate verdicts — NOT the flat
  // {spfStatus, dkimStatus, dmarcStatus} the shape reads like at first glance.
  const REAL = JSON.stringify({
    name: 'domains/acme.com/complianceStatus',
    complianceData: {
      domainId: 'acme.com',
      rowData: [
        { requirement: 'SPF_AND_DKIM', status: { status: 'COMPLIANT' } },
        { requirement: 'DMARC_ALIGNMENT', status: { status: 'COMPLIANT' } },
        { requirement: 'DMARC_POLICY', status: { status: 'NON_COMPLIANT' } },
        { requirement: 'ENCRYPTION', status: { status: 'COMPLIANT' } },
        { requirement: 'USER_REPORTED_SPAM_RATE', status: { status: 'COMPLIANT' } },
        { requirement: 'DNS_RECORDS', status: { status: 'COMPLIANT' } },
      ],
      oneClickUnsubscribeVerdict: { status: { status: 'COMPLIANT' } },
      honorUnsubscribeVerdict: { status: { status: 'COMPLIANT' } },
      deliverabilityStatusVerdict: { state: { status: 'COMPLIANT' }, reason: 'USER_FEEDBACK_POSITIVE' },
    },
  });

  it("reads Gmail's whole bulk-sender checklist", async () => {
    const f = fake({ 'GET /domains/acme.com/complianceStatus': { status: 200, body: REAL } });
    const c = await f.client.getComplianceStatus(DOMAIN);
    expect(c.requirements.SPF_AND_DKIM).toBe('COMPLIANT');
    expect(c.requirements.DMARC_POLICY).toBe('NON_COMPLIANT');
    expect(Object.keys(c.requirements)).toHaveLength(6);
    expect(c.oneClickUnsubscribe).toBe('COMPLIANT');
    expect(c.honorUnsubscribe).toBe('COMPLIANT');
    expect(c.deliverability).toBe('COMPLIANT');
    expect(c.deliverabilityReason).toBe('USER_FEEDBACK_POSITIVE');
  });

  it('degrades to empty rather than throwing on an unexpected body', async () => {
    const f = fake({ 'GET /domains/acme.com/complianceStatus': { status: 200, body: 'not json' } });
    const c = await f.client.getComplianceStatus(DOMAIN);
    expect(c.requirements).toEqual({});
    expect(c.deliverability).toBeNull();
  });
});

describe('getMetrics', () => {
  // Also the real shape: value is a wrapper, and `metric` echoes the NAME we chose.
  const REAL = JSON.stringify({
    domainStats: [
      { name: 'domains/acme.com/domainStats/spamrate.nofilter.20260813', metric: 'spam_rate', value: { floatValue: 0.0025 }, date: { year: 2026, month: 8, day: 13 } },
      { name: 'domains/acme.com/domainStats/spamrate.nofilter.20260814', metric: 'spam_rate', value: { floatValue: 0 }, date: { year: 2026, month: 8, day: 14 } },
    ],
  });

  it('maps daily values and formats the date', async () => {
    const f = fake({ 'POST /domains/acme.com/domainStats:query': { status: 200, body: REAL } });
    const m = await f.client.getMetrics(DOMAIN, 14);
    expect(m).toHaveLength(2);
    expect(m[0]).toEqual({ metric: 'spam_rate', value: 0.0025, date: '2026-08-13' });
    expect(m[1]!.value).toBe(0); // zero is a real value, not "missing"
  });

  // Omitting `parent` from the BODY (it is already in the path) yields a bare
  // INVALID_ARGUMENT naming no field — an easy afternoon to lose.
  it('sends parent in the body as well as the path', async () => {
    const f = fake({ 'POST /domains/acme.com/domainStats:query': { status: 200, body: '{}' } });
    await f.client.getMetrics(DOMAIN, 7);
    const body = JSON.parse(f.calls[0]!.body!);
    expect(body.parent).toBe('domains/acme.com');
    expect(body.metricDefinitions[0].baseMetric.standardMetric).toBe('SPAM_RATE');
    expect(body.timeQuery.dateRanges.dateRanges[0].start).toHaveProperty('year');
  });

  // Gmail publishes on a lag; asking for today reliably returns nothing and looks
  // like a broken integration.
  it('ends the window two days back to allow for Gmail publishing lag', async () => {
    const f = fake({ 'POST /domains/acme.com/domainStats:query': { status: 200, body: '{}' } });
    await f.client.getMetrics(DOMAIN, 7);
    const end = JSON.parse(f.calls[0]!.body!).timeQuery.dateRanges.dateRanges[0].end;
    const asDate = Date.UTC(end.year, end.month - 1, end.day);
    const daysAgo = Math.round((Date.now() - asDate) / 86_400_000);
    expect(daysAgo).toBeGreaterThanOrEqual(2);
  });

  it('handles an OVERALL aggregate with no date', async () => {
    const f = fake({
      'POST /domains/acme.com/domainStats:query': {
        status: 200,
        body: JSON.stringify({ domainStats: [{ metric: 'spam_rate', value: { floatValue: 0.00254 } }] }),
      },
    });
    const m = await f.client.getMetrics(DOMAIN, 30, ['SPAM_RATE'], 'OVERALL');
    expect(m[0]).toEqual({ metric: 'spam_rate', value: 0.00254, date: null });
  });

  it('returns empty when Gmail has no data for a low-volume domain', async () => {
    const f = fake({ 'POST /domains/acme.com/domainStats:query': { status: 200, body: '{}' } });
    expect(await f.client.getMetrics(DOMAIN, 7)).toEqual([]);
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
