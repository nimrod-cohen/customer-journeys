import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { runFeedbackStatementsInTx } from '../src/deps.js';
import { handleNotification, type FeedbackDeps, type Reader } from '../src/feedback.js';
import { SOFT_BOUNCE_THRESHOLD_N } from '../src/core.js';

// §10 "Soft bounce → count; suppress after N". N DISTINCT soft bounces (distinct
// ses_message_id) suppress; a REPLAYED ses_message_id does NOT advance the count
// (idempotency index makes the replay a no-op). Real Postgres only.
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

async function suppressed(admin: Pool): Promise<boolean> {
  const r = await admin.query('SELECT 1 FROM suppressions WHERE workspace_id = $1 AND email = $2', [ws, email]);
  return (r.rowCount ?? 0) > 0;
}

async function cleanup(admin: Pool): Promise<void> {
  await admin.query('DELETE FROM email_events WHERE workspace_id = $1', [ws]);
  await admin.query('DELETE FROM suppressions WHERE workspace_id = $1', [ws]);
  await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
  await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
}

describe.skipIf(!RUN)('feedback soft bounce after N (real Postgres)', () => {
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

  it('suppresses only after N DISTINCT soft bounces', async () => {
    for (let i = 1; i < SOFT_BOUNCE_THRESHOLD_N; i++) {
      await handleNotification(deps, softBounce(`soft-${i}`));
      expect(await suppressed(admin)).toBe(false);
    }
    // The Nth distinct soft bounce crosses the threshold.
    await handleNotification(deps, softBounce(`soft-${SOFT_BOUNCE_THRESHOLD_N}`));
    expect(await suppressed(admin)).toBe(true);
  });

  it('a replayed ses_message_id does NOT advance the count', async () => {
    // Replay the SAME message id (N-1) times → still ONE distinct → no suppress.
    for (let i = 0; i < SOFT_BOUNCE_THRESHOLD_N + 2; i++) {
      await handleNotification(deps, softBounce('soft-replay'));
    }
    expect(await suppressed(admin)).toBe(false);
    const ev = await admin.query(
      "SELECT count(*)::int AS n FROM email_events WHERE workspace_id = $1 AND ses_message_id = 'soft-replay' AND type = 'bounce'",
      [ws],
    );
    expect(ev.rows[0].n).toBe(1);
  });
});
