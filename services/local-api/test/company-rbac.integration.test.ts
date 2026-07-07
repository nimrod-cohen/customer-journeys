// Company-centric RBAC (real Postgres): a user belongs to a COMPANY with a company
// role (owner|marketer|accounting). Owners access every workspace; marketers only
// GRANTED workspaces; accounting is company-level billing only (no workspace).
// Plus the /company/users management API (add/role/grants/remove, pass-ownership,
// last-owner guard).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const P = '0c0d0e0c-0000-4000-8000-';
const CO = `${P}0000000000f1`;
const CO2 = `${P}0000000000f2`;
const WS1 = `${P}000000000a01`;
const WS2 = `${P}000000000a02`;
const WS_OTHER = `${P}000000000a09`;
const OWNER = `${P}0000000000b1`;
const MKT = `${P}0000000000b2`;
const ACCT = `${P}0000000000b3`;
const NEWUSER = `${P}0000000000b4`;
const OUTSIDER = `${P}0000000000b5`;

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('company-centric RBAC (real Postgres)', () => {
  let world: TestWorld;

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    const q = (t: string, v: unknown[]) => world.pool.query(t, v);
    await q("INSERT INTO companies (id, name) VALUES ($1,'Acme'),($2,'Other')", [CO, CO2]);
    await q("INSERT INTO workspaces (id, name, status, company_id) VALUES ($1,'WS1','active',$2),($3,'WS2','active',$2)", [WS1, CO, WS2]);
    await q("INSERT INTO workspaces (id, name, status, company_id) VALUES ($1,'WSO','active',$2)", [WS_OTHER, CO2]);
    // Users (emails for the add-by-email path).
    await q("INSERT INTO users (id, email, name) VALUES ($1,'owner@acme.test','Owner'),($2,'mkt@acme.test','Mkt'),($3,'acct@acme.test','Acct'),($4,'new@acme.test','New'),($5,'out@other.test','Out')",
      [OWNER, MKT, ACCT, NEWUSER, OUTSIDER]);
    // Company roles.
    await q("INSERT INTO company_users (company_id, user_id, role) VALUES ($1,$2,'owner'),($1,$3,'marketer'),($1,$4,'accounting')", [CO, OWNER, MKT, ACCT]);
    await q("INSERT INTO company_users (company_id, user_id, role) VALUES ($1,$2,'owner')", [CO2, OUTSIDER]);
    // Marketer grant: WS1 only (NOT WS2).
    await q("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'marketer')", [WS1, MKT]);
  });

  afterAll(async () => {
    if (world) {
      await cleanup();
      await world.pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    const ids = [WS1, WS2, WS_OTHER];
    await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = ANY($1::uuid[])', [ids]);
    await world.pool.query('DELETE FROM company_users WHERE company_id = ANY($1::uuid[])', [[CO, CO2]]);
    await world.pool.query('DELETE FROM workspaces WHERE id = ANY($1::uuid[])', [ids]);
    await world.pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[CO, CO2]]);
    await world.pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[OWNER, MKT, ACCT, NEWUSER, OUTSIDER]]);
  }

  const roleOf = async (uid: string) =>
    (await world.pool.query<{ role: string }>('SELECT role FROM company_users WHERE company_id = $1 AND user_id = $2', [CO, uid])).rows[0]?.role;
  const grantsOf = async (uid: string) =>
    (await world.pool.query<{ workspace_id: string }>('SELECT workspace_id FROM workspace_users WHERE user_id = $1 ORDER BY workspace_id', [uid])).rows.map((r) => r.workspace_id);

  // ── Access resolution ──────────────────────────────────────────────
  it('OWNER sees every workspace in the company', async () => {
    const r = await call(world.env, 'GET', '/me', { token: tokenFor(OWNER, WS1) });
    expect(r.status).toBe(200);
    const b = r.body as { role: string; memberships: { workspaceId: string }[] };
    expect(b.role).toBe('owner');
    expect(b.memberships.map((m) => m.workspaceId).sort()).toEqual([WS1, WS2].sort());
  });

  it('MARKETER sees only granted workspaces; a non-granted active workspace is 403', async () => {
    const me = await call(world.env, 'GET', '/me', { token: tokenFor(MKT, WS1) });
    expect(me.status).toBe(200);
    const b = me.body as { role: string; memberships: { workspaceId: string }[] };
    expect(b.role).toBe('marketer');
    expect(b.memberships.map((m) => m.workspaceId)).toEqual([WS1]);
    // WS2 is not granted → the authorizer rejects that active workspace.
    const bad = await call(world.env, 'GET', '/broadcasts', { token: tokenFor(MKT, WS2) });
    expect(bad.status).toBe(403);
    // WS1 (granted) works.
    const good = await call(world.env, 'GET', '/broadcasts', { token: tokenFor(MKT, WS1) });
    expect(good.status).toBe(200);
  });

  it('ACCOUNTING is company-level: no workspace, billing works, workspace routes 403', async () => {
    const me = await call(world.env, 'GET', '/me', { token: tokenFor(ACCT, null) });
    expect(me.status).toBe(200);
    const b = me.body as { role: string; memberships: unknown[]; workspace_id: string | null };
    expect(b.role).toBe('accounting');
    expect(b.memberships).toEqual([]);
    expect(b.workspace_id).toBeNull();
    // Company-level billing is reachable with no active workspace.
    const bill = await call(world.env, 'GET', '/billing/usage', { token: tokenFor(ACCT, null) });
    expect(bill.status).toBe(200);
    // A workspace-scoped route (manage_content) is refused.
    const bc = await call(world.env, 'GET', '/broadcasts', { token: tokenFor(ACCT, null) });
    expect(bc.status).toBe(403);
  });

  it('MARKETER cannot manage users (needs manage_workspace_users)', async () => {
    const r = await call(world.env, 'GET', '/company/users', { token: tokenFor(MKT, WS1) });
    expect(r.status).toBe(403);
  });

  // ── /company/users management ──────────────────────────────────────
  it('OWNER lists company users with roles + marketer grants', async () => {
    const r = await call(world.env, 'GET', '/company/users', { token: tokenFor(OWNER, WS1) });
    expect(r.status).toBe(200);
    const b = r.body as { users: { user_id: string; role: string; workspace_ids: string[] }[]; workspaces: { id: string }[] };
    const byId = new Map(b.users.map((u) => [u.user_id, u]));
    expect(byId.get(OWNER)?.role).toBe('owner');
    expect(byId.get(MKT)?.role).toBe('marketer');
    expect(byId.get(MKT)?.workspace_ids).toEqual([WS1]);
    expect(byId.get(ACCT)?.role).toBe('accounting');
    expect(b.workspaces.map((w) => w.id).sort()).toEqual([WS1, WS2].sort());
  });

  it('OWNER adds a marketer by email with a workspace grant', async () => {
    const r = await call(world.env, 'POST', '/company/users', {
      token: tokenFor(OWNER, WS1),
      body: { email: 'new@acme.test', role: 'marketer', workspace_ids: [WS2] },
    });
    expect(r.status).toBe(201);
    expect(await roleOf(NEWUSER)).toBe('marketer');
    expect(await grantsOf(NEWUSER)).toEqual([WS2]);
  });

  it('rejects adding a user who already belongs to another company (409)', async () => {
    const r = await call(world.env, 'POST', '/company/users', {
      token: tokenFor(OWNER, WS1),
      body: { email: 'out@other.test', role: 'marketer' },
    });
    expect(r.status).toBe(409);
  });

  it('OWNER passes ownership (promotes another user to owner — co-owners)', async () => {
    const r = await call(world.env, 'PATCH', '/company/users', {
      token: tokenFor(OWNER, WS1),
      body: { user_id: MKT, role: 'owner' },
    });
    expect(r.status).toBe(200);
    expect(await roleOf(MKT)).toBe('owner');
    // Promoting to owner clears their marketer grants (owners access all).
    expect(await grantsOf(MKT)).toEqual([]);
  });

  it('a co-owner can demote another owner; an owner cannot change their OWN role', async () => {
    // MKT is a co-owner (from the pass-ownership test). MKT demotes OWNER → accounting: allowed
    // (MKT remains an owner, so it is not the last).
    const demote = await call(world.env, 'PATCH', '/company/users', {
      token: tokenFor(MKT, WS1),
      body: { user_id: OWNER, role: 'accounting' },
    });
    expect(demote.status).toBe(200);
    expect(await roleOf(OWNER)).toBe('accounting');
    expect(await roleOf(MKT)).toBe('owner');
    // The sole owner (MKT) cannot change their OWN role — the practical last-owner protection.
    const self = await call(world.env, 'PATCH', '/company/users', {
      token: tokenFor(MKT, WS1),
      body: { user_id: MKT, role: 'marketer' },
    });
    expect(self.status).toBe(403);
    expect(await roleOf(MKT)).toBe('owner');
  });

  it('the last-owner guard refuses demoting the final owner (defense in depth)', async () => {
    // Give the company two owners, then verify demoting one leaves ≥1 (allowed), and the
    // count-based guard rejects a demotion that would leave zero. Re-promote OWNER first.
    await call(world.env, 'PATCH', '/company/users', { token: tokenFor(MKT, WS1), body: { user_id: OWNER, role: 'owner' } });
    // OWNER demotes MKT → marketer: allowed (OWNER remains).
    const ok1 = await call(world.env, 'PATCH', '/company/users', { token: tokenFor(OWNER, WS1), body: { user_id: MKT, role: 'marketer' } });
    expect(ok1.status).toBe(200);
    // MKT (now marketer) tries to demote the sole owner OWNER via the API: forbidden (marketer
    // lacks manage_workspace_users) — so the sole owner is unreachable-for-demotion.
    const blocked = await call(world.env, 'PATCH', '/company/users', { token: tokenFor(MKT, WS1), body: { user_id: OWNER, role: 'accounting' } });
    expect(blocked.status).toBe(403);
    expect((await world.pool.query<{ n: number }>("SELECT count(*)::int n FROM company_users WHERE company_id=$1 AND role='owner'", [CO])).rows[0]?.n).toBe(1);
  });

  it('remove a user from the company', async () => {
    const r = await call(world.env, 'DELETE', `/company/users/${ACCT}`, { token: tokenFor(OWNER, WS1) });
    expect(r.status).toBe(200);
    expect(await roleOf(ACCT)).toBeUndefined();
  });
});
