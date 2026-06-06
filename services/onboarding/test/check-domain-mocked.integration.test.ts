import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import type { SesEmailClient, DkimStatus } from '@cdp/email';
import { startDomain } from '../src/start-domain.js';
import { checkDomain, type CheckDomainDeps } from '../src/check-domain.js';
import { makeWorkspaceTxRunner, makeSendingIdentityReader } from '../src/deps.js';
import { buildDnsRecordSet, type DnsRecordType } from '../src/core.js';
import type { DnsResolver } from '../src/check-domain.js';

// §16A — "Onboarding check-domain logic against mocked DNS/SES responses." REAL
// Postgres reads the persisted identity; DNS + SES are injected mocks. Confirms
// the per-record UX states and that the SES status (not DNS) drives dkimVerified.
const RUN = hasDatabaseUrl();

const ws = '0b0a0d00-0000-0000-0000-0000000000d1';
const domain = 'mail.checkmock.test';
const tokens = ['c1', 'c2', 'c3'];
const region = 'us-east-1';
const mailFrom = `mail.${domain}`;
const set = buildDnsRecordSet(domain, tokens, mailFrom, region);

async function cleanup(admin: Pool): Promise<void> {
  await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
}

function ses(status: DkimStatus): SesEmailClient {
  return {
    createDomainIdentity: vi.fn(async (d: string) => ({ identity: d, dkimTokens: tokens })),
    getIdentityVerificationAttributes: vi.fn(async () => ({
      dkimStatus: status,
      signingEnabled: status === 'SUCCESS',
      dkimTokens: tokens,
    })),
    createConfigurationSet: vi.fn(),
  } as unknown as SesEmailClient;
}

function dnsFrom(values: Map<string, string[]>): DnsResolver {
  return {
    async resolve(name: string, type: DnsRecordType) {
      return values.get(`${name}|${type}`) ?? [];
    },
  };
}

describe.skipIf(!RUN)('check-domain against mocked DNS/SES (real DB read)', () => {
  let admin: Pool;

  beforeAll(async () => {
    admin = adminPool();
    await cleanup(admin);
    await admin.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'C','onboarding')", [ws]);
    await startDomain(
      { ses: ses('PENDING'), region, runInWorkspaceTx: makeWorkspaceTxRunner(admin) },
      { workspaceId: ws, fromDomain: domain },
    );
  });

  afterAll(async () => {
    if (admin) {
      await cleanup(admin);
      await admin.end();
    }
  });

  it('all DNS found + SES PENDING → records found but dkimVerified false', async () => {
    const m = new Map<string, string[]>();
    for (const r of set.records) m.set(`${r.name}|${r.type}`, [r.value]);
    const deps: CheckDomainDeps = {
      ses: ses('PENDING'),
      dns: dnsFrom(m),
      identity: makeSendingIdentityReader(admin),
      region,
    };
    const res = await checkDomain(deps, { workspaceId: ws });
    expect(res.dkimVerified).toBe(false);
    expect(res.requiredRecordsResolved).toBe(true);
    expect(res.recordChecks.filter((c) => c.role === 'dkim').every((c) => c.status === 'found')).toBe(true);
  });

  it('no DNS + SES SUCCESS → dkimVerified true, required pending, records pending', async () => {
    const deps: CheckDomainDeps = {
      ses: ses('SUCCESS'),
      dns: dnsFrom(new Map()),
      identity: makeSendingIdentityReader(admin),
      region,
    };
    const res = await checkDomain(deps, { workspaceId: ws });
    expect(res.dkimVerified).toBe(true);
    expect(res.requiredRecordsResolved).toBe(false);
    expect(res.recordChecks.every((c) => c.status === 'pending')).toBe(true);
  });

  it('mismatch SPF surfaces a mismatch status (UX)', async () => {
    const m = new Map<string, string[]>();
    m.set(`${domain}|TXT`, ['v=spf1 include:sendgrid.net ~all']);
    const deps: CheckDomainDeps = {
      ses: ses('PENDING'),
      dns: dnsFrom(m),
      identity: makeSendingIdentityReader(admin),
      region,
    };
    const res = await checkDomain(deps, { workspaceId: ws });
    expect(res.recordChecks.find((c) => c.role === 'spf')!.status).toBe('mismatch');
  });

  it('throws for a workspace that never started onboarding', async () => {
    const deps: CheckDomainDeps = {
      ses: ses('PENDING'),
      dns: dnsFrom(new Map()),
      identity: makeSendingIdentityReader(admin),
      region,
    };
    await expect(
      checkDomain(deps, { workspaceId: '0b0a0d00-0000-0000-0000-0000000000ff' }),
    ).rejects.toThrow(/no sending identity/);
  });
});
