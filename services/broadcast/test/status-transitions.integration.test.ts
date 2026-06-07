import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { buildBroadcastStatusUpdate } from '../src/core.js';

// §9A / §6 — the compare-and-set status update is atomic: it flips ONLY if the
// row is still in the `from` status, so a concurrent claim cannot double-send a
// broadcast. Proven against real Postgres.
const RUN = hasDatabaseUrl();
const ws = 'b9000000-0000-0000-0000-0000000000a4';

describe.skipIf(!RUN)('broadcast status compare-and-set (real Postgres)', () => {
  let admin: Pool;
  let broadcastId: string;

  beforeAll(async () => {
    admin = adminPool();
    await cleanup();
    await admin.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [ws]);
  });

  afterAll(async () => {
    if (admin) {
      await cleanup();
      await admin.end();
    }
  });

  beforeEach(async () => {
    await admin.query('DELETE FROM broadcasts WHERE workspace_id = $1', [ws]);
    const b = await admin.query(
      "INSERT INTO broadcasts (workspace_id, name, audience_kind, audience_ref, status) VALUES ($1,'B','segment',gen_random_uuid(),'draft') RETURNING id",
      [ws],
    );
    broadcastId = b.rows[0].id;
  });

  async function cleanup() {
    await admin.query('DELETE FROM broadcasts WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
  }

  it('claims draft→sending exactly once under concurrency', async () => {
    const stmt = buildBroadcastStatusUpdate(ws, broadcastId, 'draft', 'sending');
    const results = await Promise.all([
      admin.query(stmt.text, stmt.values),
      admin.query(stmt.text, stmt.values),
      admin.query(stmt.text, stmt.values),
    ]);
    const claimed = results.filter((r) => r.rowCount === 1);
    expect(claimed).toHaveLength(1);
    const st = await admin.query('SELECT status FROM broadcasts WHERE id = $1', [broadcastId]);
    expect(st.rows[0].status).toBe('sending');
  });

  it('sending→sent stamps sent_at; a stale draft→sending is a no-op afterward', async () => {
    await admin.query(...asArgs(buildBroadcastStatusUpdate(ws, broadcastId, 'draft', 'sending')));
    await admin.query(...asArgs(buildBroadcastStatusUpdate(ws, broadcastId, 'sending', 'sent')));
    const st = await admin.query('SELECT status, sent_at FROM broadcasts WHERE id = $1', [broadcastId]);
    expect(st.rows[0].status).toBe('sent');
    expect(st.rows[0].sent_at).not.toBeNull();

    // a late draft→sending now matches nothing (status is 'sent').
    const stale = buildBroadcastStatusUpdate(ws, broadcastId, 'draft', 'sending');
    const r = await admin.query(stale.text, stale.values);
    expect(r.rowCount).toBe(0);
  });
});

function asArgs(s: { text: string; values: unknown[] }): [string, unknown[]] {
  return [s.text, s.values];
}
