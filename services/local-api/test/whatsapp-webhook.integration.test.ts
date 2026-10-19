// Meta WhatsApp webhooks — GET handshake + signed POST, through the REAL Hono app and
// REAL Postgres. Properties that matter:
//   - an unsigned/forged body is refused and stores NOTHING
//   - the workspace comes from OUR phone-number table, never the payload; an unknown
//     number writes nothing, and two workspaces never see each other's messages
//   - a redelivered webhook changes nothing (one message, one event, unread stays 1)
//   - an unknown sender becomes a phone-only profile; a known phone is reused
//   - an inbound message is a behavioral event, so event-triggered automations enroll
//   - statuses only move forward, a status before its send converges, and an
//     inbound row is never touched by a status
//   - a failed body is kept and re-driven by the sweep; media is copied privately
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import { hasDatabaseUrl, adminPool, encryptSecret } from '@cdp/db';
import type { GraphHttpClient, BinaryHttpClient } from '@cdp/channels';
import { createApp, dispatch, makePgLookups, makeLocalDeps } from '../src/index.js';
import { sweepWhatsAppInbox, sweepWhatsAppMedia } from '../src/whatsapp-inbound.js';
import { tokenFor } from './seed.js';
import type { Pool } from 'pg';

const describeMaybe = hasDatabaseUrl() ? describe : describe.skip;

const CO = '0c0d0e8a-0000-4000-8000-0000000000c1';
const WS_A = '0c0d0e8a-0000-4000-8000-000000000a01';
const WS_B = '0c0d0e8a-0000-4000-8000-000000000a02';
const OWNER = '0c0d0e8a-0000-4000-8000-0000000000b1';
const PN_A = 'wh-test-pn-a';
const PN_B = 'wh-test-pn-b';
const APP_SECRET = 'test-meta-app-secret';
const VERIFY = 'test-verify-token';

const sign = (body: string) => 'sha256=' + createHmac('sha256', APP_SECRET).update(body).digest('hex');

function change(phoneNumberId: string, value: Record<string, unknown>) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phoneNumberId }, ...value } }] }],
  };
}
const textMsg = (pn: string, from: string, wamid: string, body: string, name = 'Dana') =>
  change(pn, {
    contacts: [{ profile: { name }, wa_id: from }],
    messages: [{ from, id: wamid, timestamp: '1760000000', type: 'text', text: { body } }],
  });
const status = (pn: string, wamid: string, s: string, errors?: unknown[]) =>
  change(pn, { statuses: [{ id: wamid, status: s, timestamp: '1760000100', recipient_id: '972541111111', ...(errors ? { errors } : {}) }] });

