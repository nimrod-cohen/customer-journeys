// The WhatsApp INBOX API — conversations, threads, and replying from the chat.
// Every query is scoped to ctx.workspaceId (inv.1/2); a foreign id is a 404.
//
// Replying follows Meta's rule: free-form text only inside the 24h customer-service
// window (24h after the person's last message); outside it, an approved template.
// Consent (decided 2026-10-19): while the window is OPEN the reply goes through even
// to someone opted out of marketing — they messaged us. With it closed, the
// `sms_whatsapp` opt-out blocks the send like any other.
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { normalizePhone, resolveChannelProvider } from '@cdp/channels';
import {
  channelConfigForWorkspace,
  buildWhatsAppOutboundRecord,
  buildMessagesLogInsert,
  buildUsageCounterIncrement,
} from '@cdp/service-dispatcher';
import type { Handler, HandlerResponse } from './handlers.js';
import type { LocalApiDeps } from './deps.js';

const ok = (body: unknown, status = 200): HandlerResponse => ({ status, body });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WINDOW_MS = 24 * 60 * 60 * 1000;
/** Meta's limit for a text message body. */
export const MAX_TEXT_LENGTH = 4096;

const pageSize = (raw: string | undefined, dflt: number, max: number): number => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : dflt;
};
const isoOrNull = (raw: string | undefined): string | null => (raw && !Number.isNaN(Date.parse(raw)) ? raw : null);

/** Is Meta's customer-service window open, given the person's last inbound message? Pure. */
export function windowState(lastInboundAt: Date | null, now: Date = new Date()): { open: boolean; closesAt: Date | null } {
  if (!lastInboundAt) return { open: false, closesAt: null };
  const closesAt = new Date(lastInboundAt.getTime() + WINDOW_MS);
  return { open: closesAt.getTime() > now.getTime(), closesAt };
}

const CONVERSATION_COLUMNS = `
  c.id, c.profile_id, c.wa_phone, c.contact_name, c.last_message_at, c.last_inbound_at,
  c.last_message_preview, c.unread_count, c.archived,
  p.email AS profile_email,
  p.attributes->>'first_name' AS first_name,
  p.attributes->>'last_name' AS last_name`;

interface ConversationRow {
  id: string;
  profile_id: string | null;
  wa_phone: string;
  contact_name: string | null;
  last_message_at: Date | null;
  last_inbound_at: Date | null;
  last_message_preview: string | null;
  unread_count: number;
  archived: boolean;
  profile_email: string | null;
  first_name: string | null;
  last_name: string | null;
}

function presentConversation(r: ConversationRow) {
  const w = windowState(r.last_inbound_at);
  const fullName = [r.first_name, r.last_name].filter(Boolean).join(' ');
  return {
    id: r.id,
    profile_id: r.profile_id,
    wa_phone: r.wa_phone,
    display_name: fullName || r.contact_name || r.profile_email || r.wa_phone,
    contact_name: r.contact_name,
    profile_email: r.profile_email,
    last_message_at: r.last_message_at,
    last_inbound_at: r.last_inbound_at,
    last_message_preview: r.last_message_preview,
    unread_count: r.unread_count,
    archived: r.archived,
    window_open: w.open,
    window_closes_at: w.closesAt,
  };
}

async function loadConversation(pool: Pool, ws: string, id: string): Promise<ConversationRow | null> {
  if (!UUID_RE.test(id)) return null;
  const { rows } = await pool.query<ConversationRow>(
    `SELECT ${CONVERSATION_COLUMNS}
       FROM whatsapp_conversations c LEFT JOIN profiles p ON p.id = c.profile_id AND p.workspace_id = c.workspace_id
      WHERE c.workspace_id = $1 AND c.id = $2`,
    [ws, id],
  );
  return rows[0] ?? null;
}

