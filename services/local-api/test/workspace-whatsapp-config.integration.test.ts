// Per-WORKSPACE Meta WhatsApp config (CLAUDE.md → WhatsApp). REAL Postgres + an INJECTED
// fake Graph client (never touches graph.facebook.com). Proves: config is stored per
// workspace; saving verifies the number and subscribes our app to the WABA BEFORE any
// write; the token is write-only + encrypted; a phone number belongs to ONE workspace;
// workspaces are isolated; DELETE clears it; and every reader (templates, dispatcher
// config, readiness) uses the workspace row.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool, decryptSecret, isEncryptedSecret } from '@cdp/db';
import type { GraphHttpClient, GraphHttpResponse } from '@cdp/channels';
import { channelConfigForWorkspace } from '@cdp/service-dispatcher';
import { makePgLookups, makeLocalDeps, dispatch, type DispatchEnv } from '../src/index.js';
import { tokenFor } from './seed.js';
import type { Pool } from 'pg';

const CO = '0c0d0e7a-0000-4000-8000-0000000000c1';
const WS_A = '0c0d0e7a-0000-4000-8000-000000000a01';
const WS_B = '0c0d0e7a-0000-4000-8000-000000000a02';
const OWNER = '0c0d0e7a-0000-4000-8000-0000000000b1';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

type Call = { method: string; url: string; headers: Record<string, string>; body: string | null };

/** Fake Graph: answers the phone-number GET and the subscribed_apps POST by URL. */
function fakeGraph(opts: { phoneStatus?: number; subscribeStatus?: number } = {}): { http: GraphHttpClient; calls: Call[] } {
  const calls: Call[] = [];
  const http: GraphHttpClient = {
    async request(method, url, headers, body): Promise<GraphHttpResponse> {
      calls.push({ method, url, headers, body });
      if (url.includes('/subscribed_apps')) {
        const s = opts.subscribeStatus ?? 200;
        return { status: s, body: s === 200 ? '{"success":true}' : '{"error":{"message":"app not allowed"}}' };
      }
      if (url.includes('/message_templates')) return { status: 200, body: '{"data":[]}' };
      const s = opts.phoneStatus ?? 200;
      return {
        status: s,
        body: s === 200
          ? JSON.stringify({ display_phone_number: '+972 54-111-1111', verified_name: 'Acme', quality_rating: 'GREEN' })
          : '{"error":{"message":"Invalid OAuth access token"}}',
      };
    },
  };
  return { http, calls };
}

