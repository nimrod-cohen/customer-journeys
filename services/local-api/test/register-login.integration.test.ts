// Self-service company-owner registration + first-workspace bootstrap + login
// (§12). REAL Postgres. Registration creates a COMPANY + owner only (NO
// workspace): the owner lands in the needs_workspace state, can log in (not
// 403'd), then creates their first workspace via /workspace/bootstrap and is
// logged into it. Duplicate email is 409; a user with NO access (owns no company,
// no membership, not platform admin) is still rejected at login.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import { createApp } from '../src/index.js';
import { encodeDevToken } from '../src/auth.js';
import type { Pool } from 'pg';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

const EMAIL = 'owner-regtest@example.com';
const PW = 'sup3r-secret-pw';
const ORPHAN = '0c0d0e90-0000-4000-8000-0000000000c1'; // a user id with no company + no membership

describeMaybe('register + bootstrap + login (real Postgres)', () => {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;
  const post = (path: string, body: unknown) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const get = (path: string, token: string) =>
    app.request(path, { headers: { authorization: `Bearer ${token}` } });
  const postAuth = (path: string, token: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  const loginBody = async () =>
    (await (await post('/auth/dev-login', { email: EMAIL, password: PW })).json()) as {
      token: string;
      workspace_id: string | null;
      needs_workspace?: boolean;
    };

  beforeAll(async () => {
    pool = adminPool();
    app = createApp({ pool });
    await cleanup();
  });
  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  // Remove the test owner and everything they own, in either state (company-only
  // after registration, or company + workspace(s) after bootstrap).
  async function cleanup(): Promise<void> {
    const { rows: users } = await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [EMAIL]);
    for (const u of users) {
      const { rows: comps } = await pool.query<{ id: string }>('SELECT id FROM companies WHERE owner_user_id = $1', [
        u.id,
      ]);
      const wsIds = new Set<string>();
      for (const c of comps) {
        const { rows: ws } = await pool.query<{ id: string }>('SELECT id FROM workspaces WHERE company_id = $1', [c.id]);
        ws.forEach((w) => wsIds.add(w.id));
      }
      const { rows: mem } = await pool.query<{ workspace_id: string }>(
        'SELECT workspace_id FROM workspace_users WHERE user_id = $1',
        [u.id],
      );
      mem.forEach((m) => wsIds.add(m.workspace_id));
      for (const wid of wsIds) {
        await pool.query('DELETE FROM domain_senders WHERE workspace_id = $1', [wid]);
        await pool.query('DELETE FROM sending_domains WHERE workspace_id = $1', [wid]);
        await pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [wid]);
        await pool.query('DELETE FROM workspaces WHERE id = $1', [wid]);
      }
      await pool.query('DELETE FROM workspace_users WHERE user_id = $1', [u.id]);
      for (const c of comps) {
        await pool.query('DELETE FROM company_ses_config WHERE company_id = $1', [c.id]);
        await pool.query('DELETE FROM companies WHERE id = $1', [c.id]);
      }
    }
    await pool.query('DELETE FROM users WHERE email = $1', [EMAIL]);
  }

  it('registration creates a company + owner only (no workspace) → needs_workspace', async () => {
    const r = await post('/auth/register', {
      name: 'Reg Owner',
      email: EMAIL,
      password: PW,
      company_name: 'Reg Test Co',
    });
    expect(r.status).toBe(201);
    const b = (await r.json()) as {
      token: string;
      workspace_id: string | null;
      is_platform_admin: boolean;
      needs_workspace: boolean;
      memberships: unknown[];
      company: { id: string; name: string };
    };
    expect(b.token).toBeTruthy();
    expect(b.workspace_id).toBeNull();
    expect(b.is_platform_admin).toBe(false);
    expect(b.needs_workspace).toBe(true);
    expect(b.memberships).toEqual([]);
    expect(b.company.name).toBe('Reg Test Co');
  });

  it('a workspace-less owner can log in (needs_workspace) — NOT rejected', async () => {
    const r = await post('/auth/dev-login', { email: EMAIL, password: PW });
    expect(r.status).toBe(200);
    const b = (await r.json()) as { workspace_id: string | null; needs_workspace?: boolean };
    expect(b.workspace_id).toBeNull();
    expect(b.needs_workspace).toBe(true);
  });

  it('the owner creates their first workspace via bootstrap → logged into it as owner', async () => {
    const login = await loginBody();
    const r = await postAuth('/workspace/bootstrap', login.token, { name: 'Main' });
    expect(r.status).toBe(201);
    const b = (await r.json()) as { workspace_id: string; memberships: { role: string; name?: string }[] };
    expect(b.workspace_id).toBeTruthy();
    expect(b.memberships[0]?.role).toBe('owner');
    expect(b.memberships[0]?.name).toBe('Main');
  });

  it('bootstrap requires a name and a company-owning token', async () => {
    const login = await loginBody();
    expect((await postAuth('/workspace/bootstrap', login.token, { name: '' })).status).toBe(400);
    // A token whose subject owns no company cannot bootstrap a workspace (403).
    const orphanToken = encodeDevToken({ sub: ORPHAN, workspace_id: null });
    expect((await postAuth('/workspace/bootstrap', orphanToken, { name: 'Nope' })).status).toBe(403);
  });

  it('after bootstrap, login resolves straight into the workspace', async () => {
    const b = await loginBody();
    expect(b.workspace_id).toBeTruthy();
    expect(b.needs_workspace).toBeFalsy();
  });

  it('identity + members show the registered EMAIL (not a user-<id> label)', async () => {
    const login = await loginBody();
    const me = (await (await get('/me', login.token)).json()) as { email: string };
    expect(me.email).toBe(EMAIL);
    const mem = (await (await get('/workspace/members', login.token)).json()) as {
      members: { email: string; role: string }[];
    };
    expect(mem.members.find((m) => m.role === 'owner')?.email).toBe(EMAIL);
    expect(mem.members.some((m) => m.email.startsWith('user-'))).toBe(false);
  });

  it('rejects a wrong password and a duplicate registration', async () => {
    expect((await post('/auth/dev-login', { email: EMAIL, password: 'nope' })).status).toBe(401);
    const dup = await post('/auth/register', { name: 'x', email: EMAIL, password: 'another-pw-1', company_name: 'Dup Co' });
    expect(dup.status).toBe(409);
  });

  it('validates input (bad email, short password, missing company)', async () => {
    expect((await post('/auth/register', { email: 'bad', password: 'longenough', company_name: 'C' })).status).toBe(400);
    expect((await post('/auth/register', { email: 'a@b.co', password: 'short', company_name: 'C' })).status).toBe(400);
    expect((await post('/auth/register', { email: 'a@b.co', password: 'longenough', company_name: '' })).status).toBe(400);
  });

  it('a user with NO access (owns no company, no membership, not admin) is rejected at login', async () => {
    const r = await post('/auth/dev-login', { user_id: ORPHAN });
    expect(r.status).toBe(403);
  });

  it('with NO SES credentials, domain setup is BLOCKED (no simulation)', async () => {
    // The registered company has no company_ses_config and LOCAL_SES_FORCE_MOCK
    // is not set here → setup must surface an error and produce NO records.
    const token = (await loginBody()).token;
    const created = await postAuth('/sending-domains', token, { domain: 'mail.regtest.example' });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { domain: { id: string } }).domain.id;

    const detail = (await (await get(`/sending-domains/${id}`, token)).json()) as {
      records: unknown[];
      sesError?: string;
    };
    expect(detail.records).toHaveLength(0);
    expect(detail.sesError).toBeTruthy();

    const check = (await (await postAuth(`/sending-domains/${id}/check`, token, {})).json()) as {
      verified: boolean;
      error?: string;
    };
    expect(check.verified).toBe(false);
    expect(check.error).toBeTruthy();
  });
});
