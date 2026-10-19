// The WhatsApp INBOX API (real Postgres, injected Meta HTTP). Properties:
//   - conversations, threads and media are workspace-scoped: a foreign id is a 404
//   - free text only inside the 24h window; outside it a template, and then the
//     sms_whatsapp opt-out applies — inside the window a reply goes through anyway
//   - a reply is recorded in the thread, the activity log and usage, and clears unread
//   - a failed send stays in the thread and Retry replaces it
//   - media bytes need a signed-in member; Meta's media id never reaches the browser
//   - the live stream delivers this workspace's changes and nobody else's
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { hasDatabaseUrl, adminPool, encryptSecret } from '@cdp/db';
import type { ChannelHttpClient } from '@cdp/channels';
import { createApp, dispatch, makePgLookups, makeLocalDeps, type DispatchEnv } from '../src/index.js';
import { recordInboundMessage } from '../src/whatsapp-inbound.js';
import { WhatsAppEventHub } from '../src/whatsapp-stream.js';
import { windowState, parseReply } from '../src/whatsapp-inbox.js';
import { tokenFor } from './seed.js';
import type { Pool } from 'pg';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

const CO = '0c0d0e9a-0000-4000-8000-0000000000c1';
const WS_A = '0c0d0e9a-0000-4000-8000-000000000a01';
const WS_B = '0c0d0e9a-0000-4000-8000-000000000a02';
const OWNER = '0c0d0e9a-0000-4000-8000-0000000000b1';
const PHONE = '+972541111111';

describe('windowState / parseReply (pure)', () => {
  it('the window is open for 24h after the last inbound message', () => {
    const now = new Date('2026-10-19T12:00:00Z');
    expect(windowState(null, now).open).toBe(false);
    expect(windowState(new Date('2026-10-18T12:00:01Z'), now).open).toBe(true);
    expect(windowState(new Date('2026-10-18T11:59:59Z'), now).open).toBe(false);
  });
  it('exactly one of text | template', () => {
    expect(parseReply({ text: '  hi ' })).toEqual({ ok: true, input: { text: 'hi' } });
    expect(parseReply({ template: { name: 'x', language: 'en', params: [1] } })).toEqual({ ok: true, input: { template: { name: 'x', language: 'en', params: ['1'] } } });
    expect(parseReply({}).ok).toBe(false);
    expect(parseReply({ text: 'a', template: { name: 'x', language: 'en' } }).ok).toBe(false);
    expect(parseReply({ template: { name: 'x' } }).ok).toBe(false);
    expect(parseReply({ text: 'x'.repeat(4097) }).ok).toBe(false);
  });
});

describe('WhatsAppEventHub (pure)', () => {
  it("delivers only to the event's workspace, and stops after unsubscribe", () => {
    const hub = new WhatsAppEventHub();
    const a: unknown[] = [];
    const b: unknown[] = [];
    const offA = hub.subscribe('A', (e) => a.push(e));
    hub.subscribe('B', (e) => b.push(e));
    hub.dispatch(JSON.stringify({ workspace_id: 'A', kind: 'message', conversation_id: 'c1', message_id: 'm1' }));
    hub.dispatch('not json');
    hub.dispatch(JSON.stringify({ kind: 'message' }));
    expect(a).toEqual([{ kind: 'message', conversation_id: 'c1', message_id: 'm1' }]);
    expect(b).toEqual([]);
    offA();
    hub.dispatch(JSON.stringify({ workspace_id: 'A', kind: 'status' }));
    expect(a).toHaveLength(1);
    expect(hub.size).toBe(1);
  });
});