/** GET /whatsapp/conversations?q=&before=&limit= — the inbox list, most recent first. */
export const listWhatsappConversations: Handler = async (ctx, pool, req) => {
  const q = (req.query.q ?? '').trim();
  const before = isoOrNull(req.query.before);
  const limit = pageSize(req.query.limit, 50, 100);
  const values: unknown[] = [ctx.workspaceId];
  const where = ['c.workspace_id = $1', 'c.last_message_at IS NOT NULL'];
  if (q) {
    values.push(`%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    const i = values.length;
    where.push(
      `(c.contact_name ILIKE $${i} OR c.wa_phone ILIKE $${i} OR p.email ILIKE $${i}
        OR (p.attributes->>'first_name' || ' ' || COALESCE(p.attributes->>'last_name', '')) ILIKE $${i})`,
    );
  }
  if (before) {
    values.push(before);
    where.push(`c.last_message_at < $${values.length}`);
  }
  values.push(limit + 1);
  const { rows } = await pool.query<ConversationRow>(
    `SELECT ${CONVERSATION_COLUMNS}
       FROM whatsapp_conversations c LEFT JOIN profiles p ON p.id = c.profile_id AND p.workspace_id = c.workspace_id
      WHERE ${where.join(' AND ')}
      ORDER BY c.last_message_at DESC, c.id DESC
      LIMIT $${values.length}`,
    values,
  );
  return ok({ conversations: rows.slice(0, limit).map(presentConversation), has_more: rows.length > limit });
};

/** GET /whatsapp/conversations/:id */
export const getWhatsappConversation: Handler = async (ctx, pool, req) => {
  const c = await loadConversation(pool, ctx.workspaceId, req.params.id!);
  return c ? ok({ conversation: presentConversation(c) }) : ok({ error: 'not found' }, 404);
};

/** GET /whatsapp/unread — total unread conversations, for the nav badge. */
export const getWhatsappUnread: Handler = async (ctx, pool) => {
  const { rows } = await pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM whatsapp_conversations WHERE workspace_id = $1 AND unread_count > 0 AND NOT archived',
    [ctx.workspaceId],
  );
  return ok({ conversations: rows[0]!.n });
};

/** GET /whatsapp/conversations/:id/messages?before=&limit= — newest first, paged backwards. */
export const listWhatsappMessages: Handler = async (ctx, pool, req) => {
  const c = await loadConversation(pool, ctx.workspaceId, req.params.id!);
  if (!c) return ok({ error: 'not found' }, 404);
  const before = isoOrNull(req.query.before);
  const limit = pageSize(req.query.limit, 50, 200);
  const values: unknown[] = [ctx.workspaceId, c.id];
  let cursor = '';
  if (before) {
    values.push(before);
    cursor = `AND m.created_at < $${values.length}`;
  }
  values.push(limit + 1);
  const { rows } = await pool.query(
    `SELECT m.id, m.direction, m.wamid, m.type, m.body, m.media, m.template, m.status, m.error,
            m.broadcast_id, b.name AS broadcast_name, m.automation_id, a.name AS automation_name,
            m.sent_by_user_id, u.name AS sent_by_name, u.email AS sent_by_email, m.created_at
       FROM whatsapp_messages m
       LEFT JOIN broadcasts b ON b.id = m.broadcast_id AND b.workspace_id = m.workspace_id
       LEFT JOIN automations a ON a.id = m.automation_id AND a.workspace_id = m.workspace_id
       LEFT JOIN users u ON u.id = m.sent_by_user_id
      WHERE m.workspace_id = $1 AND m.conversation_id = $2 ${cursor}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT $${values.length}`,
    values,
  );
  const messages = rows.slice(0, limit).map((r) => {
    const media = r.media as Record<string, unknown> | null;
    return {
      ...r,
      // Never ship Meta's media id to the browser: media is served by OUR id.
      media: media
        ? {
            mime_type: media.mime_type ?? null,
            filename: media.filename ?? null,
            stored: media.stored === true,
            failed: media.stored !== true && Number(media.attempts ?? 0) >= 5,
          }
        : null,
    };
  });
  return ok({ messages, has_more: rows.length > limit });
};

/** POST /whatsapp/conversations/:id/read — clear the unread count. */
export const markWhatsappConversationRead: Handler = async (ctx, pool, req) => {
  if (!UUID_RE.test(req.params.id!)) return ok({ error: 'not found' }, 404);
  const { rowCount } = await pool.query(
    'UPDATE whatsapp_conversations SET unread_count = 0, updated_at = now() WHERE workspace_id = $1 AND id = $2',
    [ctx.workspaceId, req.params.id],
  );
  return rowCount ? ok({ ok: true }) : ok({ error: 'not found' }, 404);
};

/** GET /profiles/:id/whatsapp — the profile's conversation (or none yet) + its phone. */
export const getProfileWhatsapp: Handler = async (ctx, pool, req) => {
  const id = req.params.id!;
  if (!UUID_RE.test(id)) return ok({ error: 'not found' }, 404);
  const p = await pool.query<{ phone: string | null }>('SELECT phone FROM profiles WHERE workspace_id = $1 AND id = $2', [
    ctx.workspaceId,
    id,
  ]);
  if (!p.rows[0]) return ok({ error: 'not found' }, 404);
  const phone = p.rows[0].phone;
  const { rows } = await pool.query<ConversationRow>(
    `SELECT ${CONVERSATION_COLUMNS}
       FROM whatsapp_conversations c LEFT JOIN profiles p ON p.id = c.profile_id AND p.workspace_id = c.workspace_id
      WHERE c.workspace_id = $1 AND (c.profile_id = $2 OR ($3::text IS NOT NULL AND c.wa_phone = $3))
      ORDER BY (c.profile_id = $2) DESC, c.last_message_at DESC NULLS LAST
      LIMIT 1`,
    [ctx.workspaceId, id, phone],
  );
  return ok({ phone, conversation: rows[0] ? presentConversation(rows[0]) : null });
};

// ── Replying ───────────────────────────────────────────────────────────────

export interface ReplyInput {
  text?: string;
  template?: { name: string; language: string; params: string[] };
}

/** Validate a reply body. Pure. Exactly one of text | template. */
export function parseReply(body: unknown): { ok: true; input: ReplyInput } | { ok: false; error: string } {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const text = typeof b.text === 'string' ? b.text.trim() : '';
  const t = b.template && typeof b.template === 'object' ? (b.template as Record<string, unknown>) : null;
  if (text && t) return { ok: false, error: 'Send either a text or a template, not both.' };
  if (text) {
    if (text.length > MAX_TEXT_LENGTH) return { ok: false, error: `A message can be at most ${MAX_TEXT_LENGTH} characters.` };
    return { ok: true, input: { text } };
  }
  if (t) {
    const name = typeof t.name === 'string' ? t.name.trim() : '';
    const language = typeof t.language === 'string' ? t.language.trim() : '';
    if (!name || !language) return { ok: false, error: 'A template needs a name and a language.' };
    const params = Array.isArray(t.params) ? t.params.map((x) => String(x ?? '')) : [];
    return { ok: true, input: { template: { name, language, params } } };
  }
  return { ok: false, error: 'Type a message or choose a template.' };
}

interface Target {
  profileId: string;
  phone: string;
  lastInboundAt: Date | null;
}

async function sendReply(pool: Pool, deps: LocalApiDeps, ws: string, userId: string | null, target: Target, input: ReplyInput): Promise<HandlerResponse> {
  const cfgRow = await pool.query('SELECT 1 FROM workspace_whatsapp_config WHERE workspace_id = $1 AND enabled', [ws]);
  if (!cfgRow.rowCount) return ok({ error: 'Connect WhatsApp under Workspace settings → WhatsApp first.' }, 409);

  const window = windowState(target.lastInboundAt);
  if (input.text && !window.open) {
    return ok(
      {
        error: "It's been more than 24 hours since this person last wrote, so WhatsApp only allows an approved template.",
        code: 'window_closed',
      },
      409,
    );
  }
  if (!window.open) {
    const opt = await pool.query(
      "SELECT 1 FROM channel_optouts WHERE workspace_id = $1 AND profile_id = $2 AND medium_group = 'sms_whatsapp'",
      [ws, target.profileId],
    );
    if (opt.rowCount) return ok({ error: 'This person opted out of WhatsApp and SMS messages.', code: 'opted_out' }, 409);
  }

  const cfg = await channelConfigForWorkspace(pool, ws, 'whatsapp');
  const provider = resolveChannelProvider('whatsapp', cfg, deps.channelHttp);
  const message = {
    body: input.text ?? '',
    ...(input.template
      ? { template: { name: input.template.name, language: input.template.language, bodyParams: input.template.params } }
      : {}),
  };

  let wamid: string;
  try {
    ({ providerMessageId: wamid } = await provider.send({ to: target.phone, ...message }));
  } catch (e) {
    // Keep the failed attempt in the thread so it can be retried from there.
    const reason = e instanceof Error ? e.message : 'send failed';
    // A failed attempt has no Meta id; a local one keeps the (workspace, wamid) key unique.
    const failedId = `failed:${randomUUID()}`;
    const rec = buildWhatsAppOutboundRecord({ workspaceId: ws, profileId: target.profileId, phone: target.phone, wamid: failedId, message, sentByUserId: userId });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(rec.text, rec.values as unknown[]);
      await client.query(
        `UPDATE whatsapp_messages SET status = 'failed', error = $3::jsonb
          WHERE workspace_id = $1 AND wamid = $2`,
        [ws, failedId, JSON.stringify({ code: null, title: 'Not sent', message: reason })],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    return ok({ error: reason, code: 'send_failed' }, 502);
  }

  const statements = [
    buildMessagesLogInsert(ws, target.profileId, null, wamid, null, 'whatsapp'),
    buildUsageCounterIncrement(ws, new Date(), 'whatsapp_sent'),
    buildWhatsAppOutboundRecord({ workspaceId: ws, profileId: target.profileId, phone: target.phone, wamid, message, sentByUserId: userId }),
  ];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const s of statements) await client.query(s.text, s.values as unknown[]);
    // Replying means it has been read.
    await client.query(
      'UPDATE whatsapp_conversations SET unread_count = 0 WHERE workspace_id = $1 AND wa_phone = $2',
      [ws, target.phone],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  const { rows } = await pool.query<{ id: string; conversation_id: string }>(
    'SELECT id, conversation_id FROM whatsapp_messages WHERE workspace_id = $1 AND wamid = $2',
    [ws, wamid],
  );
  return ok({ sent: true, message_id: rows[0]?.id, conversation_id: rows[0]?.conversation_id }, 201);
}

/** POST /whatsapp/conversations/:id/messages — reply in a conversation. */
export const sendWhatsappConversationMessage: Handler = async (ctx, pool, req, deps) => {
  const c = await loadConversation(pool, ctx.workspaceId, req.params.id!);
  if (!c) return ok({ error: 'not found' }, 404);
  const parsed = parseReply(req.body);
  if (!parsed.ok) return ok({ error: parsed.error }, 400);
  if (!c.profile_id) return ok({ error: 'This conversation has no profile.' }, 409);
  return sendReply(pool, deps, ctx.workspaceId, ctx.userId ?? null, { profileId: c.profile_id, phone: c.wa_phone, lastInboundAt: c.last_inbound_at }, parsed.input);
};

/** POST /profiles/:id/whatsapp/messages — message a profile (starts the conversation if needed). */
export const sendProfileWhatsappMessage: Handler = async (ctx, pool, req, deps) => {
  const id = req.params.id!;
  if (!UUID_RE.test(id)) return ok({ error: 'not found' }, 404);
  const p = await pool.query<{ phone: string | null }>('SELECT phone FROM profiles WHERE workspace_id = $1 AND id = $2', [
    ctx.workspaceId,
    id,
  ]);
  if (!p.rows[0]) return ok({ error: 'not found' }, 404);
  // Stored phones are already E.164; one the phone library rejects may still be a
  // real WhatsApp account (it may have come from Meta itself), so keep it.
  const stored = p.rows[0].phone;
  const phone = stored ? (normalizePhone(stored, null) ?? (/^\+\d{6,15}$/.test(stored) ? stored : null)) : null;
  if (!phone) return ok({ error: 'This profile has no phone number.' }, 409);
  const parsed = parseReply(req.body);
  if (!parsed.ok) return ok({ error: parsed.error }, 400);
  const conv = await pool.query<{ last_inbound_at: Date | null }>(
    'SELECT last_inbound_at FROM whatsapp_conversations WHERE workspace_id = $1 AND wa_phone = $2',
    [ctx.workspaceId, phone],
  );
  return sendReply(pool, deps, ctx.workspaceId, ctx.userId ?? null, { profileId: id, phone, lastInboundAt: conv.rows[0]?.last_inbound_at ?? null }, parsed.input);
};

/** POST /whatsapp/messages/:id/retry — resend a failed reply; the failed row is replaced. */
export const retryWhatsappMessage: Handler = async (ctx, pool, req, deps) => {
  const id = req.params.id!;
  if (!UUID_RE.test(id)) return ok({ error: 'not found' }, 404);
  const { rows } = await pool.query<{ body: string | null; template: ReplyInput['template'] | null; status: string; direction: string; conversation_id: string | null }>(
    'SELECT body, template, status, direction, conversation_id FROM whatsapp_messages WHERE workspace_id = $1 AND id = $2',
    [ctx.workspaceId, id],
  );
  const m = rows[0];
  if (!m || !m.conversation_id) return ok({ error: 'not found' }, 404);
  if (m.direction !== 'out' || m.status !== 'failed') return ok({ error: 'Only a failed message can be retried.' }, 409);
  const c = await loadConversation(pool, ctx.workspaceId, m.conversation_id);
  if (!c || !c.profile_id) return ok({ error: 'not found' }, 404);
  const input: ReplyInput = m.template ? { template: m.template } : { text: m.body ?? '' };
  const res = await sendReply(pool, deps, ctx.workspaceId, ctx.userId ?? null, { profileId: c.profile_id, phone: c.wa_phone, lastInboundAt: c.last_inbound_at }, input);
  // The new attempt replaces the old row whether it was sent or failed again, so a
  // thread never collects a pile of identical failures.
  const code = (res.body as { code?: string }).code;
  if (res.status === 201 || code === 'send_failed') {
    await pool.query('DELETE FROM whatsapp_messages WHERE workspace_id = $1 AND id = $2', [ctx.workspaceId, id]);
  }
  return res;
};
