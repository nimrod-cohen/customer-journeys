import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { buildRecentSendCountQuery, windowStart, isOverCap } from '../src/core.js';

// §9 step 3 / AC "Frequency cap" — the recent-send count is per workspace and
// per profile, read from messages_log within the rolling window. Real Postgres:
// the windowed count + the time bound are what we verify. citext/scoping aside,
// this proves the SQL bound matches windowStart and that another workspace's
// sends never inflate the count.
const RUN = hasDatabaseUrl();

const wsA = 'd6a00000-0000-0000-0000-0000000000a1';
const wsB = 'd6b00000-0000-0000-0000-0000000000b2';

async function recentCount(admin: Pool, ws: string, profileId: string, since: Date): Promise<number> {
  const q = buildRecentSendCountQuery(ws, profileId, since);
  const { rows } = await admin.query(q.text, q.values);
  return rows[0].n;
}

describe.skipIf(!RUN)('dispatcher frequency cap (real Postgres)', () => {
  let admin: Pool;
  let profA: string;
  let profB: string;
  const now = new Date('2026-06-10T12:00:00.000Z');

  beforeAll(async () => {
    admin = adminPool();
    for (const ws of [wsA, wsB]) {
      await admin.query('DELETE FROM messages_log WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    }
    await admin.query("INSERT INTO workspaces (id, name) VALUES ($1,'A'),($2,'B')", [wsA, wsB]);
    const a = await admin.query(
      "INSERT INTO profiles (workspace_id, external_id, email) VALUES ($1,'cap-cust','cap@example.com') RETURNING id",
      [wsA],
    );
    const b = await admin.query(
      "INSERT INTO profiles (workspace_id, external_id, email) VALUES ($1,'cap-cust','cap@example.com') RETURNING id",
      [wsB],
    );
    profA = a.rows[0].id;
    profB = b.rows[0].id;
    // Two sends in-window + one OLD send (outside the 7-day window) for A.
    await admin.query(
      "INSERT INTO messages_log (workspace_id, profile_id, sent_at) VALUES ($1,$2,$3),($1,$2,$4),($1,$2,$5)",
      [wsA, profA, '2026-06-09T10:00:00Z', '2026-06-08T10:00:00Z', '2026-05-01T10:00:00Z'],
    );
    // One send for B (must not affect A's count).
    await admin.query("INSERT INTO messages_log (workspace_id, profile_id, sent_at) VALUES ($1,$2,$3)", [
      wsB,
      profB,
      '2026-06-09T10:00:00Z',
    ]);
  });

  afterAll(async () => {
    if (admin) {
      for (const ws of [wsA, wsB]) {
        await admin.query('DELETE FROM messages_log WHERE workspace_id = $1', [ws]);
        await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
        await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
      }
      await admin.end();
    }
  });

  it('counts only sends inside the rolling window', async () => {
    const since = windowStart(now, 7); // 2026-06-03T12:00:00Z
    // Two in-window (06-09, 06-08); the 05-01 send is excluded.
    expect(await recentCount(admin, wsA, profA, since)).toBe(2);
  });

  it("another workspace's sends never inflate the count (scoping)", async () => {
    const since = windowStart(now, 7);
    expect(await recentCount(admin, wsB, profB, since)).toBe(1);
  });

  it('isOverCap blocks once the windowed count reaches the cap', async () => {
    const since = windowStart(now, 7);
    const n = await recentCount(admin, wsA, profA, since); // 2
    expect(isOverCap(n, { max: 3, days: 7 })).toBe(false);
    expect(isOverCap(n, { max: 2, days: 7 })).toBe(true);
  });
});
