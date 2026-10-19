// Inbound WhatsApp — what Meta's webhook delivers, turned into conversations,
// messages, profile events and delivery statuses.
//
// Tenancy (inv.2): the workspace is resolved from `metadata.phone_number_id` against
// OUR `workspace_whatsapp_config` — the signature proves Meta sent the body, but which
// workspace it belongs to is still decided by our own table, never by the payload.
// Idempotency (inv.5): Meta redelivers webhooks, so a message insert is
// ON CONFLICT (workspace_id, wamid) DO NOTHING and nothing downstream (event,
// enrollment, unread count) runs for a duplicate. Order-convergence (inv.3): a status
// for an outbound message we have not recorded yet upserts a stub the send fills in.
import type { Pool, PoolClient } from 'pg';
import {
  classifyWhatsAppWebhook,
  downloadWhatsAppMedia,
  normalizePhone,
  type GraphHttpClient,
  type BinaryHttpClient,
  type WhatsAppInboundMessage,
  type WhatsAppStatusUpdate,
} from '@cdp/channels';
import { decryptSecret, isEncryptedSecret } from '@cdp/db';
import { enrollFromEvent, enrollFromProfileChange } from '@cdp/service-automation-runner';
import {
  upsertProfileByIdentity,
  recomputeFeaturesAndSegments,
  enrollDepsOnClient,
  logProfileCreated,
  r2StorageForWorkspace,
} from './handlers.js';
import type { R2StorageFactory } from './storage.js';

/** The behavioral event an inbound message records — what automations trigger on. */
export const WHATSAPP_RECEIVED_EVENT = 'whatsapp_message_received';
/** pg_notify channel the live chat (SSE) listens on. Payload carries ids only. */
export const WHATSAPP_NOTIFY_CHANNEL = 'wa_events';
/** Status order for the monotonic update — must match `statusRank` in @cdp/channels. */
const STATUS_ORDER = ['received', 'pending', 'sent', 'delivered', 'read', 'failed'];

export interface WebhookOutcome {
  messages: number;
  duplicates: number;
  statuses: number;
  /** Changes for a phone number no workspace owns (dropped). */
  unrouted: number;
}

async function inTx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Process one webhook body. Throws on a DB failure (the caller records + retries it). */
export async function processWhatsAppWebhook(pool: Pool, payload: unknown): Promise<WebhookOutcome> {
  const { messages, statuses } = classifyWhatsAppWebhook(payload);
  const out: WebhookOutcome = { messages: 0, duplicates: 0, statuses: 0, unrouted: 0 };
  const workspaces = new Map<string, string | null>();
  const route = async (phoneNumberId: string): Promise<string | null> => {
    if (!workspaces.has(phoneNumberId)) {
      const { rows } = await pool.query<{ workspace_id: string }>(
        'SELECT workspace_id FROM workspace_whatsapp_config WHERE phone_number_id = $1 AND enabled',
        [phoneNumberId],
      );
      workspaces.set(phoneNumberId, rows[0]?.workspace_id ?? null);
    }
    return workspaces.get(phoneNumberId)!;
  };

  for (const m of messages) {
    const ws = await route(m.phoneNumberId);
    if (!ws) {
      out.unrouted++;
      continue;
    }
    if (await recordInboundMessage(pool, ws, m)) out.messages++;
    else out.duplicates++;
  }
  for (const s of statuses) {
    const ws = await route(s.phoneNumberId);
    if (!ws) {
      out.unrouted++;
      continue;
    }
    await applyStatus(pool, ws, s);
    out.statuses++;
  }
  return out;
}

const preview = (m: { type: string; body: string | null }): string =>
  (m.body ?? `[${m.type}]`).replace(/\s+/g, ' ').slice(0, 140);

