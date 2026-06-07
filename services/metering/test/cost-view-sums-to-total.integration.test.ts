// §20 / §18 "Cost attribution" — the computed cost view = direct usage cost +
// equal share of fixed costs, and the per-workspace figures SUM TO THE TRUE
// TOTAL. Proven against REAL Postgres: we seed usage_counters + ip_mode for the
// active set, compute the view via the production read path, and assert
// penny-exact sum-to-total + that the $24.95 IP cost lands only on the upgraded
// workspace.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { runStatementsInWorkspaceTx } from '../src/deps.js';
import {
  DEFAULT_PRICES,
  computeCostViewForWorkspaces,
  type MeteringDeps,
} from '../src/index.js';

const RUN = hasDatabaseUrl();
const WS_SMALL = 'fe710000-0000-4000-8000-0000000000b1';
const WS_LARGE = 'fe710000-0000-4000-8000-0000000000b2';
const WS_IDLE = 'fe710000-0000-4000-8000-0000000000b3';
const ALL = [WS_SMALL, WS_LARGE, WS_IDLE];
const cents = (n: number) => Math.round(n * 100);

describe.skipIf(!RUN)('metering cost view sums to total (real Postgres)', () => {
  let admin: Pool;
  const period = '2026-06-01';

  function deps(): MeteringDeps {
    return {
      reader: { query: (text, values) => admin.query(text, values) },
      runInWorkspaceTx: (wsId, statements) => runStatementsInWorkspaceTx(admin, wsId, statements),
    };
  }

  async function setUsage(ws: string, metric: string, value: number): Promise<void> {
    await admin.query(
      `INSERT INTO usage_counters (workspace_id, period, metric, value) VALUES ($1,$2::date,$3,$4)
       ON CONFLICT (workspace_id, period, metric) DO UPDATE SET value = EXCLUDED.value`,
      [ws, period, metric, value],
    );
  }

  beforeAll(async () => {
    admin = adminPool();
    await cleanup();
    // small: shared pool; large: dedicated; idle: shared, no usage.
    await admin.query(
      "INSERT INTO workspaces (id, name, status, sending_identity) VALUES ($1,'small','active',$2::jsonb)",
      [WS_SMALL, JSON.stringify({ ip_mode: 'shared' })],
    );
    await admin.query(
      "INSERT INTO workspaces (id, name, status, sending_identity) VALUES ($1,'large','active',$2::jsonb)",
      [WS_LARGE, JSON.stringify({ ip_mode: 'dedicated' })],
    );
    await admin.query(
      "INSERT INTO workspaces (id, name, status, sending_identity) VALUES ($1,'idle','active',$2::jsonb)",
      [WS_IDLE, JSON.stringify({ ip_mode: 'shared' })],
    );
    await setUsage(WS_SMALL, 'emails_sent', 10_000);
    await setUsage(WS_LARGE, 'emails_sent', 300_000);
  });

  afterAll(async () => {
    if (admin) {
      await cleanup();
      await admin.end();
    }
  });

  async function cleanup(): Promise<void> {
    for (const ws of ALL) {
      await admin.query('DELETE FROM usage_counters WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    }
  }

  it('per-workspace figures sum to direct_total + fixed_total EXACTLY (penny-accurate)', async () => {
    const fixed = 40; // §20 example fixed pool
    const view = await computeCostViewForWorkspaces(deps(), ALL, period, fixed, DEFAULT_PRICES);
    const sumPerWs = view.workspaces.map((w) => cents(w.total)).reduce((a, b) => a + b, 0);
    const grand = cents(view.directTotal + view.fixedTotal);
    expect(sumPerWs).toBe(grand);
    expect(view.activeWorkspaceCount).toBe(3);
  });

  it('matches the §20 worked example shape (small ≈ part of $9, large includes $24.95 IP)', async () => {
    const fixed = 40;
    const view = await computeCostViewForWorkspaces(deps(), ALL, period, fixed, DEFAULT_PRICES);
    const small = view.workspaces.find((w) => w.workspaceId === WS_SMALL)!;
    const large = view.workspaces.find((w) => w.workspaceId === WS_LARGE)!;
    // fixed/3 ≈ 13.33/13.34 — penny-accurate; direct: small $1, large $30 + $24.95.
    expect(small.directCost).toBeCloseTo(1, 6);
    expect(large.directCost).toBeCloseTo(30 + 24.95, 6);
    // $24.95 IP lands ONLY on the dedicated workspace.
    expect(small.directCost).toBeLessThan(24.95);
  });

  it("the non-divisible fixed remainder is distributed penny-by-penny, summing exactly", async () => {
    const fixed = 40; // 40/3 = 13.333... → shares must differ by ≤ 1¢ and sum to 4000¢
    const view = await computeCostViewForWorkspaces(deps(), ALL, period, fixed, DEFAULT_PRICES);
    const shareCents = view.workspaces.map((w) => cents(w.fixedShare));
    expect(shareCents.reduce((a, b) => a + b, 0)).toBe(4000);
    expect(Math.max(...shareCents) - Math.min(...shareCents)).toBeLessThanOrEqual(1);
  });
});
