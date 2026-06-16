// Self-service company-owner registration + login (§12). REAL Postgres.
// register → creates company + workspace + owner user → token; that user can
// then log in; duplicate email is 409; and a user with NO workspace access (not
// a platform admin) is rejected at login rather than landing on an empty app.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import { createApp } from '../src/index.js';
import type { Pool } from 'pg';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

const EMAIL = 'owner-regtest@example.com';
const ORPHAN = '0c0d0e90-0000-4000-8000-0000000000c1'; // a user id with no membership

describeMaybe('register + login (real Postgres)', () => {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;
  const post = (path: string, body: unknown) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const get = (path: string, token: string) =>
    app.request(path, { headers: { authorization: `Bearer ${token}` } });

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

  async function cleanup(): Promise<void> {
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [EMAIL]);
    for (const u of rows) {
      const { rows: ws } = await pool.query<{ workspace_id: string }>(
        'SELECT workspace_id FROM workspace_users WHERE user_id = $1',
        [u.id],
      );
      await pool.query('DELETE FROM workspace_users WHERE user_id = $1', [u.id]);
      for (const w of ws) {
        const { rows: cmp } = await pool.query<{ company_id: string }>('SELECT company_id FROM workspaces WHERE id = $1', [w.workspace_id]);
        await pool.query('DELETE FROM workspaces WHERE id = $1', [w.workspace_id]);
        for (const cm of cmp) await pool.query('DELETE FROM companies WHERE id = $1', [cm.company_id]);
      }
    }
    await pool.query('DELETE FROM users WHERE email = $1', [EMAIL]);
  }

  it('registers a company owner → token + active workspace + owner membership', async () => {
    const r = await post('/auth/register', {
      name: 'Reg Owner',
      email: EMAIL,
      password: 'sup3r-secret-pw',
      company_name: 'Reg Test Co',
    });
    expect(r.status).toBe(201);
    const b = (await r.json()) as { token: string; workspace_id: string; is_platform_admin: boolean; memberships: { role: string }[] };
    expect(b.token).toBeTruthy();
    expect(b.workspace_id).toBeTruthy();
    expect(b.is_platform_admin).toBe(false);
    expect(b.memberships[0]?.role).toBe('owner');
  });

  it('the registered owner can log back in with those credentials', async () => {
    const r = await post('/auth/dev-login', { email: EMAIL, password: 'sup3r-secret-pw' });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { workspace_id: string }).workspace_id).toBeTruthy();
  });

  it('identity + members show the registered EMAIL (not a user-<id> label)', async () => {
    const login = (await (await post('/auth/dev-login', { email: EMAIL, password: 'sup3r-secret-pw' })).json()) as {
      token: string;
    };
    const me = (await (await get('/me', login.token)).json()) as { email: string };
    expect(me.email).toBe(EMAIL);
    const mem = (await (await get('/workspace/members', login.token)).json()) as { members: { email: string; role: string }[] };
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

  it('a user with NO workspace access (not platform admin) is rejected at login', async () => {
    const r = await post('/auth/dev-login', { user_id: ORPHAN });
    expect(r.status).toBe(403);
  });
});