describeMaybe('WhatsApp webhooks (real Postgres, real app)', () => {
  let pool: Pool;
  let app: ReturnType<typeof createApp>;
  const prev: Record<string, string | undefined> = {};

  const post = (payload: unknown, signature?: string) => {
    const body = JSON.stringify(payload);
    return app.request('/webhooks/whatsapp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature ?? sign(body) },
      body,
    });
  };
  const one = async <T>(sql: string, values: unknown[]): Promise<T | undefined> => (await pool.query(sql, values)).rows[0] as T | undefined;
  const count = async (sql: string, values: unknown[]): Promise<number> => Number((await pool.query(sql, values)).rows[0].n);

  async function wipe(): Promise<void> {
    for (const ws of [WS_A, WS_B]) {
      for (const t of ['whatsapp_messages', 'whatsapp_conversations', 'automation_enrollments', 'automations', 'activity_log', 'events', 'segment_change_log', 'segment_memberships', 'profile_features']) {
        await pool.query(`DELETE FROM ${t} WHERE workspace_id = $1`, [ws]);
      }
      await pool.query('DELETE FROM profiles WHERE workspace_id = $1', [ws]);
    }
    await pool.query("DELETE FROM whatsapp_webhook_inbox WHERE payload::text LIKE '%wh-test-pn-%'");
  }

  beforeAll(async () => {
    for (const k of ['META_APP_SECRET', 'META_WEBHOOK_VERIFY_TOKEN']) prev[k] = process.env[k];
    process.env.META_APP_SECRET = APP_SECRET;
    process.env.META_WEBHOOK_VERIFY_TOKEN = VERIFY;
    pool = adminPool();
    app = createApp({ pool });
    await wipe();
    await pool.query('DELETE FROM workspace_users WHERE workspace_id = ANY($1)', [[WS_A, WS_B]]);
    await pool.query('DELETE FROM workspaces WHERE id = ANY($1)', [[WS_A, WS_B]]);
    await pool.query('DELETE FROM companies WHERE id = $1', [CO]);
    await pool.query("INSERT INTO companies (id, name) VALUES ($1, 'Co')", [CO]);
    for (const [ws, pn] of [[WS_A, PN_A], [WS_B, PN_B]] as const) {
      await pool.query("INSERT INTO workspaces (id, name, status, company_id) VALUES ($1,'W','active',$2)", [ws, CO]);
      await pool.query("INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ($1,$2,'owner')", [ws, OWNER]);
      await pool.query(
        'INSERT INTO workspace_whatsapp_config (workspace_id, phone_number_id, access_token) VALUES ($1,$2,$3)',
        [ws, pn, encryptSecret('EAAtok')],
      );
    }
  });

  beforeEach(wipe);

  afterAll(async () => {
    if (!pool) return;
    await wipe();
    await pool.query('DELETE FROM workspace_users WHERE workspace_id = ANY($1)', [[WS_A, WS_B]]);
    await pool.query('DELETE FROM workspaces WHERE id = ANY($1)', [[WS_A, WS_B]]);
    await pool.query('DELETE FROM companies WHERE id = $1', [CO]);
    await pool.end();
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("answers Meta's subscription handshake only with the right token", async () => {
    const ok = await app.request(`/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=12345`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('12345');
    expect((await app.request('/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1')).status).toBe(403);
  });

  it('refuses an unsigned or forged body and stores nothing', async () => {
    const payload = textMsg(PN_A, '972541111111', 'wamid.forged', 'hi');
    expect((await post(payload, 'sha256=' + '0'.repeat(64))).status).toBe(401);
    const r = await app.request('/webhooks/whatsapp', { method: 'POST', body: JSON.stringify(payload) });
    expect(r.status).toBe(401);
    expect(await count("SELECT count(*) n FROM whatsapp_webhook_inbox WHERE payload::text LIKE '%wamid.forged%'", [])).toBe(0);
    expect(await count('SELECT count(*) n FROM whatsapp_messages WHERE workspace_id = $1', [WS_A])).toBe(0);
  });

  it('an unknown sender becomes a phone-only profile, a conversation, a message and an event', async () => {
    expect((await post(textMsg(PN_A, '972541111111', 'wamid.1', 'hello there'))).status).toBe(200);

    const p = await one<{ id: string; phone: string; email: string | null; attributes: Record<string, unknown> }>(
      'SELECT id, phone, email, attributes FROM profiles WHERE workspace_id = $1',
      [WS_A],
    );
    expect(p).toMatchObject({ phone: '+972541111111', email: null });
    expect(p!.attributes.whatsapp_name).toBe('Dana');

    const conv = await one<Record<string, unknown>>('SELECT * FROM whatsapp_conversations WHERE workspace_id = $1', [WS_A]);
    expect(conv).toMatchObject({ profile_id: p!.id, wa_phone: '+972541111111', contact_name: 'Dana', unread_count: 1, last_message_preview: 'hello there' });
    expect(conv!.last_inbound_at).toEqual(new Date(1760000000 * 1000));

    const msg = await one<Record<string, unknown>>('SELECT * FROM whatsapp_messages WHERE workspace_id = $1', [WS_A]);
    expect(msg).toMatchObject({ direction: 'in', wamid: 'wamid.1', type: 'text', body: 'hello there', status: 'received', conversation_id: conv!.id });

    const ev = await one<{ type: string; payload: Record<string, unknown> }>('SELECT type, payload FROM events WHERE workspace_id = $1', [WS_A]);
    expect(ev).toMatchObject({ type: 'whatsapp_message_received', payload: { text: 'hello there', wamid: 'wamid.1', conversation_id: conv!.id } });
    expect(await count("SELECT count(*) n FROM activity_log WHERE workspace_id = $1 AND type = 'profile_created'", [WS_A])).toBe(1);
    expect(await count("SELECT count(*) n FROM whatsapp_webhook_inbox WHERE payload::text LIKE '%wamid.1%' AND processed_at IS NOT NULL", [])).toBe(1);
  });

  it("keeps a sender the phone library rejects — Meta's id is a real account", async () => {
    await post(textMsg(PN_A, '447700900123', 'wamid.uk', 'hello from the UK', 'Oliver'));
    expect(await one('SELECT wa_phone, contact_name FROM whatsapp_conversations WHERE workspace_id = $1', [WS_A])).toEqual({
      wa_phone: '+447700900123',
      contact_name: 'Oliver',
    });
    expect((await one<{ phone: string }>('SELECT phone FROM profiles WHERE workspace_id = $1', [WS_A]))!.phone).toBe('+447700900123');
  });

  it('a redelivered webhook changes nothing', async () => {
    const payload = textMsg(PN_A, '972541111111', 'wamid.dup', 'once');
    await post(payload);
    await post(payload);
    expect(await count('SELECT count(*) n FROM whatsapp_messages WHERE workspace_id = $1', [WS_A])).toBe(1);
    expect(await count('SELECT count(*) n FROM events WHERE workspace_id = $1', [WS_A])).toBe(1);
    expect((await one<{ unread_count: number }>('SELECT unread_count FROM whatsapp_conversations WHERE workspace_id = $1', [WS_A]))!.unread_count).toBe(1);
  });

  it('a known phone is reused, not duplicated', async () => {
    const existing = await one<{ id: string }>(
      "INSERT INTO profiles (workspace_id, email, phone) VALUES ($1, 'dana@x.com', '+972541111111') RETURNING id",
      [WS_A],
    );
    await post(textMsg(PN_A, '972541111111', 'wamid.known', 'hi'));
    expect(await count('SELECT count(*) n FROM profiles WHERE workspace_id = $1', [WS_A])).toBe(1);
    expect((await one<{ profile_id: string }>('SELECT profile_id FROM whatsapp_messages WHERE workspace_id = $1', [WS_A]))!.profile_id).toBe(existing!.id);
    expect(await count("SELECT count(*) n FROM activity_log WHERE workspace_id = $1 AND type = 'profile_created'", [WS_A])).toBe(0);
  });

  it('routes by OUR phone-number table: unknown numbers write nothing, workspaces stay apart', async () => {
    expect((await post(textMsg('not-ours', '972541111111', 'wamid.x', 'hi'))).status).toBe(200);
    expect(await count("SELECT count(*) n FROM whatsapp_messages WHERE wamid = 'wamid.x'", [])).toBe(0);

    await post(textMsg(PN_A, '972541111111', 'wamid.a', 'to A'));
    await post(textMsg(PN_B, '972541111111', 'wamid.b', 'to B'));
    const a = await pool.query<{ wamid: string }>('SELECT wamid FROM whatsapp_messages WHERE workspace_id = $1', [WS_A]);
    const b = await pool.query<{ wamid: string }>('SELECT wamid FROM whatsapp_messages WHERE workspace_id = $1', [WS_B]);
    expect(a.rows.map((r) => r.wamid)).toEqual(['wamid.a']);
    expect(b.rows.map((r) => r.wamid)).toEqual(['wamid.b']);
  });

  it('enrolls the sender into an active event-triggered automation', async () => {
    const def = { startNode: 't', nodes: { t: { type: 'trigger', kind: 'event', eventType: 'whatsapp_message_received', next: 'x' }, x: { type: 'exit' } } };
    const auto = await one<{ id: string }>(
      "INSERT INTO automations (workspace_id, name, definition, status) VALUES ($1,'Reply bot',$2::jsonb,'active') RETURNING id",
      [WS_A, JSON.stringify(def)],
    );
    await post(textMsg(PN_A, '972541111111', 'wamid.enroll', 'hi'));
    expect(await count('SELECT count(*) n FROM automation_enrollments WHERE workspace_id = $1 AND automation_id = $2', [WS_A, auto!.id])).toBe(1);
  });

  it('statuses only move forward, converge before the send, and never touch an inbound row', async () => {
    // A status BEFORE the outbound row exists → a stub.
    await post(status(PN_A, 'wamid.out', 'delivered'));
    expect(await one('SELECT direction, status, conversation_id FROM whatsapp_messages WHERE wamid = $1', ['wamid.out'])).toEqual({
      direction: 'out',
      status: 'delivered',
      conversation_id: null,
    });
    await post(status(PN_A, 'wamid.out', 'sent')); // late, lower → ignored
    expect((await one<{ status: string }>('SELECT status FROM whatsapp_messages WHERE wamid = $1', ['wamid.out']))!.status).toBe('delivered');
    await post(status(PN_A, 'wamid.out', 'read'));
    expect((await one<{ status: string }>('SELECT status FROM whatsapp_messages WHERE wamid = $1', ['wamid.out']))!.status).toBe('read');
    await post(status(PN_A, 'wamid.out', 'failed', [{ code: 131026, title: 'Message undeliverable' }]));
    expect(await one('SELECT status, error FROM whatsapp_messages WHERE wamid = $1', ['wamid.out'])).toEqual({
      status: 'failed',
      error: { code: 131026, title: 'Message undeliverable', message: null },
    });

    await post(textMsg(PN_A, '972541111111', 'wamid.in', 'hi'));
    await post(status(PN_A, 'wamid.in', 'read'));
    expect(await one('SELECT direction, status FROM whatsapp_messages WHERE wamid = $1', ['wamid.in'])).toEqual({ direction: 'in', status: 'received' });
  });

  it('the sweep re-drives a stored body whose processing failed', async () => {
    const payload = textMsg(PN_A, '972541111111', 'wamid.redrive', 'later');
    await pool.query(
      "INSERT INTO whatsapp_webhook_inbox (payload, attempts, received_at, last_error) VALUES ($1::jsonb, 1, now() - interval '5 minutes', 'db down')",
      [JSON.stringify(payload)],
    );
    expect(await sweepWhatsAppInbox(pool)).toBeGreaterThanOrEqual(1);
    expect(await count("SELECT count(*) n FROM whatsapp_messages WHERE wamid = 'wamid.redrive'", [])).toBe(1);
    expect(await count("SELECT count(*) n FROM whatsapp_webhook_inbox WHERE payload::text LIKE '%wamid.redrive%' AND processed_at IS NOT NULL", [])).toBe(1);
  });

  it('copies inbound media into private storage; a failed download is counted, not lost', async () => {
    await post(
      change(PN_A, {
        messages: [
          { from: '972541111111', id: 'wamid.img', timestamp: '1760000000', type: 'image', image: { id: 'MEDIA-OK', mime_type: 'image/jpeg', caption: 'receipt' } },
          { from: '972541111111', id: 'wamid.bad', timestamp: '1760000001', type: 'document', document: { id: 'MEDIA-BAD', filename: 'x.pdf' } },
        ],
      }),
    );
    const graph: GraphHttpClient = {
      async request(_m, url) {
        return url.endsWith('/MEDIA-OK')
          ? { status: 200, body: JSON.stringify({ url: 'https://lookaside.test/ok', mime_type: 'image/jpeg' }) }
          : { status: 404, body: JSON.stringify({ error: { message: 'media expired' } }) };
      },
    };
    const mediaHttp: BinaryHttpClient = { async get() { return { status: 200, body: Buffer.from('JPEG'), contentType: 'image/jpeg' }; } };
    const deps = { ...makeLocalDeps(pool), graphHttp: graph, mediaHttp };

    expect(await sweepWhatsAppMedia(pool, deps)).toBe(1);
    const img = await one<{ id: string; media: Record<string, unknown> }>("SELECT id, media FROM whatsapp_messages WHERE wamid = 'wamid.img'", []);
    expect(img!.media).toMatchObject({ media_id: 'MEDIA-OK', stored: true });
    const stored = await one<{ storage: string; mime_type: string; data: Buffer }>('SELECT storage, mime_type, data FROM whatsapp_media WHERE message_id = $1', [img!.id]);
    expect(stored).toEqual({ storage: 'db', mime_type: 'image/jpeg', data: Buffer.from('JPEG') });
    const bad = await one<{ media: Record<string, unknown> }>("SELECT media FROM whatsapp_messages WHERE wamid = 'wamid.bad'", []);
    expect(bad!.media).toMatchObject({ attempts: 1, error: expect.stringContaining('media expired') });
    expect(bad!.media.stored).toBeUndefined();
  });

  it('deleting the profile erases its conversation, messages and media', async () => {
    await post(textMsg(PN_A, '972541111111', 'wamid.gdpr', 'forget me'));
    const p = await one<{ id: string }>('SELECT id FROM profiles WHERE workspace_id = $1', [WS_A]);
    const env = { pool, lookups: makePgLookups(pool), deps: makeLocalDeps(pool) };
    const r = await dispatch({ method: 'DELETE', path: `/profiles/${p!.id}`, authorization: tokenFor(OWNER, WS_A), query: {}, body: {} }, env);
    expect(r.status).toBe(200);
    expect(await count('SELECT count(*) n FROM whatsapp_messages WHERE workspace_id = $1', [WS_A])).toBe(0);
    expect(await count('SELECT count(*) n FROM whatsapp_conversations WHERE workspace_id = $1', [WS_A])).toBe(0);
  });
});
