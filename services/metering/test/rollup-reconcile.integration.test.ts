// §20 / §18 "Cost attribution" reconciliation, proven against REAL Postgres.
// emails_sent is already incremented per-send by the Dispatcher; the rollup
// DERIVES the authoritative monthly total from messages_log and writes it
// SET-to-truth. We prove:
//   (a) the rollup equals the true count of 'sent' messages_log rows in the month,
//   (b) re-running is IDEMPOTENT (no doubling — SET-to-truth, not additive),
//   (c) a DRIFTED counter (set too high) is HEALED back to the true count,
//   (d) it is scoped per workspace (another workspace's rows never bleed in).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { runStatementsInWorkspaceTx } from '../src/deps.js';
import { planRollups, runRollupForWorkspace, type MeteringDeps } from '../src/index.js';

const RUN = hasDatabaseUrl();
const WS = 'fe700000-0000-4000-8000-0000000000a1';
const WS_OTHER = 'fe700000-0000-4000-8000-0000000000a2';

describe.skipIf(!RUN)('metering rollup reconcile (real Postgres)', () => {
  let admin: Pool;
  let profileId: string;
  let otherProfileId: string;
  const period = '2026-06-01';

  async function seedSentMessages(ws: string, profile: string, n: number, monthDay: string): Promise<void> {
    for (let i = 0; i < n; i++) {
      await admin.query(
        "INSERT INTO messages_log (workspace_id, profile_id, status, sent_at) VALUES ($1,$2,'sent',$3::timestamptz)",
        [ws, profile, `2026-06-${monthDay}T10:00:00Z`],
      );
    }
  }

  function deps(): MeteringDeps {
    return {
      reader: { query: (text, values) => admin.query(text, values) },
      runInWorkspaceTx: (wsId, statements) => runStatementsInWorkspaceTx(admin, wsId, statements),
    };
  }

  beforeAll(async () => {
    admin = adminPool();
    await cleanup();
    for (const ws of [WS, WS_OTHER]) {
      await admin.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [ws]);
    }
    const p = await admin.query(
      "INSERT INTO profiles (workspace_id, external_id, email) VALUES ($1,'r','r@example.com') RETURNING id",
      [WS],
    );
    profileId = p.rows[0].id;
    const po = await admin.query(
      "INSERT INTO profiles (workspace_id, external_id, email) VALUES ($1,'ro','ro@example.com') RETURNING id",
      [WS_OTHER],
    );
    otherProfileId = po.rows[0].id;

    // 7 sent in June for WS; 3 sent in June for WS_OTHER; plus 1 NON-sent for WS.
    await seedSentMessages(WS, profileId, 7, '05');
    await seedSentMessages(WS_OTHER, otherProfileId, 3, '06');
    await admin.query(
      "INSERT INTO messages_log (workspace_id, profile_id, status, sent_at) VALUES ($1,$2,'failed','2026-06-05T10:00:00Z')",
      [WS, profileId],
    );
    // A May send for WS that must NOT count toward June.
    await admin.query(
      "INSERT INTO messages_log (workspace_id, profile_id, status, sent_at) VALUES ($1,$2,'sent','2026-05-30T10:00:00Z')",
      [WS, profileId],
    );
  });

  afterAll(async () => {
    if (admin) {
      await cleanup();
      await admin.end();
    }
  });

  async function cleanup(): Promise<void> {
    for (const ws of [WS, WS_OTHER]) {
      await admin.query('DELETE FROM usage_counters WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM messages_log WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM events WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    }
  }

  async function emailsSentCounter(ws: string): Promise<number | null> {
    const r = await admin.query(
      "SELECT value FROM usage_counters WHERE workspace_id = $1 AND period = $2::date AND metric = 'emails_sent'",
      [ws, period],
    );
    return r.rows[0] ? Number(r.rows[0].value) : null;
  }

  it('derives the authoritative count (7) of June sent messages, excluding failed + May', async () => {
    await runStatementsInWorkspaceTx(admin, WS, planRollups(WS, period));
    expect(await emailsSentCounter(WS)).toBe(7);
  });

  it('is idempotent: re-running does NOT double the value (SET-to-truth)', async () => {
    await runStatementsInWorkspaceTx(admin, WS, planRollups(WS, period));
    await runStatementsInWorkspaceTx(admin, WS, planRollups(WS, period));
    expect(await emailsSentCounter(WS)).toBe(7);
  });

  it('heals a drifted (too-high) counter back to the true count', async () => {
    await admin.query(
      `INSERT INTO usage_counters (workspace_id, period, metric, value) VALUES ($1,$2::date,'emails_sent',999)
       ON CONFLICT (workspace_id, period, metric) DO UPDATE SET value = 999`,
      [WS, period],
    );
    expect(await emailsSentCounter(WS)).toBe(999);
    await runRollupForWorkspace(deps(), WS, new Date('2026-06-15T00:00:00Z'));
    expect(await emailsSentCounter(WS)).toBe(7);
  });

  it('is workspace-scoped: WS_OTHER reconciles to its own 3, no bleed', async () => {
    await runRollupForWorkspace(deps(), WS_OTHER, new Date('2026-06-15T00:00:00Z'));
    expect(await emailsSentCounter(WS_OTHER)).toBe(3);
    // WS unchanged.
    expect(await emailsSentCounter(WS)).toBe(7);
  });
});
