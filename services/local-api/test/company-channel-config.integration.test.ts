// Per-company text-channel (019 SMS) credentials + the REAL 019 dispatcher
// resolution (CLAUDE.md). REAL Postgres. Proves:
//  - the config is stored per COMPANY, the bearer is write-only (never returned)
//    and ENVELOPE-ENCRYPTED at rest; a blank bearer on update keeps the stored one;
//    one company can't read another's config.
//  - an SMS broadcast for a company WITH a 019 config routes through the real
//    Sms019Provider — we INJECT a fake ChannelHttpClient and assert the EXACT 019
//    JSON payload + Bearer header (bearer decrypted only at send), and that
//    messages_log records the provider message id.
//  - a company with NO config falls back to the deterministic MOCK (unchanged).
//  - cross-workspace isolation; the bearer is never logged/returned.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool, decryptSecret, isEncryptedSecret } from '@cdp/db';
import type { ChannelHttpClient, ChannelHttpResponse } from '@cdp/channels';
import { makePgLookups, makeLocalDeps, dispatch, type DispatchEnv } from '../src/index.js';
import { tokenFor } from './seed.js';
import type { Pool } from 'pg';

const CO_A = '0c0d0e1a-0000-4000-8000-0000000000c1';
const CO_B = '0c0d0e1a-0000-4000-8000-0000000000c2';
const WS_A = '0c0d0e1a-0000-4000-8000-000000000a01';
const WS_B = '0c0d0e1a-0000-4000-8000-000000000a02';
const OWNER_A = '0c0d0e1a-0000-4000-8000-0000000000b1';
const OWNER_B = '0c0d0e1a-0000-4000-8000-0000000000b2';
const SEG_A = '0c0d0e1a-0000-4000-8000-0000000000d1';
const P_PHONE = '0c0d0e1a-0000-4000-8000-0000000000f1';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

/** A fake ChannelHttpClient that records every POST and returns a canned 019 OK. */
function makeCapturingHttp(): {
  http: ChannelHttpClient;
  calls: Array<{ url: string; headers: Record<string, string>; body: string }>;
} {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const http: ChannelHttpClient = {
    async post(url, headers, body): Promise<ChannelHttpResponse> {
      calls.push({ url, headers, body });
      return { status: 200, body: JSON.stringify({ status: 0, message_id: '019-MSG-123' }) };
    },
  };
  return { http, calls };
}

