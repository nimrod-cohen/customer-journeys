// Configuration readiness over HTTP (real Postgres): GET /company/readiness reflects the
// real config state and derives the channel-enabled booleans. Email is READY only with a
// provider connector + a verified sending domain + a named sender (the user's rule).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import { makePgLookups, makeLocalDeps, dispatch, type DispatchEnv } from '../src/index.js';
import { tokenFor } from './seed.js';
import type { Pool } from 'pg';

const P = '0c0d0f0a-0000-4000-8000-';
const CO = `${P}0000000000f1`;
const WS = `${P}000000000a01`;
const OWNER = `${P}0000000000b1`;

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

interface Check {
  id: string;
  severity: string;
  status: string;
  items: { label: string; ok: boolean }[];
}
interface Readiness {
  checks: Check[];
  channels: { email: boolean; sms: boolean; whatsapp: boolean };
  errorCount: number;
  warningCount: number;
}

describeMaybe('GET /company/readiness (real Postgres)', () => {
  let pool: Pool;
  const env = (): DispatchEnv => ({ pool, lookups: makePgLookups(pool), deps: makeLocalDeps(pool) });
  const owner = () => tokenFor(OWNER, WS);
  const readiness = async (): Promise<Readiness> =>
    (await dispatch({ method: 'GET', path: '/company/readiness', authorization: owner(), query: {}, body: {} }, env()))
      .body as Readiness;
  const check = (r: Readiness, id: string) => r.checks.find((c) => c.id === id)!;

  beforeAll(async () => {
    pool = adminPool();
    await cleanup();
    await pool.query("INSERT INTO companies (id, name) VALUES ($1,'Acme')", [CO]);
    await pool.query("INSERT INTO workspaces (id, name, status, company_id) VALUES ($1,'W','active',$2)", [WS, CO]);
    await pool.query("INSERT INTO company_users (company_id, user_id, role) VALUES ($1,$2,'owner')", [CO, OWNER]);
  });
  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });
  async function cleanup(): Promise<void> {
    await pool.query('DELETE FROM company_connectors WHERE company_id = $1', [CO]);
    await pool.query('DELETE FROM domain_senders WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM sending_domains WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM company_r2_config WHERE company_id = $1', [CO]);
    await pool.query('DELETE FROM company_users WHERE company_id = $1', [CO]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [WS]);
    await pool.query('DELETE FROM companies WHERE id = $1', [CO]);
  }

  it('nothing configured → all channels disabled, 3 errors + a storage warning', async () => {
    const r = await readiness();
    expect(r.channels).toEqual({ email: false, sms: false, whatsapp: false });
    expect(r.errorCount).toBe(3);
    expect(r.warningCount).toBe(1);
    expect(check(r, 'storage').severity).toBe('warning');
  });

  it('email walks provider → domain → sender, and is READY only when all present', async () => {
    // provider only
    await pool.query(
      "INSERT INTO company_connectors (company_id, channel, provider, config, enabled) VALUES ($1,'email','ses','{\"region\":\"il-central-1\"}'::jsonb,true)",
      [CO],
    );
    expect(check(await readiness(), 'email').status).toBe('incomplete'); // no domain

    // + verified domain, still no sender
    await pool.query(
      "INSERT INTO sending_domains (workspace_id, domain, verified, verified_at) VALUES ($1,'mail.acme.test',true,now())",
      [WS],
    );
    let r = await readiness();
    expect(r.channels.email).toBe(false);
    expect(check(r, 'email').items.find((i) => /sender/i.test(i.label))!.ok).toBe(false);

    // + a sender → READY, channel enabled
    await pool.query(
      "INSERT INTO domain_senders (workspace_id, domain, name, email) VALUES ($1,'mail.acme.test','Acme','team@mail.acme.test')",
      [WS],
    );
    r = await readiness();
    expect(r.channels.email).toBe(true);
    expect(check(r, 'email').status).toBe('ready');
  });

  it('sms + whatsapp connectors enable their channels; R2 config clears the warning', async () => {
    await pool.query(
      `INSERT INTO company_connectors (company_id, channel, provider, config, enabled) VALUES
         ($1,'sms','019','{}'::jsonb,true), ($1,'whatsapp','meta_whatsapp','{}'::jsonb,true)`,
      [CO],
    );
    let r = await readiness();
    expect(r.channels.sms).toBe(true);
    expect(r.channels.whatsapp).toBe(true);
    expect(r.errorCount).toBe(0); // email (from prior test) + sms + whatsapp all ready
    expect(r.warningCount).toBe(1); // still no R2

    await pool.query(
      "INSERT INTO company_r2_config (company_id, endpoint, bucket, access_key_id, secret_access_key) VALUES ($1,'https://r2','b','k','s')",
      [CO],
    );
    r = await readiness();
    expect(check(r, 'storage').status).toBe('ready');
    expect(r.warningCount).toBe(0);
  });
});
