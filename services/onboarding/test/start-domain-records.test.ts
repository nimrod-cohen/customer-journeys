import { describe, it, expect } from 'vitest';
import { buildDnsRecordSet } from '../src/core.js';

// §10A step 2 — the publishable record set: 3 DKIM CNAME, SPF TXT, MAIL FROM
// (MX + SPF), recommended DMARC TXT.
const domain = 'mail.acme.com';
const tokens = ['tok1', 'tok2', 'tok3'];
const mailFrom = 'bounce.mail.acme.com';
const region = 'us-east-1';

describe('buildDnsRecordSet', () => {
  const set = buildDnsRecordSet(domain, tokens, mailFrom, region);
  const byRole = (role: string) => set.records.filter((r) => r.role === role);

  it('emits exactly 3 DKIM CNAME records (required)', () => {
    const dkim = byRole('dkim');
    expect(dkim).toHaveLength(3);
    for (const d of dkim) {
      expect(d.type).toBe('CNAME');
      expect(d.required).toBe(true);
      expect(d.name).toMatch(/\._domainkey\.mail\.acme\.com$/);
      expect(d.value).toMatch(/\.dkim\.amazonses\.com$/);
    }
  });

  it('emits an SPF TXT on the from domain including amazonses.com (required)', () => {
    const spf = byRole('spf');
    expect(spf).toHaveLength(1);
    expect(spf[0]!.type).toBe('TXT');
    expect(spf[0]!.name).toBe(domain);
    expect(spf[0]!.value).toContain('include:amazonses.com');
    expect(spf[0]!.required).toBe(true);
  });

  it('emits MAIL FROM MX + SPF on the subdomain (required), MX region-parameterized', () => {
    const mx = byRole('mailfrom_mx');
    const sub = byRole('mailfrom_spf');
    expect(mx).toHaveLength(1);
    expect(mx[0]!.type).toBe('MX');
    expect(mx[0]!.name).toBe(mailFrom);
    expect(mx[0]!.value).toBe(`feedback-smtp.${region}.amazonses.com`);
    expect(mx[0]!.priority).toBe(10);
    expect(mx[0]!.required).toBe(true);
    expect(sub).toHaveLength(1);
    expect(sub[0]!.type).toBe('TXT');
    expect(sub[0]!.name).toBe(mailFrom);
    expect(sub[0]!.required).toBe(true);
  });

  it('emits a recommended (NOT required) DMARC TXT starting at p=none', () => {
    const dmarc = byRole('dmarc');
    expect(dmarc).toHaveLength(1);
    expect(dmarc[0]!.type).toBe('TXT');
    expect(dmarc[0]!.name).toBe(`_dmarc.${domain}`);
    expect(dmarc[0]!.value).toContain('v=DMARC1');
    expect(dmarc[0]!.value).toContain('p=none');
    expect(dmarc[0]!.required).toBe(false);
  });

  it('the MX region is parameterized', () => {
    const eu = buildDnsRecordSet(domain, tokens, mailFrom, 'eu-west-1');
    expect(eu.records.find((r) => r.role === 'mailfrom_mx')!.value).toBe(
      'feedback-smtp.eu-west-1.amazonses.com',
    );
  });

  it('throws without a fromDomain / region', () => {
    expect(() => buildDnsRecordSet('', tokens, mailFrom, region)).toThrow(/fromDomain/);
    expect(() => buildDnsRecordSet(domain, tokens, mailFrom, '')).toThrow(/region/);
  });
});
