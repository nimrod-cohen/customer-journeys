// GET /automations/:id/test-send/candidates — the last 10 customers the automation's
// (draft) trigger WOULD have enrolled, so a test send can use a real one without
// searching. Real Postgres.
//
//   event          → latest distinct profiles that fired the event AND pass its filter,
//                    each with that event (so {{event.*}} renders from it)
//   segment_entry  → last to enter (or exit, per trigger direction) the segment
//   profile        → most recently created / updated
//   manual         → most recently updated customers (there is no trigger history)
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

// Unused prefix: 0c0d7e58.
const WS = '0c0d7e58-0000-4000-8000-000000000a01';
const WS_B = '0c0d7e58-0000-4000-8000-000000000a02';
const USER = '0c0d7e58-0000-4000-8000-0000000000b1';
const SEG = '0c0d7e58-0000-4000-8000-0000000000c1';

interface Candidate {
  profile_id: string;
  email: string | null;
  event_id?: string;
  at: string;
}

const triggerDef = (trigger: Record<string, unknown>) => ({
  startNode: 't',
  nodes: { t: { type: 'trigger', next: 'x', ...trigger }, x: { type: 'exit' } },
});

describeMaybe('test-send candidates (real Postgres)', () => {
  let world: TestWorld;
  const p: Record<string, string> = {};
  let profB = '';

  const candidates = async (id: string) =>
    call(world.env, 'GET', `/automations/${id}/test-send/candidates`, { token: tokenFor(USER, WS) });
  const ids = (body: unknown) => (body as { candidates: Candidate[] }).candidates.map((c) => c.email);

  const automation = async (definition: object, extra: { seg?: string; on?: 'enter' | 'exit'; draft?: boolean } = {}) =>
    (
      await world.pool.query<{ id: string }>(
        extra.draft
          ? "INSERT INTO automations (workspace_id, name, definition, draft_definition, draft_trigger_segment_id, draft_trigger_on, status) VALUES ($1,'A','{\"startNode\":\"t\",\"nodes\":{\"t\":{\"type\":\"trigger\",\"kind\":\"manual\",\"next\":\"x\"},\"x\":{\"type\":\"exit\"}}}'::jsonb,$2::jsonb,$3,$4,'draft') RETURNING id"
          : "INSERT INTO automations (workspace_id, name, definition, trigger_segment_id, trigger_on, status) VALUES ($1,'A',$2::jsonb,$3,$4,'draft') RETURNING id",
        [WS, JSON.stringify(definition), extra.seg ?? null, extra.on ?? 'enter'],
      )
    ).rows[0]!.id;

  async function cleanup(): Promise<void> {
    for (const ws of [WS, WS_B]) {
      for (const t of ['automations', 'segment_change_log', 'segment_memberships', 'segments', 'events', 'profiles', 'workspace_users']) {
        await world.pool.query(`DELETE FROM ${t} WHERE workspace_id = $1`, [ws]);
      }
      await world.pool.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    }
  }

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    for (const ws of [WS, WS_B]) {
      await world.pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [ws]);
    }
    await world.pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'marketer')", [WS, USER]);
    // 12 customers, created one minute apart (c0 oldest … c11 newest); c3 updated last.
    for (let i = 0; i < 12; i++) {
      p[`c${i}`] = (
        await world.pool.query<{ id: string }>(
          "INSERT INTO profiles (workspace_id, email, created_at, updated_at) VALUES ($1,$2, now() - make_interval(mins => 100 - $3::int), now() - make_interval(mins => 100 - $3::int)) RETURNING id",
          [WS, `c${i}@x.test`, i],
        )
      ).rows[0]!.id;
    }
    await world.pool.query("UPDATE profiles SET updated_at = now() WHERE id = $1", [p.c3]);
    profB = (
      await world.pool.query<{ id: string }>("INSERT INTO profiles (workspace_id, email) VALUES ($1,'b@x.test') RETURNING id", [WS_B])
    ).rows[0]!.id;

    // Events: c1 bought (small), c2 bought big twice, c4 bought big, c5 viewed; WS_B bought big latest.
    const ev = (ws: string, prof: string, type: string, total: number, minsAgo: number) =>
      world.pool.query(
        "INSERT INTO events (event_id, workspace_id, profile_id, type, occurred_at, payload) VALUES (gen_random_uuid(),$1,$2,$3, now() - make_interval(mins => $5::int), jsonb_build_object('total',$4::int))",
        [ws, prof, type, total, minsAgo],
      );
    await ev(WS, p.c1!, 'purchase', 10, 1);
    await ev(WS, p.c2!, 'purchase', 500, 5);
    await ev(WS, p.c2!, 'purchase', 700, 2);
    await ev(WS, p.c4!, 'purchase', 300, 3);
    await ev(WS, p.c5!, 'view', 0, 0);
    await ev(WS_B, profB, 'purchase', 999, 0);

    // Segment: c6 entered, c7 entered later, c8 entered then exited.
    await world.pool.query("INSERT INTO segments (id, workspace_id, name, kind) VALUES ($1,$2,'S','manual')", [SEG, WS]);
    const ch = (prof: string, action: string, minsAgo: number) =>
      world.pool.query(
        "INSERT INTO segment_change_log (workspace_id, segment_id, profile_id, action, occurred_at) VALUES ($1,$2,$3,$4, now() - make_interval(mins => $5::int))",
        [WS, SEG, prof, action, minsAgo],
      );
    await ch(p.c6!, 'entered', 10);
    await ch(p.c8!, 'entered', 9);
    await ch(p.c7!, 'entered', 8);
    await ch(p.c8!, 'exited', 7);
    // c9 joined by a direct membership (hand-picked / seeded) with no change-log row.
    await world.pool.query(
      "INSERT INTO segment_memberships (segment_id, profile_id, workspace_id, source, entered_at) VALUES ($1,$2,$3,'manual', now() - interval '1 minute')",
      [SEG, p.c9, WS],
    );
  });

  afterAll(async () => {
    if (world) {
      await cleanup();
      await world.pool.end();
    }
  });

  it('event trigger: latest distinct customers who fired it, each with their latest event', async () => {
    const id = await automation(triggerDef({ kind: 'event', eventType: 'purchase' }));
    const res = await candidates(id);
    expect(res.status).toBe(200);
    expect((res.body as { trigger: string }).trigger).toBe('event');
    expect(ids(res.body)).toEqual(['c1@x.test', 'c2@x.test', 'c4@x.test']);
    const c2 = (res.body as { candidates: Candidate[] }).candidates[1]!;
    const latest = await world.pool.query<{ event_id: string }>(
      "SELECT event_id FROM events WHERE profile_id = $1 ORDER BY occurred_at DESC LIMIT 1",
      [p.c2],
    );
    expect(c2.event_id).toBe(latest.rows[0]!.event_id);
  });

  it('event trigger with a payload filter: only events that would have enrolled', async () => {
    const id = await automation(
      triggerDef({ kind: 'event', eventType: 'purchase', filter: { field: 'payload.total', operator: '>', value: 100 } }),
    );
    expect(ids((await candidates(id)).body)).toEqual(['c2@x.test', 'c4@x.test']);
  });

  it('segment entry: last to enter (change log or a direct membership); segment exit: last to exit', async () => {
    const enter = await automation(triggerDef({ kind: 'segment_entry' }), { seg: SEG, on: 'enter' });
    expect(ids((await candidates(enter)).body)).toEqual(['c9@x.test', 'c7@x.test', 'c8@x.test', 'c6@x.test']);
    expect((await candidates(enter)).body).toMatchObject({ triggerOn: 'enter' });
    const exit = await automation(triggerDef({ kind: 'segment_entry' }), { seg: SEG, on: 'exit' });
    expect((await candidates(exit)).body).toMatchObject({ triggerOn: 'exit' });
    expect(ids((await candidates(exit)).body)).toEqual(['c8@x.test']);
  });

  it('reads the DRAFT trigger, which is what is being built', async () => {
    const id = await automation(triggerDef({ kind: 'segment_entry' }), { seg: SEG, on: 'enter', draft: true });
    expect(ids((await candidates(id)).body)).toEqual(['c9@x.test', 'c7@x.test', 'c8@x.test', 'c6@x.test']);
  });

  it('profile created: newest 10; profile updated / manual: most recently updated 10', async () => {
    const created = await automation(triggerDef({ kind: 'profile', profileChange: 'created' }));
    const c = ids((await candidates(created)).body);
    expect(c).toHaveLength(10);
    expect(c[0]).toBe('c11@x.test');
    expect(c).not.toContain('c0@x.test');

    const updated = await automation(triggerDef({ kind: 'profile', profileChange: 'updated' }));
    expect(ids((await candidates(updated)).body)).toEqual(['c3@x.test']);

    const manual = await automation(triggerDef({ kind: 'manual' }));
    const m = ids((await candidates(manual)).body);
    expect(m).toHaveLength(10);
    expect(m[0]).toBe('c3@x.test');
  });

  it('a foreign automation is a 404', async () => {
    const foreign = (
      await world.pool.query<{ id: string }>(
        "INSERT INTO automations (workspace_id, name, definition, status) VALUES ($1,'B',$2::jsonb,'draft') RETURNING id",
        [WS_B, JSON.stringify(triggerDef({ kind: 'manual' }))],
      )
    ).rows[0]!.id;
    expect((await candidates(foreign)).status).toBe(404);
  });
});
