// Numbered-page pagination + server-side search for the four list endpoints (broadcasts,
// automations, segments, profiles). Paging is OPT-IN: no ?limit ⇒ the whole list (back-compat
// for dropdown consumers); with ?limit&page ⇒ one page + a `total`. `?q` searches server-side
// (spans the whole table, not just a page). Real Postgres; never mocks the DB.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import { makePgLookups, makeLocalDeps, dispatch, type DispatchEnv } from '../src/index.js';
import { tokenFor } from './seed.js';
import type { Pool } from 'pg';

const WS = '0c0d0ee7-0000-4000-8000-000000000a01';
const OWNER = '0c0d0ee7-0000-4000-8000-0000000000b1';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('list pagination + search (real Postgres)', () => {
  let pool: Pool;
  const e = (): DispatchEnv => ({ pool, lookups: makePgLookups(pool), deps: makeLocalDeps(pool) });
  const get = (path: string, query: Record<string, string> = {}) =>
    dispatch({ method: 'GET', path, authorization: tokenFor(OWNER, WS), query, body: {} }, e());

  beforeAll(async () => {
    pool = adminPool();
    await cleanup();
    await pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [WS]);
    await pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS, OWNER]);
    // 7 broadcasts, 7 automations, 7 segments, 7 profiles — enough to page with limit 3.
    for (let i = 0; i < 7; i++) {
      const nm = i === 0 ? 'Spring sale' : `Item ${i}`; // one searchable name
      await pool.query(
        "INSERT INTO broadcasts (workspace_id, name, audience_kind, audience_ref, status, created_at) VALUES ($1,$2,'rule',null,'draft', now() - ($3 || ' seconds')::interval)",
        [WS, nm, String(i)],
      );
      await pool.query(
        "INSERT INTO automations (workspace_id, name, definition, status, created_at) VALUES ($1,$2,'{\"startNode\":\"t\",\"nodes\":{}}'::jsonb,'draft', now() - ($3 || ' seconds')::interval)",
        [WS, nm, String(i)],
      );
      await pool.query("INSERT INTO segments (workspace_id, name, kind) VALUES ($1,$2,'manual')", [WS, nm]);
      await pool.query("INSERT INTO profiles (workspace_id, email) VALUES ($1,$2)", [WS, `p${i}@x.com`]);
    }
  });

  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    for (const t of ['broadcasts', 'automations', 'segments', 'profiles', 'workspace_users']) {
      await pool.query(`DELETE FROM ${t} WHERE workspace_id = $1`, [WS]);
    }
    await pool.query('DELETE FROM workspaces WHERE id = $1', [WS]);
  }

  it('no ?limit ⇒ the WHOLE list (back-compat) with page_size null', async () => {
    const r = await get('/segments');
    const b = r.body as { segments: unknown[]; total: number; page: number; page_size: number | null };
    expect(b.segments).toHaveLength(7);
    expect(b).toMatchObject({ total: 7, page: 1, page_size: null });
  });

  for (const [path, key] of [
    ['/broadcasts', 'broadcasts'],
    ['/automations', 'automations'],
    ['/segments', 'segments'],
    ['/profiles', 'profiles'],
  ] as const) {
    it(`${path}: limit=3 page=1 → 3 rows, total 7, page_size 3`, async () => {
      const r = await get(path, { limit: '3', page: '1' });
      const b = r.body as Record<string, unknown>;
      expect((b[key] as unknown[]).length).toBe(3);
      expect(b).toMatchObject({ total: 7, page: 1, page_size: 3 });
    });
    it(`${path}: page 3 (limit 3) → the last single row`, async () => {
      const r = await get(path, { limit: '3', page: '3' });
      const b = r.body as Record<string, unknown>;
      expect((b[key] as unknown[]).length).toBe(1); // rows 7..7
      expect(b).toMatchObject({ total: 7, page: 3, page_size: 3 });
    });
  }

  // Name search applies to the name-based lists (profiles search email/external_id instead).
  for (const [path, key] of [
    ['/broadcasts', 'broadcasts'],
    ['/automations', 'automations'],
    ['/segments', 'segments'],
  ] as const) {
    it(`${path}: ?q=spring searches the NAME server-side across the whole table`, async () => {
      const r = await get(path, { limit: '3', page: '1', q: 'spring' });
      const b = r.body as Record<string, unknown>;
      expect((b[key] as unknown[]).length).toBe(1);
      expect(b.total).toBe(1);
    });
  }

  it('profiles ?q matches on email', async () => {
    const r = await get('/profiles', { limit: '10', q: 'p3@' });
    const b = r.body as { profiles: Array<{ email: string }>; total: number };
    expect(b.total).toBe(1);
    expect(b.profiles[0]!.email).toBe('p3@x.com');
  });
});
