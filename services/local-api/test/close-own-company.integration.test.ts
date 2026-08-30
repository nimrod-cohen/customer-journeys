// An OWNER closing their own company account.
//
// Closing an account necessarily ends the caller's own access — that is what
// closing an account means, not a reason to forbid it. Requiring a platform admin
// would turn account closure into a support ticket for data the customer owns.
//
// The guarantees that matter: it deletes everything, it can only ever reach the
// caller's OWN company, and a marketer cannot do it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';
import type { Pool } from 'pg';

const CO = '0c0d4455-0000-4000-8000-000000000c01'; // closed
const CO_OTHER = '0c0d4455-0000-4000-8000-000000000c02'; // must survive
const WS_A = '0c0d4455-0000-4000-8000-000000000a01';
const WS_B = '0c0d4455-0000-4000-8000-000000000a02';
const WS_OTHER = '0c0d4455-0000-4000-8000-000000000a03';
const OWNER = '0c0d4455-0000-4000-8000-0000000000b1';
const MARKETER = '0c0d4455-0000-4000-8000-0000000000b2';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('an owner closes their own company (real Postgres)', () => {
  let world: TestWorld;
  let pool: Pool;

  async function cleanup(): Promise<void> {
    for (const t of ['profiles', 'sending_domains', 'topics', 'workspace_users']) {
      await pool.query(`DELETE FROM ${t} WHERE workspace_id = ANY($1)`, [[WS_A, WS_B, WS_OTHER]]).catch(() => {});
    }
    await pool.query('DELETE FROM company_connectors WHERE company_id = ANY($1)', [[CO, CO_OTHER]]).catch(() => {});
    await pool.query('DELETE FROM workspaces WHERE id = ANY($1)', [[WS_A, WS_B, WS_OTHER]]).catch(() => {});
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [[CO, CO_OTHER]]).catch(() => {});
  }

  beforeAll(async () => {
    world = makeWorld();
    pool = world.pool;
    await cleanup();
    await pool.query("INSERT INTO companies (id, name) VALUES ($1,'Acme Ltd'), ($2,'Other Ltd')", [CO, CO_OTHER]);
    await pool.query(
      `INSERT INTO workspaces (id, company_id, name, status) VALUES
         ($1,$4,'Main','active'), ($2,$4,'Second','active'), ($3,$5,'Theirs','active')`,
      [WS_A, WS_B, WS_OTHER, CO, CO_OTHER],
    );
    for (const w of [WS_A, WS_B]) {
      await pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [w, OWNER]);
      await pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'marketer')", [w, MARKETER]);
    }
    await pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS_OTHER, OWNER]);
    await pool.query("INSERT INTO profiles (workspace_id, email) VALUES ($1,'a@x.com'), ($2,'b@x.com')", [WS_A, WS_B]);
    await pool.query("INSERT INTO sending_domains (workspace_id, domain) VALUES ($1,'acme.com')", [WS_A]);
    await pool.query(
      "INSERT INTO company_connectors (company_id, channel, provider, config) VALUES ($1,'email','resend','{}'::jsonb)",
      [CO],
    );
  });

  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  const close = (user: string, ws: string, body: Record<string, unknown>) =>
    call(world.env, 'DELETE', '/company', { token: tokenFor(user, ws), body });

  it('refuses a marketer', async () => {
    const res = await close(MARKETER, WS_A, { confirm_name: 'Acme Ltd' });
    expect(res.status).toBe(403);
    const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM companies WHERE id=$1', [CO]);
    expect(rows[0]!.n).toBe(1);
  });

  // The only safety here is typing the name: there is no undo and no sibling
  // context to recover from afterwards.
  it('refuses a mismatched confirmation', async () => {
    const res = await close(OWNER, WS_A, { confirm_name: 'acme' });
    expect(res.status).toBe(400);
    const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM companies WHERE id=$1', [CO]);
    expect(rows[0]!.n).toBe(1);
  });

  it('closes the company and deletes every workspace and its data', async () => {
    const res = await close(OWNER, WS_A, { confirm_name: 'Acme Ltd' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deleted: true, workspaces_deleted: 2, signed_out: true });

    for (const [t, col] of [
      ['companies', 'id'],
      ['company_connectors', 'company_id'],
    ] as const) {
      const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t} WHERE ${col}=$1`, [CO]);
      expect(rows[0]!.n, `${t} still has rows`).toBe(0);
    }
    for (const t of ['workspaces', 'profiles', 'sending_domains', 'workspace_users'] as const) {
      const col = t === 'workspaces' ? 'id' : 'workspace_id';
      const { rows } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${t} WHERE ${col} = ANY($1)`,
        [[WS_A, WS_B]],
      );
      expect(rows[0]!.n, `${t} still has rows`).toBe(0);
    }
  });

  // The company comes from the caller's active workspace, never the body, so an
  // owner can only ever close their own (inv. 2).
  it('leaves the other company entirely untouched', async () => {
    const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM companies WHERE id=$1', [CO_OTHER]);
    expect(rows[0]!.n).toBe(1);
    const w = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM workspaces WHERE id=$1', [WS_OTHER]);
    expect(w.rows[0]!.n).toBe(1);
  });
});