describeMaybe('workspace WhatsApp config (real Postgres, injected Graph)', () => {
  let pool: Pool;
  const env = (http: GraphHttpClient): DispatchEnv => ({ pool, lookups: makePgLookups(pool), deps: makeLocalDeps(pool, undefined, http) });
  const req = (method: string, path: string, ws: string, http: GraphHttpClient, body: unknown = {}) =>
    dispatch({ method, path, authorization: tokenFor(OWNER, ws), query: {}, body }, env(http));
  const VALID = { phone_number_id: 'PN-A', waba_id: 'WABA-1', access_token: 'EAAsecret', default_country: 'il' };

  beforeAll(async () => {
    pool = adminPool();
    await cleanup();
    await pool.query("INSERT INTO companies (id, name) VALUES ($1, 'Co')", [CO]);
    for (const ws of [WS_A, WS_B]) {
      await pool.query("INSERT INTO workspaces (id, name, status, company_id) VALUES ($1,'W','active',$2)", [ws, CO]);
      await pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [ws, OWNER]);
    }
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM workspace_whatsapp_config WHERE workspace_id = ANY($1)', [[WS_A, WS_B]]);
  });

  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    await pool.query('DELETE FROM workspace_whatsapp_config WHERE workspace_id = ANY($1)', [[WS_A, WS_B]]);
    await pool.query('DELETE FROM workspace_users WHERE workspace_id = ANY($1)', [[WS_A, WS_B]]);
    await pool.query('DELETE FROM workspaces WHERE id = ANY($1)', [[WS_A, WS_B]]);
    await pool.query('DELETE FROM companies WHERE id = $1', [CO]);
  }

  it('saves after verifying the number + subscribing the app; token write-only and encrypted', async () => {
    const { http, calls } = fakeGraph();
    expect((await req('GET', '/workspace/whatsapp', WS_A, http)).body).toEqual({ configured: false });

    const saved = await req('PUT', '/workspace/whatsapp', WS_A, http, VALID);
    expect(saved.status).toBe(200);
    // Phone check with the plaintext token, then the WABA subscription.
    expect(calls.map((c) => c.method + ' ' + c.url.replace(/^https:\/\/graph\.facebook\.com\/v[\d.]+/, ''))).toEqual([
      'GET /PN-A?fields=display_phone_number,verified_name,quality_rating',
      'POST /WABA-1/subscribed_apps',
    ]);
    expect(calls[0]!.headers.Authorization).toBe('Bearer EAAsecret');

    const got = (await req('GET', '/workspace/whatsapp', WS_A, http)).body as Record<string, unknown>;
    expect(got).toMatchObject({
      configured: true,
      phone_number_id: 'PN-A',
      waba_id: 'WABA-1',
      default_country: 'IL',
      display_phone_number: '+972 54-111-1111',
      verified_name: 'Acme',
      has_token: true,
    });
    expect(got.webhook_subscribed_at).toBeTruthy();
    expect(JSON.stringify(got)).not.toContain('EAAsecret');

    const { rows } = await pool.query<{ access_token: string }>(
      'SELECT access_token FROM workspace_whatsapp_config WHERE workspace_id = $1',
      [WS_A],
    );
    expect(isEncryptedSecret(rows[0]!.access_token)).toBe(true);
    expect(decryptSecret(rows[0]!.access_token)).toBe('EAAsecret');
  });

  it('validates required fields and the country code', async () => {
    const { http, calls } = fakeGraph();
    expect((await req('PUT', '/workspace/whatsapp', WS_A, http, { ...VALID, phone_number_id: '' })).status).toBe(400);
    expect((await req('PUT', '/workspace/whatsapp', WS_A, http, { ...VALID, waba_id: '' })).status).toBe(400);
    expect((await req('PUT', '/workspace/whatsapp', WS_A, http, { ...VALID, access_token: '' })).status).toBe(400);
    expect((await req('PUT', '/workspace/whatsapp', WS_A, http, { ...VALID, default_country: 'israel' })).status).toBe(400);
    expect(calls).toHaveLength(0); // nothing reaches Meta before local validation passes
  });

  it("a Meta rejection is a 400 with Meta's reason and writes NOTHING", async () => {
    const badToken = await req('PUT', '/workspace/whatsapp', WS_A, fakeGraph({ phoneStatus: 401 }).http, VALID);
    expect(badToken.status).toBe(400);
    expect((badToken.body as { error: string }).error).toContain('Invalid OAuth access token');

    const badSub = await req('PUT', '/workspace/whatsapp', WS_A, fakeGraph({ subscribeStatus: 403 }).http, VALID);
    expect(badSub.status).toBe(400);
    expect((badSub.body as { error: string }).error).toContain('app not allowed');

    const { rowCount } = await pool.query('SELECT 1 FROM workspace_whatsapp_config WHERE workspace_id = $1', [WS_A]);
    expect(rowCount).toBe(0);
  });

  it('a blank token on update keeps the stored one', async () => {
    const { http, calls } = fakeGraph();
    await req('PUT', '/workspace/whatsapp', WS_A, http, VALID);
    const upd = await req('PUT', '/workspace/whatsapp', WS_A, http, { ...VALID, access_token: '', api_version: 'v22.0' });
    expect(upd.status).toBe(200);
    expect(calls.at(-2)!.headers.Authorization).toBe('Bearer EAAsecret'); // verified with the STORED token
    const { rows } = await pool.query<{ access_token: string; api_version: string }>(
      'SELECT access_token, api_version FROM workspace_whatsapp_config WHERE workspace_id = $1',
      [WS_A],
    );
    expect(decryptSecret(rows[0]!.access_token)).toBe('EAAsecret');
    expect(rows[0]!.api_version).toBe('v22.0');
  });

  it('a phone number belongs to ONE workspace (409), and workspaces are isolated', async () => {
    const { http } = fakeGraph();
    await req('PUT', '/workspace/whatsapp', WS_A, http, VALID);
    const taken = await req('PUT', '/workspace/whatsapp', WS_B, http, VALID);
    expect(taken.status).toBe(409);
    expect((await req('GET', '/workspace/whatsapp', WS_B, http)).body).toEqual({ configured: false });

    expect((await req('PUT', '/workspace/whatsapp', WS_B, http, { ...VALID, phone_number_id: 'PN-B' })).status).toBe(200);
    expect(((await req('GET', '/workspace/whatsapp', WS_A, http)).body as { phone_number_id: string }).phone_number_id).toBe('PN-A');

    expect((await req('DELETE', '/workspace/whatsapp', WS_A, http)).status).toBe(200);
    expect((await req('GET', '/workspace/whatsapp', WS_A, http)).body).toEqual({ configured: false });
    expect(((await req('GET', '/workspace/whatsapp', WS_B, http)).body as { configured: boolean }).configured).toBe(true);
  });

  it('every reader uses the workspace row: dispatcher config, templates, readiness', async () => {
    const { http, calls } = fakeGraph();
    await req('PUT', '/workspace/whatsapp', WS_A, http, VALID);

    const cfg = await channelConfigForWorkspace(pool, WS_A, 'whatsapp');
    expect(cfg).toMatchObject({ kind: 'meta', phoneNumberId: 'PN-A', accessToken: 'EAAsecret', defaultCountry: 'IL' });
    expect((await channelConfigForWorkspace(pool, WS_B, 'whatsapp')).kind).toBe('mock'); // B has none

    const t = await req('GET', '/whatsapp/templates', WS_A, http);
    expect(t.body).toEqual({ configured: true, templates: [] });
    expect(calls.at(-1)!.url).toContain('/WABA-1/message_templates');
    expect((await req('GET', '/whatsapp/templates', WS_B, http)).body).toEqual({ configured: false, templates: [] });

    const ch = (await req('GET', '/company/channels', WS_A, http)).body as { channels: { whatsapp: boolean } };
    expect(ch.channels.whatsapp).toBe(true);
    const chB = (await req('GET', '/company/channels', WS_B, http)).body as { channels: { whatsapp: boolean } };
    expect(chB.channels.whatsapp).toBe(false);
  });

  it('the company connectors API no longer accepts WhatsApp', async () => {
    const { http } = fakeGraph();
    const r = await req('PUT', '/company/connectors', WS_A, http, { provider: 'meta_whatsapp', config: { phone_number_id: 'x' }, secret: 't' });
    expect(r.status).toBe(400);
  });
});
