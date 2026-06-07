// §20 / §12 — GET /billing/usage returns the computed cost view (direct + even
// share of fixed, summing to the platform total) plus an ip_recommendation badge
// from sending_identity (read-only; view_billing capability). Proven against
// REAL Postgres through the SAME dispatch pipeline the HTTP server uses.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl } from '@cdp/db';
import { makeWorld, tokenFor, call, type TestWorld } from './seed.js';

const WS = 'b111c000-0000-4000-8000-0000000000a1';
const WS2 = 'b111c000-0000-4000-8000-0000000000a2';
const OWNER = 'b111c000-0000-4000-8000-0000000000b1';
const MKT = 'b111c000-0000-4000-8000-0000000000b2';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

function monthBucket(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

describeMaybe('GET /billing/usage cost view (real Postgres)', () => {
  let world: TestWorld;
  const period = monthBucket(new Date());

  beforeAll(async () => {
    world = makeWorld();
    await cleanup();
    // WS: dedicated IP + 10k emails + a persisted ip_recommendation.
    await world.pool.query(
      "INSERT INTO workspaces (id, name, status, sending_identity) VALUES ($1,'Acme','active',$2::jsonb)",
      [WS, JSON.stringify({ ip_mode: 'dedicated', ip_recommendation: { recommend: true, reasons: ['sustained'] } })],
    );
    // WS2: another active workspace (shared) so the fixed split has >1 denominator.
    await world.pool.query(
      "INSERT INTO workspaces (id, name, status, sending_identity) VALUES ($1,'Beta','active',$2::jsonb)",
      [WS2, JSON.stringify({ ip_mode: 'shared' })],
    );
    for (const [u, role] of [[OWNER, 'owner'], [MKT, 'marketer']] as const) {
      await world.pool.query(
        'INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,$3)',
        [WS, u, role],
      );
    }
    await world.pool.query(
      `INSERT INTO usage_counters (workspace_id, period, metric, value) VALUES ($1,$2::date,'emails_sent',10000)
       ON CONFLICT (workspace_id, period, metric) DO UPDATE SET value = EXCLUDED.value`,
      [WS, period],
    );
  });

  afterAll(async () => {
    if (world) {
      await cleanup();
      await world.pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    for (const ws of [WS, WS2]) {
      await world.pool.query('DELETE FROM usage_counters WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [ws]);
      await world.pool.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    }
  }

  it('returns the computed cost (direct + fixed share) and the raw usage', async () => {
    const r = await call(world.env, 'GET', '/billing/usage', { token: tokenFor(OWNER, WS) });
    expect(r.status).toBe(200);
    const body = r.body as {
      usage: unknown[];
      cost: { directCost: number; fixedShare: number; total: number };
      totals: { directTotal: number; fixedTotal: number; activeWorkspaceCount: number };
    };
    expect(Array.isArray(body.usage)).toBe(true);
    // direct = 10k × $0.0001 ($1) + $24.95 dedicated IP = $25.95.
    expect(body.cost.directCost).toBeCloseTo(25.95, 6);
    expect(body.cost.fixedShare).toBeGreaterThan(0);
    expect(body.cost.total).toBeCloseTo(body.cost.directCost + body.cost.fixedShare, 6);
    expect(body.totals.activeWorkspaceCount).toBeGreaterThanOrEqual(2);
  });

  it('surfaces the ip_recommendation badge + ip_mode (read-only)', async () => {
    const r = await call(world.env, 'GET', '/billing/usage', { token: tokenFor(OWNER, WS) });
    const body = r.body as { ip_mode: string; ip_recommendation: { recommend: boolean } | null };
    expect(body.ip_mode).toBe('dedicated');
    expect(body.ip_recommendation?.recommend).toBe(true);
  });

  it('marketer is still 403 (view_billing capability unchanged)', async () => {
    const r = await call(world.env, 'GET', '/billing/usage', { token: tokenFor(MKT, WS) });
    expect(r.status).toBe(403);
  });
});
