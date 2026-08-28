// VERP (Variable Envelope Return Path) bounce tokens.
//
// Every outgoing message gets a UNIQUE envelope sender:
//
//     bounce+<token>@bounce.<mail-domain>
//
// so an asynchronous bounce arriving hours later can be attributed to the exact
// message that caused it, instead of guessing from the recipient address.
//
// The token is HMAC-SIGNED for the same reason unsubscribe links are: an
// unsigned, guessable bounce address would let anyone mail us a forged bounce
// and suppress an arbitrary recipient. A signed token means a forger can only
// "bounce" a message they actually received.
//
// Wire format (bytes), then base64url:
//
//     [ version(1) | message_uuid(16 RAW bytes) | HMAC-SHA256 truncated to 12 ]
//
// = 29 bytes => 40 base64url chars. With the `bounce+` prefix the local part is
// 47 chars, comfortably inside RFC 5321's 64-octet limit — which is why the
// workspace id is NOT packed in as well.
//
// The workspace is resolved by looking the message id up in `messages_log`,
// NOT taken from the token. That is deliberate and stricter: tenancy comes from
// our own database rather than from anything that travelled over the wire
// (invariant 2), and a bounce for an unknown message is simply ignored.
import { createHmac, timingSafeEqual } from 'node:crypto';

// Domain separation. The VERP token shares UNSUBSCRIBE_LINK_SECRET with the
// subscription token, so the two MACs are bound to distinct labels: a signature
// minted for one purpose can never validate for the other. They happen to differ
// in length today, but relying on a length check for key separation is the kind
// of accident that stops being true after one refactor.
const VERP_MAC_LABEL = 'cdp-verp-bounce-v1';
const VERP_TOKEN_VERSION = 1;
const VERP_MAC_BYTES = 12;
const UUID_BYTES = 16;

/** Local part prefix; Postfix strips `+<token>` via `recipient_delimiter = +`. */
export const VERP_LOCAL_PART = 'bounce';

function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32 || /[^0-9a-fA-F]/.test(hex)) {
    throw new Error('packVerpToken: messageId is not a uuid');
  }
  return Buffer.from(hex, 'hex');
}

function bytesToUuid(buf: Buffer): string {
  const h = buf.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function verpMac(secret: string, payload: Buffer): Buffer {
  return createHmac('sha256', secret)
    .update(VERP_MAC_LABEL)
    .update(payload)
    .digest()
    .subarray(0, VERP_MAC_BYTES);
}

/**
 * Pack a message id into a compact, tamper-proof bounce token.
 * Deterministic: the same message always yields the same token, so a resend
 * reuses it and duplicate bounce reports collapse onto one message.
 */
export function packVerpToken(secret: string, messageId: string): string {
  if (!secret) throw new Error('packVerpToken: secret is required');
  if (!messageId) throw new Error('packVerpToken: messageId is required');
  const payload = Buffer.concat([Buffer.from([VERP_TOKEN_VERSION]), uuidToBytes(messageId)]);
  return Buffer.concat([payload, verpMac(secret, payload)]).toString('base64url');
}

/**
 * Unpack + VERIFY a bounce token. Returns the message id only when the trailing
 * MAC matches (constant-time compare); otherwise null — garbled base64url, wrong
 * length, bad version, tampered byte, or wrong secret. NEVER throws: a malformed
 * bounce address must not be able to crash the ingestion path.
 */
export function unpackVerpToken(secret: string, token: string | null | undefined): string | null {
  if (!secret || !token) return null;
  let raw: Buffer;
  try {
    raw = Buffer.from(token, 'base64url');
  } catch {
    return null;
  }
  if (raw.length !== 1 + UUID_BYTES + VERP_MAC_BYTES) return null;
  if (raw[0] !== VERP_TOKEN_VERSION) return null;

  const payload = raw.subarray(0, 1 + UUID_BYTES);
  const mac = raw.subarray(1 + UUID_BYTES);
  const expected = verpMac(secret, payload);
  if (mac.length !== expected.length) return null;
  if (!timingSafeEqual(mac, expected)) return null;

  return bytesToUuid(payload.subarray(1));
}

/**
 * Build the full envelope sender for a message. This is the `MAIL FROM` /
 * `Return-Path`, never the visible `From:` header — the recipient still sees the
 * sending company's own address.
 */
export function verpReturnPath(bounceDomain: string, secret: string, messageId: string): string {
  const domain = (bounceDomain ?? '').trim().replace(/^@/, '');
  if (!domain) throw new Error('verpReturnPath: bounceDomain is required');
  return `${VERP_LOCAL_PART}+${packVerpToken(secret, messageId)}@${domain}`;
}

/**
 * Pull the token back out of a delivered bounce's recipient address, e.g.
 * `bounce+AbC123@bounce.example.com` -> `AbC123`. Accepts an optional display
 * form (`<addr>`), any case in the local part, and returns null for anything
 * that is not one of our VERP addresses.
 */
export function parseVerpRecipient(recipient: string | null | undefined): string | null {
  if (!recipient) return null;
  const addr = recipient.trim().replace(/^</, '').replace(/>$/, '');
  const at = addr.lastIndexOf('@');
  if (at <= 0) return null;
  const local = addr.slice(0, at);
  const plus = local.indexOf('+');
  if (plus <= 0) return null;
  if (local.slice(0, plus).toLowerCase() !== VERP_LOCAL_PART) return null;
  const token = local.slice(plus + 1);
  return token.length > 0 ? token : null;
}
