// GET /broadcasts returns per-broadcast metrics (§9A): Sent/Delivered/Failed from
// messages_log + email_events (joined by ses_message_id, attributed via
// messages_log.broadcast_id), and Clicked summed from tracked_links. REAL Postgres.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import { makePgLookups, makeLocalDeps, dispatch, type DispatchEnv } from '../src/index.js';
import { tokenFor } from './seed.js';
import type { Pool } from 'pg';

const WS = '0c0d0e60-0000-4000-8000-000000000a01';
const OWNER = '0c0d0e60-0000-4000-8000-0000000000b1';
const BCAST = '0c0d0e60-0000-4000-8000-0000000000e1';
const P1 = '0c0d0e60-0000-4000-8000-0000000000f1';
const P2 = '0c0d0e60-0000-4000-8000-0000000000f2';
const P3 = '0c0d0e60-0000-4000-8000-0000000000f3';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

interface Row {
  id: string;
  updated_at: string | null;
  stats: { sent: number; delivered: number; failed: number; clicked: number; opened: number; unsubscribed: number };
}

describeMaybe('broadcast metrics via GET /broadcasts (real Postgres)', () => {
  let pool: Pool;
  const e = (): DispatchEnv => ({ pool, lookups: makePgLookups(pool), deps: makeLocalDeps(pool) });

  beforeAll(async () => {
    pool = adminPool();
    await cleanup();
    await pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [WS]);
    await pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS, OWNER]);
    await pool.query(
      "INSERT INTO broadcasts (id, workspace_id, name, audience_kind, audience_ref, status, sent_at) VALUES ($1,$2,'B','manual',$1,'sent',now())",
      [BCAST, WS],
    );
    // 3 sends for this broadcast; 2 delivered, 1 bounced.
    for (const [p, mid] of [[P1, 'ses-1'], [P2, 'ses-2'], [P3, 'ses-3']] as const) {
      await pool.query("INSERT INTO profiles (id, workspace_id, email) VALUES ($1,$2,$3)", [p, WS, `${p}@x.test`]);
      await pool.query(
        "INSERT INTO messages_log (workspace_id, profile_id, broadcast_id, ses_message_id, status) VALUES ($1,$2,$3,$4,'sent')",
        [WS, p, BCAST, mid],
      );
    }
    await pool.query("INSERT INTO email_events (workspace_id, ses_message_id, type) VALUES ($1,'ses-1','delivery')", [WS]);
    await pool.query("INSERT INTO email_events (workspace_id, ses_message_id, type) VALUES ($1,'ses-2','delivery')", [WS]);
    await pool.query("INSERT INTO email_events (workspace_id, ses_message_id, type, sub_type) VALUES ($1,'ses-3','bounce','Permanent')", [WS]);
    // 5 tracked-link clicks across two links for this broadcast.
    await pool.query("INSERT INTO tracked_links (token, workspace_id, broadcast_id, url, clicks) VALUES ('tk1',$1,$2,'https://a',3)", [WS, BCAST]);
    await pool.query("INSERT INTO tracked_links (token, workspace_id, broadcast_id, url, clicks) VALUES ('tk2',$1,$2,'https://b',2)", [WS, BCAST]);
    // 2 DISTINCT-profile opens (P1 opened twice, P2 once) → opened = 2 profiles.
    await pool.query("INSERT INTO tracked_opens (token, workspace_id, broadcast_id, profile_id, opens) VALUES ('op1',$1,$2,$3,2)", [WS, BCAST, P1]);
    await pool.query("INSERT INTO tracked_opens (token, workspace_id, broadcast_id, profile_id, opens) VALUES ('op2',$1,$2,$3,1)", [WS, BCAST, P2]);
    // P3 was pre-created but never opened (opens=0) → must NOT count toward opened.
    await pool.query("INSERT INTO tracked_opens (token, workspace_id, broadcast_id, profile_id, opens) VALUES ('op3',$1,$2,$3,0)", [WS, BCAST, P3]);
    // 1 unsubscribe attributed to this broadcast.
    await pool.query("INSERT INTO email_events (workspace_id, broadcast_id, profile_id, type) VALUES ($1,$2,$3,'unsubscribe')", [WS, BCAST, P1]);
  });

  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    await pool.query('DELETE FROM tracked_opens WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM tracked_links WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM email_events WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM messages_log WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM broadcasts WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM profiles WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [WS]);
  }

  it('aggregates sent/delivered/failed/clicked/opened/unsubscribed per broadcast', async () => {
    const r = await dispatch(
      { method: 'GET', path: '/broadcasts', authorization: tokenFor(OWNER, WS), query: {}, body: {} },
      e(),
    );
    expect(r.status).toBe(200);
    const b = (r.body as { broadcasts: Row[] }).broadcasts.find((x) => x.id === BCAST)!;
    expect(b.updated_at).toBeTruthy();
    expect(b.stats).toEqual({ sent: 3, delivered: 2, failed: 1, clicked: 5, opened: 2, unsubscribed: 1 });
  });

  it('is cross-workspace isolated (another workspace sees zero for this broadcast)', async () => {
    const OTHER_WS = '0c0d0f01-0000-4000-8000-000000000a01';
    const OTHER_OWNER = '0c0d0f01-0000-4000-8000-0000000000b1';
    await pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'O','active')", [OTHER_WS]);
    await pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [OTHER_WS, OTHER_OWNER]);
    try {
      const r = await dispatch(
        { method: 'GET', path: '/broadcasts', authorization: tokenFor(OTHER_OWNER, OTHER_WS), query: {}, body: {} },
        e(),
      );
      expect(r.status).toBe(200);
      // The other workspace cannot see BCAST at all (workspace-scoped list).
      expect((r.body as { broadcasts: Row[] }).broadcasts.find((x) => x.id === BCAST)).toBeUndefined();
    } finally {
      await pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [OTHER_WS]);
      await pool.query('DELETE FROM workspaces WHERE id = $1', [OTHER_WS]);
    }
  });
});
