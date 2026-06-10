// Renaming a workspace — by an OWNER (own company only) and by a PLATFORM admin
// (any). REAL Postgres.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const CO = '0c0d0e09-0000-4000-8000-0000000000f1';
const CO2 = '0c0d0e09-0000-4000-8000-0000000000f2';
const WS = '0c0d0e09-0000-4000-8000-000000000a01';
const WS_OTHER = '0c0d0e09-0000-4000-8000-000000000a02';
const OWNER = '0c0d0e09-0000-4000-8000-0000000000b1';
const MKT = '0c0d0e09-0000-4000-8000-0000000000b2';
const ADMIN = '0c0d0e09-0000-4000-8000-0000000000b3';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('rename workspace (real Postgres)', () => {
  let world: TestWorld;

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    await world.pool.query("INSERT INTO companies (id, name) VALUES ($1,'Co'),($2,'Other')", [CO, CO2]);
    await world.pool.query("INSERT INTO workspaces (id, name, status, company_id) VALUES ($1,'Old','active',$2)", [WS, CO]);
    await world.pool.query("INSERT INTO workspaces (id, name, status, company_id) VALUES ($1,'Other WS','active',$2)", [WS_OTHER, CO2]);
    await world.pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS, OWNER]);
    await world.pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'marketer')", [WS, MKT]);
    await world.pool.query('INSERT INTO platform_admins (user_id) VALUES ($1)', [ADMIN]);
  });

  afterAll(async () => {
    if (world) {
      await cleanup();
      await world.pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    await world.pool.query('DELETE FROM platform_admins WHERE user_id = $1', [ADMIN]);
    for (const ws of [WS, WS_OTHER]) {
      await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    }
    await world.pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[CO, CO2]]);
  }

  const name = async (id: string) =>
    (await world.pool.query<{ name: string }>('SELECT name FROM workspaces WHERE id = $1', [id])).rows[0]?.name;

  it('an owner renames a workspace in their company', async () => {
    const r = await call(world.env, 'PATCH', `/workspaces/${WS}`, { token: tokenFor(OWNER, WS), body: { name: 'New Name' } });
    expect(r.status).toBe(200);
    expect(await name(WS)).toBe('New Name');
  });

  it("an owner cannot rename another company's workspace (404)", async () => {
    const r = await call(world.env, 'PATCH', `/workspaces/${WS_OTHER}`, { token: tokenFor(OWNER, WS), body: { name: 'Hax' } });
    expect(r.status).toBe(404);
    expect(await name(WS_OTHER)).toBe('Other WS');
  });

  it('a marketer cannot rename (403)', async () => {
    const r = await call(world.env, 'PATCH', `/workspaces/${WS}`, { token: tokenFor(MKT, WS), body: { name: 'Nope' } });
    expect(r.status).toBe(403);
  });

  it('a platform admin renames any workspace via /admin/workspaces/:id', async () => {
    const r = await call(world.env, 'PATCH', `/admin/workspaces/${WS_OTHER}`, { token: tokenFor(ADMIN, WS), body: { name: 'Admin Renamed' } });
    expect(r.status).toBe(200);
    expect(await name(WS_OTHER)).toBe('Admin Renamed');
  });

  const companyName = async (id: string) =>
    (await world.pool.query<{ name: string }>('SELECT name FROM companies WHERE id = $1', [id])).rows[0]?.name;

  it('an owner renames their own company via /company', async () => {
    const r = await call(world.env, 'PATCH', '/company', { token: tokenFor(OWNER, WS), body: { name: 'Owner Co' } });
    expect(r.status).toBe(200);
    expect(await companyName(CO)).toBe('Owner Co');
  });

  it('a marketer cannot rename the company (403)', async () => {
    const r = await call(world.env, 'PATCH', '/company', { token: tokenFor(MKT, WS), body: { name: 'Nope' } });
    expect(r.status).toBe(403);
  });

  it('a platform admin renames any company via /admin/companies/:id', async () => {
    const r = await call(world.env, 'PATCH', `/admin/companies/${CO2}`, { token: tokenFor(ADMIN, WS), body: { name: 'Admin Co' } });
    expect(r.status).toBe(200);
    expect(await companyName(CO2)).toBe('Admin Co');
  });
});
