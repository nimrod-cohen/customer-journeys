// Per-company Meta WhatsApp Cloud API credentials (CLAUDE.md). REAL Postgres. Proves the
// config is stored per COMPANY, the access token is write-only (never returned) and
// ENVELOPE-ENCRYPTED at rest, a blank token on update keeps the stored one, one company
// can't read another's config, and DELETE clears it. (The full WhatsApp SEND through the
// real MetaWhatsAppProvider is covered by the broadcast/automation send tests.)
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool, decryptSecret, isEncryptedSecret } from '@cdp/db';
import { makePgLookups, makeLocalDeps, dispatch, type DispatchEnv } from '../src/index.js';
import { tokenFor } from './seed.js';
import type { Pool } from 'pg';

const CO_A = '0c0d0e2a-0000-4000-8000-0000000000c1';
const CO_B = '0c0d0e2a-0000-4000-8000-0000000000c2';
const WS_A = '0c0d0e2a-0000-4000-8000-000000000a01';
const WS_B = '0c0d0e2a-0000-4000-8000-000000000a02';
const OWNER_A = '0c0d0e2a-0000-4000-8000-0000000000b1';
const OWNER_B = '0c0d0e2a-0000-4000-8000-0000000000b2';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

describeMaybe('company WhatsApp config (Meta Cloud API) CRUD (real Postgres)', () => {
  let pool: Pool;
  const e = (): DispatchEnv => ({ pool, lookups: makePgLookups(pool), deps: makeLocalDeps(pool) });
  const get = (tok: string) =>
    dispatch({ method: 'GET', path: '/company/whatsapp-config', authorization: tok, query: {}, body: {} }, e());
  const put = (tok: string, body: unknown) =>
    dispatch({ method: 'PUT', path: '/company/whatsapp-config', authorization: tok, query: {}, body }, e());
  const del = (tok: string) =>
    dispatch({ method: 'DELETE', path: '/company/whatsapp-config', authorization: tok, query: {}, body: {} }, e());

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
    await pool.query('DELETE FROM company_whatsapp_config WHERE company_id = ANY($1)', [[CO_A, CO_B]]);
  });

  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    await pool.query('DELETE FROM company_whatsapp_config WHERE company_id = ANY($1)', [[CO_A, CO_B]]);
    for (const ws of [WS_A, WS_B]) await pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [ws]);
    for (const ws of [WS_A, WS_B]) await pool.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    for (const co of [CO_A, CO_B]) await pool.query('DELETE FROM companies WHERE id = $1', [co]);
  }

  it('stores config per company; the token is never returned and is encrypted at rest', async () => {
    const a = tokenFor(OWNER_A, WS_A);
    expect((await get(a)).body).toEqual({ configured: false });

    // phone_number_id is required on first set.
    expect((await put(a, { api_version: 'v21.0' })).status).toBe(400);
    // A token is required when there's no stored one.
    expect((await put(a, { phone_number_id: '123' })).status).toBe(400);

    const saved = await put(a, {
      phone_number_id: '100055512345',
      access_token: 'EAApermanenttoken',
      api_version: 'v21.0',
      default_country: 'il',
    });
    expect(saved.status).toBe(200);

    const got = (await get(a)).body as {
      configured: boolean;
      phone_number_id: string;
      api_version: string | null;
      default_country: string | null;
    };
    expect(got.configured).toBe(true);
    expect(got.phone_number_id).toBe('100055512345');
    expect(got.api_version).toBe('v21.0');
    expect(got.default_country).toBe('IL'); // upper-cased
    // The token is NEVER in the response.
    expect(JSON.stringify(got)).not.toContain('EAApermanenttoken');

    // Stored encrypted (an envelope), decrypting back to the plaintext.
    const { rows } = await pool.query<{ access_token: string }>(
      'SELECT access_token FROM company_whatsapp_config WHERE company_id = $1',
      [CO_A],
    );
    expect(rows[0]!.access_token).not.toBe('EAApermanenttoken');
    expect(isEncryptedSecret(rows[0]!.access_token)).toBe(true);
    expect(decryptSecret(rows[0]!.access_token)).toBe('EAApermanenttoken');
  });

  it('a blank token on update keeps the stored one (change phone id / version alone)', async () => {
    const a = tokenFor(OWNER_A, WS_A);
    await put(a, { phone_number_id: '111', access_token: 'tok-1', api_version: 'v21.0' });
    // Update with NO token → keeps tok-1, changes the phone id.
    const upd = await put(a, { phone_number_id: '222', api_version: 'v22.0' });
    expect(upd.status).toBe(200);
    const { rows } = await pool.query<{ phone_number_id: string; access_token: string; api_version: string }>(
      'SELECT phone_number_id, access_token, api_version FROM company_whatsapp_config WHERE company_id = $1',
      [CO_A],
    );
    expect(rows[0]!.phone_number_id).toBe('222');
    expect(rows[0]!.api_version).toBe('v22.0');
    expect(decryptSecret(rows[0]!.access_token)).toBe('tok-1'); // unchanged
  });

  it('rejects a bad default_country', async () => {
    const a = tokenFor(OWNER_A, WS_A);
    expect((await put(a, { phone_number_id: '1', access_token: 't', default_country: 'israel' })).status).toBe(400);
  });

  it('is isolated per company; DELETE clears it', async () => {
    const a = tokenFor(OWNER_A, WS_A);
    const b = tokenFor(OWNER_B, WS_B);
    await put(a, { phone_number_id: 'A-phone', access_token: 'tok-A' });
    // B sees nothing of A's.
    expect((await get(b)).body).toEqual({ configured: false });
    await put(b, { phone_number_id: 'B-phone', access_token: 'tok-B' });
    expect(((await get(a)).body as { phone_number_id: string }).phone_number_id).toBe('A-phone');
    expect(((await get(b)).body as { phone_number_id: string }).phone_number_id).toBe('B-phone');
    // DELETE A → gone; B intact.
    expect((await del(a)).status).toBe(200);
    expect((await get(a)).body).toEqual({ configured: false });
    expect(((await get(b)).body as { configured: boolean }).configured).toBe(true);
  });
});
