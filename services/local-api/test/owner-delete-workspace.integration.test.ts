// An OWNER (company admin) deletes a workspace IN THEIR OWN company (§3A). REAL
// Postgres. Proves: can't delete the active workspace (400), wrong name (400),
// another company's workspace (404), a non-owner (marketer) 403, and a correct
// confirmation on a non-active same-company workspace succeeds.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const CO = '0c0d0e08-0000-4000-8000-0000000000f1';
const CO2 = '0c0d0e08-0000-4000-8000-0000000000f2';
const WS = '0c0d0e08-0000-4000-8000-000000000a01'; // active workspace
const WS2 = '0c0d0e08-0000-4000-8000-000000000a02'; // same company, target
const WS_OTHER = '0c0d0e08-0000-4000-8000-000000000a03'; // different company
const OWNER = '0c0d0e08-0000-4000-8000-0000000000b1';
const MKT = '0c0d0e08-0000-4000-8000-0000000000b2';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('owner deletes a workspace (real Postgres)', () => {
  let world: TestWorld;

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    await world.pool.query("INSERT INTO companies (id, name) VALUES ($1,'Co'),($2,'Other')", [CO, CO2]);
    await world.pool.query("INSERT INTO workspaces (id, name, status, company_id) VALUES ($1,'Main','active',$2)", [WS, CO]);
    await world.pool.query("INSERT INTO workspaces (id, name, status, company_id) VALUES ($1,'Side','active',$2)", [WS2, CO]);
    await world.pool.query("INSERT INTO workspaces (id, name, status, company_id) VALUES ($1,'Other WS','active',$2)", [WS_OTHER, CO2]);
    await world.pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS, OWNER]);
    await world.pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS2, OWNER]);
    await world.pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'marketer')", [WS, MKT]);
  });

  afterAll(async () => {
    if (world) {
      await cleanup();
      await world.pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    for (const ws of [WS, WS2, WS_OTHER]) {
      await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    }
    await world.pool.query('DELETE FROM companies WHERE id = ANY($1::uuid[])', [[CO, CO2]]);
  }

  const ownerTok = () => tokenFor(OWNER, WS);

  it('cannot delete the active workspace (400)', async () => {
    const r = await call(world.env, 'DELETE', `/workspaces/${WS}`, { token: ownerTok(), body: { confirm_name: 'Main' } });
    expect(r.status).toBe(400);
  });

  it('rejects a wrong name confirmation (400)', async () => {
    const r = await call(world.env, 'DELETE', `/workspaces/${WS2}`, { token: ownerTok(), body: { confirm_name: 'nope' } });
    expect(r.status).toBe(400);
  });

  it("cannot delete another company's workspace (404)", async () => {
    const r = await call(world.env, 'DELETE', `/workspaces/${WS_OTHER}`, { token: ownerTok(), body: { confirm_name: 'Other WS' } });
    expect(r.status).toBe(404);
  });

  it('a marketer cannot delete (403)', async () => {
    const r = await call(world.env, 'DELETE', `/workspaces/${WS2}`, { token: tokenFor(MKT, WS), body: { confirm_name: 'Side' } });
    expect(r.status).toBe(403);
  });

  it('deletes a non-active same-company workspace with the correct name', async () => {
    const r = await call(world.env, 'DELETE', `/workspaces/${WS2}`, { token: ownerTok(), body: { confirm_name: 'Side' } });
    expect(r.status).toBe(200);
    expect((await world.pool.query('SELECT 1 FROM workspaces WHERE id = $1', [WS2])).rowCount).toBe(0);
  });
});
