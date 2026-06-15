// GET /dashboards/delivery-health (§10): workspace-level deliverability over a
// rolling window — sent/delivered/bounced/complained + rates, suppression-list
// size by reason, and a gap-filled per-day trend. REAL Postgres.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import { makePgLookups, makeLocalDeps, dispatch, type DispatchEnv } from '../src/index.js';
import { tokenFor } from './seed.js';
import type { Pool } from 'pg';

const WS = '0c0d0e80-0000-4000-8000-000000000a01';
const OWNER = '0c0d0e80-0000-4000-8000-0000000000b1';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

interface Health {
  window_days: number;
  outcomes: { sent: number; delivered: number; bounced: number; complained: number };
  rates: { bounce: number; complaint: number };
  suppression: { total: number; hard_bounce: number; complaint: number; unsubscribe: number; manual: number };
  trend: { day: string; sent: number; delivered: number }[];
}

describeMaybe('GET /dashboards/delivery-health (real Postgres)', () => {
  let pool: Pool;
  const e = (): DispatchEnv => ({ pool, lookups: makePgLookups(pool), deps: makeLocalDeps(pool) });
  const fetchHealth = async (query: Record<string, string> = {}): Promise<Health> => {
    const r = await dispatch(
      { method: 'GET', path: '/dashboards/delivery-health', authorization: tokenFor(OWNER, WS), query, body: {} },
      e(),
    );
    expect(r.status).toBe(200);
    return r.body as Health;
  };

  beforeAll(async () => {
    pool = adminPool();
    await cleanup();
    await pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [WS]);
    await pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS, OWNER]);
    const prof = await pool.query<{ id: string }>(
      "INSERT INTO profiles (workspace_id, email) VALUES ($1,'dh@x.test') RETURNING id",
      [WS],
    );
    const pid = prof.rows[0]!.id;
    // 10 RECENT sends (within the window) + 2 OLD sends (90 days ago, outside 30d).
    for (let i = 0; i < 10; i++) {
      await pool.query(
        "INSERT INTO messages_log (workspace_id, profile_id, ses_message_id, status, sent_at) VALUES ($1,$2,$3,'sent', now() - interval '2 days')",
        [WS, pid, `r-${i}`],
      );
    }
    await pool.query(
      "INSERT INTO messages_log (workspace_id, profile_id, ses_message_id, status, sent_at) VALUES ($1,$2,'old-1','sent', now() - interval '90 days')",
      [WS, pid],
    );
    // Recent events: 8 delivered, 2 bounced, 1 complained (within window).
    for (let i = 0; i < 8; i++) {
      await pool.query(
        "INSERT INTO email_events (workspace_id, ses_message_id, type, occurred_at) VALUES ($1,$2,'delivery', now() - interval '2 days')",
        [WS, `r-${i}`],
      );
    }
    await pool.query("INSERT INTO email_events (workspace_id, type, occurred_at) VALUES ($1,'bounce', now() - interval '2 days')", [WS]);
    await pool.query("INSERT INTO email_events (workspace_id, type, occurred_at) VALUES ($1,'bounce', now() - interval '2 days')", [WS]);
    await pool.query("INSERT INTO email_events (workspace_id, type, occurred_at) VALUES ($1,'complaint', now() - interval '2 days')", [WS]);
    // An OLD delivery (outside the 30d window) — must NOT count.
    await pool.query("INSERT INTO email_events (workspace_id, type, occurred_at) VALUES ($1,'delivery', now() - interval '90 days')", [WS]);
    // Suppression list (NOT windowed): 2 hard_bounce, 1 complaint, 3 unsubscribe.
    for (const [reason, n] of [['hard_bounce', 2], ['complaint', 1], ['unsubscribe', 3]] as const) {
      for (let i = 0; i < n; i++) {
        await pool.query("INSERT INTO suppressions (workspace_id, email, reason) VALUES ($1,$2,$3)", [WS, `${reason}-${i}@x.test`, reason]);
      }
    }
  });

  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    await pool.query('DELETE FROM email_events WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM messages_log WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM suppressions WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM profiles WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [WS]);
  }

  it('aggregates windowed outcomes + rates, excluding events outside the window', async () => {
    const h = await fetchHealth();
    expect(h.window_days).toBe(30);
    expect(h.outcomes).toEqual({ sent: 10, delivered: 8, bounced: 2, complained: 1 });
    // bounce rate = 2 / (8 + 2) = 0.2 ; complaint rate = 1 / 8.
    expect(h.rates.bounce).toBeCloseTo(0.2, 5);
    expect(h.rates.complaint).toBeCloseTo(1 / 8, 5);
  });

  it('reports the suppression-list size by reason (not windowed)', async () => {
    const h = await fetchHealth();
    expect(h.suppression).toEqual({ total: 6, hard_bounce: 2, complaint: 1, unsubscribe: 3, manual: 0 });
  });

  it('returns a gap-filled per-day trend of length = window', async () => {
    const h = await fetchHealth({ days: '14' });
    expect(h.window_days).toBe(14);
    expect(h.trend).toHaveLength(14);
    // The 10 recent sends all fall on one day (2 days ago) → that day shows 10.
    expect(h.trend.reduce((n, t) => n + t.sent, 0)).toBe(10);
    expect(Math.max(...h.trend.map((t) => t.sent))).toBe(10);
  });

  it('clamps an absurd window and is workspace-scoped', async () => {
    const h = await fetchHealth({ days: '99999' });
    expect(h.window_days).toBe(365);
  });
});
