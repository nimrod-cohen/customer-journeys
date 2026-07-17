// Phase 3 (real Postgres): the manual/API enroll endpoint
// POST /automations/:id/enroll enrolls a single profile OR a segment snapshot at the
// automation's start node, is capability-gated (manage_content) + workspace-scoped,
// and refuses cross-workspace automation/profile/segment ids (404/inv.2).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const WS = '0c0d0e91-0000-4000-8000-000000000a01';
const WS_B = '0c0d0e91-0000-4000-8000-000000000a02';
const USER = '0c0d0e91-0000-4000-8000-0000000000b1';
const USER_B = '0c0d0e91-0000-4000-8000-0000000000b2';
const SEG = '0c0d0e91-0000-4000-8000-0000000000d1';
const SEG_B = '0c0d0e91-0000-4000-8000-0000000000d2';

const DEF = {
  startNode: 'start',
  nodes: { start: { type: 'trigger', kind: 'manual', next: 'x' }, x: { type: 'exit' } },
};

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('POST /automations/:id/enroll (real Postgres)', () => {
  let world: TestWorld;
  const tok = () => tokenFor(USER, WS);
  let campA = '';
  let campB = '';

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    for (const [ws, user] of [[WS, USER], [WS_B, USER_B]] as const) {
      await world.pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [ws]);
      await world.pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [ws, user]);
    }
    // Manual segments (membership rows) in each workspace.
    await world.pool.query("INSERT INTO segments (id, workspace_id, name, kind, status) VALUES ($1,$2,'seg','manual','active')", [SEG, WS]);
    await world.pool.query("INSERT INTO segments (id, workspace_id, name, kind, status) VALUES ($1,$2,'segB','manual','active')", [SEG_B, WS_B]);
    campA = (
      await world.pool.query(
        "INSERT INTO automations (workspace_id, name, definition, status) VALUES ($1,'CA',$2::jsonb,'active') RETURNING id",
        [WS, JSON.stringify(DEF)],
      )
    ).rows[0].id;
    campB = (
      await world.pool.query(
        "INSERT INTO automations (workspace_id, name, definition, status) VALUES ($1,'CB',$2::jsonb,'active') RETURNING id",
        [WS_B, JSON.stringify(DEF)],
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    if (world) {
      await cleanup();
      await world.pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    for (const ws of [WS, WS_B]) {
      await world.pool.query('DELETE FROM automation_enrollments WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM automations WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM segment_memberships WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM segments WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    }
  }

  async function newProfile(ws: string, ext: string): Promise<string> {
    return (await world.pool.query('INSERT INTO profiles (workspace_id, external_id) VALUES ($1,$2) RETURNING id', [ws, ext])).rows[0].id;
  }
  async function addMember(ws: string, seg: string, profileId: string): Promise<void> {
    await world.pool.query(
      "INSERT INTO segment_memberships (segment_id, profile_id, workspace_id, source) VALUES ($1,$2,$3,'manual')",
      [seg, profileId, ws],
    );
  }
  async function enrollRows(ws: string, camp: string): Promise<{ profile_id: string; current_node: string; status: string; workspace_id: string }[]> {
    return (
      await world.pool.query(
        'SELECT profile_id, current_node, status, workspace_id FROM automation_enrollments WHERE workspace_id = $1 AND automation_id = $2',
        [ws, camp],
      )
    ).rows;
  }

  it('enrolls a single profile at the start node; reports count 1', async () => {
    const prof = await newProfile(WS, 'single-1');
    const r = await call(world.env, 'POST', `/automations/${campA}/enroll`, { token: tok(), body: { profile_id: prof } });
    expect(r.status).toBe(200);
    expect((r.body as { enrolled: number }).enrolled).toBe(1);
    const rows = await enrollRows(WS, campA);
    const row = rows.find((x) => x.profile_id === prof)!;
    expect(row.current_node).toBe('start');
    expect(row.status).toBe('active');
    expect(row.workspace_id).toBe(WS);
  });

  it('enrolls a SNAPSHOT of the segment members (point-in-time)', async () => {
    const segCamp = (
      await world.pool.query(
        "INSERT INTO automations (workspace_id, name, definition, status) VALUES ($1,'SnapC',$2::jsonb,'active') RETURNING id",
        [WS, JSON.stringify(DEF)],
      )
    ).rows[0].id;
    const m1 = await newProfile(WS, 'snap-1');
    const m2 = await newProfile(WS, 'snap-2');
    await addMember(WS, SEG, m1);
    await addMember(WS, SEG, m2);
    const r = await call(world.env, 'POST', `/automations/${segCamp}/enroll`, { token: tok(), body: { segment_id: SEG } });
    expect(r.status).toBe(200);
    expect((r.body as { enrolled: number }).enrolled).toBe(2);
    // Adding a member AFTER the call does NOT enroll (point-in-time snapshot).
    const m3 = await newProfile(WS, 'snap-3');
    await addMember(WS, SEG, m3);
    const rows = await enrollRows(WS, segCamp);
    expect(rows.map((x) => x.profile_id).sort()).toEqual([m1, m2].sort());
  });

  it('IDEMPOTENT: re-enrolling the same segment snapshot inserts no duplicates', async () => {
    const segCamp = (
      await world.pool.query(
        "INSERT INTO automations (workspace_id, name, definition, status) VALUES ($1,'IdemC',$2::jsonb,'active') RETURNING id",
        [WS, JSON.stringify(DEF)],
      )
    ).rows[0].id;
    const seg3 = '0c0d0e91-0000-4000-8000-0000000000d3';
    await world.pool.query("INSERT INTO segments (id, workspace_id, name, kind, status) VALUES ($1,$2,'seg3','manual','active')", [seg3, WS]);
    for (const e of ['idem-1', 'idem-2', 'idem-3']) await addMember(WS, seg3, await newProfile(WS, e));
    await call(world.env, 'POST', `/automations/${segCamp}/enroll`, { token: tok(), body: { segment_id: seg3 } });
    await call(world.env, 'POST', `/automations/${segCamp}/enroll`, { token: tok(), body: { segment_id: seg3 } });
    expect((await enrollRows(WS, segCamp)).length).toBe(3);
  });

  it('cross-workspace automation id ⇒ 404, no enrollment written', async () => {
    const prof = await newProfile(WS, 'xws-camp');
    const r = await call(world.env, 'POST', `/automations/${campB}/enroll`, { token: tok(), body: { profile_id: prof } });
    expect(r.status).toBe(404);
    expect((await enrollRows(WS_B, campB)).length).toBe(0);
  });

  it('cross-workspace profile id ⇒ 404 (never enrolls another tenant profile)', async () => {
    const profB = await newProfile(WS_B, 'xws-prof');
    const r = await call(world.env, 'POST', `/automations/${campA}/enroll`, { token: tok(), body: { profile_id: profB } });
    expect(r.status).toBe(404);
    const c = await world.pool.query('SELECT count(*)::int n FROM automation_enrollments WHERE profile_id = $1', [profB]);
    expect(c.rows[0].n).toBe(0);
  });

  it('cross-workspace segment id ⇒ 404 (inv.2)', async () => {
    const r = await call(world.env, 'POST', `/automations/${campA}/enroll`, { token: tok(), body: { segment_id: SEG_B } });
    expect(r.status).toBe(404);
  });

  it('a workspace_id in the request body is IGNORED (taken from ctx only)', async () => {
    const prof = await newProfile(WS, 'body-ws');
    const r = await call(world.env, 'POST', `/automations/${campA}/enroll`, {
      token: tok(),
      body: { profile_id: prof, workspace_id: WS_B },
    });
    expect(r.status).toBe(200);
    const rows = await enrollRows(WS, campA);
    const row = rows.find((x) => x.profile_id === prof)!;
    expect(row.workspace_id).toBe(WS); // ctx, never the body
  });
});
