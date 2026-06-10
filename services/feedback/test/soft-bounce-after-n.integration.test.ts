import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { runFeedbackStatementsInTx } from '../src/deps.js';
import { handleNotification, type FeedbackDeps, type Reader } from '../src/feedback.js';
import { PERMANENT_SOFT_BOUNCE_DAYS, buildSoftBounceDayCountQuery } from '../src/core.js';

// §10 "Soft bounce → permanent after N distinct DAYS, no delivery in between".
// A profile that soft-bounces on N distinct UTC days (with no successful delivery
// between) flips to email_status='permanent_soft_bounce' and is suppressed with
// reason 'permanent_soft_bounce'. A delivery resets the window. Real Postgres only.
const RUN = hasDatabaseUrl();

const ws = 'fb500000-0000-0000-0000-0000000000a1';
const email = 'softy@fb-soft.example';

function makeDeps(pool: Pool): FeedbackDeps {
  const reader: Reader = {
    async query<T>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }> {
      const res = await pool.query(text, values as unknown[]);
      return { rows: res.rows as T[] };
    },
  };
  return { reader, runInWorkspaceTx: (w, s) => runFeedbackStatementsInTx(pool, w, s) };
}

function softBounce(messageId: string) {
  return {
    eventType: 'Bounce' as const,
    bounce: { bounceType: 'Transient', bouncedRecipients: [{ emailAddress: email }] },
    mail: { messageId, tags: { workspace_id: [ws] } },
  };
}

/** Directly record a past-dated soft bounce / delivery (to simulate distinct days). */
async function record(admin: Pool, type: string, subType: string | null, ses: string, at: string) {
  await admin.query(
    `INSERT INTO email_events (workspace_id, ses_message_id, type, sub_type, occurred_at, raw)
     VALUES ($1,$2,$3,$4,$5::timestamptz, jsonb_build_object('recipient',$6::text))`,
    [ws, ses, type, subType, at, email],
  );
}

async function suppression(admin: Pool): Promise<string | null> {
  const r = await admin.query<{ reason: string }>(
    'SELECT reason FROM suppressions WHERE workspace_id = $1 AND email = $2',
    [ws, email],
  );
  return r.rows[0]?.reason ?? null;
}
async function status(admin: Pool): Promise<string> {
  const r = await admin.query<{ email_status: string }>(
    'SELECT email_status FROM profiles WHERE workspace_id = $1 AND email = $2',
    [ws, email],
  );
  return r.rows[0]?.email_status ?? '';
}

async function cleanup(admin: Pool): Promise<void> {
  await admin.query('DELETE FROM email_events WHERE workspace_id = $1', [ws]);
  await admin.query('DELETE FROM suppressions WHERE workspace_id = $1', [ws]);
  await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
  await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
}

describe.skipIf(!RUN)('feedback permanent soft bounce after N distinct days (real Postgres)', () => {
  let admin: Pool;
  let deps: FeedbackDeps;

  beforeAll(async () => {
    admin = adminPool();
    deps = makeDeps(admin);
  });

  beforeEach(async () => {
    await cleanup(admin);
    await admin.query(
      `INSERT INTO workspaces (id, name, status, sending_identity) VALUES ($1,'FB Soft','active','{"verified":true}')`,
      [ws],
    );
    await admin.query(`INSERT INTO profiles (workspace_id, email, email_status) VALUES ($1,$2,'active')`, [ws, email]);
  });

  afterAll(async () => {
    if (admin) {
      await cleanup(admin);
      await admin.end();
    }
  });

  it('flips to permanent_soft_bounce only on the Nth DISTINCT day', async () => {
    // Two soft bounces on two distinct PAST days — not yet permanent.
    await record(admin, 'bounce', 'Transient', 's1', '2026-01-01T08:00:00Z');
    await record(admin, 'bounce', 'Transient', 's2', '2026-01-02T08:00:00Z');
    // (Count query includes "today" as a 3rd day → would be 3, but no live bounce
    // has been processed yet, so nothing is suppressed.)
    expect(await suppression(admin)).toBeNull();

    // A live soft bounce TODAY is the 3rd distinct day → permanent.
    await handleNotification(deps, softBounce('s3-today'));
    expect(await suppression(admin)).toBe('permanent_soft_bounce');
    expect(await status(admin)).toBe('permanent_soft_bounce');
  });

  it('two distinct days (incl. today) is NOT yet permanent', async () => {
    await record(admin, 'bounce', 'Transient', 's1', '2026-01-01T08:00:00Z'); // 1 past day
    await handleNotification(deps, softBounce('s2-today')); // + today = 2 days
    expect(await suppression(admin)).toBeNull();
    expect(await status(admin)).toBe('active');
  });

  it('multiple soft bounces on the SAME day count once', async () => {
    // Two distinct PAST days, plus two live bounces TODAY (same day) → 3 distinct
    // days total (day1, day2, today) → permanent on the first of today's bounces.
    await record(admin, 'bounce', 'Transient', 'p1', '2026-01-01T08:00:00Z');
    await record(admin, 'bounce', 'Transient', 'p2', '2026-01-01T20:00:00Z'); // same day as p1
    await handleNotification(deps, softBounce('t1')); // today: only 2 distinct days so far (jan1 + today)
    expect(await suppression(admin)).toBeNull();
  });

  it('a successful delivery RESETS the day window', async () => {
    await record(admin, 'bounce', 'Transient', 's1', '2026-01-01T00:00:00Z');
    await record(admin, 'bounce', 'Transient', 's2', '2026-01-02T00:00:00Z');
    await record(admin, 'delivery', null, 'd1', '2026-01-03T00:00:00Z'); // recovered
    const q = buildSoftBounceDayCountQuery(ws, email);
    const r = await admin.query<{ n: number }>(q.text, q.values);
    // Only "today" counts after the delivery (the two pre-delivery days are reset).
    expect(r.rows[0].n).toBe(1);
  });

  it('a replayed ses_message_id does NOT add a day', async () => {
    for (let i = 0; i < PERMANENT_SOFT_BOUNCE_DAYS + 2; i++) {
      await handleNotification(deps, softBounce('soft-replay'));
    }
    // All replays are the same id on the same day → 1 distinct day → not permanent.
    expect(await suppression(admin)).toBeNull();
    const ev = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM email_events WHERE workspace_id = $1 AND ses_message_id = 'soft-replay' AND type = 'bounce'",
      [ws],
    );
    expect(ev.rows[0].n).toBe(1);
  });
});
