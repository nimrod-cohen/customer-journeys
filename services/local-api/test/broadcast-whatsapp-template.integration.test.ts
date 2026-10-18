// A WhatsApp broadcast with an approved TEMPLATE, for a company WITH Meta credentials,
// routes through the REAL MetaWhatsAppProvider (CLAUDE.md). REAL Postgres + an INJECTED
// fake ChannelHttpClient (never touches graph.facebook.com). Proves:
//  - the send builds the exact Cloud API type:'template' request (name + language +
//    per-recipient rendered body params, E.164 with the '+' stripped, Bearer token
//    decrypted only at send), and messages_log records the returned provider id;
//  - a company with NO WhatsApp config falls back to the deterministic mock (no HTTP).
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool } from '@cdp/db';
import type { ChannelHttpClient, ChannelHttpResponse } from '@cdp/channels';
import { makePgLookups, makeLocalDeps, dispatch, type DispatchEnv } from '../src/index.js';
import { tokenFor, seedWorkspaceWhatsapp } from './seed.js';
import type { Pool } from 'pg';

const CO = '0c0d0e3a-0000-4000-8000-0000000000c1';
const WS = '0c0d0e3a-0000-4000-8000-000000000a01';
const OWNER = '0c0d0e3a-0000-4000-8000-0000000000b1';
const SEG = '0c0d0e3a-0000-4000-8000-0000000000d1';
const P = '0c0d0e3a-0000-4000-8000-0000000000f1';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

/** A capturing HTTP client returning a canned Meta OK ({ messages: [{ id }] }). */
function makeCapturingHttp(): {
  http: ChannelHttpClient;
  calls: Array<{ url: string; headers: Record<string, string>; body: string }>;
} {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const http: ChannelHttpClient = {
    async post(url, headers, body): Promise<ChannelHttpResponse> {
      calls.push({ url, headers, body });
      return { status: 200, body: JSON.stringify({ messages: [{ id: 'wamid.TEST123' }] }) };
    },
  };
  return { http, calls };
}

