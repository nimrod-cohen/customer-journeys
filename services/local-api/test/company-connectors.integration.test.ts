// Per-company CONNECTORS (real Postgres): CRUD (secret write-only + encrypted) +
// channel availability. Email is enabled by a Resend connector (trusted) OR a SES
// connector WITH a verified sending_domain; SMS by 019; WhatsApp by meta.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool, isEncryptedSecret } from '@cdp/db';
import { makePgLookups, makeLocalDeps, dispatch, type DispatchEnv } from '../src/index.js';
import { tokenFor } from './seed.js';
import type { Pool } from 'pg';

const P = '0c0d0f04-0000-4000-8000-';
const CO = `${P}0000000000f1`;
const WS = `${P}000000000a01`;
const OWNER = `${P}0000000000b1`;

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('company connectors + channel availability (real Postgres)', () => {
  let pool: Pool;
  const env = (): DispatchEnv => ({ pool, lookups: makePgLookups(pool), deps: makeLocalDeps(pool) });
  const owner = () => tokenFor(OWNER, WS);
  const channels = async () =>
    ((await dispatch({ method: 'GET', path: '/company/channels', authorization: owner(), query: {}, body: {} }, env())).body as {
      channels: { email: boolean; sms: boolean; whatsapp: boolean };
    }).channels;

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
    await pool.query('DELETE FROM sending_domains WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM company_users WHERE company_id = $1', [CO]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [WS]);
    await pool.query('DELETE FROM companies WHERE id = $1', [CO]);
  }

  it('starts with no channels enabled', async () => {
    expect(await channels()).toEqual({ email: false, sms: false, whatsapp: false });
  });

  it('a Resend connector enables email (trusted From); secret is write-only + encrypted', async () => {
    const put = await dispatch(
      { method: 'PUT', path: '/company/connectors', authorization: owner(), query: {}, body: { provider: 'resend', config: { from: 'Acme <news@acme.com>' }, secret: 're_secret_key' } },
      env(),
    );
    expect(put.status).toBe(200);
    const list = await dispatch({ method: 'GET', path: '/company/connectors', authorization: owner(), query: {}, body: {} }, env());
    const conns = (list.body as { connectors: Array<{ channel: string; provider: string; has_secret: boolean; config: Record<string, unknown> }> }).connectors;
    expect(conns).toHaveLength(1);
    expect(conns[0]).toMatchObject({ channel: 'email', provider: 'resend', has_secret: true });
    expect(JSON.stringify(list.body)).not.toContain('re_secret_key'); // never returned
    const stored = await pool.query<{ secret: string }>("SELECT secret FROM company_connectors WHERE company_id=$1 AND provider='resend'", [CO]);
    expect(isEncryptedSecret(stored.rows[0]!.secret)).toBe(true);
    expect(await channels()).toMatchObject({ email: true });
  });

  it('a SES connector needs a verified sending_domain to enable email', async () => {
    await pool.query('DELETE FROM company_connectors WHERE company_id = $1', [CO]); // drop resend
    await dispatch({ method: 'PUT', path: '/company/connectors', authorization: owner(), query: {}, body: { provider: 'ses', config: { region: 'il-central-1', access_key_id: 'AKIA' }, secret: 'sk' } }, env());
    expect((await channels()).email).toBe(false); // SES but no verified domain
    await pool.query("INSERT INTO sending_domains (workspace_id, domain, verified) VALUES ($1,'acme.com',true)", [WS]);
    expect((await channels()).email).toBe(true); // now verified
  });

  it('019 → sms, meta → whatsapp; delete disables the channel', async () => {
    await dispatch({ method: 'PUT', path: '/company/connectors', authorization: owner(), query: {}, body: { provider: '019', config: { api_url: 'https://019', username: 'u', source: 'SRC' }, secret: 'bearer' } }, env());
    await dispatch({ method: 'PUT', path: '/company/connectors', authorization: owner(), query: {}, body: { provider: 'meta_whatsapp', config: { phone_number_id: 'PNID' }, secret: 'tok' } }, env());
    const c = await channels();
    expect(c.sms).toBe(true);
    expect(c.whatsapp).toBe(true);
    // delete the sms connector
    const list = await dispatch({ method: 'GET', path: '/company/connectors', authorization: owner(), query: {}, body: {} }, env());
    const smsId = (list.body as { connectors: Array<{ id: string; provider: string }> }).connectors.find((x) => x.provider === '019')!.id;
    await dispatch({ method: 'DELETE', path: `/company/connectors/${smsId}`, authorization: owner(), query: {}, body: {} }, env());
    expect((await channels()).sms).toBe(false);
  });

  it('rejects an unknown provider', async () => {
    const r = await dispatch({ method: 'PUT', path: '/company/connectors', authorization: owner(), query: {}, body: { provider: 'sendgrid', config: {}, secret: 'x' } }, env());
    expect(r.status).toBe(400);
  });
});
