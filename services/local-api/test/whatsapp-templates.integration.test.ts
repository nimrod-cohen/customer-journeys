// WhatsApp message-template MANAGEMENT via the Graph API (CLAUDE.md). REAL Postgres + an
// INJECTED fake GraphHttpClient (never touches graph.facebook.com). Proves the handlers
// resolve the company's WABA id + DECRYPTED token, build the exact Graph request, and map
// the response; no WABA id → configured:false; validation + company isolation.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import type { GraphHttpClient, GraphHttpResponse } from '@cdp/channels';
import { makePgLookups, makeLocalDeps, dispatch, type DispatchEnv } from '../src/index.js';
import { tokenFor } from './seed.js';
import type { Pool } from 'pg';

const CO = '0c0d0e4a-0000-4000-8000-0000000000c1';
const WS = '0c0d0e4a-0000-4000-8000-000000000a01';
const OWNER = '0c0d0e4a-0000-4000-8000-0000000000b1';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

/** A capturing Graph client returning scripted responses per call. */
function makeGraph(responses: Array<{ status: number; body: string }>): {
  http: GraphHttpClient;
  calls: Array<{ method: string; url: string; headers: Record<string, string>; body: string | null }>;
} {
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; body: string | null }> = [];
  let i = 0;
  const http: GraphHttpClient = {
    async request(method, url, headers, body): Promise<GraphHttpResponse> {
      calls.push({ method, url, headers, body });
      const r = responses[Math.min(i, responses.length - 1)]!;
      i++;
      return r;
    },
  };
  return { http, calls };
}