describeMaybe('WhatsApp template broadcast → real Meta provider (real Postgres)', () => {
  let pool: Pool;
  const createBc = (tok: string, body: Record<string, unknown>, env: DispatchEnv) =>
    dispatch({ method: 'POST', path: '/broadcasts', authorization: tok, query: {}, body }, env);
  const sendBc = (tok: string, id: string, env: DispatchEnv) =>
    dispatch({ method: 'POST', path: `/broadcasts/${id}/send`, authorization: tok, query: {}, body: {} }, env);

  const WA = { name: 'order_update', language: 'en_US', params: ['{{customer.first_name}}', '{{customer.code}}'] };

  beforeAll(async () => {
    pool = adminPool();
    await cleanup();
    await pool.query("INSERT INTO companies (id, name) VALUES ($1, 'Co')", [CO]);
    await pool.query("INSERT INTO workspaces (id, name, status, company_id) VALUES ($1,'W','active',$2)", [WS, CO]);
    await pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [WS, OWNER]);
    await pool.query("INSERT INTO segments (id, workspace_id, name, kind) VALUES ($1,$2,'S','manual')", [SEG, WS]);
    await pool.query(
      "INSERT INTO profiles (id, workspace_id, email, attributes) VALUES ($1,$2,'p@x.com',$3::jsonb)",
      [P, WS, JSON.stringify({ phone: '+972529461566', first_name: 'Ada', code: 'A1B2' })],
    );
    await pool.query(
      "INSERT INTO segment_memberships (segment_id, profile_id, workspace_id, source) VALUES ($1,$2,$3,'manual')",
      [SEG, P, WS],
    );
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM workspace_whatsapp_config WHERE workspace_id = $1', [WS]);
    for (const t of ['whatsapp_messages', 'whatsapp_conversations', 'messages_log', 'usage_counters', 'outbox', 'broadcasts']) {
      await pool.query(`DELETE FROM ${t} WHERE workspace_id = $1`, [WS]);
    }
  });

  afterAll(async () => {
    if (pool) {
      await cleanup();
      await pool.end();
    }
  });

  async function cleanup(): Promise<void> {
    for (const t of ['whatsapp_messages', 'whatsapp_conversations', 'messages_log', 'usage_counters', 'outbox', 'broadcasts', 'segment_memberships', 'segments', 'profiles', 'workspace_users']) {
      await pool.query(`DELETE FROM ${t} WHERE workspace_id = $1`, [WS]);
    }
    await pool.query('DELETE FROM workspace_whatsapp_config WHERE workspace_id = $1', [WS]);
    await pool.query('DELETE FROM workspaces WHERE id = $1', [WS]);
    await pool.query('DELETE FROM companies WHERE id = $1', [CO]);
  }

  it('routes a template broadcast through the real Cloud API (exact type:template request)', async () => {
    const tok = tokenFor(OWNER, WS);
    const { http, calls } = makeCapturingHttp();
    const env: DispatchEnv = { pool, lookups: makePgLookups(pool), deps: makeLocalDeps(pool, http) };
    // Configure Meta WhatsApp for the company.
    await seedWorkspaceWhatsapp(pool, WS, { phoneNumberId: '100055512345', accessToken: 'EAAsecret', apiVersion: 'v21.0' });

    const c = await createBc(
      tok,
      { name: 'WA tpl', medium: 'whatsapp', whatsapp_template: WA, audience_kind: 'manual', audience_ref: SEG },
      env,
    );
    expect(c.status).toBe(201);
    const id = (c.body as { broadcast: { id: string } }).broadcast.id;
    const r = await sendBc(tok, id, env);
    expect(r.status).toBe(200);
    expect((r.body as { result: { result: string } }).result.result).toBe('sent');

    // ONE Cloud API POST with the exact URL + Bearer + template payload.
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://graph.facebook.com/v21.0/100055512345/messages');
    expect(call.headers['Authorization']).toBe('Bearer EAAsecret'); // decrypted only at send
    const payload = JSON.parse(call.body);
    expect(payload).toEqual({
      messaging_product: 'whatsapp',
      to: '972529461566', // E.164, '+' stripped
      type: 'template',
      template: {
        name: 'order_update',
        language: { code: 'en_US' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: 'Ada' }, { type: 'text', text: 'A1B2' }] }, // merge-rendered
        ],
      },
    });

    // messages_log records the returned wamid (not a mock id).
    const ml = await pool.query<{ medium: string; status: string; ses_message_id: string | null }>(
      "SELECT medium, status, ses_message_id FROM messages_log WHERE workspace_id = $1 AND status = 'sent'",
      [WS],
    );
    expect(ml.rows).toHaveLength(1);
    expect(ml.rows[0]!.medium).toBe('whatsapp');
    expect(ml.rows[0]!.ses_message_id).toBe('wamid.TEST123');

    // ...and the send lands in the person's WhatsApp conversation, tagged to the broadcast.
    const wm = await pool.query(
      `SELECT m.direction, m.type, m.body, m.template, m.status, m.broadcast_id, c.wa_phone, c.last_message_preview, c.unread_count
         FROM whatsapp_messages m JOIN whatsapp_conversations c ON c.id = m.conversation_id
        WHERE m.workspace_id = $1 AND m.wamid = 'wamid.TEST123'`,
      [WS],
    );
    expect(wm.rows).toEqual([
      {
        direction: 'out',
        type: 'template',
        body: null,
        template: { name: 'order_update', language: 'en_US', params: ['Ada', 'A1B2'] },
        status: 'sent',
        broadcast_id: id,
        wa_phone: '+972529461566',
        last_message_preview: 'Template: order_update',
        unread_count: 0,
      },
    ]);
  });

  it('a delivery status that beat the send to us is kept when the send records itself', async () => {
    const tok = tokenFor(OWNER, WS);
    const { http } = makeCapturingHttp();
    const env: DispatchEnv = { pool, lookups: makePgLookups(pool), deps: makeLocalDeps(pool, http) };
    await seedWorkspaceWhatsapp(pool, WS, { phoneNumberId: '100055512345', accessToken: 'EAAsecret' });
    // The webhook's stub: Meta said "delivered" before our send's tx committed.
    await pool.query(
      "INSERT INTO whatsapp_messages (workspace_id, direction, wamid, status) VALUES ($1, 'out', 'wamid.TEST123', 'delivered')",
      [WS],
    );
    const c = await createBc(tok, { name: 'race', medium: 'whatsapp', whatsapp_template: WA, audience_kind: 'manual', audience_ref: SEG }, env);
    await sendBc(tok, (c.body as { broadcast: { id: string } }).broadcast.id, env);
    const row = await pool.query<{ status: string; conversation_id: string | null; type: string }>(
      "SELECT status, conversation_id, type FROM whatsapp_messages WHERE workspace_id = $1 AND wamid = 'wamid.TEST123'",
      [WS],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]!.status).toBe('delivered'); // not regressed to 'sent'
    expect(row.rows[0]!.conversation_id).not.toBeNull(); // filled in
    expect(row.rows[0]!.type).toBe('template');
  });

  it('a WhatsApp broadcast for a company with NO Meta config falls back to the MOCK (no HTTP)', async () => {
    const tok = tokenFor(OWNER, WS);
    const { http, calls } = makeCapturingHttp();
    const env: DispatchEnv = { pool, lookups: makePgLookups(pool), deps: makeLocalDeps(pool, http) };
    // No whatsapp config (cleared). A template broadcast still sends — via the mock.
    const c = await createBc(
      tok,
      { name: 'WA mock', medium: 'whatsapp', whatsapp_template: WA, audience_kind: 'manual', audience_ref: SEG },
      env,
    );
    const id = (c.body as { broadcast: { id: string } }).broadcast.id;
    expect((await sendBc(tok, id, env)).status).toBe(200);
    expect(calls).toHaveLength(0); // the mock NEVER hits HTTP
    const ml = await pool.query<{ ses_message_id: string | null }>(
      "SELECT ses_message_id FROM messages_log WHERE workspace_id = $1 AND status = 'sent'",
      [WS],
    );
    expect(ml.rows[0]!.ses_message_id).toMatch(/^mock-wa-/);
  });

  it('a WhatsApp broadcast with NEITHER a body NOR a template is refused at send (409)', async () => {
    const tok = tokenFor(OWNER, WS);
    const env: DispatchEnv = { pool, lookups: makePgLookups(pool), deps: makeLocalDeps(pool) };
    const c = await createBc(tok, { name: 'empty', medium: 'whatsapp', audience_kind: 'manual', audience_ref: SEG }, env);
    const id = (c.body as { broadcast: { id: string } }).broadcast.id;
    const r = await sendBc(tok, id, env);
    expect(r.status).toBe(409);
    expect((r.body as { error: string }).error).toMatch(/message body or.*template/i);
  });
});
