// Deleting a company, with and without its workspaces.
//
// The default stays conservative — a company with workspaces 409s — so no tenant
// data is destroyed by a request that looks like tidying up an unused row. Removing
// everything is possible but must be asked for explicitly.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';
import type { Pool } from 'pg';

const CO = '0c0d3344-0000-4000-8000-000000000c01'; // deleted
const CO_OTHER = '0c0d3344-0000-4000-8000-000000000c02'; // the admin acts from here
const WS_A = '0c0d3344-0000-4000-8000-000000000a01';
const WS_B = '0c0d3344-0000-4000-8000-000000000a02';
const WS_ADMIN = '0c0d3344-0000-4000-8000-000000000a03';
const ADMIN = '0c0d3344-0000-4000-8000-0000000000b1';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('deleting a company (real Postgres)', () => {
  let world: TestWorld;
  let pool: Pool;

  async function cleanup(): Promise<void> {
    for (const t of ['profiles', 'sending_domains', 'topics', 'workspace_users']) {
      await pool.query(`DELETE FROM ${t} WHERE workspace_id = ANY($1)`, [[WS_A, WS_B, WS_ADMIN]]).catch(() => {});
    }
    await pool.query('DELETE FROM company_connectors WHERE company_id = ANY($1)', [[CO, CO_OTHER]]).catch(() => {});
    await pool.query('DELETE FROM workspaces WHERE id = ANY($1)', [[WS_A, WS_B, WS_ADMIN]]).catch(() => {});
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [[CO, CO_OTHER]]).catch(() => {});
    await pool.query("DELETE FROM platform_admins WHERE user_id = $1", [ADMIN]).catch(() => {});
  }

  beforeAll(async () => {
    world = makeWorld();
    pool = world.pool;
    await cleanup();
    await pool.query("INSERT INTO companies (id, name) VALUES ($1,'Doomed'), ($2,'Safe')", [CO, CO_OTHER]);
    await pool.query(
      `INSERT INTO workspaces (id, company_id, name, status) VALUES
         ($1,$4,'A','active'), ($2,$4,'B','active'), ($3,$5,'AdminHome','active')`,
      [WS_A, WS_B, WS_ADMIN, CO, CO_OTHER],
    );
    await pool.query("INSERT INTO platform_admins (user_id) VALUES ($1)", [ADMIN]).catch(() => {});
    await pool.query(
      "INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')",
      [WS_ADMIN, ADMIN],
    );
    // Real tenant data, so the purge has something to prove.
    await pool.query("INSERT INTO profiles (workspace_id, email) VALUES ($1,'a@x.com'), ($2,'b@x.com')", [WS_A, WS_B]);
    await pool.query("INSERT INTO sending_domains (workspace_id, domain) VALUES ($1,'a.com')", [WS_A]);
    await pool.query("INSERT INTO company_connectors (company_id, channel, provider, config) VALUES ($1,'email','resend','{}'::jsonb)", [CO]);
  });

  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  const del = (body: Record<string, unknown>) =>
    call(world.env, 'DELETE', `/admin/companies/${CO}`, { token: tokenFor(ADMIN, WS_ADMIN), body });

  it('refuses without a matching name confirmation', async () => {
    const res = await del({ confirm_name: 'wrong' });
    expect(res.status).toBe(400);
  });

  // The safety that must not regress: tidying up must never destroy tenant data.
  it('refuses a company that still has workspaces, and names them', async () => {
    const res = await del({ confirm_name: 'Doomed' });
    expect(res.status).toBe(409);
    const b = res.body as { workspaces: string[]; hint: string };
    expect(b.workspaces.sort()).toEqual(['A', 'B']);
    expect(b.hint).toMatch(/delete_workspaces/);

    // Nothing was touched.
    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM workspaces WHERE company_id = $1',
      [CO],
    );
    expect(rows[0]!.n).toBe(2);
  });

  it('deletes the company and every workspace when asked explicitly', async () => {
    const res = await del({ confirm_name: 'Doomed', delete_workspaces: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deleted: true, workspaces_deleted: 2 });

    for (const [table, col] of [
      ['companies', 'id'],
      ['company_connectors', 'company_id'],
    ] as const) {
      const { rows } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${table} WHERE ${col} = $1`,
        [CO],
      );
      expect(rows[0]!.n, `${table} still has rows`).toBe(0);
    }
    for (const t of ['workspaces', 'profiles', 'sending_domains'] as const) {
      const col = t === 'workspaces' ? 'id' : 'workspace_id';
      const { rows } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${t} WHERE ${col} = ANY($1)`,
        [[WS_A, WS_B]],
      );
      expect(rows[0]!.n, `${t} still has rows`).toBe(0);
    }
  });

  it('leaves the other company and its workspace untouched', async () => {
    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM workspaces WHERE company_id = $1',
      [CO_OTHER],
    );
    expect(rows[0]!.n).toBe(1);
  });

  // Deleting the company you are acting from would revoke your own session
  // mid-request and leave the outcome ambiguous.
  it('refuses to delete the company the caller is acting from', async () => {
    const res = await call(world.env, 'DELETE', `/admin/companies/${CO_OTHER}`, {
      token: tokenFor(ADMIN, WS_ADMIN),
      body: { confirm_name: 'Safe', delete_workspaces: true },
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/another company/);
  });
});