describeMaybe('WhatsApp inbox API (real Postgres)', () => {
  let pool: Pool;
  let calls: Array<{ url: string; body: string }>;
  let failNext: boolean;
  const http: ChannelHttpClient = {
    async post(url, _headers, body) {
      calls.push({ url, body });
      if (failNext) {
        failNext = false;
        return { status: 400, body: JSON.stringify({ error: { message: 'Recipient phone number not in allowed list' } }) };
      }
      return { status: 200, body: JSON.stringify({ messages: [{ id: `wamid.reply${calls.length}` }] }) };
    },
  };
  const env = (): DispatchEnv => ({ pool, lookups: makePgLookups(pool), deps: makeLocalDeps(pool, http) });
  const call = (method: string, path: string, ws = WS_A, body: unknown = {}, query: Record<string, string> = {}) =>
    dispatch({ method, path, authorization: tokenFor(OWNER, ws), query, body }, env());

  const inbound = (wamid: string, body: string, at = new Date(), ws = WS_A, from = PHONE) =>
    recordInboundMessage(pool, ws, { phoneNumberId: 'x', from, contactName: 'Dana', wamid, timestamp: at, type: 'text', body, media: null, replyTo: null });
  const conversationId = async (ws = WS_A): Promise<string> =>
    (await pool.query<{ id: string }>('SELECT id FROM whatsapp_conversations WHERE workspace_id = $1', [ws])).rows[0]!.id;

  async function wipe(): Promise<void> {
    for (const ws of [WS_A, WS_B]) {
      for (const t of ['whatsapp_messages', 'whatsapp_conversations', 'channel_optouts', 'messages_log', 'usage_counters', 'activity_log', 'events', 'segment_change_log', 'segment_memberships', 'automation_enrollments', 'profile_features']) {
        await pool.query(`DELETE FROM ${t} WHERE workspace_id = $1`, [ws]);
      }
      await pool.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
    }
  }

  beforeAll(async () => {
    pool = adminPool();
    await wipe();
    await pool.query('DELETE FROM workspace_users WHERE workspace_id = ANY($1)', [[WS_A, WS_B]]);
    await pool.query('DELETE FROM workspaces WHERE id = ANY($1)', [[WS_A, WS_B]]);
    await pool.query('DELETE FROM companies WHERE id = $1', [CO]);
    await pool.query("INSERT INTO companies (id, name) VALUES ($1, 'Co')", [CO]);
    for (const [ws, pn] of [[WS_A, 'inbox-pn-a'], [WS_B, 'inbox-pn-b']] as const) {
      await pool.query("INSERT INTO workspaces (id, name, status, company_id) VALUES ($1,'W','active',$2)", [ws, CO]);
      await pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [ws, OWNER]);
      await pool.query('INSERT INTO workspace_whatsapp_config (workspace_id, phone_number_id, access_token) VALUES ($1,$2,$3)', [ws, pn, encryptSecret('EAAtok')]);
    }
  });

  beforeEach(async () => {
    calls = [];
    failNext = false;
    await wipe();
  });

  afterAll(async () => {
    if (!pool) return;
    await wipe();
    await pool.query('DELETE FROM workspace_users WHERE workspace_id = ANY($1)', [[WS_A, WS_B]]);
    await pool.query('DELETE FROM workspaces WHERE id = ANY($1)', [[WS_A, WS_B]]);
    await pool.query('DELETE FROM companies WHERE id = $1', [CO]);
    await pool.end();
  });

  it('lists conversations per workspace, searches, counts unread, marks read', async () => {
    await inbound('w1', 'first');
    await inbound('w2', 'second');
    const list = (await call('GET', '/whatsapp/conversations')).body as { conversations: Array<Record<string, unknown>> };
    expect(list.conversations).toHaveLength(1);
    expect(list.conversations[0]).toMatchObject({ wa_phone: PHONE, display_name: 'Dana', unread_count: 2, last_message_preview: 'second', window_open: true });

    expect(((await call('GET', '/whatsapp/conversations', WS_A, {}, { q: 'dan' })).body as { conversations: unknown[] }).conversations).toHaveLength(1);
    expect(((await call('GET', '/whatsapp/conversations', WS_A, {}, { q: 'nobody' })).body as { conversations: unknown[] }).conversations).toHaveLength(0);
    expect(((await call('GET', '/whatsapp/conversations', WS_B)).body as { conversations: unknown[] }).conversations).toHaveLength(0);

    expect((await call('GET', '/whatsapp/unread')).body).toEqual({ conversations: 1 });
    const id = await conversationId();
    expect((await call('GET', `/whatsapp/conversations/${id}`, WS_B)).status).toBe(404);
    expect((await call('POST', `/whatsapp/conversations/${id}/read`, WS_B)).status).toBe(404);
    expect((await call('POST', `/whatsapp/conversations/${id}/read`)).status).toBe(200);
    expect((await call('GET', '/whatsapp/unread')).body).toEqual({ conversations: 0 });
  });

  it('pages messages newest first and never exposes the Meta media id', async () => {
    await inbound('w1', 'one', new Date(Date.now() - 3000));
    await inbound('w2', 'two', new Date(Date.now() - 2000));
    await inbound('w3', 'three', new Date(Date.now() - 1000));
    await pool.query(`UPDATE whatsapp_messages SET media = '{"media_id":"SECRET-META-ID","mime_type":"image/jpeg"}' WHERE wamid = 'w3'`);
    const id = await conversationId();
    const page = (await call('GET', `/whatsapp/conversations/${id}/messages`, WS_A, {}, { limit: '2' })).body as { messages: Array<{ body: string; created_at: string }>; has_more: boolean };
    expect(page.messages.map((m) => m.body)).toEqual(['three', 'two']);
    expect(page.has_more).toBe(true);
    expect(JSON.stringify(page)).not.toContain('SECRET-META-ID');
    const older = (await call('GET', `/whatsapp/conversations/${id}/messages`, WS_A, {}, { limit: '2', before: new Date(page.messages[1]!.created_at).toISOString() })).body as { messages: Array<{ body: string }>; has_more: boolean };
    expect(older.messages.map((m) => m.body)).toEqual(['one']);
    expect(older.has_more).toBe(false);
    expect((await call('GET', `/whatsapp/conversations/${id}/messages`, WS_B)).status).toBe(404);
  });

  it('replies inside the window: sent, recorded, metered, unread cleared', async () => {
    await inbound('w1', 'hi');
    const id = await conversationId();
    const r = await call('POST', `/whatsapp/conversations/${id}/messages`, WS_A, { text: 'Hello Dana!' });
    expect(r.status).toBe(201);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ to: '972541111111', type: 'text', text: { body: 'Hello Dana!' } });

    const m = await pool.query('SELECT direction, body, status, sent_by_user_id FROM whatsapp_messages WHERE workspace_id = $1 AND wamid = $2', [WS_A, 'wamid.reply1']);
    expect(m.rows).toEqual([{ direction: 'out', body: 'Hello Dana!', status: 'sent', sent_by_user_id: OWNER }]);
    const conv = await pool.query('SELECT unread_count, last_message_preview FROM whatsapp_conversations WHERE id = $1', [id]);
    expect(conv.rows[0]).toEqual({ unread_count: 0, last_message_preview: 'Hello Dana!' });
    expect((await pool.query("SELECT count(*)::int n FROM messages_log WHERE workspace_id = $1 AND medium = 'whatsapp'", [WS_A])).rows[0].n).toBe(1);
    expect((await pool.query("SELECT value FROM usage_counters WHERE workspace_id = $1 AND metric = 'whatsapp_sent'", [WS_A])).rows[0]?.value).toBe('1');
  });

  it('outside the window: text refused, a template is sent — unless opted out', async () => {
    await inbound('w1', 'old', new Date(Date.now() - 25 * 3600 * 1000));
    const id = await conversationId();
    const text = await call('POST', `/whatsapp/conversations/${id}/messages`, WS_A, { text: 'hi' });
    expect(text.status).toBe(409);
    expect((text.body as { code: string }).code).toBe('window_closed');

    const tpl = { template: { name: 'follow_up', language: 'en_US', params: ['Dana'] } };
    expect((await call('POST', `/whatsapp/conversations/${id}/messages`, WS_A, tpl)).status).toBe(201);
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ type: 'template', template: { name: 'follow_up' } });

    const p = (await pool.query<{ profile_id: string }>('SELECT profile_id FROM whatsapp_conversations WHERE id = $1', [id])).rows[0]!.profile_id;
    await pool.query("INSERT INTO channel_optouts (workspace_id, profile_id, medium_group) VALUES ($1,$2,'sms_whatsapp')", [WS_A, p]);
    const blocked = await call('POST', `/whatsapp/conversations/${id}/messages`, WS_A, tpl);
    expect(blocked.status).toBe(409);
    expect((blocked.body as { code: string }).code).toBe('opted_out');
    expect(calls).toHaveLength(1);
  });

  it('inside the window a reply reaches someone opted out of marketing (they wrote first)', async () => {
    await inbound('w1', 'question?');
    const id = await conversationId();
    const p = (await pool.query<{ profile_id: string }>('SELECT profile_id FROM whatsapp_conversations WHERE id = $1', [id])).rows[0]!.profile_id;
    await pool.query("INSERT INTO channel_optouts (workspace_id, profile_id, medium_group) VALUES ($1,$2,'sms_whatsapp')", [WS_A, p]);
    expect((await call('POST', `/whatsapp/conversations/${id}/messages`, WS_A, { text: 'answer' })).status).toBe(201);
  });

  it('a failed send stays in the thread; Retry replaces it', async () => {
    await inbound('w1', 'hi');
    const id = await conversationId();
    failNext = true;
    const r = await call('POST', `/whatsapp/conversations/${id}/messages`, WS_A, { text: 'are you there?' });
    expect(r.status).toBe(502);
    const failed = await pool.query<{ id: string; status: string; error: { message: string } }>(
      "SELECT id, status, error FROM whatsapp_messages WHERE workspace_id = $1 AND direction = 'out'",
      [WS_A],
    );
    expect(failed.rows).toHaveLength(1);
    expect(failed.rows[0]!.status).toBe('failed');
    expect(failed.rows[0]!.error.message).toContain('not in allowed list');

    expect((await call('POST', `/whatsapp/messages/${failed.rows[0]!.id}/retry`, WS_B)).status).toBe(404);
    expect((await call('POST', `/whatsapp/messages/${failed.rows[0]!.id}/retry`)).status).toBe(201);
    const after = await pool.query("SELECT body, status FROM whatsapp_messages WHERE workspace_id = $1 AND direction = 'out'", [WS_A]);
    expect(after.rows).toEqual([{ body: 'are you there?', status: 'sent' }]);
  });

  it('a profile without a conversation can be messaged with a template (starts one)', async () => {
    const p = (await pool.query<{ id: string }>("INSERT INTO profiles (workspace_id, email, phone) VALUES ($1,'d@x.com',$2) RETURNING id", [WS_A, PHONE])).rows[0]!.id;
    expect((await call('GET', `/profiles/${p}/whatsapp`)).body).toEqual({ phone: PHONE, conversation: null });
    expect((await call('POST', `/profiles/${p}/whatsapp/messages`, WS_A, { text: 'hi' })).status).toBe(409); // no window yet
    expect((await call('POST', `/profiles/${p}/whatsapp/messages`, WS_A, { template: { name: 'welcome', language: 'en', params: [] } })).status).toBe(201);
    const got = (await call('GET', `/profiles/${p}/whatsapp`)).body as { conversation: { last_message_preview: string } };
    expect(got.conversation.last_message_preview).toBe('Template: welcome');
    expect((await call('GET', `/profiles/${p}/whatsapp`, WS_B)).status).toBe(404);
  });

  it('refuses to send when the workspace has not connected WhatsApp', async () => {
    await inbound('w1', 'hi', new Date(), WS_B);
    const id = await conversationId(WS_B);
    await pool.query('UPDATE workspace_whatsapp_config SET enabled = false WHERE workspace_id = $1', [WS_B]);
    try {
      expect((await call('POST', `/whatsapp/conversations/${id}/messages`, WS_B, { text: 'x' })).status).toBe(409);
    } finally {
      await pool.query('UPDATE workspace_whatsapp_config SET enabled = true WHERE workspace_id = $1', [WS_B]);
    }
  });

  it('serves media only to a signed-in member of the workspace', async () => {
    await inbound('w1', 'photo');
    const msgId = (await pool.query<{ id: string }>("SELECT id FROM whatsapp_messages WHERE wamid = 'w1' AND workspace_id = $1", [WS_A])).rows[0]!.id;
    await pool.query("INSERT INTO whatsapp_media (message_id, workspace_id, mime_type, size_bytes, storage, data) VALUES ($1,$2,'image/jpeg',4,'db',$3)", [msgId, WS_A, Buffer.from('JPEG')]);
    const app = createApp({ pool });
    expect((await app.request(`/whatsapp/media/${msgId}`)).status).toBe(401);
    expect((await app.request(`/whatsapp/media/${msgId}`, { headers: { authorization: tokenFor(OWNER, WS_B) } })).status).toBe(404);
    const res = await app.request(`/whatsapp/media/${msgId}`, { headers: { authorization: tokenFor(OWNER, WS_A) } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toContain('private');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('JPEG');
  });

  it('the live stream delivers this workspace’s changes over real LISTEN/NOTIFY', async () => {
    const app = createApp({ pool });
    expect((await app.request('/whatsapp/stream')).status).toBe(401);
    const ctl = new AbortController();
    const res = await app.request('/whatsapp/stream', { headers: { authorization: tokenFor(OWNER, WS_A) }, signal: ctl.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const readUntil = async (needle: string, ms: number): Promise<boolean> => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const chunk = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), 200))]);
        if (chunk && !chunk.done) text += decoder.decode(chunk.value);
        if (text.includes(needle)) return true;
      }
      return false;
    };
    expect(await readUntil('event: ready', 2000)).toBe(true);
    // The LISTEN connection starts with the first stream; keep writing until it is up.
    let seen = false;
    for (let i = 0; i < 15 && !seen; i++) {
      await inbound(`live-b-${i}`, 'for B', new Date(), WS_B, '+972549999999'); // another workspace: never seen
      await inbound(`live-a-${i}`, 'for A');
      seen = await readUntil('event: message', 400);
    }
    expect(seen).toBe(true);
    const idA = await conversationId(WS_A);
    const idB = await conversationId(WS_B);
    expect(text).toContain(idA);
    expect(text).not.toContain(idB);
    ctl.abort();
    await reader.cancel().catch(() => {});
  });
});
