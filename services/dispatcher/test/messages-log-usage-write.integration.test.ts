import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { runStatementsInWorkspaceTx } from '../src/deps.js';
import {
  buildMessagesLogInsert,
  buildUsageCounterIncrement,
  buildOutboxMarkSent,
} from '../src/core.js';

// §9 step 7 / §20 — on a successful send, messages_log + usage_counters
// (emails_sent) + the outbox mark-sent commit in ONE workspace-scoped tx. Real
// Postgres: we run the EXACT production write path (runStatementsInWorkspaceTx)
// and prove (a) all three land together, and (b) a FORCED failure mid-tx rolls
// back ALL of them (no partial messages_log/usage write).
const RUN = hasDatabaseUrl();

const ws = 'd7000000-0000-0000-0000-0000000000a7';

describe.skipIf(!RUN)('dispatcher messages_log + usage write atomicity (real Postgres)', () => {
  let admin: Pool;
  let profileId: string;
  let outboxId: string;
  const now = new Date('2026-06-10T12:00:00.000Z');

  beforeAll(async () => {
    admin = adminPool();
    await admin.query('DELETE FROM messages_log WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM usage_counters WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM outbox WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    await admin.query("INSERT INTO workspaces (id, name) VALUES ($1,'W')", [ws]);
    const p = await admin.query(
      "INSERT INTO profiles (workspace_id, external_id, email) VALUES ($1,'mlu','mlu@example.com') RETURNING id",
      [ws],
    );
    profileId = p.rows[0].id;
    const o = await admin.query(
      "INSERT INTO outbox (workspace_id, profile_id, status) VALUES ($1,$2,'sending') RETURNING id",
      [ws, profileId],
    );
    outboxId = o.rows[0].id;
  });

  afterAll(async () => {
    if (admin) {
      await admin.query('DELETE FROM messages_log WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM usage_counters WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM outbox WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
      await admin.end();
    }
  });

  it('writes messages_log + usage_counters + marks outbox sent in one tx', async () => {
    await runStatementsInWorkspaceTx(admin, ws, [
      buildMessagesLogInsert(ws, profileId, null, 'ses-msg-1'),
      buildUsageCounterIncrement(ws, now),
      buildOutboxMarkSent(ws, outboxId),
    ]);

    const ml = await admin.query('SELECT count(*)::int n FROM messages_log WHERE workspace_id = $1', [ws]);
    const uc = await admin.query(
      "SELECT value FROM usage_counters WHERE workspace_id = $1 AND metric = 'emails_sent'",
      [ws],
    );
    const ob = await admin.query('SELECT status FROM outbox WHERE id = $1', [outboxId]);
    expect(ml.rows[0].n).toBe(1);
    expect(Number(uc.rows[0].value)).toBe(1);
    expect(ob.rows[0].status).toBe('sent');
  });

  it('a forced failure mid-tx rolls back BOTH messages_log and usage_counters', async () => {
    const before = await admin.query('SELECT count(*)::int n FROM messages_log WHERE workspace_id = $1', [ws]);
    const ucBefore = await admin.query(
      "SELECT value FROM usage_counters WHERE workspace_id = $1 AND metric = 'emails_sent'",
      [ws],
    );

    await expect(
      runStatementsInWorkspaceTx(admin, ws, [
        buildMessagesLogInsert(ws, profileId, null, 'ses-msg-2'),
        buildUsageCounterIncrement(ws, now),
        // A deliberately broken statement (still workspace-scoped at $1) forces
        // a mid-tx error AFTER the two good writes → the whole tx rolls back.
        { text: 'UPDATE outbox SET nonexistent_column = 1 WHERE workspace_id = $1', values: [ws] },
      ]),
    ).rejects.toThrow();

    const after = await admin.query('SELECT count(*)::int n FROM messages_log WHERE workspace_id = $1', [ws]);
    const ucAfter = await admin.query(
      "SELECT value FROM usage_counters WHERE workspace_id = $1 AND metric = 'emails_sent'",
      [ws],
    );
    // Unchanged — neither the messages_log insert nor the usage bump persisted.
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect(Number(ucAfter.rows[0].value)).toBe(Number(ucBefore.rows[0].value));
  });

  it('rejects a statement not scoped to the requested workspace (tenancy guard)', async () => {
    await expect(
      runStatementsInWorkspaceTx(admin, ws, [
        { text: 'SELECT 1 WHERE $1 IS NOT NULL', values: ['some-other-workspace'] },
      ]),
    ).rejects.toThrow(/not scoped/);
  });
});