/** Record one inbound message. Returns false for a duplicate (already stored). */
export async function recordInboundMessage(pool: Pool, ws: string, m: WhatsAppInboundMessage): Promise<boolean> {
  // Meta's sender id IS a live WhatsApp account, so it is authoritative: when the
  // phone library rejects it (new ranges, numbers it considers fictional) we keep
  // Meta's own digits rather than silently dropping a real customer's message.
  const phone = normalizePhone(m.from, null) ?? (/^\+\d{6,15}$/.test(m.from) ? m.from : null);
  if (!phone) return false;
  const at = m.timestamp.getTime() > 0 ? m.timestamp : new Date();

  return inTx(pool, async (client) => {
    const traits = m.contactName ? { whatsapp_name: m.contactName } : {};
    const { id: profileId, created } = await upsertProfileByIdentity(client, ws, { email: null, phone }, traits);

    const conv = await client.query<{ id: string }>(
      `INSERT INTO whatsapp_conversations (workspace_id, profile_id, wa_phone, contact_name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace_id, wa_phone) DO UPDATE SET
         profile_id = EXCLUDED.profile_id,
         contact_name = COALESCE(EXCLUDED.contact_name, whatsapp_conversations.contact_name),
         updated_at = now()
       RETURNING id`,
      [ws, profileId, phone, m.contactName],
    );
    const conversationId = conv.rows[0]!.id;

    const ins = await client.query<{ id: string }>(
      `INSERT INTO whatsapp_messages
         (workspace_id, conversation_id, profile_id, direction, wamid, type, body, media, status, provider_ts, created_at)
       VALUES ($1, $2, $3, 'in', $4, $5, $6, $7::jsonb, 'received', $8, $8)
       ON CONFLICT (workspace_id, wamid) DO NOTHING
       RETURNING id`,
      [
        ws,
        conversationId,
        profileId,
        m.wamid,
        m.type,
        m.body,
        m.media
          ? JSON.stringify({ media_id: m.media.mediaId, mime_type: m.media.mimeType, filename: m.media.filename, sha256: m.media.sha256 })
          : null,
        at,
      ],
    );
    const messageId = ins.rows[0]?.id;
    if (!messageId) return false; // a redelivery — everything below already happened

    await client.query(
      `UPDATE whatsapp_conversations SET
         last_message_at = GREATEST(COALESCE(last_message_at, $3), $3),
         last_inbound_at = GREATEST(COALESCE(last_inbound_at, $3), $3),
         last_message_preview = CASE WHEN last_message_at IS NULL OR $3 >= last_message_at THEN $4 ELSE last_message_preview END,
         unread_count = unread_count + 1,
         archived = false,
         updated_at = now()
       WHERE workspace_id = $1 AND id = $2`,
      [ws, conversationId, at, preview(m)],
    );

    const payload = {
      text: m.body,
      type: m.type,
      wamid: m.wamid,
      conversation_id: conversationId,
      ...(m.replyTo ? { reply_to: m.replyTo } : {}),
    };
    const ev = await client.query<{ event_id: string }>(
      `INSERT INTO events (event_id, workspace_id, profile_id, type, occurred_at, payload)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::jsonb) RETURNING event_id`,
      [ws, profileId, WHATSAPP_RECEIVED_EVENT, at, JSON.stringify(payload)],
    );
    await recomputeFeaturesAndSegments(client, ws, profileId);
    if (created) {
      await logProfileCreated(client, ws, profileId, 'created from an inbound WhatsApp message');
      await enrollFromProfileChange(enrollDepsOnClient(client), { workspace_id: ws, profile_id: profileId, change: 'created' });
    }
    await enrollFromEvent(enrollDepsOnClient(client), {
      workspace_id: ws,
      profile_id: profileId,
      type: WHATSAPP_RECEIVED_EVENT,
      payload,
      event_id: ev.rows[0]!.event_id,
    });
    await notify(client, ws, { kind: 'message', conversation_id: conversationId, message_id: messageId });
    return true;
  });
}

