// §10 — the IP-advisor's inputs come from usage_counters (volume), messages_log
// (cadence / distinct send-days) and email_events (reputation). Proven against
// REAL Postgres: we seed a qualifying sender across 3 months and assert the
// advisor RECOMMENDS and PERSISTS ip_recommendation into sending_identity
// WITHOUT changing ip_mode; and a one-off spike does NOT.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { runStatementsInWorkspaceTx } from '../src/deps.js';
import {
  buildAdvisorSeriesRead,
  rowToMonthSeries,
  runAdvisorForWorkspace,
  DEFAULT_IP_THRESHOLDS,
  type MeteringDeps,
} from '../src/index.js';

const RUN = hasDatabaseUrl();
const WS_GOOD = 'fe720000-0000-4000-8000-0000000000c1';
const WS_SPIKE = 'fe720000-0000-4000-8000-0000000000c2';

describe.skipIf(!RUN)('metering IP-advisor inputs (real Postgres)', () => {
  let admin: Pool;
  let goodProfile: string;
  let spikeProfile: string;
  const months = ['2026-04-01', '2026-05-01', '2026-06-01'];

  function deps(): MeteringDeps {
    return {
      reader: { query: (text, values) => admin.query(text, values) },
      runInWorkspaceTx: (wsId, statements) => runStatementsInWorkspaceTx(admin, wsId, statements),
    };
  }

  async function setVolume(ws: string, period: string, value: number): Promise<void> {
    await admin.query(
      `INSERT INTO usage_counters (workspace_id, period, metric, value) VALUES ($1,$2::date,'emails_sent',$3)
       ON CONFLICT (workspace_id, period, metric) DO UPDATE SET value = EXCLUDED.value`,
      [ws, period, value],
    );
  }

  // Seed `days` distinct send-days in the given month (cadence signal).
  async function seedCadence(ws: string, profile: string, period: string, days: number): Promise<void> {
    const ym = period.slice(0, 7); // YYYY-MM
    for (let d = 1; d <= days; d++) {
      const dd = String(d).padStart(2, '0');
      await admin.query(
        "INSERT INTO messages_log (workspace_id, profile_id, status, sent_at) VALUES ($1,$2,'sent',$3::timestamptz)",
        [ws, profile, `${ym}-${dd}T09:00:00Z`],
      );
    }
  }

  beforeAll(async () => {
    admin = adminPool();
    await cleanup();
    for (const ws of [WS_GOOD, WS_SPIKE]) {
      await admin.query(
        "INSERT INTO workspaces (id, name, status, sending_identity) VALUES ($1,'W','active',$2::jsonb)",
        [ws, JSON.stringify({ ip_mode: 'shared', verified: true })],
      );
    }
    const g = await admin.query(
      "INSERT INTO profiles (workspace_id, external_id, email) VALUES ($1,'g','g@example.com') RETURNING id",
      [WS_GOOD],
    );
    goodProfile = g.rows[0].id;
    const s = await admin.query(
      "INSERT INTO profiles (workspace_id, external_id, email) VALUES ($1,'s','s@example.com') RETURNING id",
      [WS_SPIKE],
    );
    spikeProfile = s.rows[0].id;

    // GOOD: sustained ≥100k volume, ~25 send-days/mo, no bounces/complaints.
    for (const p of months) {
      await setVolume(WS_GOOD, p, 120_000);
      await seedCadence(WS_GOOD, goodProfile, p, 25);
    }
    // SPIKE: only June is high, and only a single send-day each month.
    await setVolume(WS_SPIKE, '2026-04-01', 2_000);
    await setVolume(WS_SPIKE, '2026-05-01', 3_000);
    await setVolume(WS_SPIKE, '2026-06-01', 200_000);
    for (const p of months) await seedCadence(WS_SPIKE, spikeProfile, p, 1);
  });

  afterAll(async () => {
    if (admin) {
      await cleanup();
      await admin.end();
    }
  });

  async function cleanup(): Promise<void> {
    for (const ws of [WS_GOOD, WS_SPIKE]) {
      await admin.query('DELETE FROM usage_counters WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM email_events WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM messages_log WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    }
  }

  it('reads the trailing series with volume + cadence + reputation per month', async () => {
    const q = buildAdvisorSeriesRead(WS_GOOD, new Date('2026-06-15T00:00:00Z'), 3);
    const { rows } = await admin.query(q.text, q.values);
    const series = rows.map(rowToMonthSeries);
    expect(series).toHaveLength(3);
    expect(series.every((m) => m.emailsSent === 120_000)).toBe(true);
    expect(series.every((m) => m.activeDays === 25)).toBe(true);
  });

  it('RECOMMENDS for a qualifying sender and persists ip_recommendation WITHOUT changing ip_mode', async () => {
    const verdict = await runAdvisorForWorkspace(
      deps(),
      WS_GOOD,
      new Date('2026-06-15T00:00:00Z'),
      DEFAULT_IP_THRESHOLDS,
    );
    expect(verdict.recommend).toBe(true);
    const r = await admin.query('SELECT sending_identity FROM workspaces WHERE id = $1', [WS_GOOD]);
    const si = r.rows[0].sending_identity as Record<string, unknown>;
    expect((si.ip_recommendation as { recommend: boolean }).recommend).toBe(true);
    // ip_mode untouched — recommending is not upgrading.
    expect(si.ip_mode).toBe('shared');
  });

  it('does NOT recommend a one-off spike (and persists recommend=false)', async () => {
    const verdict = await runAdvisorForWorkspace(
      deps(),
      WS_SPIKE,
      new Date('2026-06-15T00:00:00Z'),
      DEFAULT_IP_THRESHOLDS,
    );
    expect(verdict.recommend).toBe(false);
    const r = await admin.query('SELECT sending_identity FROM workspaces WHERE id = $1', [WS_SPIKE]);
    const si = r.rows[0].sending_identity as Record<string, unknown>;
    expect((si.ip_recommendation as { recommend: boolean }).recommend).toBe(false);
    expect(si.ip_mode).toBe('shared');
  });
});
