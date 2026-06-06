import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { runFeedbackStatementsInTx } from '../src/deps.js';
import { handleNotification, type FeedbackDeps, type Reader } from '../src/feedback.js';
import { MIN_SENT_FOR_RATE, BOUNCE_RATE_CRITICAL } from '../src/core.js';

// §10 / AC "Reputation policing": a workspace exceeding its per-workspace
// bounce/complaint thresholds is auto-suspended WITHOUT pausing other
// workspaces. The rate uses email_events (numerator) over messages_log
// (denominator) with a MIN_SENT_FOR_RATE guard. Real Postgres only.
const RUN = hasDatabaseUrl();

const offender = 'fb300000-0000-0000-0000-00000000bad1';
const healthy = 'fb300000-0000-0000-0000-00000000fee1';

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
  for (const ws of [offender, healthy]) {
    await admin.query('DELETE FROM email_events WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM messages_log WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM suppressions WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
  }
  await admin.query("DELETE FROM global_hard_bounces WHERE email LIKE '%fb-suspend.example'");
}

describe.skipIf(!RUN)('feedback auto-suspend isolation (real Postgres)', () => {
  let admin: Pool;
  let deps: FeedbackDeps;

  beforeAll(async () => {
    admin = adminPool();
    deps = makeDeps(admin);
    await cleanup(admin);
    for (const [ws, name] of [[offender, 'Offender'], [healthy, 'Healthy']] as const) {
      await admin.query(
        `INSERT INTO workspaces (id, name, status, sending_identity)
         VALUES ($1, $2, 'active', '{"verified":true}')`,
        [ws, name],
      );
    }
    // Both have plenty of sends (denominator over the MIN guard).
    const sent = MIN_SENT_FOR_RATE * 4;
    for (const ws of [offender, healthy]) {
      const p = await admin.query(
        `INSERT INTO profiles (workspace_id, email, email_status) VALUES ($1,$2,'active') RETURNING id`,
        [ws, `seed@${ws}.fb-suspend.example`],
      );
      const pid = p.rows[0].id as string;
      const values: string[] = [];
      for (let i = 0; i < sent; i++) values.push(`('${ws}','${pid}','sent')`);
      await admin.query(`INSERT INTO messages_log (workspace_id, profile_id, status) VALUES ${values.join(',')}`);
    }
    // Offender already has MANY prior bounces in email_events (over critical rate).
    const offProfile = (
      await admin.query('SELECT id FROM profiles WHERE workspace_id = $1 LIMIT 1', [offender])
    ).rows[0].id as string;
    const bounceCount = Math.ceil(sent * (BOUNCE_RATE_CRITICAL + 0.05));
    for (let i = 0; i < bounceCount; i++) {
      await admin.query(
        `INSERT INTO email_events (workspace_id, ses_message_id, profile_id, type, sub_type)
         VALUES ($1, $2, $3, 'bounce', 'Permanent')`,
        [offender, `prior-bounce-${i}`, offProfile],
      );
    }
  });

  afterAll(async () => {
    if (admin) {
      await cleanup(admin);
      await admin.end();
    }
  });

  it('auto-suspends the offending workspace and leaves the healthy one active', async () => {
    // One more hard bounce for the offender triggers policing.
    await handleNotification(deps, {
      eventType: 'Bounce',
      bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: `trigger@${offender}.fb-suspend.example` }] },
      mail: { messageId: 'suspend-trigger', tags: { workspace_id: [offender] } },
    });

    const off = await admin.query('SELECT status FROM workspaces WHERE id = $1', [offender]);
    expect(off.rows[0].status).toBe('suspended');

    const ok = await admin.query('SELECT status FROM workspaces WHERE id = $1', [healthy]);
    expect(ok.rows[0].status).toBe('active');
  });

  it('a single bounce in the healthy workspace does NOT suspend it (under threshold)', async () => {
    await handleNotification(deps, {
      eventType: 'Bounce',
      bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: `one@${healthy}.fb-suspend.example` }] },
      mail: { messageId: 'healthy-one-bounce', tags: { workspace_id: [healthy] } },
    });
    const ok = await admin.query('SELECT status FROM workspaces WHERE id = $1', [healthy]);
    expect(ok.rows[0].status).toBe('active');
  });
});