/**
 * Apply a delivery status. The status only ever moves UP (`failed` wins), since
 * Meta does not promise order. An unknown wamid becomes an outbound stub the
 * dispatcher's own insert later fills in. Never touches an INBOUND row.
 */
export async function applyStatus(pool: Pool, ws: string, s: WhatsAppStatusUpdate): Promise<void> {
  await inTx(pool, async (client) => {
    const { rows } = await client.query<{ id: string; conversation_id: string | null }>(
      `INSERT INTO whatsapp_messages (workspace_id, direction, wamid, status, error, provider_ts)
       VALUES ($1, 'out', $2, $3, $4::jsonb, $5)
       ON CONFLICT (workspace_id, wamid) DO UPDATE SET
         status = CASE
           WHEN array_position($6::text[], EXCLUDED.status) > array_position($6::text[], whatsapp_messages.status)
           THEN EXCLUDED.status ELSE whatsapp_messages.status END,
         error = COALESCE(EXCLUDED.error, whatsapp_messages.error),
         updated_at = now()
       WHERE whatsapp_messages.direction = 'out'
       RETURNING id, conversation_id`,
      [ws, s.wamid, s.status, s.error ? JSON.stringify(s.error) : null, s.timestamp.getTime() > 0 ? s.timestamp : null, STATUS_ORDER],
    );
    const r = rows[0];
    if (r?.conversation_id) {
      await notify(client, ws, { kind: 'status', conversation_id: r.conversation_id, message_id: r.id });
    }
  });
}

async function notify(client: PoolClient, ws: string, body: Record<string, string>): Promise<void> {
  // Delivered on COMMIT, so a listener never sees a message the tx then rolled back.
  await client.query('SELECT pg_notify($1, $2)', [WHATSAPP_NOTIFY_CHANNEL, JSON.stringify({ workspace_id: ws, ...body })]);
}

// ── The raw inbox ──────────────────────────────────────────────────────────

/** Store a verified webhook body. Called BEFORE processing so nothing is ever lost. */
export async function storeWebhook(pool: Pool, payload: unknown): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO whatsapp_webhook_inbox (payload, attempts) VALUES ($1::jsonb, 1) RETURNING id',
    [JSON.stringify(payload)],
  );
  return rows[0]!.id;
}

/** Process a stored body and record the outcome on its inbox row. Never throws. */
export async function processInboxRow(pool: Pool, id: string, payload: unknown): Promise<WebhookOutcome | null> {
  try {
    const out = await processWhatsAppWebhook(pool, payload);
    await pool.query('UPDATE whatsapp_webhook_inbox SET processed_at = now(), last_error = NULL WHERE id = $1', [id]);
    return out;
  } catch (e) {
    await pool
      .query('UPDATE whatsapp_webhook_inbox SET last_error = $2 WHERE id = $1', [id, String((e as Error).message ?? e).slice(0, 500)])
      .catch(() => {});
    return null;
  }
}

const MAX_INBOX_ATTEMPTS = 10;

/**
 * Re-drive inbox rows whose processing failed (a DB blip, a deploy mid-request).
 * Claims rows with SKIP LOCKED so concurrent sweepers never double-process, and
 * prunes everything older than 30 days.
 */
export async function sweepWhatsAppInbox(pool: Pool, limit = 50): Promise<number> {
  const { rows } = await pool.query<{ id: string; payload: unknown }>(
    `UPDATE whatsapp_webhook_inbox SET attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM whatsapp_webhook_inbox
         WHERE processed_at IS NULL AND attempts < $1 AND received_at < now() - interval '1 minute'
         ORDER BY received_at LIMIT $2 FOR UPDATE SKIP LOCKED)
      RETURNING id, payload`,
    [MAX_INBOX_ATTEMPTS, limit],
  );
  for (const r of rows) await processInboxRow(pool, r.id, r.payload);
  await pool.query("DELETE FROM whatsapp_webhook_inbox WHERE received_at < now() - interval '30 days'");
  return rows.length;
}

