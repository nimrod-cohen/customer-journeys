import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { runFeedbackStatementsInTx } from '../src/deps.js';
import { handleNotification, type FeedbackDeps, type Reader } from '../src/feedback.js';

// §10 / CLAUDE.md invariant 5: idempotent on the SES message id. A re-delivered
// SNS notification → ONE email_events row, ONE suppression, ONE global row
// (ON CONFLICT DO NOTHING on the (workspace_id, ses_message_id, type) index and
// the PKs). Real Postgres only — the dedupe lives in the DB.
const RUN = hasDatabaseUrl();

const ws = 'fb400000-0000-0000-0000-0000000000a1';
const email = 'replay@fb-idem.example';

function makeDeps(pool: Pool): FeedbackDeps {
  const reader: Reader = {
    async query<T>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }> {
      const res = await pool.query(text, values as unknown[]);
      return { rows: res.rows as T[] };
    },
  };
  return { reader, runInWorkspaceTx: (w, s) => runFeedbackStatementsInTx(pool, w, s) };
}

async function cleanup(admin: Pool): Promise<void> {
  await admin.query('DELETE FROM email_events WHERE workspace_id = $1', [ws]);
  await admin.query('DELETE FROM suppressions WHERE workspace_id = $1', [ws]);
  await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
  await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
  await admin.query('DELETE FROM global_hard_bounces WHERE email = $1', [email]);
}

describe.skipIf(!RUN)('feedback idempotency on SES message id (real Postgres)', () => {
  let admin: Pool;
  let deps: FeedbackDeps;

  beforeAll(async () => {
    admin = adminPool();
    deps = makeDeps(admin);
  });

  beforeEach(async () => {
    await cleanup(admin);
    await admin.query(
      `INSERT INTO workspaces (id, name, status, sending_identity) VALUES ($1,'FB Idem','active','{"verified":true}')`,
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

  it('re-delivering the SAME hard-bounce notification yields ONE row each', async () => {
    const note = {
      eventType: 'Bounce' as const,
      bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: email }] },
      mail: { messageId: 'idem-hard-1', tags: { workspace_id: [ws] } },
    };
    await handleNotification(deps, note);
    await handleNotification(deps, note); // replay
    await handleNotification(deps, note); // replay again

    const ev = await admin.query(
      "SELECT count(*)::int AS n FROM email_events WHERE workspace_id = $1 AND ses_message_id = 'idem-hard-1' AND type = 'bounce'",
      [ws],
    );
    expect(ev.rows[0].n).toBe(1);

    const sup = await admin.query('SELECT count(*)::int AS n FROM suppressions WHERE workspace_id = $1 AND email = $2', [ws, email]);
    expect(sup.rows[0].n).toBe(1);

    const glob = await admin.query('SELECT count(*)::int AS n FROM global_hard_bounces WHERE email = $1', [email]);
    expect(glob.rows[0].n).toBe(1);
  });
});
