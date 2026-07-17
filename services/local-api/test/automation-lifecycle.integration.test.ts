// Integration (real Postgres): the automation LIFECYCLE endpoints (§9B phase 7).
// POST /automations/:id/{pause,resume,archive} flip automations.status via plain
// workspace-scoped UPDATEs (no migration — status is free-text draft|active|
// paused|archived). Asserts: the pure transition table (idempotent no-ops, typed
// 409 on an illegal transition), tenant isolation (a cross-workspace :id 404s,
// workspace_id never from the body), capability gating (manage_content), and that
// an archived automation no longer enrolls. Never mocks the DB.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { enrollFromEvent } from '@cdp/service-automation-runner';
import { runStatementsInWorkspaceTx } from '@cdp/service-automation-runner';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const WS = '0c0d0e97-0000-4000-8000-000000000a01';
const WS_B = '0c0d0e97-0000-4000-8000-000000000a02';
const OWNER = '0c0d0e97-0000-4000-8000-0000000000b1';
const ACCT = '0c0d0e97-0000-4000-8000-0000000000b2';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

const eventDef = (eventType: string) => ({
  startNode: 't',
  nodes: {
    t: { type: 'trigger', kind: 'event', eventType, next: 'x' },
    x: { type: 'exit' },
  },
});

describeMaybe('automation lifecycle endpoints (real Postgres)', () => {
  let world: TestWorld;
  const ownerTok = () => tokenFor(OWNER, WS);
  const acctTok = () => tokenFor(ACCT, WS);

  async function makeAutomation(ws: string, status: string, def: unknown = eventDef('purchase')): Promise<string> {
    const r = await world.pool.query<{ id: string }>(
      'INSERT INTO automations (workspace_id, name, definition, status) VALUES ($1,\'C\',$2::jsonb,$3) RETURNING id',
      [ws, JSON.stringify(def), status],
    );
    return r.rows[0]!.id;
  }
  async function statusOf(id: string): Promise<string> {
    const r = await world.pool.query<{ status: string }>('SELECT status FROM automations WHERE id = $1', [id]);
    return r.rows[0]!.status;
  }

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    for (const w of [WS, WS_B]) {
      await world.pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [w]);
    }
    await world.pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS, OWNER]);
    await world.pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'accounting')", [WS, ACCT]);
  });

  afterAll(async () => {
    if (world) {
      await cleanup();
      await world.pool.end();
    }
  });

  beforeEach(async () => {
    await world.pool.query('DELETE FROM automation_enrollments WHERE workspace_id = ANY($1::uuid[])', [[WS, WS_B]]);
    await world.pool.query('DELETE FROM automations WHERE workspace_id = ANY($1::uuid[])', [[WS, WS_B]]);
    await world.pool.query('DELETE FROM profiles WHERE workspace_id = ANY($1::uuid[])', [[WS, WS_B]]);
  });

  async function cleanup(): Promise<void> {
    await world.pool.query('DELETE FROM automation_enrollments WHERE workspace_id = ANY($1::uuid[])', [[WS, WS_B]]);
    await world.pool.query('DELETE FROM automations WHERE workspace_id = ANY($1::uuid[])', [[WS, WS_B]]);
    await world.pool.query('DELETE FROM profiles WHERE workspace_id = ANY($1::uuid[])', [[WS, WS_B]]);
    await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = ANY($1::uuid[])', [[WS, WS_B]]);
    await world.pool.query('DELETE FROM workspaces WHERE id = ANY($1::uuid[])', [[WS, WS_B]]);
  }

  it('pause: active → paused; idempotent (pausing a paused automation is a 200 no-op)', async () => {
    const camp = await makeAutomation(WS, 'active');
    const r1 = await call(world.env, 'POST', `/automations/${camp}/pause`, { token: ownerTok() });
    expect(r1.status).toBe(200);
    expect((r1.body as { status: string }).status).toBe('paused');
    expect(await statusOf(camp)).toBe('paused');
    // idempotent — a second pause is a no-op 200, not an error.
    const r2 = await call(world.env, 'POST', `/automations/${camp}/pause`, { token: ownerTok() });
    expect(r2.status).toBe(200);
    expect((r2.body as { status: string }).status).toBe('paused');
  });

  it('resume: paused → active; resuming a non-paused (draft) automation is a typed 409', async () => {
    const paused = await makeAutomation(WS, 'paused');
    const ok = await call(world.env, 'POST', `/automations/${paused}/resume`, { token: ownerTok() });
    expect(ok.status).toBe(200);
    expect(await statusOf(paused)).toBe('active');

    const draft = await makeAutomation(WS, 'draft');
    const bad = await call(world.env, 'POST', `/automations/${draft}/resume`, { token: ownerTok() });
    expect(bad.status).toBe(409);
    expect(typeof (bad.body as { error?: string }).error).toBe('string');
    expect(await statusOf(draft)).toBe('draft');
  });

  it('archive: sets archived from any state; an archived automation no longer enrolls', async () => {
    const camp = await makeAutomation(WS, 'active', eventDef('purchase'));
    const p = await world.pool.query<{ id: string }>(
      'INSERT INTO profiles (workspace_id, email) VALUES ($1,$2) RETURNING id',
      [WS, 'arch@example.com'],
    );
    const profileId = p.rows[0]!.id;

    const r = await call(world.env, 'POST', `/automations/${camp}/archive`, { token: ownerTok() });
    expect(r.status).toBe(200);
    expect((r.body as { status: string }).status).toBe('archived');
    expect(await statusOf(camp)).toBe('archived');

    // An event that WOULD have matched the trigger does NOT enroll into an
    // archived automation (the enroll core targets status='active' only).
    const enrollDeps = {
      reader: { query: (t: string, v?: readonly unknown[]) => world.pool.query(t, v as unknown[]) } as never,
      runInWorkspaceTx: (w: string, s: never) => runStatementsInWorkspaceTx(world.pool, w, s),
    };
    const res = await enrollFromEvent(enrollDeps, {
      workspace_id: WS,
      profile_id: profileId,
      type: 'purchase',
      payload: {},
      event_id: 'evt-arch-1',
    });
    expect(res.enrolled).toBe(0);
    const cnt = await world.pool.query('SELECT 1 FROM automation_enrollments WHERE workspace_id = $1 AND automation_id = $2', [WS, camp]);
    expect(cnt.rowCount).toBe(0);
  });

  it('tenant isolation: a pause/resume/archive on a WS_B automation under a WS_A token 404s', async () => {
    const foreign = await makeAutomation(WS_B, 'active');
    for (const action of ['pause', 'resume', 'archive'] as const) {
      const res = await call(world.env, 'POST', `/automations/${foreign}/${action}`, { token: ownerTok() });
      expect(res.status).toBe(404);
    }
    // The WS_B automation is untouched.
    expect(await statusOf(foreign)).toBe('active');
  });

  it('capability: an accounting role (no manage_content) is 403 on every lifecycle action', async () => {
    const camp = await makeAutomation(WS, 'active');
    for (const action of ['pause', 'resume', 'archive'] as const) {
      const res = await call(world.env, 'POST', `/automations/${camp}/${action}`, { token: acctTok() });
      expect(res.status).toBe(403);
    }
    expect(await statusOf(camp)).toBe('active');
  });
});
