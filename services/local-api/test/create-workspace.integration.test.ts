// An owner creates a new workspace IN THEIR OWN company (§3A). REAL Postgres.
// Proves the new workspace inherits the active workspace's company, the creator
// becomes its owner, and a non-owner (marketer) is 403.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const CO = '0c0d0e06-0000-4000-8000-0000000000f1';
const WS = '0c0d0e06-0000-4000-8000-000000000a01';
const OWNER = '0c0d0e06-0000-4000-8000-0000000000b1';
const MKT = '0c0d0e06-0000-4000-8000-0000000000b2';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('owner creates a workspace (real Postgres)', () => {
  let world: TestWorld;

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    await world.pool.query("INSERT INTO companies (id, name) VALUES ($1,'Co')", [CO]);
    await world.pool.query("INSERT INTO workspaces (id, name, status, company_id) VALUES ($1,'WS','active',$2)", [WS, CO]);
    await world.pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS, OWNER]);
    await world.pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'marketer')", [WS, MKT]);
  });

  afterAll(async () => {
    if (world) {
      await cleanup();
      await world.pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    await world.pool.query('DELETE FROM workspace_users WHERE workspace_id IN (SELECT id FROM workspaces WHERE company_id = $1)', [CO]);
    await world.pool.query('DELETE FROM workspaces WHERE company_id = $1', [CO]);
    await world.pool.query('DELETE FROM companies WHERE id = $1', [CO]);
  }

  it('an owner creates a workspace in their company and becomes its owner', async () => {
    const r = await call(world.env, 'POST', '/workspaces', { token: tokenFor(OWNER, WS), body: { name: 'West' } });
    expect(r.status).toBe(201);
    const ws = (r.body as { workspace: { id: string; name: string } }).workspace;
    expect(ws.name).toBe('West');

    // Inherits the active workspace's company.
    const { rows } = await world.pool.query<{ company_id: string }>('SELECT company_id FROM workspaces WHERE id = $1', [ws.id]);
    expect(rows[0]?.company_id).toBe(CO);

    // The creator is an owner of the new workspace.
    const m = await world.pool.query("SELECT role FROM workspace_users WHERE workspace_id = $1 AND user_id = $2", [ws.id, OWNER]);
    expect(m.rows[0]?.role).toBe('owner');
  });

  it('a marketer cannot create a workspace (403)', async () => {
    const r = await call(world.env, 'POST', '/workspaces', { token: tokenFor(MKT, WS), body: { name: 'Nope' } });
    expect(r.status).toBe(403);
  });
});