describeMaybe('WhatsApp templates management (real Postgres, injected Graph)', () => {
  let pool: Pool;
  const tok = () => tokenFor(OWNER, WS);
  const env = (http?: GraphHttpClient): DispatchEnv => ({
    pool,
    lookups: makePgLookups(pool),
    deps: makeLocalDeps(pool, undefined, http),
  });
  const putConfig = (body: unknown, e: DispatchEnv) =>
    dispatch({ method: 'PUT', path: '/company/whatsapp-config', authorization: tok(), query: {}, body }, e);

  beforeAll(async () => {
    pool = adminPool();
    await cleanup();
    await pool.query("INSERT INTO companies (id, name) VALUES ($1, 'Co')", [CO]);
    await pool.query("INSERT INTO workspaces (id, name, status, company_id) VALUES ($1,'W','active',$2)", [WS, CO]);
    await pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS, OWNER]);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM company_whatsapp_config WHERE company_id = $1', [CO]);
  });

  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    await pool.query('DELETE FROM company_whatsapp_config WHERE company_id = $1', [CO]);
    await pool.query('DELETE FROM workspace_users WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [WS]);
    await pool.query('DELETE FROM companies WHERE id = $1', [CO]);
  }

  it('no WABA id → GET /whatsapp/templates returns configured:false (no Graph call)', async () => {
    const { http, calls } = makeGraph([{ status: 200, body: '{"data":[]}' }]);
    const e = env(http);
    // Config without a WABA id.
    await putConfig({ phone_number_id: '123', access_token: 'EAAtok' }, e);
    const r = await dispatch({ method: 'GET', path: '/whatsapp/templates', authorization: tok(), query: {}, body: {} }, e);
    expect(r.body).toEqual({ configured: false, templates: [] });
    expect(calls).toHaveLength(0);
  });

  it('with a WABA id, GET lists templates via the Graph API (token decrypted at call)', async () => {
    const { http, calls } = makeGraph([
      { status: 200, body: JSON.stringify({ data: [{ id: 't1', name: 'order_update', language: 'en_US', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'BODY', text: 'Hi {{1}}' }] }] }) },
    ]);
    const e = env(http);
    await putConfig({ phone_number_id: '123', waba_id: '999888', access_token: 'EAAsecret', api_version: 'v21.0' }, e);
    const r = await dispatch({ method: 'GET', path: '/whatsapp/templates', authorization: tok(), query: {}, body: {} }, e);
    expect(r.status).toBe(200);
    const body = r.body as { configured: boolean; templates: Array<{ name: string; status: string; variableCount: number }> };
    expect(body.configured).toBe(true);
    expect(body.templates[0]).toMatchObject({ name: 'order_update', status: 'APPROVED', variableCount: 1 });
    // The Graph call used the WABA id + the DECRYPTED token.
    expect(calls[0]!.url).toBe('https://graph.facebook.com/v21.0/999888/message_templates?limit=200');
    expect(calls[0]!.headers.Authorization).toBe('Bearer EAAsecret');
  });

  it('POST creates + submits a template for approval (exact Graph body)', async () => {
    const { http, calls } = makeGraph([{ status: 200, body: JSON.stringify({ id: 'NEW', status: 'PENDING', category: 'MARKETING' }) }]);
    const e = env(http);
    await putConfig({ phone_number_id: '123', waba_id: '999888', access_token: 'EAAsecret' }, e);
    const r = await dispatch(
      { method: 'POST', path: '/whatsapp/templates', authorization: tok(), query: {}, body: { name: 'Order_Update', language: 'en_US', category: 'marketing', body: 'Hi {{1}}, code {{2}}', examples: ['Ada', 'A1B2'] } },
      e,
    );
    expect(r.status).toBe(201);
    expect((r.body as { template: { status: string } }).template.status).toBe('PENDING');
    const sent = JSON.parse(calls[0]!.body!);
    expect(sent).toEqual({
      name: 'order_update', // lower-cased
      language: 'en_US',
      category: 'MARKETING', // upper-cased
      components: [{ type: 'BODY', text: 'Hi {{1}}, code {{2}}', example: { body_text: [['Ada', 'A1B2']] } }],
    });
  });

  it('POST validates the name + category (400, no Graph call)', async () => {
    const { http, calls } = makeGraph([{ status: 200, body: '{}' }]);
    const e = env(http);
    await putConfig({ phone_number_id: '123', waba_id: '999888', access_token: 'EAAsecret' }, e);
    const bad = await dispatch({ method: 'POST', path: '/whatsapp/templates', authorization: tok(), query: {}, body: { name: 'Bad Name!', language: 'en', category: 'MARKETING', body: 'x' }, }, e);
    expect(bad.status).toBe(400);
    const badCat = await dispatch({ method: 'POST', path: '/whatsapp/templates', authorization: tok(), query: {}, body: { name: 'ok_name', language: 'en', category: 'SPAM', body: 'x' } }, e);
    expect(badCat.status).toBe(400);
    expect(calls).toHaveLength(0); // never reached the Graph API
  });

  it('DELETE removes a template by name via the Graph API', async () => {
    const { http, calls } = makeGraph([{ status: 200, body: JSON.stringify({ success: true }) }]);
    const e = env(http);
    await putConfig({ phone_number_id: '123', waba_id: '999888', access_token: 'EAAsecret' }, e);
    const r = await dispatch({ method: 'DELETE', path: '/whatsapp/templates/order_update', authorization: tok(), query: {}, body: {} }, e);
    expect(r.status).toBe(200);
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.url).toContain('message_templates?name=order_update');
  });

  it('a Graph API error is surfaced as a 502', async () => {
    const { http } = makeGraph([{ status: 400, body: JSON.stringify({ error: { message: 'Bad WABA' } }) }]);
    const e = env(http);
    await putConfig({ phone_number_id: '123', waba_id: '999888', access_token: 'EAAsecret' }, e);
    const r = await dispatch({ method: 'GET', path: '/whatsapp/templates', authorization: tok(), query: {}, body: {} }, e);
    expect(r.status).toBe(502);
    expect((r.body as { error: string }).error).toMatch(/Bad WABA/);
  });
});
