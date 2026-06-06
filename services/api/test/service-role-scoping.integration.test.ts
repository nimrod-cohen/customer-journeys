import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { adminPool, scopedQuery, hasDatabaseUrl } from '@cdp/db';

// AC1 (in-code scoping, §3) — service-role code BYPASSES RLS, so it MUST scope
// by workspace_id in code. This proves both halves:
//   1. The admin/service-role connection genuinely bypasses RLS (sees all rows),
//      so RLS is NOT a safety net for it.
//   2. Running a query through scopedQuery on that same connection returns ONLY
//      the scoped workspace's rows — the in-code guard is what isolates tenants.
// Skips when no DATABASE_URL.
const RUN = hasDatabaseUrl();

describe.skipIf(!RUN)('service-role in-code scoping (AC1)', () => {
  let admin: Pool;
  const wsA = '88888888-8888-8888-8888-888888888888';
  const wsB = '99999999-9999-9999-9999-999999999999';

  beforeAll(async () => {
    admin = adminPool();
    await admin.query('DELETE FROM profiles WHERE workspace_id IN ($1,$2)', [wsA, wsB]);
    await admin.query('DELETE FROM workspaces WHERE id IN ($1,$2)', [wsA, wsB]);
    await admin.query("INSERT INTO workspaces (id, name) VALUES ($1,'A'),($2,'B')", [wsA, wsB]);
    await admin.query("INSERT INTO profiles (workspace_id, external_id) VALUES ($1,'a1'),($1,'a2')", [wsA]);
    await admin.query("INSERT INTO profiles (workspace_id, external_id) VALUES ($1,'b1')", [wsB]);
  });

  afterAll(async () => {
    if (admin) {
      await admin.query('DELETE FROM profiles WHERE workspace_id IN ($1,$2)', [wsA, wsB]);
      await admin.query('DELETE FROM workspaces WHERE id IN ($1,$2)', [wsA, wsB]);
      await admin.end();
    }
  });

  it('the service-role connection bypasses RLS (sees BOTH workspaces) — RLS is no safety net', async () => {
    const { rows } = await admin.query(
      'SELECT count(*)::int AS n FROM profiles WHERE workspace_id IN ($1,$2)',
      [wsA, wsB],
    );
    expect(rows[0].n).toBe(3);
  });

  it('scopedQuery on the service-role connection returns ONLY the scoped workspace', async () => {
    const q = scopedQuery(wsA, 'SELECT external_id FROM profiles');
    const { rows } = await admin.query(q.text, q.values as unknown[]);
    expect(rows.map((r: { external_id: string }) => r.external_id).sort()).toEqual(['a1', 'a2']);
  });

  it('scopedQuery cannot be tricked into reading another workspace', async () => {
    const q = scopedQuery(wsB, 'SELECT external_id FROM profiles');
    const { rows } = await admin.query(q.text, q.values as unknown[]);
    expect(rows.map((r: { external_id: string }) => r.external_id)).toEqual(['b1']);
  });
});
