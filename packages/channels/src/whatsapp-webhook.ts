// Meta WhatsApp Cloud API WEBHOOKS — pure parsing + signature verification.
//
// Meta POSTs `{object, entry[{id: <WABA>, changes[{field:'messages', value}]}]}`
// where `value` carries `metadata.phone_number_id` (which of OUR numbers it is
// for), plus `messages[]` (inbound) and/or `statuses[]` (delivery receipts for
// what we sent). Everything here is pure and NEVER throws: a webhook body is
// untrusted input, and an unparseable part is dropped rather than failing the
// rest of the batch.

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify `X-Hub-Signature-256: sha256=<hex>` = HMAC-SHA256(appSecret, RAW body).
 * It must be computed over the exact bytes Meta sent — a re-serialized JSON body
 * does not verify. Constant-time compare. An empty secret never verifies.
 */
export function verifyMetaSignature(rawBody: string | Buffer, header: string | undefined | null, appSecret: string): boolean {
  if (!appSecret || !header || !header.startsWith('sha256=')) return false;
  const given = header.slice('sha256='.length);
  if (!/^[0-9a-f]{64}$/i.test(given)) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(given, 'hex'));
}

export interface WhatsAppInboundMedia {
  readonly mediaId: string;
  readonly mimeType: string | null;
  readonly filename: string | null;
  readonly sha256: string | null;
}

export interface WhatsAppInboundMessage {
  /** Which of our numbers received it — the workspace routing key. */
  readonly phoneNumberId: string;
  /** The sender, E.164 (Meta's `wa_id` with a leading +). */
  readonly from: string;
  readonly contactName: string | null;
  readonly wamid: string;
  readonly timestamp: Date;
  readonly type: string;
  /** Text, caption, or a readable summary (location/reply title); null when none. */
  readonly body: string | null;
  readonly media: WhatsAppInboundMedia | null;
  /** The message this one replies or reacts to. */
  readonly replyTo: string | null;
}

export type WhatsAppDeliveryStatus = 'sent' | 'delivered' | 'read' | 'failed';

export interface WhatsAppStatusUpdate {
  readonly phoneNumberId: string;
  readonly wamid: string;
  readonly status: WhatsAppDeliveryStatus;
  readonly timestamp: Date;
  readonly recipient: string | null;
  readonly error: { code: number | null; title: string | null; message: string | null } | null;
}

export interface ClassifiedWhatsAppWebhook {
  readonly messages: WhatsAppInboundMessage[];
  readonly statuses: WhatsAppStatusUpdate[];
}

/** Rank of a message status — a status may only ever move UP. `failed` wins. */
export function statusRank(s: string): number {
  return ['received', 'pending', 'sent', 'delivered', 'read', 'failed'].indexOf(s);
}

const MEDIA_TYPES = ['image', 'video', 'audio', 'document', 'sticker'] as const;
const STATUSES: readonly string[] = ['sent', 'delivered', 'read', 'failed'];

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const e164 = (waId: string | null): string | null => (waId ? (waId.startsWith('+') ? waId : `+${waId}`) : null);
const ts = (v: unknown): Date => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date(0);
};

function summarize(type: string, m: Obj): { body: string | null; media: WhatsAppInboundMedia | null; replyTo: string | null } {
  let replyTo = str(obj(m.context).id);
  if ((MEDIA_TYPES as readonly string[]).includes(type)) {
    const part = obj(m[type]);
    const mediaId = str(part.id);
    return {
      body: str(part.caption),
      media: mediaId
        ? { mediaId, mimeType: str(part.mime_type), filename: str(part.filename), sha256: str(part.sha256) }
        : null,
      replyTo,
    };
  }
  switch (type) {
    case 'text':
      return { body: str(obj(m.text).body), media: null, replyTo };
    case 'location': {
      const l = obj(m.location);
      const label = str(l.name) ?? str(l.address) ?? 'Location';
      const coords = l.latitude !== undefined && l.longitude !== undefined ? ` (${String(l.latitude)}, ${String(l.longitude)})` : '';
      return { body: label + coords, media: null, replyTo };
    }
    case 'reaction': {
      const r = obj(m.reaction);
      replyTo = str(r.message_id) ?? replyTo;
      return { body: str(r.emoji), media: null, replyTo };
    }
    case 'button':
      return { body: str(obj(m.button).text), media: null, replyTo };
    case 'interactive': {
      const i = obj(m.interactive);
      const reply = obj(i.button_reply ?? i.list_reply);
      return { body: str(reply.title), media: null, replyTo };
    }
    case 'contacts':
      return { body: 'Shared a contact', media: null, replyTo };
    default:
      return { body: null, media: null, replyTo };
  }
}

/** Parse a webhook body into inbound messages + status updates. Never throws. */
export function classifyWhatsAppWebhook(payload: unknown): ClassifiedWhatsAppWebhook {
  const messages: WhatsAppInboundMessage[] = [];
  const statuses: WhatsAppStatusUpdate[] = [];
  for (const entry of arr(obj(payload).entry)) {
    for (const change of arr(obj(entry).changes)) {
      const c = obj(change);
      if (c.field !== 'messages') continue;
      const value = obj(c.value);
      const phoneNumberId = str(obj(value.metadata).phone_number_id);
      if (!phoneNumberId) continue; // unroutable

      const names = new Map<string, string>();
      for (const ct of arr(value.contacts)) {
        const waId = str(obj(ct).wa_id);
        const name = str(obj(obj(ct).profile).name);
        if (waId && name) names.set(waId, name);
      }

      for (const raw of arr(value.messages)) {
        const m = obj(raw);
        const wamid = str(m.id);
        const fromId = str(m.from);
        if (!wamid || !fromId) continue;
        const type = str(m.type) ?? 'unsupported';
        messages.push({
          phoneNumberId,
          from: e164(fromId)!,
          contactName: names.get(fromId) ?? null,
          wamid,
          timestamp: ts(m.timestamp),
          type,
          ...summarize(type, m),
        });
      }

      for (const raw of arr(value.statuses)) {
        const s = obj(raw);
        const wamid = str(s.id);
        const status = str(s.status);
        if (!wamid || !status || !STATUSES.includes(status)) continue;
        const err = obj(arr(s.errors)[0]);
        statuses.push({
          phoneNumberId,
          wamid,
          status: status as WhatsAppDeliveryStatus,
          timestamp: ts(s.timestamp),
          recipient: e164(str(s.recipient_id)),
          error:
            Object.keys(err).length > 0
              ? { code: typeof err.code === 'number' ? err.code : null, title: str(err.title), message: str(err.message) }
              : null,
        });
      }
    }
  }
  return { messages, statuses };
}
