import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { buildIsSuppressedQuery } from '@cdp/service-dispatcher';
import { runFeedbackStatementsInTx } from '../src/deps.js';
import { handleNotification, type FeedbackDeps, type Reader } from '../src/feedback.js';

// §10 / AC "Suppression scoping": suppressions are keyed (workspace_id, email).
// A hard bounce in workspace A must NOT block the same address in B
// (per-workspace) — but the GLOBAL hard-bounce list blocks it EVERYWHERE
// (cross-workspace exception). We assert BOTH using the Phase-7 dispatcher
// buildIsSuppressedQuery (per-workspace arm AND global arm). Real Postgres only.
const RUN = hasDatabaseUrl();

const wsA = 'fb200000-0000-0000-0000-0000000000a1';
const wsB = 'fb200000-0000-0000-0000-0000000000b2';
const email = 'shared@fb-scope.example';

function makeDeps(pool: Pool): FeedbackDeps {
  const reader: Reader = {
    async query<T>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }> {
      const res = await pool.query(text, values as unknown[]);
      return { rows: res.rows as T[] };
    },
  };
  return { reader, runInWorkspaceTx: (w, s) => runFeedbackStatementsInTx(pool, w, s) };
}

async function suppressedInWorkspace(admin: Pool, ws: string, e: string): Promise<boolean> {
  // Per-workspace ONLY: query suppressions directly (not the global-or arm).
  const r = await admin.query('SELECT 1 FROM suppressions WHERE workspace_id = $1 AND email = $2', [ws, e]);
  return (r.rowCount ?? 0) > 0;
}

async function cleanup(admin: Pool): Promise<void> {
  for (const ws of [wsA, wsB]) {
    await admin.query('DELETE FROM email_events WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM suppressions WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
  }
  await admin.query('DELETE FROM global_hard_bounces WHERE email = $1', [email]);
}

describe.skipIf(!RUN)('feedback suppression scoping (real Postgres)', () => {
  let admin: Pool;
  let deps: FeedbackDeps;

  beforeAll(async () => {
    admin = adminPool();
    deps = makeDeps(admin);
    await cleanup(admin);
    for (const [ws, name] of [[wsA, 'A'], [wsB, 'B']] as const) {
      await admin.query(
        `INSERT INTO workspaces (id, name, status, sending_identity)
         VALUES ($1, $2, 'active', '{"verified":true}')`,
        [ws, name],
      );
      await admin.query(`INSERT INTO profiles (workspace_id, email, email_status) VALUES ($1,$2,'active')`, [ws, email]);
    }
    // A complaint in A (NOT a hard bounce → no global row), scoped to A.
    await handleNotification(deps, {
      notificationType: 'Complaint',
      complaint: { complainedRecipients: [{ emailAddress: email }] },
      mail: { messageId: 'scope-comp-A', tags: { workspace_id: [wsA] } },
    });
  });

  afterAll(async () => {
    if (admin) {
      await cleanup(admin);
      await admin.end();
    }
  });

  it("A's complaint suppresses the address in A", async () => {
    expect(await suppressedInWorkspace(admin, wsA, email)).toBe(true);
  });

  it("A's complaint does NOT suppress the same address in B (per-workspace)", async () => {
    expect(await suppressedInWorkspace(admin, wsB, email)).toBe(false);
    // And the dispatcher's combined query for B is false too (no global row).
    const isq = buildIsSuppressedQuery(wsB, email);
    const r = await admin.query(isq.text, isq.values);
    expect(r.rows[0].suppressed).toBe(false);
  });

  it('a hard bounce in A is GLOBAL → blocks the address in B via the dispatcher global arm', async () => {
    await handleNotification(deps, {
      eventType: 'Bounce',
      bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: email }] },
      mail: { messageId: 'scope-hard-A', tags: { workspace_id: [wsA] } },
    });
    // B has NO per-workspace suppression row...
    expect(await suppressedInWorkspace(admin, wsB, email)).toBe(false);
    // ...but the dispatcher's combined query blocks B via global_hard_bounces.
    const isq = buildIsSuppressedQuery(wsB, email);
    const r = await admin.query(isq.text, isq.values);
    expect(r.rows[0].suppressed).toBe(true);
  });
});
