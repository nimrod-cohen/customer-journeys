import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, hasDatabaseUrl } from '@cdp/db';
import { runUnsubscribeInWorkspaceTx } from '../src/deps.js';
import { makeUnsubscribeHandler, type UnsubscribeDeps } from '../src/handler.js';

// §10 / AC "Suppression scoping": an unsubscribe in workspace A must NOT
// suppress the same email in workspace B (suppressions PK = (workspace_id,
// email)). Real Postgres only — the scoping lives in the DB. We drive the FULL
// handler (parse link → workspace-scoped write).
const RUN = hasDatabaseUrl();

const wsA = 'ab100000-0000-0000-0000-0000000000a1';
const wsB = 'ab100000-0000-0000-0000-0000000000b2';
const email = 'optout@ub-scope.example';

function makeDeps(pool: Pool): UnsubscribeDeps {
  return { runInWorkspaceTx: (w, s) => runUnsubscribeInWorkspaceTx(pool, w, s) };
}

async function suppressed(admin: Pool, ws: string): Promise<boolean> {
  const r = await admin.query('SELECT 1 FROM suppressions WHERE workspace_id = $1 AND email = $2', [ws, email]);
  return (r.rowCount ?? 0) > 0;
}

async function unsubAttr(admin: Pool, ws: string): Promise<string | null> {
  const r = await admin.query(
    "SELECT attributes->>'unsubscribed' AS u FROM profiles WHERE workspace_id = $1 AND email = $2",
    [ws, email],
  );
  return (r.rows[0]?.u as string | undefined) ?? null;
}

async function cleanup(admin: Pool): Promise<void> {
  for (const ws of [wsA, wsB]) {
    await admin.query('DELETE FROM suppressions WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
    await admin.query('DELETE FROM workspaces WHERE id = $1', [ws]);
  }
}

describe.skipIf(!RUN)('unsubscribe scoping (real Postgres)', () => {
  let admin: Pool;
  let handler: ReturnType<typeof makeUnsubscribeHandler>;

  beforeAll(async () => {
    admin = adminPool();
    handler = makeUnsubscribeHandler(makeDeps(admin));
    await cleanup(admin);
    await admin.query("INSERT INTO workspaces (id, name) VALUES ($1,'A'),($2,'B')", [wsA, wsB]);
    // A profile with this email in EACH workspace (same email, different tenants).
    await admin.query(
      "INSERT INTO profiles (workspace_id, external_id, email, attributes) VALUES ($1,'p-a',$2,'{}'::jsonb)",
      [wsA, email],
    );
    await admin.query(
      "INSERT INTO profiles (workspace_id, external_id, email, attributes) VALUES ($1,'p-b',$2,'{}'::jsonb)",
      [wsB, email],
    );
  });

  afterAll(async () => {
    if (admin) {
      await cleanup(admin);
      await admin.end();
    }
  });

  it('one-click POST unsubscribe in A suppresses A but NOT B', async () => {
    const res = await handler({
      httpMethod: 'POST',
      rawPath: '/unsubscribe',
      queryStringParameters: { workspace_id: wsA, email },
      body: 'List-Unsubscribe=One-Click',
    });
    expect(res.statusCode).toBe(200);

    const supA = await admin.query("SELECT reason FROM suppressions WHERE workspace_id = $1 AND email = $2", [wsA, email]);
    expect(supA.rows[0]?.reason).toBe('unsubscribe');

    expect(await suppressed(admin, wsA)).toBe(true);
    expect(await suppressed(admin, wsB)).toBe(false);
  });

  it('flags the profile attribute unsubscribed=true in A only (not B)', async () => {
    // The first test already ran the one-click unsubscribe in workspace A.
    expect(await unsubAttr(admin, wsA)).toBe('true');
    // Workspace B's same-email profile is untouched (tenant isolation).
    expect(await unsubAttr(admin, wsB)).toBe(null);
  });

  it('a replayed unsubscribe is idempotent (ON CONFLICT DO NOTHING → one row)', async () => {
    await handler({ httpMethod: 'POST', queryStringParameters: { workspace_id: wsA, email }, body: 'List-Unsubscribe=One-Click' });
    const cnt = await admin.query('SELECT count(*)::int AS n FROM suppressions WHERE workspace_id = $1 AND email = $2', [wsA, email]);
    expect(cnt.rows[0].n).toBe(1);
  });

  it('a request missing workspace_id is a 400 (never a guessed workspace)', async () => {
    const res = await handler({ httpMethod: 'POST', queryStringParameters: { email }, body: 'List-Unsubscribe=One-Click' });
    expect(res.statusCode).toBe(400);
  });
});
