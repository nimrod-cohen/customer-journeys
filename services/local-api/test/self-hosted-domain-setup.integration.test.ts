// The sending-domain flow has to branch on the company's EMAIL PROVIDER.
//
// It used to assume Amazon SES: a company sending through the internal mail server
// opened its domain and was told "This company has no Amazon SES credentials. Add
// them in Company settings" — an account it will never have, for a provider it does
// not use, with no way forward.
//
// REAL Postgres: which provider a workspace resolves to is a join across companies
// and connectors, and that join is the thing being asserted.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import { makePgLookups, makeLocalDeps, dispatch, type DispatchEnv } from '../src/index.js';
import { tokenFor } from './seed.js';
import type { Pool } from 'pg';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

// A prefix of this file's OWN — the integration tier shares one database and every
// file cleans up by id, so reusing another file's ids means its teardown deletes
// your fixtures out from under you, mid-run.
const CO = '0c0da011-0000-4000-8000-000000000c01';
const WS = '0c0da011-0000-4000-8000-000000000a01';
const OWNER = '0c0da011-0000-4000-8000-0000000000b1';
// A real 2048-bit key's base64, shortened — the shape is what matters here.
const PUBKEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtest';

describeMaybe('sending-domain setup follows the email provider (real Postgres)', () => {
  let pool: Pool;
  let domainId: string;
  const e = (): DispatchEnv => ({ pool, lookups: makePgLookups(pool), deps: makeLocalDeps(pool) });
  const tok = () => tokenFor(OWNER, WS);
  const get = () =>
    dispatch({ method: 'GET', path: `/sending-domains/${domainId}`, authorization: tok(), query: {}, body: {} }, e());
  const check = () =>
    dispatch(
      { method: 'POST', path: `/sending-domains/${domainId}/check`, authorization: tok(), query: {}, body: {} },
      e(),
    );

  const setProvider = async (provider: string | null): Promise<void> => {
    await pool.query('DELETE FROM company_connectors WHERE company_id = $1', [CO]);
    if (provider) {
      await pool.query(
        `INSERT INTO company_connectors (company_id, channel, provider, config, enabled)
         VALUES ($1,'email',$2,'{}'::jsonb,true)`,
        [CO, provider],
      );
    }
  };

  async function cleanup(): Promise<void> {
    await pool.query('DELETE FROM company_connectors WHERE company_id = $1', [CO]);
    await pool.query('DELETE FROM domain_senders WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM sending_domains WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [WS]);
    await pool.query('DELETE FROM companies WHERE id = $1', [CO]);
  }

  beforeAll(async () => {
    pool = adminPool();
    await cleanup();
    await pool.query("INSERT INTO companies (id, name) VALUES ($1,'SelfHosted')", [CO]);
    await pool.query("INSERT INTO workspaces (id, company_id, name, status) VALUES ($1,$2,'W','active')", [WS, CO]);
    await pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS, OWNER]);
    const d = await dispatch(
      { method: 'POST', path: '/sending-domains', authorization: tok(), query: {}, body: { domain: 'acme-self.com' } },
      e(),
    );
    domainId = (d.body as { domain: { id: string } }).domain.id;
    process.env.SELF_HOSTED_DKIM_PUBLIC_KEY = PUBKEY;
  });

  afterAll(async () => {
    delete process.env.SELF_HOSTED_DKIM_PUBLIC_KEY;
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  it('shows a self-hosted company OUR signing key to publish, and never mentions SES', async () => {
    await setProvider('smtp');
    const body = (await get()).body as {
      provider: string;
      records: Array<{ type: string; name: string; value: string; required: boolean }>;
      sesError?: string;
      setupError?: string;
    };
    expect(body.provider).toBe('smtp');
    expect(body.sesError).toBeUndefined();
    expect(body.setupError).toBeUndefined();

    const dkim = body.records.find((r) => r.name.includes('_domainkey'));
    expect(dkim?.type).toBe('TXT'); // a TXT of our key, not an SES CNAME
    expect(dkim?.value).toContain(PUBKEY);
    expect(dkim?.required).toBe(true);
    // DMARC is required here: Gmail and Yahoo refuse bulk mail without it, so a
    // domain that verified without one would be rejected where it matters.
    expect(body.records.some((r) => r.name.startsWith('_dmarc.') && r.required)).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/Amazon SES/i);
  });

  // Before this, the check compared DNS against `dkim_tokens[0]` — always empty for
  // a self-hosted company — and an empty expected key matches any TXT record at all,
  // so a domain could verify without ever publishing our key.
  it('does not verify a self-hosted domain that has published nothing', async () => {
    await setProvider('smtp');
    const body = (await check()).body as { verified: boolean; selfHosted?: boolean };
    expect(body.selfHosted).toBe(true);
    expect(body.verified).toBe(false);
  });

  // Honest about our own gap rather than blaming the customer's DNS.
  it('says the deployment has no signing key when one is not configured', async () => {
    await setProvider('smtp');
    delete process.env.SELF_HOSTED_DKIM_PUBLIC_KEY;
    const body = (await get()).body as { records: unknown[]; setupError?: string };
    expect(body.records).toEqual([]);
    expect(body.setupError).toMatch(/no signing key/i);
    expect(body.setupError).not.toMatch(/Amazon|your DNS provider/i);
    process.env.SELF_HOSTED_DKIM_PUBLIC_KEY = PUBKEY;
  });

  it('tells a Resend company to verify in Resend, with nothing to publish here', async () => {
    await setProvider('resend');
    const body = (await get()).body as { provider: string; records: unknown[]; setupError?: string };
    expect(body.provider).toBe('resend');
    expect(body.records).toEqual([]);
    expect(body.setupError).toMatch(/Resend dashboard/i);
  });

  // The SES path is unchanged for the companies that actually use it.
  it('still asks an SES company for its credentials', async () => {
    await setProvider('ses');
    const body = (await get()).body as { sesError?: string; sesConfigured?: boolean };
    expect(body.sesConfigured).toBe(false);
    expect(body.sesError).toMatch(/Amazon SES credentials/i);
  });
});
