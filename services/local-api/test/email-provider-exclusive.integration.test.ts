// A company sends email through EXACTLY ONE provider: self-hosted SMTP, Amazon SES,
// or Resend. Never two at once.
//
// Before this, `UNIQUE (company_id, channel, provider)` let a company hold both an
// SES and a Resend connector, and resolution preferred Resend — so the provider that
// actually sent depended on resolution order rather than on what was configured, and
// a company could verify a domain for one provider while sending through another.
//
// REAL Postgres: the guarantee is half constraint, half handler, and only the
// database can prove the constraint.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const CO = '0c0d1122-0000-4000-8000-000000000c01';
const WS = '0c0d1122-0000-4000-8000-000000000a01';
const USER = '0c0d1122-0000-4000-8000-0000000000b1';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('one email provider per company (real Postgres)', () => {
  let world: TestWorld;
  const tok = () => tokenFor(USER, WS);

  const putConnector = (provider: string, config: Record<string, unknown>, secret = 'sekret') =>
    call(world.env, 'PUT', '/company/connectors', {
      token: tok(),
      body: { provider, config, secret },
    });

  async function cleanup(): Promise<void> {
    await world.pool.query('DELETE FROM company_connectors WHERE company_id=$1', [CO]);
    await world.pool.query('DELETE FROM workspace_users WHERE workspace_id=$1', [WS]);
    await world.pool.query('DELETE FROM workspaces WHERE id=$1', [WS]);
    await world.pool.query('DELETE FROM companies WHERE id=$1', [CO]);
  }

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    await world.pool.query("INSERT INTO companies (id, name) VALUES ($1,'Excl')", [CO]);
    await world.pool.query(
      "INSERT INTO workspaces (id, company_id, name, status) VALUES ($1,$2,'W','active')",
      [WS, CO],
    );
    await world.pool.query(
      "INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')",
      [WS, USER],
    );
  });

  afterAll(async () => {
    if (world) {
      await cleanup();
      await world.pool.end();
    }
  });

  it('accepts the first email provider', async () => {
    const res = await putConnector('ses', { region: 'il-central-1', access_key_id: 'AKIA' });
    expect(res.status).toBe(200);
  });

  it('refuses a SECOND email provider, naming the one in use', async () => {
    const res = await putConnector('resend', { from: 'hi@acme.com' });
    expect(res.status).toBe(409);
    const body = res.body as { error: string; currentProvider: string };
    expect(body.currentProvider).toBe('ses');
    expect(body.error).toMatch(/Amazon SES/);
    expect(body.error).toMatch(/one email provider at a time/);
  });

  it('allows re-configuring the SAME provider', async () => {
    const res = await putConnector('ses', { region: 'eu-west-1', access_key_id: 'AKIA2' });
    expect(res.status).toBe(200);
  });

  // Switching provider must not silently discard the old credentials.
  it('allows switching once the previous provider is disabled', async () => {
    await world.pool.query(
      "UPDATE company_connectors SET enabled = false WHERE company_id=$1 AND provider='ses'",
      [CO],
    );
    const res = await putConnector('resend', { from: 'hi@acme.com' });
    expect(res.status).toBe(200);

    const { rows } = await world.pool.query<{ provider: string; enabled: boolean }>(
      'SELECT provider, enabled FROM company_connectors WHERE company_id=$1 ORDER BY provider',
      [CO],
    );
    // The SES row is still there, just disabled — credentials survive the switch.
    expect(rows).toEqual([
      { provider: 'resend', enabled: true },
      { provider: 'ses', enabled: false },
    ]);
  });

  it('does not constrain the sms and whatsapp channels', async () => {
    expect(
      (await putConnector('019', { api_url: 'https://x', username: 'u', source: 's' })).status,
    ).toBe(200);
    expect((await putConnector('meta_whatsapp', { phone_number_id: '1' })).status).toBe(200);
  });

  // Self-hosted mail spends OUR IP reputation, so it is a platform-admin grant.
  it('refuses the self-hosted provider for an unauthorized company', async () => {
    await world.pool.query(
      "UPDATE company_connectors SET enabled = false WHERE company_id=$1 AND channel='email'",
      [CO],
    );
    const res = await putConnector('smtp', { from: 'hi@acme.com' }, '');
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/not authorized/i);
  });

  it('accepts it once a platform admin grants the company access', async () => {
    await world.pool.query('UPDATE companies SET self_hosted_mail_enabled = true WHERE id=$1', [CO]);
    const res = await putConnector('smtp', { from: 'hi@acme.com' }, '');
    expect(res.status).toBe(200);

    const { rows } = await world.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM company_connectors WHERE company_id=$1 AND channel='email' AND enabled",
      [CO],
    );
    expect(rows[0]!.n).toBe(1); // still exactly one
  });

  // Defence in depth: the handler check could be bypassed by a future code path,
  // so the database enforces it too.
  it('is enforced by the database, not only the handler', async () => {
    await expect(
      world.pool.query(
        "INSERT INTO company_connectors (company_id, channel, provider, config, enabled) VALUES ($1,'email','ses','{}'::jsonb,true)",
        [CO],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });
});
