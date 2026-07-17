// Integration (real Postgres): the Journeys tab + the list's publishable flag.
//
// Covers:
//   - GET /automations/:id/enrollments returns THIS automation's enrollments joined to
//     profiles for the email, newest-enrolled first, with status + current_node +
//     timestamps; everything workspace-scoped (a cross-workspace automation id → 404,
//     a foreign tenant's enrollments never surface — inv.1/inv.2).
//   - GET /automations LIST returns `hasDraft` per automation (a draft differing from
//     live → true; no draft → false) — the list's "Publish…" gate.
//   - POST /automations/:id/revert refuses (409) a revert to the ALREADY-LIVE version
//     (defense-in-depth; the UI hides the button).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const WS = '0c0d0eab-0000-4000-8000-000000000a01';
const WS_B = '0c0d0eab-0000-4000-8000-000000000a02';
const USER = '0c0d0eab-0000-4000-8000-0000000000b1';
const USER_B = '0c0d0eab-0000-4000-8000-0000000000b2';

const DEF = {
  startNode: 'start',
  nodes: { start: { type: 'trigger', kind: 'manual', next: 'x' }, x: { type: 'exit' } },
};
const DRAFT_DEF = {
  startNode: 'start',
  nodes: { start: { type: 'trigger', kind: 'manual', next: 'w' }, w: { type: 'wait', delay: { seconds: 60 }, next: 'x' }, x: { type: 'exit' } },
};

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('GET /automations/:id/enrollments + list hasDraft (real Postgres)', () => {
  let world: TestWorld;
  const tok = () => tokenFor(USER, WS);

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    for (const [ws, user] of [[WS, USER], [WS_B, USER_B]] as const) {
      await world.pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [ws]);
      await world.pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [ws, user]);
    }
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
      await world.pool.query("UPDATE automations SET active_version_id = NULL WHERE workspace_id = $1", [ws]);
      await world.pool.query('DELETE FROM automation_versions WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM automations WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    }
  }

  async function makeAutomation(ws: string, opts: { draft?: boolean } = {}): Promise<string> {
    const r = await world.pool.query<{ id: string }>(
      "INSERT INTO automations (workspace_id, name, definition, draft_definition, status) VALUES ($1,'C',$2::jsonb,$3::jsonb,'draft') RETURNING id",
      [ws, JSON.stringify(DEF), opts.draft ? JSON.stringify(DRAFT_DEF) : null],
    );
    return r.rows[0]!.id;
  }

  async function enroll(ws: string, automationId: string, email: string, status: string, node: string): Promise<string> {
    const p = await world.pool.query<{ id: string }>(
      'INSERT INTO profiles (workspace_id, email) VALUES ($1,$2) RETURNING id',
      [ws, email],
    );
    await world.pool.query(
      'INSERT INTO automation_enrollments (workspace_id, automation_id, profile_id, current_node, status) VALUES ($1,$2,$3,$4,$5)',
      [ws, automationId, p.rows[0]!.id, node, status],
    );
    return p.rows[0]!.id;
  }

  it('lists the automation enrollments joined to profiles, newest-enrolled first', async () => {
    const camp = await makeAutomation(WS);
    await enroll(WS, camp, 'first@a.test', 'completed', 'x');
    // Force a later enrolled_at on the second so ordering is deterministic.
    const p2 = await enroll(WS, camp, 'second@a.test', 'active', 'start');
    await world.pool.query("UPDATE automation_enrollments SET enrolled_at = now() + interval '1 minute' WHERE profile_id = $1", [p2]);

    const res = await call(world.env, 'GET', `/automations/${camp}/enrollments`, { token: tok() });
    expect(res.status).toBe(200);
    const list = (res.body as { enrollments: Array<Record<string, unknown>> }).enrollments;
    expect(list).toHaveLength(2);
    // Newest enrolled first.
    expect(list[0]!.email).toBe('second@a.test');
    expect(list[0]!.status).toBe('active');
    expect(list[0]!.current_node).toBe('start');
    expect(list[0]!.enrolled_at).toBeTruthy();
    expect(list[0]!.updated_at).toBeTruthy();
    expect(list[1]!.email).toBe('first@a.test');
    expect(list[1]!.status).toBe('completed');
  });

  it('a cross-workspace automation id → 404 (no foreign enrollments leak, inv.2)', async () => {
    const campB = await makeAutomation(WS_B);
    await enroll(WS_B, campB, 'beta@b.test', 'active', 'start');
    // WS token asking for WS_B's automation → 404.
    const res = await call(world.env, 'GET', `/automations/${campB}/enrollments`, { token: tok() });
    expect(res.status).toBe(404);
  });

  it('GET /automations LIST returns hasDraft (true when a draft differs from live, else false)', async () => {
    const withDraft = await makeAutomation(WS, { draft: true });
    const noDraft = await makeAutomation(WS);
    const res = await call(world.env, 'GET', '/automations', { token: tok() });
    expect(res.status).toBe(200);
    const byId = new Map(
      (res.body as { automations: Array<{ id: string; hasDraft: boolean }> }).automations.map((c) => [c.id, c.hasDraft]),
    );
    expect(byId.get(withDraft)).toBe(true);
    expect(byId.get(noDraft)).toBe(false);
  });

  it('revert to the ALREADY-LIVE version → 409 (defense-in-depth)', async () => {
    const camp = await makeAutomation(WS);
    // Publish v1 → it becomes active_version_id.
    const pub = await world.pool.query<{ id: string }>(
      `INSERT INTO automation_versions (workspace_id, automation_id, version, name, definition)
       VALUES ($1,$2,1,'v1',$3::jsonb) RETURNING id`,
      [WS, camp, JSON.stringify(DEF)],
    );
    await world.pool.query('UPDATE automations SET active_version_id = $1 WHERE id = $2', [pub.rows[0]!.id, camp]);
    const res = await call(world.env, 'POST', `/automations/${camp}/revert`, {
      token: tok(),
      body: { version_id: pub.rows[0]!.id },
    });
    expect(res.status).toBe(409);
  });
});
