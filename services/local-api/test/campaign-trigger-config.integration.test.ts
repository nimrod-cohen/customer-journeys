// The campaign API persists trigger_on (enter|exit) + keep_while_in_segment so the
// segment-eval Phase-4 behaviors (exit-triggered journeys, membership-gated
// enrollments) are addressable. REAL Postgres.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const WS = '0c0d0e10-0000-4000-8000-000000000a01';
const USER = '0c0d0e10-0000-4000-8000-0000000000b1';
const SEG = '0c0d0e10-0000-4000-8000-0000000000d1';

const DEF = {
  startNode: 't',
  nodes: { t: { type: 'trigger', kind: 'segment_entry', next: 'x' }, x: { type: 'exit' } },
};

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('campaign trigger config (real Postgres)', () => {
  let world: TestWorld;
  const tok = () => tokenFor(USER, WS);

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    await world.pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [WS]);
    await world.pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS, USER]);
    await world.pool.query(
      "INSERT INTO segments (id, workspace_id, name, kind, status) VALUES ($1,$2,'seg','dynamic_realtime','active')",
      [SEG, WS],
    );
  });

  afterAll(async () => {
    if (world) {
      await cleanup();
      await world.pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    await world.pool.query('DELETE FROM campaigns WHERE workspace_id = $1', [WS]);
    await world.pool.query('DELETE FROM segments WHERE workspace_id = $1', [WS]);
    await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [WS]);
    await world.pool.query('DELETE FROM workspaces WHERE id = $1', [WS]);
  }

  it('defaults trigger_on to enter and keep_while_in_segment to null', async () => {
    const r = await call(world.env, 'POST', '/campaigns', {
      token: tok(),
      body: { name: 'Plain', definition: DEF, trigger_segment_id: SEG },
    });
    expect(r.status).toBe(201);
    const c = r.body as { campaign: { trigger_on: string; keep_while_in_segment: string | null } };
    expect(c.campaign.trigger_on).toBe('enter');
    expect(c.campaign.keep_while_in_segment).toBeNull();
  });

  it('persists trigger_on=exit + keep_while_in_segment on create, and PUT updates them', async () => {
    const created = await call(world.env, 'POST', '/campaigns', {
      token: tok(),
      body: { name: 'WinBack', definition: DEF, trigger_segment_id: SEG, trigger_on: 'exit', keep_while_in_segment: SEG },
    });
    const c = (created.body as { campaign: { id: string; trigger_on: string; keep_while_in_segment: string | null } }).campaign;
    expect(c.trigger_on).toBe('exit');
    expect(c.keep_while_in_segment).toBe(SEG);

    // PUT back to enter + clear the gate.
    await call(world.env, 'PUT', `/campaigns/${c.id}`, {
      token: tok(),
      body: { trigger_on: 'enter', keep_while_in_segment: null },
    });
    const row = await world.pool.query<{ trigger_on: string; keep_while_in_segment: string | null }>(
      'SELECT trigger_on, keep_while_in_segment FROM campaigns WHERE id = $1',
      [c.id],
    );
    expect(row.rows[0]!.trigger_on).toBe('enter');
    expect(row.rows[0]!.keep_while_in_segment).toBeNull();
  });
});
