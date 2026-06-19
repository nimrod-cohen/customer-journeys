// Scheduled-broadcast sweep (§9A): the dev server's local stand-in for the
// production EventBridge cron. A broadcast whose scheduled_at has passed is sent
// (status → sent, recipients enqueued); a future one is left untouched. REAL
// Postgres (the due-set query + status transitions live in the DB/core).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import { makeLocalDeps } from '../src/index.js';
import { sweepDueScheduledBroadcasts } from '../src/handlers.js';
import type { Pool } from 'pg';

const WS = '0c0d0e70-0000-4000-8000-000000000a01';
const SEG = '0c0d0e70-0000-4000-8000-0000000000d1';
const PROF = '0c0d0e70-0000-4000-8000-0000000000f1';
const TPL = '0c0d0e70-0000-4000-8000-0000000000a2';
const DUE = '0c0d0e70-0000-4000-8000-0000000000e1';
const FUTURE = '0c0d0e70-0000-4000-8000-0000000000e2';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('scheduled-broadcast sweep (real Postgres)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = adminPool();
    await cleanup();
    await pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [WS]);
    await pool.query("INSERT INTO segments (id, workspace_id, name, kind) VALUES ($1,$2,'S','manual')", [SEG, WS]);
    await pool.query("INSERT INTO profiles (id, workspace_id, external_id, email) VALUES ($1,$2,'s-1','s1@example.com')", [PROF, WS]);
    await pool.query("INSERT INTO segment_memberships (segment_id, profile_id, workspace_id, source) VALUES ($1,$2,$3,'manual')", [SEG, PROF, WS]);
    await pool.query(
      "INSERT INTO email_templates (id, workspace_id, name, mjml, compiled_html, subject, from_selected) VALUES ($1,$2,'T','<mjml/>','<html/>','Hi',true)",
      [TPL, WS],
    );
    await pool.query("INSERT INTO sending_domains (workspace_id, domain, verified, verified_at) VALUES ($1,'mail.x.test',true,now())", [WS]);
    // One broadcast DUE (scheduled an hour ago) and one in the future.
    await pool.query(
      `INSERT INTO broadcasts (id, workspace_id, name, template_id, audience_kind, audience_ref, status, scheduled_at)
       VALUES ($1,$2,'Due',$3,'manual',$4,'scheduled', now() - interval '1 hour')`,
      [DUE, WS, TPL, SEG],
    );
    await pool.query(
      `INSERT INTO broadcasts (id, workspace_id, name, template_id, audience_kind, audience_ref, status, scheduled_at)
       VALUES ($1,$2,'Future',$3,'manual',$4,'scheduled', now() + interval '1 day')`,
      [FUTURE, WS, TPL, SEG],
    );
  });

  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    await pool.query('DELETE FROM outbox WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM broadcasts WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM segment_memberships WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM segments WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM email_templates WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM profiles WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM sending_domains WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [WS]);
  }

  const statusOf = async (id: string): Promise<string> =>
    (await pool.query<{ status: string }>('SELECT status FROM broadcasts WHERE id = $1', [id])).rows[0]!.status;

  it('sends a DUE scheduled broadcast and leaves a future one scheduled', async () => {
    const processed = await sweepDueScheduledBroadcasts(pool, makeLocalDeps(pool));
    expect(processed).toBeGreaterThanOrEqual(1);

    expect(await statusOf(DUE)).toBe('sent');
    expect(await statusOf(FUTURE)).toBe('scheduled'); // not yet due → untouched

    // The due broadcast enqueued its one recipient.
    const ob = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM outbox WHERE workspace_id = $1 AND payload->>'broadcast_id' = $2",
      [WS, DUE],
    );
    expect(ob.rows[0]!.n).toBeGreaterThanOrEqual(1);
  });
});
