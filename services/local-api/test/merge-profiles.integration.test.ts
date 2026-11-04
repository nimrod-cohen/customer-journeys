// Profile merge (§6/§12): merge a secondary profile INTO a lead, then delete the
// secondary. REAL Postgres. Proves: events reassigned, features recomputed,
// manual memberships repointed to the survivor, dynamic segments re-evaluated,
// chosen attributes applied, secondary gone — all workspace-scoped.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const WS = '0c1d2e09-0000-4000-8000-000000000a01';
const WS_B = '0c1d2e09-0000-4000-8000-000000000a02';
const USER = '0c1d2e09-0000-4000-8000-0000000000b1';
const LEAD = '0c1d2e09-0000-4000-8000-0000000000c1';
const SEC = '0c1d2e09-0000-4000-8000-0000000000c2';
const SEG_MANUAL = '0c1d2e09-0000-4000-8000-0000000000d1';
const SEG_DYN = '0c1d2e09-0000-4000-8000-0000000000d2';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('merge profiles (real Postgres)', () => {
  let world: TestWorld;
  const tok = () => tokenFor(USER, WS);

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    for (const ws of [WS, WS_B])
      await world.pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [ws]);
    await world.pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS, USER]);
    // Lead + secondary in WS.
    await world.pool.query(
      "INSERT INTO profiles (id, workspace_id, external_id, email, attributes) VALUES ($1,$2,'lead','lead@acme.com','{\"tier\":\"std\"}'::jsonb)",
      [LEAD, WS],
    );
    await world.pool.query(
      "INSERT INTO profiles (id, workspace_id, external_id, email, attributes) VALUES ($1,$2,'sec','sec@acme.com','{\"plan\":\"pro\"}'::jsonb)",
      [SEC, WS],
    );
    for (const id of [LEAD, SEC])
      await world.pool.query('INSERT INTO profile_features (profile_id, workspace_id) VALUES ($1,$2)', [id, WS]);
    // Lead: 1 page_view. Secondary: 2 purchases (amount 50 each).
    await world.pool.query(
      "INSERT INTO events (event_id, workspace_id, profile_id, type, occurred_at) VALUES (gen_random_uuid(),$1,$2,'page_view','2026-01-01T00:00:00Z')",
      [WS, LEAD],
    );
    for (const t of ['2026-02-01T00:00:00Z', '2026-03-01T00:00:00Z'])
      await world.pool.query(
        "INSERT INTO events (event_id, workspace_id, profile_id, type, occurred_at, payload) VALUES (gen_random_uuid(),$1,$2,'purchase',$3,'{\"amount\":50}'::jsonb)",
        [WS, SEC, t],
      );
    // Manual segment with the SECONDARY as a member; dynamic segment tier=vip.
    await world.pool.query("INSERT INTO segments (id, workspace_id, name, kind) VALUES ($1,$2,'Manual','manual')", [SEG_MANUAL, WS]);
    await world.pool.query(
      "INSERT INTO segment_memberships (segment_id, profile_id, workspace_id, source) VALUES ($1,$2,$3,'manual')",
      [SEG_MANUAL, SEC, WS],
    );
    await world.pool.query(
      `INSERT INTO segments (id, workspace_id, name, kind, definition)
       VALUES ($1,$2,'VIPs','dynamic_realtime','{"field":"attributes.tier","operator":"=","value":"vip"}'::jsonb)`,
      [SEG_DYN, WS],
    );
  });

  afterAll(async () => {
    if (world) {
      await cleanup();
      await world.pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    for (const ws of [WS, WS_B]) {
      await world.pool.query('DELETE FROM segment_change_log WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM segment_memberships WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM segments WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM events WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM profile_features WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    }
  }

  it('rejects a self-merge (400) and a cross-workspace secondary (404)', async () => {
    expect((await call(world.env, 'POST', `/profiles/${LEAD}/merge`, { token: tok(), body: { secondary_id: LEAD } })).status).toBe(400);
    const stranger = '0c1d2e09-0000-4000-8000-0000000000ff';
    expect((await call(world.env, 'POST', `/profiles/${LEAD}/merge`, { token: tok(), body: { secondary_id: stranger } })).status).toBe(404);
  });

  it('merges events + features + memberships + dynamic re-eval; deletes the secondary', async () => {
    const r = await call(world.env, 'POST', `/profiles/${LEAD}/merge`, {
      token: tok(),
      body: { secondary_id: SEC, attributes: { tier: 'vip', plan: 'pro' } },
    });
    expect(r.status).toBe(200);

    // Secondary is gone.
    const sec = await world.pool.query('SELECT 1 FROM profiles WHERE id = $1', [SEC]);
    expect(sec.rowCount).toBe(0);

    // All events now belong to the lead.
    const ev = await world.pool.query('SELECT count(*)::int n FROM events WHERE workspace_id = $1 AND profile_id = $2', [WS, LEAD]);
    expect(ev.rows[0].n).toBe(3);

    // Features recomputed from the merged events.
    const pf = await world.pool.query('SELECT total_events, monetary_total, counters FROM profile_features WHERE profile_id = $1', [LEAD]);
    expect(pf.rows[0].total_events).toBe(3);
    expect(Number(pf.rows[0].monetary_total)).toBe(100);
    expect(pf.rows[0].counters).toEqual({ page_view: 1, purchase: 2 });

    // Lead got the chosen attributes.
    const p = await world.pool.query("SELECT attributes FROM profiles WHERE id = $1", [LEAD]);
    expect(p.rows[0].attributes).toEqual({ tier: 'vip', plan: 'pro' });

    // Manual membership now points at the survivor (lead), not the secondary.
    const man = await world.pool.query('SELECT profile_id FROM segment_memberships WHERE segment_id = $1', [SEG_MANUAL]);
    expect(man.rows.map((x) => x.profile_id)).toEqual([LEAD]);

    // Dynamic segment re-evaluated: lead (now tier=vip) is a member.
    const dyn = await world.pool.query('SELECT 1 FROM segment_memberships WHERE segment_id = $1 AND profile_id = $2', [SEG_DYN, LEAD]);
    expect(dyn.rowCount).toBe(1);
  });
});

// Email + phone are core columns, not attributes: the caller PICKS, per field,
// whether the survivor keeps the lead's or the secondary's value. Nothing moves
// unless chosen; a pick that leaves no identifier is refused.
const WS_ID = '0c1d2e09-0000-4000-8000-000000000a11';
const USER_ID = '0c1d2e09-0000-4000-8000-0000000000b2';
const L2 = '0c1d2e09-0000-4000-8000-0000000000e1';
const S2 = '0c1d2e09-0000-4000-8000-0000000000e2';

describeMaybe('merge profiles — choosing email/phone (real Postgres)', () => {
  let world: TestWorld;
  const tok = () => tokenFor(USER_ID, WS_ID);
  const merge = (body: Record<string, unknown>) =>
    call(world.env, 'POST', `/profiles/${L2}/merge`, { token: tok(), body: { secondary_id: S2, ...body } });
  const lead = async () =>
    (await world.pool.query('SELECT email, phone, email_status FROM profiles WHERE id = $1', [L2])).rows[0];
  const secExists = async () => (await world.pool.query('SELECT 1 FROM profiles WHERE id = $1', [S2])).rowCount === 1;

  async function cleanup(): Promise<void> {
    for (const t of ['events', 'profile_features', 'profiles', 'workspace_users'])
      await world.pool.query(`DELETE FROM ${t} WHERE workspace_id = $1`, [WS_ID]);
    await world.pool.query('DELETE FROM workspaces WHERE id = $1', [WS_ID]);
  }
  // Lead: email only. Secondary: a phone AND its own (bounced) email.
  async function seed(): Promise<void> {
    await cleanup();
    await world.pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [WS_ID]);
    await world.pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS_ID, USER_ID]);
    await world.pool.query("INSERT INTO profiles (id, workspace_id, email) VALUES ($1,$2,'lead@x.com')", [L2, WS_ID]);
    await world.pool.query(
      "INSERT INTO profiles (id, workspace_id, email, phone, email_status) VALUES ($1,$2,'sec@x.com','+972542223306','bounced')",
      [S2, WS_ID],
    );
  }

  beforeAll(() => {
    world = makeWorld();
  });
  afterAll(async () => {
    if (world) {
      await cleanup();
      await world.pool.end();
    }
  });

  it("keeps the secondary's phone when chosen, and the lead's email", async () => {
    await seed();
    const r = await merge({ identity: { email: 'lead', phone: 'secondary' } });
    expect(r.status).toBe(200);
    expect(await lead()).toEqual({ email: 'lead@x.com', phone: '+972542223306', email_status: 'active' });
    expect(await secExists()).toBe(false);
  });

  it("takes the secondary's email WITH its email_status (a bounce belongs to the address)", async () => {
    await seed();
    expect((await merge({ identity: { email: 'secondary', phone: 'lead' } })).status).toBe(200);
    expect(await lead()).toEqual({ email: 'sec@x.com', phone: null, email_status: 'bounced' });
  });

  it('with no identity pick, the lead keeps its own email and phone', async () => {
    await seed();
    expect((await merge({})).status).toBe(200);
    expect(await lead()).toEqual({ email: 'lead@x.com', phone: null, email_status: 'active' });
  });

  it('refuses a pick that leaves the survivor with no email and no phone (400, nothing changed)', async () => {
    await seed();
    // Secondary has a phone but no email; lead has an email but no phone. Taking the
    // secondary's (empty) email and the lead's (empty) phone leaves nothing.
    await world.pool.query('UPDATE profiles SET email = NULL WHERE id = $1', [S2]);
    const r = await merge({ identity: { email: 'secondary', phone: 'lead' } });
    expect(r.status).toBe(400);
    expect(await secExists()).toBe(true);
  });

  it('rejects an unknown pick value (400)', async () => {
    await seed();
    expect((await merge({ identity: { phone: 'both' } })).status).toBe(400);
    expect(await secExists()).toBe(true);
  });
});
