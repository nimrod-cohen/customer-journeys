import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { buildIsSuppressedQuery } from '@cdp/service-dispatcher';
import { runFeedbackStatementsInTx } from '../src/deps.js';
import { handleNotification, type FeedbackDeps, type Reader } from '../src/feedback.js';

// §10 / AC "Suppression scoping": a hard bounce suppresses in-workspace AND is
// recorded globally; a complaint suppresses in-workspace only (NO global row).
// Real Postgres only — the suppression + status writes live in the DB. We also
// cross-check against the Phase-7 dispatcher buildIsSuppressedQuery (global arm).
const RUN = hasDatabaseUrl();

const ws = 'fb100000-0000-0000-0000-0000000000a1';
const hardEmail = 'hardbounce@fb-hbc.example';
const complaintEmail = 'complainer@fb-hbc.example';

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
  await admin.query('DELETE FROM global_hard_bounces WHERE email IN ($1,$2)', [hardEmail, complaintEmail]);
}

describe.skipIf(!RUN)('feedback hard bounce / complaint (real Postgres)', () => {
  let admin: Pool;
  let deps: FeedbackDeps;

  beforeAll(async () => {
    admin = adminPool();
    deps = makeDeps(admin);
  });

  beforeEach(async () => {
    await cleanup(admin);
    await admin.query(
      `INSERT INTO workspaces (id, name, status, sending_identity)
       VALUES ($1, 'FB HBC', 'active', '{"from_domain":"mail.fb-hbc.example","config_set":"cs-fb-hbc","verified":true}')`,
      [ws],
    );
    await admin.query(
      `INSERT INTO profiles (workspace_id, email, email_status) VALUES ($1,$2,'active'),($1,$3,'active')`,
      [ws, hardEmail, complaintEmail],
    );
  });

  afterAll(async () => {
    if (admin) {
      await cleanup(admin);
      await admin.end();
    }
  });

  it('hard bounce → per-workspace suppression + global row + profile bounced + event row', async () => {
    const res = await handleNotification(deps, {
      eventType: 'Bounce',
      bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: hardEmail }] },
      mail: { messageId: 'hbc-hard-1', tags: { workspace_id: [ws] } },
    });
    expect(res.status).toBe('ok');

    const sup = await admin.query('SELECT reason FROM suppressions WHERE workspace_id = $1 AND email = $2', [ws, hardEmail]);
    expect(sup.rows[0]?.reason).toBe('hard_bounce');

    const glob = await admin.query('SELECT 1 FROM global_hard_bounces WHERE email = $1', [hardEmail]);
    expect(glob.rowCount).toBe(1);

    const prof = await admin.query('SELECT email_status FROM profiles WHERE workspace_id = $1 AND email = $2', [ws, hardEmail]);
    expect(prof.rows[0]?.email_status).toBe('bounced');

    const ev = await admin.query("SELECT type, sub_type FROM email_events WHERE workspace_id = $1 AND ses_message_id = 'hbc-hard-1'", [ws]);
    expect(ev.rows[0]).toMatchObject({ type: 'bounce', sub_type: 'Permanent' });

    // Phase-7 cross-check: the dispatcher's suppression query now blocks it.
    const isq = buildIsSuppressedQuery(ws, hardEmail);
    const sres = await admin.query(isq.text, isq.values);
    expect(sres.rows[0].suppressed).toBe(true);
  });

  it('complaint → per-workspace suppression + profile complained, NO global row', async () => {
    const res = await handleNotification(deps, {
      notificationType: 'Complaint',
      complaint: { complainedRecipients: [{ emailAddress: complaintEmail }] },
      mail: { messageId: 'hbc-comp-1', tags: { workspace_id: [ws] } },
    });
    expect(res.status).toBe('ok');

    const sup = await admin.query('SELECT reason FROM suppressions WHERE workspace_id = $1 AND email = $2', [ws, complaintEmail]);
    expect(sup.rows[0]?.reason).toBe('complaint');

    const glob = await admin.query('SELECT 1 FROM global_hard_bounces WHERE email = $1', [complaintEmail]);
    expect(glob.rowCount).toBe(0);

    const prof = await admin.query('SELECT email_status FROM profiles WHERE workspace_id = $1 AND email = $2', [ws, complaintEmail]);
    expect(prof.rows[0]?.email_status).toBe('complained');
  });
});
