import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import {
  buildBroadcastOutboxInsert,
  buildBroadcastDedupeKey,
} from '../src/core.js';

// §9A CRITICAL invariant: the BROADCAST layer of exactly-once. The outbox
// dedupe_key is UNIQUE per (broadcast_id, profile_id) and the insert is ON
// CONFLICT (dedupe_key) DO NOTHING — so a RETRY or a CONCURRENT broadcast run
// yields EXACTLY ONE outbox row per recipient. Proven against real Postgres.
const RUN = hasDatabaseUrl();
const ws = 'b9000000-0000-0000-0000-0000000000a3';

describe.skipIf(!RUN)('broadcast dedupe / idempotency (real Postgres)', () => {
  let admin: Pool;
  let templateId: string;
  let pIds: string[] = [];
  const broadcastId = 'b9000001-0000-0000-0000-0000000000a3';

  beforeAll(async () => {
    admin = adminPool();
    await cleanup();
    await admin.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [ws]);
    const t = await admin.query(
      "INSERT INTO email_templates (workspace_id, name, mjml, compiled_html) VALUES ($1,'t','<m/>','<html/>') RETURNING id",
      [ws],
    );
    templateId = t.rows[0].id;
    pIds = [];
    for (let i = 0; i < 3; i++) {
      const p = await admin.query(
        'INSERT INTO profiles (workspace_id, external_id, email) VALUES ($1,$2,$3) RETURNING id',
        [ws, `dd-${i}`, `dd-${i}@example.com`],
      );
      pIds.push(p.rows[0].id);
    }
  });

  afterAll(async () => {
    if (admin) {
      await cleanup();
      await admin.end();
    }
  });

  beforeEach(async () => {
    await admin.query('DELETE FROM outbox WHERE workspace_id = $1', [ws]);
  });

  async function cleanup() {
    await admin.query('DELETE FROM outbox WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM email_templates WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
  }

  it('a repeated insert of the same (broadcast, profiles) creates one row per recipient', async () => {
    const stmt = buildBroadcastOutboxInsert(ws, broadcastId, templateId, { broadcast_id: broadcastId }, pIds);
    await admin.query(stmt.text, stmt.values);
    await admin.query(stmt.text, stmt.values); // retry
    const n = await admin.query('SELECT count(*)::int n FROM outbox WHERE workspace_id = $1', [ws]);
    expect(n.rows[0].n).toBe(3);

    // and each row carries the deterministic dedupe key
    const keys = await admin.query('SELECT dedupe_key FROM outbox WHERE workspace_id = $1', [ws]);
    const expected = new Set(pIds.map((p) => buildBroadcastDedupeKey(broadcastId, p)));
    expect(new Set(keys.rows.map((r) => r.dedupe_key))).toEqual(expected);
  });

  it('concurrent inserts still yield exactly one row per recipient (UNIQUE dedupe_key)', async () => {
    const stmt = buildBroadcastOutboxInsert(ws, broadcastId, templateId, {}, pIds);
    await Promise.all([
      admin.query(stmt.text, stmt.values),
      admin.query(stmt.text, stmt.values),
      admin.query(stmt.text, stmt.values),
    ]);
    const n = await admin.query('SELECT count(*)::int n FROM outbox WHERE workspace_id = $1', [ws]);
    expect(n.rows[0].n).toBe(3);
  });
});