// ── Media ──────────────────────────────────────────────────────────────────

const MAX_MEDIA_ATTEMPTS = 5;

/** The object key for a stored WhatsApp media file. */
export function whatsappMediaKey(workspaceId: string, messageId: string): string {
  return `whatsapp-media/${workspaceId}/${messageId}`;
}

/**
 * Copy pending inbound media from Meta into our storage (the company's R2 bucket,
 * else Postgres). Meta's URLs expire in minutes and the media is gone after ~30
 * days, so this runs every sweep. A failure is counted on the message and given
 * up after a few attempts, recorded in `media.error`.
 */
export async function sweepWhatsAppMedia(
  pool: Pool,
  deps: { graphHttp: GraphHttpClient; mediaHttp?: BinaryHttpClient; makeR2Storage: R2StorageFactory },
  limit = 20,
): Promise<number> {
  const { rows } = await pool.query<{ id: string; workspace_id: string; media: Record<string, unknown> }>(
    `UPDATE whatsapp_messages
        SET media = jsonb_set(media, '{attempts}', to_jsonb(COALESCE((media->>'attempts')::int, 0) + 1)), updated_at = now()
      WHERE id IN (
        SELECT id FROM whatsapp_messages
         WHERE media IS NOT NULL AND media->>'media_id' IS NOT NULL AND media->>'stored' IS NULL
           AND COALESCE((media->>'attempts')::int, 0) < $1
         ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED)
      RETURNING id, workspace_id, media`,
    [MAX_MEDIA_ATTEMPTS, limit],
  );
  let stored = 0;
  for (const r of rows) {
    try {
      const cfg = await pool.query<{ access_token: string; api_version: string | null }>(
        'SELECT access_token, api_version FROM workspace_whatsapp_config WHERE workspace_id = $1',
        [r.workspace_id],
      );
      const c = cfg.rows[0];
      if (!c || !c.access_token) throw new Error('WhatsApp is not connected for this workspace');
      const token = isEncryptedSecret(c.access_token) ? decryptSecret(c.access_token) : c.access_token;
      const { bytes, mimeType } = await downloadWhatsAppMedia(
        { accessToken: token, apiVersion: c.api_version },
        String(r.media.media_id),
        deps.graphHttp,
        deps.mediaHttp,
      );
      const storage = await r2StorageForWorkspace(pool, r.workspace_id, deps.makeR2Storage);
      if (storage) {
        const key = whatsappMediaKey(r.workspace_id, r.id);
        await storage.put(key, bytes, mimeType);
        await pool.query(
          `INSERT INTO whatsapp_media (message_id, workspace_id, mime_type, size_bytes, storage, r2_key)
           VALUES ($1, $2, $3, $4, 'r2', $5) ON CONFLICT (message_id) DO NOTHING`,
          [r.id, r.workspace_id, mimeType, bytes.length, key],
        );
      } else {
        await pool.query(
          `INSERT INTO whatsapp_media (message_id, workspace_id, mime_type, size_bytes, storage, data)
           VALUES ($1, $2, $3, $4, 'db', $5) ON CONFLICT (message_id) DO NOTHING`,
          [r.id, r.workspace_id, mimeType, bytes.length, bytes],
        );
      }
      await pool.query(
        `UPDATE whatsapp_messages SET media = (media - 'error') || '{"stored": true}'::jsonb, updated_at = now()
          WHERE workspace_id = $1 AND id = $2`,
        [r.workspace_id, r.id],
      );
      stored++;
    } catch (e) {
      await pool.query(
        `UPDATE whatsapp_messages SET media = jsonb_set(media, '{error}', to_jsonb($3::text)), updated_at = now()
          WHERE workspace_id = $1 AND id = $2`,
        [r.workspace_id, r.id, String((e as Error).message ?? e).slice(0, 300)],
      );
    }
  }
  return stored;
}
