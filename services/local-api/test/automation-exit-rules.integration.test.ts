// Exit rules through the API: draft save validates them (shape + workspace-owned
// segments, inv.2), publish carries them live, a live event via the real route
// exits the journey, and the Journeys tab reports why. REAL Postgres.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const WS = 'e7170000-0000-4000-8000-00000000aa01';
const WS_B = 'e7170000-0000-4000-8000-00000000aa02';
const USER = 'e7170000-0000-4000-8000-00000000ab01';
const SEG = 'e7170000-0000-4000-8000-00000000ad01';
const SEG_B = 'e7170000-0000-4000-8000-00000000ad02';

const graph = (exitRules?: unknown) => ({
  startNode: 't',
  nodes: {
    t: { type: 'trigger', kind: 'manual', next: 'w' },
    w: { type: 'wait', delay: { seconds: 86400 }, next: 'x' },
    x: { type: 'exit' },
  },
  ...(exitRules ? { exitRules } : {}),
});

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('automation exit rules via the API (real Postgres)', () => {
  let world: TestWorld;
  const tok = () => tokenFor(USER, WS);

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    for (const w of [WS, WS_B]) await world.pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [w]);
    await world.pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS, USER]);
    await world.pool.query("INSERT INTO segments (id, workspace_id, name, kind, status) VALUES ($1,$2,'s','dynamic_realtime','active')", [SEG, WS]);
    await world.pool.query("INSERT INTO segments (id, workspace_id, name, kind, status) VALUES ($1,$2,'s','dynamic_realtime','active')", [SEG_B, WS_B]);
  });

  afterAll(async () => {
    if (world) {
      await cleanup();
      await world.pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    for (const w of [WS, WS_B]) {
      await world.pool.query('DELETE FROM activity_log WHERE workspace_id = $1', [w]);
      await world.pool.query('DELETE FROM automation_enrollments WHERE workspace_id = $1', [w]);
      await world.pool.query('UPDATE automations SET active_version_id = NULL WHERE workspace_id = $1', [w]);
      await world.pool.query('DELETE FROM automation_versions WHERE workspace_id = $1', [w]);
      await world.pool.query('DELETE FROM automations WHERE workspace_id = $1', [w]);
      await world.pool.query('DELETE FROM events WHERE workspace_id = $1', [w]);
      await world.pool.query('DELETE FROM profile_features WHERE workspace_id = $1', [w]);
      await world.pool.query('DELETE FROM segment_change_log WHERE workspace_id = $1', [w]);
      await world.pool.query('DELETE FROM segment_memberships WHERE workspace_id = $1', [w]);
      await world.pool.query('DELETE FROM profiles WHERE workspace_id = $1', [w]);
      await world.pool.query('DELETE FROM segments WHERE workspace_id = $1', [w]);
      await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [w]);
      await world.pool.query('DELETE FROM workspaces WHERE id = $1', [w]);
    }
  }

  async function create(): Promise<string> {
    const r = await call(world.env, 'POST', '/automations', { token: tok(), body: { name: 'Cart', definition: graph() } });
    expect(r.status).toBe(201);
    return (r.body as { automation: { id: string } }).automation.id;
  }
  const draft = (id: string, definition: unknown) =>
    call(world.env, 'PUT', `/automations/${id}/draft`, { token: tok(), body: { definition } });

  it('draft save validates rule shape and refuses another workspace\'s segment', async () => {
    const id = await create();
    expect((await draft(id, graph([{ id: 'a', action: 'nope', when: { kind: 'event', eventType: 'x' } }]))).status).toBe(400);
    const foreign = await draft(id, graph([{ id: 'a', action: 'exit', when: { kind: 'segment_exit', segmentId: SEG_B } }]));
    expect(foreign.status).toBe(400);
    expect((foreign.body as { error: string }).error).toMatch(/segment not found/);
    expect((await draft(id, graph([{ id: 'a', action: 'exit', when: { kind: 'segment_exit', segmentId: 'not-a-uuid' } }]))).status).toBe(400);
    expect((await draft(id, graph([{ id: 'a', action: 'exit', when: { kind: 'segment_exit', segmentId: SEG } }]))).status).toBe(200);
    const got = await call(world.env, 'GET', `/automations/${id}`, { token: tok() });
    expect((got.body as { automation: { definition: { exitRules: unknown[] } } }).automation.definition.exitRules).toHaveLength(1);
  });

  it('a published event rule exits a live journey via the real event route; the Journeys tab says why', async () => {
    const id = await create();
    expect((await draft(id, graph([{ id: 'buy', label: 'Bought', action: 'exit', when: { kind: 'event', eventType: 'purchase' } }]))).status).toBe(200);
    const pub = await call(world.env, 'POST', `/automations/${id}/publish`, { token: tok(), body: { name: 'v1', scope: 'forward' } });
    expect(pub.status).toBe(200);

    const p = await world.pool.query("INSERT INTO profiles (workspace_id, email) VALUES ($1,'exit@x.com') RETURNING id", [WS]);
    const profileId = p.rows[0].id as string;
    expect((await call(world.env, 'POST', `/automations/${id}/enroll`, { token: tok(), body: { profile_id: profileId } })).status).toBeLessThan(300);

    const ev = await call(world.env, 'POST', `/profiles/${profileId}/events`, { token: tok(), body: { type: 'purchase', payload: {} } });
    expect(ev.status).toBe(201);

    const list = await call(world.env, 'GET', `/automations/${id}/enrollments`, { token: tok() });
    const rows = (list.body as { enrollments: { status: string; exit_reason: string | null; restarts: number }[] }).enrollments;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'exited', exit_reason: 'Exit rule: Bought', restarts: 0 });
  });
});
