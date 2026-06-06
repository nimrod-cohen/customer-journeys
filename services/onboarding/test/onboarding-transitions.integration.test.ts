import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import type { SesEmailClient, DkimStatus } from '@cdp/email';
import { startDomain } from '../src/start-domain.js';
import { activate, type ActivateDeps } from '../src/activate.js';
import {
  makeWorkspaceTxRunner,
  makeSendingIdentityReader,
  configSetNameFor,
} from '../src/deps.js';
import { buildDnsRecordSet, type DnsRecordType } from '../src/core.js';
import type { DnsResolver } from '../src/check-domain.js';

// §10A / §16A integration tier — REAL local Postgres (DB NOT mocked); SES + DNS
// are injected fakes (never real). Exercises the full onboarding state machine:
// onboarding → (start persists identity) → (activate gated on SES) → active.
const RUN = hasDatabaseUrl();

const ws = '0b0a0d00-0000-0000-0000-0000000000a1'; // file-local namespace
const domain = 'mail.transitions.test';
const tokens = ['tr1', 'tr2', 'tr3'];
const region = 'us-east-1';

async function cleanup(admin: Pool): Promise<void> {
  await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
}

function sesWith(status: DkimStatus): SesEmailClient {
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

function dnsRequiredFound(mailFrom: string): DnsResolver {
  const set = buildDnsRecordSet(domain, tokens, mailFrom, region);
  const m = new Map<string, string[]>();
  for (const r of set.records) if (r.required && r.role !== 'dkim') m.set(`${r.name}|${r.type}`, [r.value]);
  return {
    async resolve(name: string, type: DnsRecordType) {
      return m.get(`${name}|${type}`) ?? [];
    },
  };
}

describe.skipIf(!RUN)('onboarding state transitions (real Postgres)', () => {
  let admin: Pool;

  beforeAll(async () => {
    admin = adminPool();
    await cleanup(admin);
    await admin.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'T','onboarding')", [ws]);
  });

  afterAll(async () => {
    if (admin) {
      await cleanup(admin);
      await admin.end();
    }
  });

  async function statusOf(): Promise<{ status: string; si: Record<string, unknown> }> {
    const { rows } = await admin.query('SELECT status, sending_identity FROM workspaces WHERE id = $1', [ws]);
    return { status: rows[0].status, si: rows[0].sending_identity };
  }

  it('starts onboarding and persists the sending identity (still onboarding)', async () => {
    await startDomain(
      { ses: sesWith('PENDING'), region, runInWorkspaceTx: makeWorkspaceTxRunner(admin) },
      { workspaceId: ws, fromDomain: domain },
    );
    const { status, si } = await statusOf();
    expect(status).toBe('onboarding');
    expect(si.from_domain).toBe(domain);
    expect(si.verified).toBe(false);
    expect(si.dkim_tokens).toEqual(tokens);
  });

  it('activate is DENIED while SES DKIM is PENDING (status stays onboarding)', async () => {
    const deps: ActivateDeps = {
      ses: sesWith('PENDING'),
      dns: dnsRequiredFound(`mail.${domain}`),
      identity: makeSendingIdentityReader(admin),
      region,
      runInWorkspaceTx: makeWorkspaceTxRunner(admin),
      configSetName: configSetNameFor,
    };
    const out = await activate(deps, { workspaceId: ws });
    expect(out.decision.allowed).toBe(false);
    expect((await statusOf()).status).toBe('onboarding');
  });

  it('activate SUCCEEDS once SES DKIM is SUCCESS + required DNS resolves → active+verified', async () => {
    const deps: ActivateDeps = {
      ses: sesWith('SUCCESS'),
      dns: dnsRequiredFound(`mail.${domain}`),
      identity: makeSendingIdentityReader(admin),
      region,
      runInWorkspaceTx: makeWorkspaceTxRunner(admin),
      configSetName: configSetNameFor,
    };
    const out = await activate(deps, { workspaceId: ws });
    expect(out.decision.allowed).toBe(true);
    const { status, si } = await statusOf();
    expect(status).toBe('active');
    expect(si.verified).toBe(true);
    expect(si.config_set).toBe(configSetNameFor(ws));
  });
});
