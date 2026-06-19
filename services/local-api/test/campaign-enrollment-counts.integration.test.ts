// Integration (real Postgres): GET /campaigns returns each campaign with its
// lifecycle status AND a per-campaign enrollment-counts object {active,
// completed, exited, failed}, aggregated from campaign_enrollments in ONE
// workspace-scoped GROUP BY (campaign_id, status). Asserts counts are per-campaign
// + workspace-scoped (never sum another tenant's rows), all-zero for a campaign
// with no enrollments, and that GET /campaigns/:id still round-trips the full
// definition + timezone (regression). Never mocks the DB.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const WS = '0c0d0e98-0000-4000-8000-000000000a01';
const WS_B = '0c0d0e98-0000-4000-8000-000000000a02';
const OWNER = '0c0d0e98-0000-4000-8000-0000000000b1';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

const DEF = {
  startNode: 't',
  nodes: { t: { type: 'trigger', kind: 'manual', next: 'x' }, x: { type: 'exit' } },
};

interface CampaignWithCounts {
  id: string;
  name: string;
  status: string;
  counts: { active: number; completed: number; exited: number; failed: number };
}

describeMaybe('GET /campaigns enrollment counts (real Postgres)', () => {
  let world: TestWorld;
  const tok = () => tokenFor(OWNER, WS);
  let campA1 = '';
  let campA2 = '';
  let campAEmpty = '';
  let campB = '';

  async function makeCampaign(ws: string, name: string): Promise<string> {
    const r = await world.pool.query<{ id: string }>(
      "INSERT INTO campaigns (workspace_id, name, definition, status) VALUES ($1,$2,$3::jsonb,'active') RETURNING id",
      [ws, name, JSON.stringify(DEF)],
    );
    return r.rows[0]!.id;
  }
  async function enroll(ws: string, camp: string, status: string): Promise<void> {
    const p = await world.pool.query<{ id: string }>(
      'INSERT INTO profiles (workspace_id, email) VALUES ($1,$2) RETURNING id',
      [ws, `${camp}-${status}-${Math.random()}@e.test`],
    );
    await world.pool.query(
      "INSERT INTO campaign_enrollments (workspace_id, campaign_id, profile_id, current_node, status, next_run_at) VALUES ($1,$2,$3,'t',$4, now())",
      [ws, camp, p.rows[0]!.id, status],
    );
  }

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    for (const w of [WS, WS_B]) {
      await world.pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [w]);
    }
    await world.pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS, OWNER]);

    campA1 = await makeCampaign(WS, 'Camp A1');
    campA2 = await makeCampaign(WS, 'Camp A2');
    campAEmpty = await makeCampaign(WS, 'Camp A Empty');
    campB = await makeCampaign(WS_B, 'Camp B');

    // A1: 2 active, 1 completed, 1 exited, 1 failed.
    await enroll(WS, campA1, 'active');
    await enroll(WS, campA1, 'active');
    await enroll(WS, campA1, 'completed');
    await enroll(WS, campA1, 'exited');
    await enroll(WS, campA1, 'failed');
    // A2: 3 completed.
    await enroll(WS, campA2, 'completed');
    await enroll(WS, campA2, 'completed');
    await enroll(WS, campA2, 'completed');
    // WS_B campaign: 5 active — must NEVER be summed into WS_A.
    for (let i = 0; i < 5; i++) await enroll(WS_B, campB, 'active');
  });

  afterAll(async () => {
    if (world) {
      await cleanup();
      await world.pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    await world.pool.query('DELETE FROM campaign_enrollments WHERE workspace_id = ANY($1::uuid[])', [[WS, WS_B]]);
    await world.pool.query('DELETE FROM campaigns WHERE workspace_id = ANY($1::uuid[])', [[WS, WS_B]]);
    await world.pool.query('DELETE FROM profiles WHERE workspace_id = ANY($1::uuid[])', [[WS, WS_B]]);
    await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = ANY($1::uuid[])', [[WS, WS_B]]);
    await world.pool.query('DELETE FROM workspaces WHERE id = ANY($1::uuid[])', [[WS, WS_B]]);
  }

  it('returns per-campaign counts, workspace-scoped, all-zero for a campaign with none', async () => {
    const res = await call(world.env, 'GET', '/campaigns', { token: tok() });
    expect(res.status).toBe(200);
    const campaigns = (res.body as { campaigns: CampaignWithCounts[] }).campaigns;
    const byId = new Map(campaigns.map((c) => [c.id, c]));

    // Only WS_A campaigns are listed (WS_B's never appears).
    expect(byId.has(campB)).toBe(false);
    expect(byId.size).toBe(3);

    expect(byId.get(campA1)!.counts).toEqual({ active: 2, completed: 1, exited: 1, failed: 1 });
    expect(byId.get(campA2)!.counts).toEqual({ active: 0, completed: 3, exited: 0, failed: 0 });
    // A campaign with no enrollments returns an all-zero counts object.
    expect(byId.get(campAEmpty)!.counts).toEqual({ active: 0, completed: 0, exited: 0, failed: 0 });

    // status is surfaced too.
    expect(byId.get(campA1)!.status).toBe('active');
  });

  it('GET /campaigns/:id still returns the full definition + timezone (regression)', async () => {
    const res = await call(world.env, 'GET', `/campaigns/${campA1}`, { token: tok() });
    expect(res.status).toBe(200);
    const body = res.body as { campaign: { definition: typeof DEF }; timezone: string };
    expect(body.campaign.definition).toEqual(DEF);
    expect(typeof body.timezone).toBe('string');
  });
});
