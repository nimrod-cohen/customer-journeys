import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { buildIsSuppressedQuery } from '../src/core.js';

// §10 / AC "Suppression scoping" — suppressions are keyed (workspace_id, email):
// A's unsubscribe must NOT block B. global_hard_bounces is cross-workspace.
// citext makes the email match case-insensitive. Real Postgres only — the
// scoping/citext semantics live in the DB.
const RUN = hasDatabaseUrl();

// File-local fixture namespace.
const wsA = 'd5a00000-0000-0000-0000-0000000000a1';
const wsB = 'd5b00000-0000-0000-0000-0000000000b2';

async function suppressed(admin: Pool, ws: string, email: string): Promise<boolean> {
  const q = buildIsSuppressedQuery(ws, email);
  const { rows } = await admin.query(q.text, q.values);
  return rows[0].suppressed === true;
}

describe.skipIf(!RUN)('dispatcher suppression scoping (real Postgres)', () => {
  let admin: Pool;

  beforeAll(async () => {
    admin = adminPool();
    for (const ws of [wsA, wsB]) {
      await admin.query('DELETE FROM suppressions WHERE workspace_id = $1', [ws]);
      await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    }
    await admin.query('DELETE FROM global_hard_bounces WHERE email = $1', ['gbounce@example.com']);
    await admin.query("INSERT INTO workspaces (id, name) VALUES ($1,'A'),($2,'B')", [wsA, wsB]);
    // A suppresses one address (unsubscribe).
    await admin.query(
      "INSERT INTO suppressions (workspace_id, email, reason) VALUES ($1,'opted-out@example.com','unsubscribe')",
      [wsA],
    );
    // A global hard bounce — cross-workspace.
    await admin.query("INSERT INTO global_hard_bounces (email) VALUES ('gbounce@example.com')");
  });

  afterAll(async () => {
    if (admin) {
      for (const ws of [wsA, wsB]) {
        await admin.query('DELETE FROM suppressions WHERE workspace_id = $1', [ws]);
        await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
      }
      await admin.query('DELETE FROM global_hard_bounces WHERE email = $1', ['gbounce@example.com']);
      await admin.end();
    }
  });

  it("A's suppression blocks the address in A", async () => {
    expect(await suppressed(admin, wsA, 'opted-out@example.com')).toBe(true);
  });

  it("A's suppression does NOT block the same address in B (per-workspace)", async () => {
    expect(await suppressed(admin, wsB, 'opted-out@example.com')).toBe(false);
  });

  it('the suppression match is case-insensitive (citext)', async () => {
    expect(await suppressed(admin, wsA, 'OPTED-OUT@EXAMPLE.COM')).toBe(true);
  });

  it('a global hard bounce suppresses in BOTH workspaces (cross-workspace)', async () => {
    expect(await suppressed(admin, wsA, 'gbounce@example.com')).toBe(true);
    expect(await suppressed(admin, wsB, 'gbounce@example.com')).toBe(true);
  });

  it('an unrelated address is not suppressed in either workspace', async () => {
    expect(await suppressed(admin, wsA, 'fine@example.com')).toBe(false);
    expect(await suppressed(admin, wsB, 'fine@example.com')).toBe(false);
  });
});
