// The signed-in user editing their own details (§12). REAL Postgres. Proves:
// GET /me returns the user's app-owned display name; PATCH /me upserts it scoped
// to the token's user (never another user); each user sees only their own name.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import { makePgLookups, makeLocalDeps, dispatch, type DispatchEnv } from '../src/index.js';
import { tokenFor } from './seed.js';
import type { Pool } from 'pg';

const WS = '0c0d0e40-0000-4000-8000-000000000a01';
const USER_A = '0c0d0e40-0000-4000-8000-0000000000b1';
const USER_B = '0c0d0e40-0000-4000-8000-0000000000b2';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

function env(pool: Pool): DispatchEnv {
  return { pool, lookups: makePgLookups(pool), deps: makeLocalDeps(pool) };
}

describeMaybe('account: GET/PATCH /me (real Postgres)', () => {
  let pool: Pool;
  const e = (): DispatchEnv => env(pool);
  const me = (tok: string) => dispatch({ method: 'GET', path: '/me', authorization: tok, query: {}, body: {} }, e());
  const setName = (tok: string, name: string) =>
    dispatch({ method: 'PATCH', path: '/me', authorization: tok, query: {}, body: { name } }, e());

  beforeAll(async () => {
    pool = adminPool();
    await cleanup();
    await pool.query("INSERT INTO workspaces (id, name, status) VALUES ($1,'W','active')", [WS]);
    for (const u of [USER_A, USER_B]) {
      await pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS, u]);
    }
  });

  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[USER_A, USER_B]]);
    await pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [WS]);
  }

  it('a user sets their own name; it round-trips via /me', async () => {
    const a = tokenFor(USER_A, WS);
    expect((await me(a)).body).toMatchObject({ name: null });

    const upd = await setName(a, 'Ada Lovelace');
    expect(upd.status).toBe(200);
    expect((upd.body as { name: string }).name).toBe('Ada Lovelace');
    expect((await me(a)).body).toMatchObject({ name: 'Ada Lovelace' });
  });

  it('names are per-user: B does not see A’s name, and PATCH only touches the caller', async () => {
    await setName(tokenFor(USER_A, WS), 'Ada');
    const b = tokenFor(USER_B, WS);
    expect((await me(b)).body).toMatchObject({ name: null });

    await setName(b, 'Babbage');
    expect((await me(b)).body).toMatchObject({ name: 'Babbage' });
    // A is unchanged by B's edit.
    expect((await me(tokenFor(USER_A, WS))).body).toMatchObject({ name: 'Ada' });
  });
});
