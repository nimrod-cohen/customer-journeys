// Integration (real Postgres): DELETE /campaigns/:id — hard-delete a campaign
// that was NEVER PUBLISHED (active_version_id IS NULL). A campaign that HAS been
// published (active_version_id set) is never hard-deleted: archive it instead
// (409). Asserts: the never-published rule, the 409 on a published campaign,
// tenant isolation (a cross-workspace :id 404s — workspace_id NEVER from the
// body), capability gating (manage_content), and that GET /campaigns exposes the
// per-campaign `published` boolean. Never mocks the DB.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const WS = '0c0d0e97-0000-4000-8000-000000000d01';
const WS_B = '0c0d0e97-0000-4000-8000-000000000d02';
const OWNER = '0c0d0e97-0000-4000-8000-0000000000d1';
const ACCT = '0c0d0e97-0000-4000-8000-0000000000d2';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

const eventDef = (eventType: string) => ({
  startNode: 't',
  nodes: {
    t: { type: 'trigger', kind: 'event', eventType, next: 'x' },
    x: { type: 'exit' },
  },
});

describeMaybe('DELETE /campaigns/:id (real Postgres)', () => {
  let world: TestWorld;
  const ownerTok = () => tokenFor(OWNER, WS);
  const acctTok = () => tokenFor(ACCT, WS);

  async function makeCampaign(ws: string, status = 'draft', def: unknown = eventDef('purchase')): Promise<string> {
    const r = await world.pool.query<{ id: string }>(
      "INSERT INTO campaigns (workspace_id, name, definition, status) VALUES ($1,'C',$2::jsonb,$3) RETURNING id",
      [ws, JSON.stringify(def), status],
    );
    return r.rows[0]!.id;
  }
  // Publish = create a campaign_versions snapshot and point active_version_id at it.
  async function publish(ws: string, campaignId: string): Promise<string> {
    const v = await world.pool.query<{ id: string }>(
      `INSERT INTO campaign_versions (workspace_id, campaign_id, version, name, definition)
       VALUES ($1,$2,1,'v1',$3::jsonb) RETURNING id`,
      [ws, campaignId, JSON.stringify(eventDef('purchase'))],
    );
    const vid = v.rows[0]!.id;
    await world.pool.query("UPDATE campaigns SET active_version_id = $1, status = 'active' WHERE id = $2", [vid, campaignId]);
    return vid;
  }
  async function exists(id: string): Promise<boolean> {
    const r = await world.pool.query('SELECT 1 FROM campaigns WHERE id = $1', [id]);
    return (r.rowCount ?? 0) > 0;
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
    await wipe();
  });

  async function wipe(): Promise<void> {
    await world.pool.query('DELETE FROM campaign_enrollments WHERE workspace_id = ANY($1::uuid[])', [[WS, WS_B]]);
    // Clear active_version_id first so campaign_versions (referenced by it) can drop.
    await world.pool.query('UPDATE campaigns SET active_version_id = NULL WHERE workspace_id = ANY($1::uuid[])', [[WS, WS_B]]);
    await world.pool.query('DELETE FROM campaign_versions WHERE workspace_id = ANY($1::uuid[])', [[WS, WS_B]]);
    await world.pool.query('DELETE FROM campaigns WHERE workspace_id = ANY($1::uuid[])', [[WS, WS_B]]);
    await world.pool.query('DELETE FROM profiles WHERE workspace_id = ANY($1::uuid[])', [[WS, WS_B]]);
  }

  async function cleanup(): Promise<void> {
    await wipe();
    await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = ANY($1::uuid[])', [[WS, WS_B]]);
    await world.pool.query('DELETE FROM workspaces WHERE id = ANY($1::uuid[])', [[WS, WS_B]]);
  }

  it('deletes a NEVER-published (active_version_id NULL) campaign → 200, row gone', async () => {
    const camp = await makeCampaign(WS, 'draft');
    const r = await call(world.env, 'DELETE', `/campaigns/${camp}`, { token: ownerTok() });
    expect(r.status).toBe(200);
    expect((r.body as { deleted: number }).deleted).toBe(1);
    expect(await exists(camp)).toBe(false);
  });

  it('refuses a PUBLISHED campaign (active_version_id set) with 409 — archive instead; row stays', async () => {
    const camp = await makeCampaign(WS, 'draft');
    await publish(WS, camp);
    const r = await call(world.env, 'DELETE', `/campaigns/${camp}`, { token: ownerTok() });
    expect(r.status).toBe(409);
    expect(typeof (r.body as { error?: string }).error).toBe('string');
    expect((r.body as { error: string }).error).toMatch(/archive/i);
    expect(await exists(camp)).toBe(true);
  });

  it('tenant isolation: deleting a WS_B campaign under a WS_A token 404s (workspace_id never from body)', async () => {
    const foreign = await makeCampaign(WS_B, 'draft');
    const r = await call(world.env, 'DELETE', `/campaigns/${foreign}`, { token: ownerTok() });
    expect(r.status).toBe(404);
    expect(await exists(foreign)).toBe(true);
    // A body-supplied workspace_id must NEVER widen scope (inv.2).
    const r2 = await call(world.env, 'DELETE', `/campaigns/${foreign}`, {
      token: ownerTok(),
      body: { workspace_id: WS_B },
    });
    expect(r2.status).toBe(404);
    expect(await exists(foreign)).toBe(true);
  });

  it('404s on a non-existent id', async () => {
    const r = await call(world.env, 'DELETE', `/campaigns/0c0d0e97-0000-4000-8000-0000000000ff`, { token: ownerTok() });
    expect(r.status).toBe(404);
  });

  it('capability: an accounting role (no manage_content) is 403', async () => {
    const camp = await makeCampaign(WS, 'draft');
    const r = await call(world.env, 'DELETE', `/campaigns/${camp}`, { token: acctTok() });
    expect(r.status).toBe(403);
    expect(await exists(camp)).toBe(true);
  });

  it('GET /campaigns exposes `published`: false for a fresh draft, true after publish', async () => {
    const draft = await makeCampaign(WS, 'draft');
    const pub = await makeCampaign(WS, 'draft');
    await publish(WS, pub);

    const r = await call(world.env, 'GET', '/campaigns', { token: ownerTok() });
    expect(r.status).toBe(200);
    const list = (r.body as { campaigns: { id: string; published: boolean }[] }).campaigns;
    const byId = new Map(list.map((c) => [c.id, c]));
    expect(byId.get(draft)?.published).toBe(false);
    expect(byId.get(pub)?.published).toBe(true);
  });
});
