// Profile-trigger campaign enrollment through the LIVE local-api routes (real
// Postgres). POST /profiles enrolls a new profile into active profile/created (+
// any) campaigns, NOT profile/updated-only; PATCH /profiles/:id enrolls into
// profile/updated (+ any); CSV import enrolls each created profile; idempotent
// (re-update doesn't double-enroll); cross-workspace isolation (workspace from the
// token, never the body); a segment/event/manual trigger is unaffected.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const RUN = hasDatabaseUrl();
const describeMaybe = RUN ? describe : describe.skip;

const WS = '0c0d0e51-0000-4000-8000-000000000a01';
const WS_B = '0c0d0e51-0000-4000-8000-000000000a02';
const OWNER = '0c0d0e51-0000-4000-8000-0000000000b1';

const profDef = (profileChange?: 'created' | 'updated' | 'any') => ({
  startNode: 't',
  nodes: {
    t: { type: 'trigger', kind: 'profile', ...(profileChange ? { profileChange } : {}), next: 'x' },
    x: { type: 'exit' },
  },
});
const eventDef = {
  startNode: 't',
  nodes: { t: { type: 'trigger', kind: 'event', eventType: 'purchase', next: 'x' }, x: { type: 'exit' } },
};

describeMaybe('profile-trigger enrollment via local-api (real Postgres)', () => {
  let world: TestWorld;
  const tok = () => tokenFor(OWNER, WS);

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    for (const ws of [WS, WS_B]) {
      await world.pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [ws]);
    }
    await world.pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS, OWNER]);
  });

  beforeEach(async () => {
    for (const ws of [WS, WS_B]) {
      await world.pool.query('DELETE FROM campaign_enrollments WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM campaigns WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM activity_log WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM profile_features WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
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
      await world.pool.query('DELETE FROM campaign_enrollments WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM campaigns WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM activity_log WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM profile_features WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    }
  }

  async function newCampaign(def: unknown, status = 'active', ws = WS): Promise<string> {
    const r = await world.pool.query<{ id: string }>(
      'INSERT INTO campaigns (workspace_id, name, definition, status) VALUES ($1,$2,$3::jsonb,$4) RETURNING id',
      [ws, 'C', JSON.stringify(def), status],
    );
    return r.rows[0]!.id;
  }
  async function enrolled(campId: string, profId: string, ws = WS): Promise<number> {
    const r = await world.pool.query<{ n: number }>(
      'SELECT count(*)::int n FROM campaign_enrollments WHERE workspace_id = $1 AND campaign_id = $2 AND profile_id = $3',
      [ws, campId, profId],
    );
    return r.rows[0]!.n;
  }

  it('POST /profiles enrolls into profile/created + any, NOT profile/updated', async () => {
    const created = await newCampaign(profDef('created'));
    const any = await newCampaign(profDef('any'));
    const updated = await newCampaign(profDef('updated'));
    const res = await call(world.env, 'POST', '/profiles', { token: tok(), body: { email: 'new@acme.com' } });
    expect(res.status).toBe(201);
    const pid = (res.body as { profile: { id: string } }).profile.id;
    expect(await enrolled(created, pid)).toBe(1);
    expect(await enrolled(any, pid)).toBe(1);
    expect(await enrolled(updated, pid)).toBe(0);
  });

  it('PATCH /profiles/:id enrolls into profile/updated + any (idempotent re-update)', async () => {
    const updated = await newCampaign(profDef('updated'));
    const any = await newCampaign(profDef('any'));
    const created = await newCampaign(profDef('created'));
    // Create a profile (no profile/created campaign matched it yet — create those after).
    const c = await call(world.env, 'POST', '/profiles', { token: tok(), body: { email: 'edit@acme.com' } });
    const pid = (c.body as { profile: { id: string } }).profile.id;
    // The create already enrolled it into created+any; clear so we isolate the PATCH.
    await world.pool.query('DELETE FROM campaign_enrollments WHERE workspace_id = $1 AND profile_id = $2', [WS, pid]);

    const r1 = await call(world.env, 'PATCH', `/profiles/${pid}`, {
      token: tok(),
      body: { attributes: { tier: 'gold' } },
    });
    expect(r1.status).toBe(200);
    expect(await enrolled(updated, pid)).toBe(1);
    expect(await enrolled(any, pid)).toBe(1);
    expect(await enrolled(created, pid)).toBe(0);

    // Re-update does NOT double-enroll (ON CONFLICT 'once').
    const r2 = await call(world.env, 'PATCH', `/profiles/${pid}`, {
      token: tok(),
      body: { attributes: { tier: 'platinum' } },
    });
    expect(r2.status).toBe(200);
    expect(await enrolled(updated, pid)).toBe(1);
    expect(await enrolled(any, pid)).toBe(1);
  });

  it('CSV import enrolls each CREATED profile into profile/created', async () => {
    const created = await newCampaign(profDef('created'));
    const r = await call(world.env, 'POST', '/profiles/import-csv', {
      token: tok(),
      body: { rows: [{ email: 'imp1@acme.com' }, { email: 'imp2@acme.com' }, { email: 'bad-email' }] },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ created: 2, skipped: 1 });
    const ids = await world.pool.query<{ id: string }>(
      "SELECT id FROM profiles WHERE workspace_id = $1 AND email LIKE 'imp%@acme.com' ORDER BY email",
      [WS],
    );
    expect(ids.rows).toHaveLength(2);
    for (const row of ids.rows) expect(await enrolled(created, row.id)).toBe(1);
  });

  it('a NON-profile trigger (event) is NOT enrolled by a profile create/update', async () => {
    const camp = await newCampaign(eventDef);
    const res = await call(world.env, 'POST', '/profiles', { token: tok(), body: { email: 'evt@acme.com' } });
    const pid = (res.body as { profile: { id: string } }).profile.id;
    expect(await enrolled(camp, pid)).toBe(0);
    await call(world.env, 'PATCH', `/profiles/${pid}`, { token: tok(), body: { attributes: { x: 1 } } });
    expect(await enrolled(camp, pid)).toBe(0);
  });

  it('TENANT ISOLATION: a WS-B profile-trigger campaign is NOT enrolled by a WS-A create (workspace from token)', async () => {
    const campB = await newCampaign(profDef('any'), 'active', WS_B);
    const res = await call(world.env, 'POST', '/profiles', {
      token: tok(),
      // even if the body carried a workspace_id it must be ignored (inv.2)
      body: { email: 'iso@acme.com', workspace_id: WS_B },
    });
    const pid = (res.body as { profile: { id: string } }).profile.id;
    const c = await world.pool.query<{ n: number }>(
      'SELECT count(*)::int n FROM campaign_enrollments WHERE campaign_id = $1',
      [campB],
    );
    expect(c.rows[0]!.n).toBe(0);
    // The profile itself landed in WS-A.
    const where = await world.pool.query<{ workspace_id: string }>('SELECT workspace_id FROM profiles WHERE id = $1', [pid]);
    expect(where.rows[0]!.workspace_id).toBe(WS);
  });
});
