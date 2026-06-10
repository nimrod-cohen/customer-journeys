// A dynamic segment with NO rules is an inactive DRAFT (status='draft'), so the
// evaluator never runs it and it never matches everyone. Adding rules makes it
// active; removing all rules reverts it to draft. Manual lists are always active.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const WS = '0c0d0e0d-0000-4000-8000-000000000a01';
const USER = '0c0d0e0d-0000-4000-8000-0000000000b1';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('segment draft status (real Postgres)', () => {
  let world: TestWorld;
  const tok = () => tokenFor(USER, WS);
  const tier = { field: 'attributes.tier', operator: '=', value: 'vip' };

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    await world.pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [WS]);
    await world.pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS, USER]);
  });

  afterAll(async () => {
    if (world) {
      await cleanup();
      await world.pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    await world.pool.query('DELETE FROM segments WHERE workspace_id = $1', [WS]);
    await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [WS]);
    await world.pool.query('DELETE FROM workspaces WHERE id = $1', [WS]);
  }

  it('a dynamic segment with no rules is created as a draft', async () => {
    const r = await call(world.env, 'POST', '/segments', {
      token: tok(),
      body: { name: 'Empty', kind: 'dynamic_realtime', definition: null },
    });
    expect(r.status).toBe(201);
    expect((r.body as { segment: { status: string } }).segment.status).toBe('draft');
  });

  it('a dynamic segment WITH rules is active', async () => {
    const r = await call(world.env, 'POST', '/segments', {
      token: tok(),
      body: { name: 'VIPs', kind: 'dynamic_realtime', definition: tier },
    });
    expect((r.body as { segment: { status: string } }).segment.status).toBe('active');
  });

  it('a manual segment is active even with a null definition', async () => {
    const r = await call(world.env, 'POST', '/segments', {
      token: tok(),
      body: { name: 'List', kind: 'manual', definition: null },
    });
    expect((r.body as { segment: { status: string } }).segment.status).toBe('active');
  });

  it('removing all rules from an active segment reverts it to draft; re-adding reactivates', async () => {
    const created = await call(world.env, 'POST', '/segments', {
      token: tok(),
      body: { name: 'Toggle', kind: 'dynamic_realtime', definition: tier },
    });
    const id = (created.body as { segment: { id: string } }).segment.id;

    // Empty the rules → draft.
    await call(world.env, 'PUT', `/segments/${id}`, { token: tok(), body: { name: 'Toggle', definition: null } });
    let row = await world.pool.query<{ status: string }>('SELECT status FROM segments WHERE id = $1', [id]);
    expect(row.rows[0]!.status).toBe('draft');

    // Add rules back → active.
    await call(world.env, 'PUT', `/segments/${id}`, { token: tok(), body: { name: 'Toggle', definition: tier } });
    row = await world.pool.query<{ status: string }>('SELECT status FROM segments WHERE id = $1', [id]);
    expect(row.rows[0]!.status).toBe('active');

    // A rename-only update leaves status untouched.
    await call(world.env, 'PUT', `/segments/${id}`, { token: tok(), body: { name: 'Renamed' } });
    row = await world.pool.query<{ status: string }>('SELECT status FROM segments WHERE id = $1', [id]);
    expect(row.rows[0]!.status).toBe('active');
  });
});
