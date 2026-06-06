import { describe, it, expect } from 'vitest';
import {
  activateDecision,
  buildActivateUpdate,
  buildDnsRecordSet,
  checkDomainCore,
  type DnsAnswer,
} from '../src/core.js';

// §10A step 4 / CRITICAL invariant — the activate gate is SES DKIM status, NOT
// DNS. Proven with decoupled inputs:
//   - DNS-all-found + SES PENDING            → DENY
//   - SES SUCCESS + a required DNS pending   → DENY
//   - SES SUCCESS + required DNS resolved    → ALLOW
//   - DMARC is recommended, not required.
const domain = 'mail.acme.com';
const tokens = ['t1', 't2', 't3'];
const mailFrom = 'bounce.mail.acme.com';
const region = 'us-east-1';
const set = buildDnsRecordSet(domain, tokens, mailFrom, region);
const ws = '22222222-0000-0000-0000-000000000002';
const cfg = `cdp-ws-${ws}`;

const ans = (name: string, type: 'CNAME' | 'TXT' | 'MX', values: string[]): DnsAnswer => ({
  name,
  type,
  values,
});
const allFound = (): DnsAnswer[] => set.records.map((r) => ans(r.name, r.type, [r.value]));
const requiredNonDkimFound = (): DnsAnswer[] =>
  set.records.filter((r) => r.required && r.role !== 'dkim').map((r) => ans(r.name, r.type, [r.value]));

describe('activateDecision — SES is the gate', () => {
  it('DENIES when DNS is all-found but SES DKIM is PENDING', () => {
    const check = checkDomainCore(set, allFound(), 'PENDING');
    const d = activateDecision(check.dkimStatus, check, cfg);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/PENDING/);
    expect(d.configSetName).toBeUndefined();
  });

  it('DENIES when SES is SUCCESS but a required DNS record is pending', () => {
    // Only SPF present; MAIL FROM missing.
    const spf = set.records.find((r) => r.role === 'spf')!;
    const check = checkDomainCore(set, [ans(spf.name, 'TXT', [spf.value])], 'SUCCESS');
    const d = activateDecision(check.dkimStatus, check, cfg);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/Required DNS records/);
  });

  it('ALLOWS only when SES SUCCESS AND required records resolve (DKIM DNS not needed)', () => {
    // DKIM CNAMEs intentionally NOT in DNS — SES SUCCESS is the gate.
    const check = checkDomainCore(set, requiredNonDkimFound(), 'SUCCESS');
    const d = activateDecision(check.dkimStatus, check, cfg);
    expect(d.allowed).toBe(true);
    expect(d.configSetName).toBe(cfg);
  });

  it('ALLOWS with DMARC absent (recommended, not required)', () => {
    const answers = requiredNonDkimFound(); // no DMARC answer
    const check = checkDomainCore(set, answers, 'SUCCESS');
    expect(check.recordChecks.find((c) => c.role === 'dmarc')!.status).toBe('pending');
    expect(activateDecision(check.dkimStatus, check, cfg).allowed).toBe(true);
  });

  it('DENIES for FAILED / NOT_STARTED SES statuses regardless of DNS', () => {
    for (const status of ['FAILED', 'NOT_STARTED', 'TEMPORARY_FAILURE'] as const) {
      const check = checkDomainCore(set, allFound(), status);
      expect(activateDecision(check.dkimStatus, check, cfg).allowed).toBe(false);
    }
  });
});

describe('buildActivateUpdate', () => {
  it('flips status=active + verified=true on exactly one workspace row (scoped $1)', () => {
    const check = checkDomainCore(set, requiredNonDkimFound(), 'SUCCESS');
    const stmt = buildActivateUpdate(ws, cfg, check.recordChecks);
    expect(stmt.values[0]).toBe(ws);
    expect(stmt.text).toMatch(/UPDATE workspaces/i);
    expect(stmt.text).toMatch(/status = 'active'/);
    expect(stmt.text).toMatch(/WHERE id = \$1/);
    const patch = JSON.parse(String(stmt.values[1]));
    expect(patch.verified).toBe(true);
    expect(patch.config_set).toBe(cfg);
    expect(Array.isArray(patch.record_checks)).toBe(true);
  });

  it('throws without workspace id (guard)', () => {
    expect(() => buildActivateUpdate('', cfg, [])).toThrow(/workspaceId/);
  });
});
