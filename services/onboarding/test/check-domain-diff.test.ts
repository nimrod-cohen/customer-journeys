import { describe, it, expect } from 'vitest';
import {
  buildDnsRecordSet,
  checkDomainCore,
  diffRecord,
  type DnsAnswer,
  type DnsRecord,
} from '../src/core.js';

// §10A step 3 — per-record DNS diffing for the live UX, and the combined
// checkDomainCore. CRITICAL: DKIM verification comes from the SES status arg,
// NOT from the DKIM CNAME DNS answers; SPF/MAILFROM are gated by DNS; DMARC is
// recommended (never in the required set).
const domain = 'mail.acme.com';
const tokens = ['t1', 't2', 't3'];
const mailFrom = 'bounce.mail.acme.com';
const region = 'us-east-1';
const set = buildDnsRecordSet(domain, tokens, mailFrom, region);

function answer(rec: DnsRecord, values: string[]): DnsAnswer {
  return { name: rec.name, type: rec.type, values };
}
function allRequiredNonDkimFound(): DnsAnswer[] {
  return set.records
    .filter((r) => r.required && r.role !== 'dkim')
    .map((r) => answer(r, [r.value]));
}

describe('diffRecord', () => {
  it('pending when there is no answer', () => {
    const rec = set.records[0]!;
    expect(diffRecord(rec, undefined).status).toBe('pending');
  });

  it('found when the answer matches (CNAME, trailing-dot/case insensitive)', () => {
    const dkim = set.records.find((r) => r.role === 'dkim')!;
    expect(diffRecord(dkim, answer(dkim, [dkim.value.toUpperCase() + '.'])).status).toBe('found');
  });

  it('found for SPF when amazonses.com is included even with extra includes', () => {
    const spf = set.records.find((r) => r.role === 'spf')!;
    const got = diffRecord(spf, answer(spf, ['v=spf1 include:_spf.google.com include:amazonses.com ~all']));
    expect(got.status).toBe('found');
  });

  it('mismatch when an answer exists but does not match', () => {
    const spf = set.records.find((r) => r.role === 'spf')!;
    expect(diffRecord(spf, answer(spf, ['v=spf1 include:sendgrid.net ~all'])).status).toBe('mismatch');
  });

  it('found for DMARC for any v=DMARC1 policy the user published', () => {
    const dmarc = set.records.find((r) => r.role === 'dmarc')!;
    expect(diffRecord(dmarc, answer(dmarc, ['v=DMARC1; p=reject'])).status).toBe('found');
  });
});

describe('checkDomainCore — DKIM gate is SES, not DNS', () => {
  it('dkimVerified is TRUE from SES SUCCESS even when DKIM CNAMEs are NOT in DNS', () => {
    // No DKIM answers at all; only required non-DKIM resolved.
    const res = checkDomainCore(set, allRequiredNonDkimFound(), 'SUCCESS');
    expect(res.dkimVerified).toBe(true);
    expect(res.dkimStatus).toBe('SUCCESS');
    // The DKIM records themselves show pending in the UX (no DNS answer)…
    expect(res.recordChecks.filter((c) => c.role === 'dkim').every((c) => c.status === 'pending')).toBe(true);
    // …but required (non-DKIM) records resolved.
    expect(res.requiredRecordsResolved).toBe(true);
  });

  it('dkimVerified is FALSE from SES PENDING even when DKIM CNAMEs ARE in DNS', () => {
    // Provide ALL answers including DKIM, but SES says PENDING.
    const answers = set.records.map((r) => answer(r, [r.value]));
    const res = checkDomainCore(set, answers, 'PENDING');
    expect(res.dkimVerified).toBe(false);
    // DNS shows the DKIM records as found, but that does NOT verify DKIM.
    expect(res.recordChecks.filter((c) => c.role === 'dkim').every((c) => c.status === 'found')).toBe(true);
  });

  it('requiredRecordsResolved is FALSE when a required non-DKIM record is pending', () => {
    // Only SPF found; MAIL FROM missing.
    const spf = set.records.find((r) => r.role === 'spf')!;
    const res = checkDomainCore(set, [answer(spf, [spf.value])], 'SUCCESS');
    expect(res.requiredRecordsResolved).toBe(false);
  });

  it('DMARC pending does NOT block requiredRecordsResolved (recommended only)', () => {
    // All required non-DKIM found, DMARC absent.
    const res = checkDomainCore(set, allRequiredNonDkimFound(), 'SUCCESS');
    expect(res.recordChecks.find((c) => c.role === 'dmarc')!.status).toBe('pending');
    expect(res.requiredRecordsResolved).toBe(true);
  });
});
