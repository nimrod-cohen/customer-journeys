// Per-company Amazon SES credentials through the API (§10). REAL Postgres. Proves:
// the config is stored per COMPANY (not workspace), the secret is write-only
// (never returned), a blank secret on update keeps the stored one, and one
// company can't read another's config.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool, decryptSecret, isEncryptedSecret } from '@cdp/db';
import { makePgLookups, makeLocalDeps, dispatch, type DispatchEnv } from '../src/index.js';
import { tokenFor } from './seed.js';
import type { Pool } from 'pg';

const CO_A = '0c0d0e30-0000-4000-8000-0000000000c1';
const CO_B = '0c0d0e30-0000-4000-8000-0000000000c2';
const WS_A = '0c0d0e30-0000-4000-8000-000000000a01';
const WS_B = '0c0d0e30-0000-4000-8000-000000000a02';
const OWNER_A = '0c0d0e30-0000-4000-8000-0000000000b1';
const OWNER_B = '0c0d0e30-0000-4000-8000-0000000000b2';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

function env(pool: Pool): DispatchEnv {
  return { pool, lookups: makePgLookups(pool), deps: makeLocalDeps(pool) };
}

describeMaybe('company SES config via API (real Postgres)', () => {
  let pool: Pool;
  const e = (): DispatchEnv => env(pool);
  const get = (tok: string) =>
    dispatch({ method: 'GET', path: '/company/ses-config', authorization: tok, query: {}, body: {} }, e());
  const put = (tok: string, body: unknown) =>
    dispatch({ method: 'PUT', path: '/company/ses-config', authorization: tok, query: {}, body }, e());

  beforeAll(async () => {
    pool = adminPool();
    await cleanup();
    for (const [co, ws, owner] of [
      [CO_A, WS_A, OWNER_A],
      [CO_B, WS_B, OWNER_B],
    ] as const) {
      await pool.query("INSERT INTO companies (id, name) VALUES ($1, 'Co')", [co]);
      await pool.query("INSERT INTO workspaces (id, name, status, company_id) VALUES ($1,'W','active',$2)", [ws, co]);
      await pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [ws, owner]);
    }
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM company_ses_config WHERE company_id = ANY($1)', [[CO_A, CO_B]]);
  });

  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    await pool.query('DELETE FROM company_ses_config WHERE company_id = ANY($1)', [[CO_A, CO_B]]);
    for (const ws of [WS_A, WS_B]) await pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [ws]);
    for (const ws of [WS_A, WS_B]) await pool.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    for (const co of [CO_A, CO_B]) await pool.query('DELETE FROM companies WHERE id = $1', [co]);
  }

  it('stores config per company; the secret is never returned', async () => {
    const a = tokenFor(OWNER_A, WS_A);
    expect((await get(a)).body).toEqual({ configured: false });

    // Needs region + key + secret on first set.
    expect((await put(a, { region: 'il-central-1', access_key_id: 'AKIAA' })).status).toBe(400);

    const saved = await put(a, { region: 'il-central-1', access_key_id: 'AKIAA', secret_access_key: 'secretA' });
    expect(saved.status).toBe(200);

    const got = (await get(a)).body as { configured: boolean; region: string; access_key_id: string; secret_access_key?: string };
    expect(got.configured).toBe(true);
    expect(got.region).toBe('il-central-1');
    expect(got.access_key_id).toBe('AKIAA');
    expect(got.secret_access_key).toBeUndefined(); // write-only

    // In the DB the secret is ENVELOPE-ENCRYPTED at rest (not plaintext), and
    // decrypts back to the original.
    const row = await pool.query<{ secret_access_key: string }>(
      'SELECT secret_access_key FROM company_ses_config WHERE company_id = $1',
      [CO_A],
    );
    const stored = row.rows[0]!.secret_access_key;
    expect(stored).not.toBe('secretA');
    expect(isEncryptedSecret(stored)).toBe(true);
    expect(decryptSecret(stored)).toBe('secretA');
  });

  it('a blank secret on update keeps the stored one; region/key can change', async () => {
    const a = tokenFor(OWNER_A, WS_A);
    await put(a, { region: 'il-central-1', access_key_id: 'AKIAA', secret_access_key: 'secretA' });
    // Update region + key, omit secret → secret kept.
    const upd = await put(a, { region: 'eu-west-1', access_key_id: 'AKIAB' });
    expect(upd.status).toBe(200);
    const row = await pool.query<{ region: string; access_key_id: string; secret_access_key: string }>(
      'SELECT region, access_key_id, secret_access_key FROM company_ses_config WHERE company_id = $1',
      [CO_A],
    );
    expect(row.rows[0]).toMatchObject({ region: 'eu-west-1', access_key_id: 'AKIAB' });
    expect(decryptSecret(row.rows[0]!.secret_access_key)).toBe('secretA'); // original secret kept
  });

  it("company isolation: B does not see A's config", async () => {
    await put(tokenFor(OWNER_A, WS_A), { region: 'il-central-1', access_key_id: 'AKIAA', secret_access_key: 'secretA' });
    expect((await get(tokenFor(OWNER_B, WS_B))).body).toEqual({ configured: false });
  });
});