describeMaybe('company channel config (019 SMS) + dispatcher resolution (real Postgres)', () => {
  let pool: Pool;
  // Default env (mock channel). CRUD tests use this.
  const e = (): DispatchEnv => ({ pool, lookups: makePgLookups(pool), deps: makeLocalDeps(pool) });
  const get = (tok: string) =>
    dispatch({ method: 'GET', path: '/company/channel-config', authorization: tok, query: {}, body: {} }, e());
  const put = (tok: string, body: unknown) =>
    dispatch({ method: 'PUT', path: '/company/channel-config', authorization: tok, query: {}, body }, e());
  const del = (tok: string) =>
    dispatch({ method: 'DELETE', path: '/company/channel-config', authorization: tok, query: {}, body: {} }, e());

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
    await pool.query("INSERT INTO segments (id, workspace_id, name, kind) VALUES ($1,$2,'S','manual')", [SEG_A, WS_A]);
    await pool.query(
      "INSERT INTO profiles (id, workspace_id, external_id, email, attributes) VALUES ($1,$2,'ph','ph@example.com',$3::jsonb)",
      [P_PHONE, WS_A, JSON.stringify({ phone: '+972529461566', first_name: 'Sam' })],
    );
    await pool.query(
      "INSERT INTO segment_memberships (segment_id, profile_id, workspace_id, source) VALUES ($1,$2,$3,'manual')",
      [SEG_A, P_PHONE, WS_A],
    );
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM company_channel_config WHERE company_id = ANY($1)', [[CO_A, CO_B]]);
    for (const w of [WS_A, WS_B]) {
      await pool.query('DELETE FROM messages_log WHERE workspace_id = $1', [w]);
      await pool.query('DELETE FROM usage_counters WHERE workspace_id = $1', [w]);
      await pool.query('DELETE FROM outbox WHERE workspace_id = $1', [w]);
      await pool.query('DELETE FROM broadcasts WHERE workspace_id = $1', [w]);
    }
  });

  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    for (const w of [WS_A, WS_B]) {
      await pool.query('DELETE FROM messages_log WHERE workspace_id = $1', [w]);
      await pool.query('DELETE FROM usage_counters WHERE workspace_id = $1', [w]);
      await pool.query('DELETE FROM outbox WHERE workspace_id = $1', [w]);
      await pool.query('DELETE FROM broadcasts WHERE workspace_id = $1', [w]);
      await pool.query('DELETE FROM segment_memberships WHERE workspace_id = $1', [w]);
      await pool.query('DELETE FROM segments WHERE workspace_id = $1', [w]);
      await pool.query('DELETE FROM profiles WHERE workspace_id = $1', [w]);
    }
    await pool.query('DELETE FROM company_channel_config WHERE company_id = ANY($1)', [[CO_A, CO_B]]);
    for (const ws of [WS_A, WS_B]) await pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [ws]);
    for (const ws of [WS_A, WS_B]) await pool.query('DELETE FROM workspaces WHERE id = $1', [ws]);
    for (const co of [CO_A, CO_B]) await pool.query('DELETE FROM companies WHERE id = $1', [co]);
  }

  it('stores config per company; the bearer is never returned and is encrypted at rest', async () => {
    const a = tokenFor(OWNER_A, WS_A);
    expect((await get(a)).body).toEqual({ configured: false });

    // Needs url + username + source + bearer on first set.
    expect((await put(a, { api_url: 'https://019.test/api', username: 'u', source: 'src' })).status).toBe(400);

    const saved = await put(a, {
      api_url: 'https://019.test/api',
      username: 'acme',
      source: 'MyBrand',
      secret: 'bearer-A',
    });
    expect(saved.status).toBe(200);

    const got = (await get(a)).body as {
      configured: boolean;
      provider: string;
      api_url: string;
      username: string;
      source: string;
      secret?: string;
    };
    expect(got.configured).toBe(true);
    expect(got.provider).toBe('019');
    expect(got.api_url).toBe('https://019.test/api');
    expect(got.username).toBe('acme');
    expect(got.source).toBe('MyBrand');
    expect(got.secret).toBeUndefined(); // write-only — never returned

    const row = await pool.query<{ secret: string }>('SELECT secret FROM company_channel_config WHERE company_id = $1', [
      CO_A,
    ]);
    const stored = row.rows[0]!.secret;
    expect(stored).not.toBe('bearer-A');
    expect(isEncryptedSecret(stored)).toBe(true);
    expect(decryptSecret(stored)).toBe('bearer-A');
  });

  it('a blank bearer on update keeps the stored one; url/username/source can change', async () => {
    const a = tokenFor(OWNER_A, WS_A);
    await put(a, { api_url: 'https://019.test/api', username: 'acme', source: 'MyBrand', secret: 'bearer-A' });
    const upd = await put(a, { api_url: 'https://019.test/v2', username: 'acme2', source: 'NewBrand' });
    expect(upd.status).toBe(200);
    const row = await pool.query<{ api_url: string; username: string; source: string; secret: string }>(
      'SELECT api_url, username, source, secret FROM company_channel_config WHERE company_id = $1',
      [CO_A],
    );
    expect(row.rows[0]).toMatchObject({ api_url: 'https://019.test/v2', username: 'acme2', source: 'NewBrand' });
    expect(decryptSecret(row.rows[0]!.secret)).toBe('bearer-A'); // original bearer kept
  });

  it('DELETE clears the config', async () => {
    const a = tokenFor(OWNER_A, WS_A);
    await put(a, { api_url: 'https://019.test/api', username: 'acme', source: 'MyBrand', secret: 'bearer-A' });
    expect((await del(a)).status).toBe(200);
    expect((await get(a)).body).toEqual({ configured: false });
  });

  it("company isolation: B does not see A's config", async () => {
    await put(tokenFor(OWNER_A, WS_A), {
      api_url: 'https://019.test/api',
      username: 'acme',
      source: 'MyBrand',
      secret: 'bearer-A',
    });
    expect((await get(tokenFor(OWNER_B, WS_B))).body).toEqual({ configured: false });
  });

  it('an SMS broadcast for a company WITH 019 config routes through the real 019 adapter', async () => {
    const a = tokenFor(OWNER_A, WS_A);
    // Configure 019 for company A.
    await put(a, { api_url: 'https://019.test/api', username: 'acme', source: 'MyBrand', secret: 'super-bearer' });

    // Inject a capturing HTTP client so we assert the exact 019 request offline.
    const { http, calls } = makeCapturingHttp();
    const env: DispatchEnv = { pool, lookups: makePgLookups(pool), deps: makeLocalDeps(pool, http) };

    const c = await dispatch(
      {
        method: 'POST',
        path: '/broadcasts',
        authorization: a,
        query: {},
        body: { name: 'SMS', medium: 'sms', text_body: 'Hi {{customer.first_name}}!', audience_kind: 'manual', audience_ref: SEG_A },
      },
      env,
    );
    expect(c.status).toBe(201);
    const id = (c.body as { broadcast: { id: string } }).broadcast.id;
    const r = await dispatch(
      { method: 'POST', path: `/broadcasts/${id}/send`, authorization: a, query: {}, body: {} },
      env,
    );
    expect(r.status).toBe(200);
    expect((r.body as { result: { result: string } }).result.result).toBe('sent');

    // The 019 adapter POSTed exactly once with the right URL, Bearer header, and JSON payload.
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://019.test/api');
    expect(call.headers['Authorization']).toBe('Bearer super-bearer'); // decrypted ONLY at send
    expect(call.headers['Content-Type']).toBe('application/json');
    const payload = JSON.parse(call.body) as {
      sms: { user: { username: string }; source: string; destinations: { phone: string }; message: string };
    };
    expect(payload.sms.user.username).toBe('acme');
    expect(payload.sms.source).toBe('MyBrand');
    expect(payload.sms.destinations.phone).toBe('+972529461566');
    expect(payload.sms.message).toBe('Hi Sam!'); // merge rendered

    // messages_log records the provider message id returned by 019 (NOT a mock id).
    const ml = await pool.query<{ medium: string; status: string; ses_message_id: string | null }>(
      "SELECT medium, status, ses_message_id FROM messages_log WHERE workspace_id = $1 AND status = 'sent'",
      [WS_A],
    );
    expect(ml.rows).toHaveLength(1);
    expect(ml.rows[0]!.medium).toBe('sms');
    expect(ml.rows[0]!.ses_message_id).toBe('019-MSG-123');

    // The bearer never leaked into messages_log / the API GET.
    expect(JSON.stringify((await get(a)).body)).not.toContain('super-bearer');
  });

  it('an SMS broadcast for a company with NO config falls back to the deterministic MOCK', async () => {
    const a = tokenFor(OWNER_A, WS_A);
    // No 019 config for company A (cleared by beforeEach). Inject a capturing client
    // that would FAIL the test if called — the mock must never touch it.
    const { http, calls } = makeCapturingHttp();
    const env: DispatchEnv = { pool, lookups: makePgLookups(pool), deps: makeLocalDeps(pool, http) };

    const c = await dispatch(
      {
        method: 'POST',
        path: '/broadcasts',
        authorization: a,
        query: {},
        body: { name: 'SMS mock', medium: 'sms', text_body: 'Hey', audience_kind: 'manual', audience_ref: SEG_A },
      },
      env,
    );
    const id = (c.body as { broadcast: { id: string } }).broadcast.id;
    const r = await dispatch(
      { method: 'POST', path: `/broadcasts/${id}/send`, authorization: a, query: {}, body: {} },
      env,
    );
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(0); // no HTTP — the mock provider is offline
    const ml = await pool.query<{ ses_message_id: string }>(
      "SELECT ses_message_id FROM messages_log WHERE workspace_id = $1 AND status = 'sent'",
      [WS_A],
    );
    expect(ml.rows).toHaveLength(1);
    expect(ml.rows[0]!.ses_message_id).toMatch(/^mock-sms-/);
  });
});
