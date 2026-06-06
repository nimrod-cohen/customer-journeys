import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import type { SesEmailClient, DkimStatus } from '@cdp/email';
import { activate, type ActivateDeps } from '../src/activate.js';
import { startDomain } from '../src/start-domain.js';
import {
  makeWorkspaceTxRunner,
  makeSendingIdentityReader,
  configSetNameFor,
} from '../src/deps.js';
import { buildDnsRecordSet, type DnsRecordType } from '../src/core.js';
import type { DnsResolver } from '../src/check-domain.js';

// §10A / §3 / AC isolation — activating ONE workspace must NOT affect another.
// REAL Postgres; SES/DNS injected. wsA activates; wsB remains untouched
// (onboarding). The activate UPDATE touches exactly one row.
const RUN = hasDatabaseUrl();

const wsA = '0b0a0d00-0000-0000-0000-0000000000c1';
const wsB = '0b0a0d00-0000-0000-0000-0000000000c2';
const region = 'us-east-1';
const tokens = ['s1', 's2', 's3'];

async function cleanup(admin: Pool): Promise<void> {
  for (const ws of [wsA, wsB]) await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
}

function ses(status: DkimStatus): SesEmailClient {
  return {
    createDomainIdentity: vi.fn(async (d: string) => ({ identity: d, dkimTokens: tokens })),
    getIdentityVerificationAttributes: vi.fn(async () => ({
      dkimStatus: status,
      signingEnabled: status === 'SUCCESS',
      dkimTokens: tokens,
    })),
    createConfigurationSet: vi.fn(async () => {}),
  } as unknown as SesEmailClient;
}

function dnsFound(domain: string, mailFrom: string): DnsResolver {
  const set = buildDnsRecordSet(domain, tokens, mailFrom, region);
  const m = new Map<string, string[]>();
  for (const r of set.records) if (r.required && r.role !== 'dkim') m.set(`${r.name}|${r.type}`, [r.value]);
  return {
    async resolve(name: string, type: DnsRecordType) {
      return m.get(`${name}|${type}`) ?? [];
    },
  };
}

describe.skipIf(!RUN)('onboarding workspace scoping (real Postgres)', () => {
  let admin: Pool;
  const domainA = 'mail.a-scope.test';
  const domainB = 'mail.b-scope.test';

  beforeAll(async () => {
    admin = adminPool();
    await cleanup(admin);
    await admin.query(
      "INSERT INTO workspaces (id, name, status) VALUES ($1,'A','onboarding'),($2,'B','onboarding')",
      [wsA, wsB],
    );
    // Both start onboarding (persist their identities).
    await startDomain(
      { ses: ses('PENDING'), region, runInWorkspaceTx: makeWorkspaceTxRunner(admin) },
      { workspaceId: wsA, fromDomain: domainA },
    );
    await startDomain(
      { ses: ses('PENDING'), region, runInWorkspaceTx: makeWorkspaceTxRunner(admin) },
      { workspaceId: wsB, fromDomain: domainB },
    );
  });

  afterAll(async () => {
    if (admin) {
      await cleanup(admin);
      await admin.end();
    }
  });

  it('activating wsA does not touch wsB', async () => {
    const deps: ActivateDeps = {
      ses: ses('SUCCESS'),
      dns: dnsFound(domainA, `mail.${domainA}`),
      identity: makeSendingIdentityReader(admin),
      region,
      runInWorkspaceTx: makeWorkspaceTxRunner(admin),
      configSetName: configSetNameFor,
    };
    const out = await activate(deps, { workspaceId: wsA });
    expect(out.decision.allowed).toBe(true);

    const a = await admin.query('SELECT status, sending_identity FROM workspaces WHERE id = $1', [wsA]);
    const b = await admin.query('SELECT status, sending_identity FROM workspaces WHERE id = $1', [wsB]);
    expect(a.rows[0].status).toBe('active');
    expect(a.rows[0].sending_identity.verified).toBe(true);
    // wsB untouched.
    expect(b.rows[0].status).toBe('onboarding');
    expect(b.rows[0].sending_identity.verified).toBe(false);
    expect(b.rows[0].sending_identity.config_set ?? null).toBeNull();
  });

  it('the activate UPDATE touched exactly one active row', async () => {
    const { rows } = await admin.query(
      "SELECT count(*)::int n FROM workspaces WHERE id = ANY($1) AND status = 'active'",
      [[wsA, wsB]],
    );
    expect(rows[0].n).toBe(1);
  });
});
