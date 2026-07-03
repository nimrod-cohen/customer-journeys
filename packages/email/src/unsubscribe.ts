// One-click List-Unsubscribe header builders (§9 step 5, §10).
//
// Links are TOKENIZED + UNGUESSABLE (security): a stateless HMAC-SHA256 over the
// (workspace_id, lower(email)) pair signed with a server-only secret
// (UNSUBSCRIBE_LINK_SECRET). The recipient's own email is still in the URL (it's
// theirs), but the token makes it impossible to FORGE a link for someone else's
// email without the secret. The dispatcher SIGNS (it appends the token to both
// the body {{unsubscribe}} link and the List-Unsubscribe header); the
// unsubscribe / manage-subscription handlers VERIFY (a missing/invalid token →
// 403). The SAME secret must be used on both sides (injected through deps).
import { createHmac, timingSafeEqual } from 'node:crypto';

// RFC 8058 one-click unsubscribe requires BOTH:
//   - `List-Unsubscribe: <https://.../unsubscribe?...>` (a URL the MUA can POST to)
//   - `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
// The unsubscribe URL is workspace-scoped so unsubscribing from Company A never
// affects Company B (§10) — the workspace id is carried in the link and the
// Unsubscribe Lambda writes `suppressions (workspace_id, email, 'unsubscribe')`.

/** Inputs for a workspace-scoped one-click unsubscribe link. */
export interface UnsubscribeLinkParams {
  /** Public base URL of the unsubscribe endpoint, e.g. `https://api.cdp.example/unsubscribe`. */
  readonly baseUrl: string;
  /** The sending workspace — scopes the suppression (never cross-tenant). */
  readonly workspaceId: string;
  /** The recipient email being given the opt-out. */
  readonly email: string;
  /**
   * The HMAC link secret. When provided, the URL carries the NEW compact
   * self-contained `t` token (`packSubscriptionToken(secret, ws, email)`). When
   * omitted, the URL falls back to the LEGACY `workspace_id`+`email`+`token`
   * triple (back-compat for callers that only have a precomputed `token`).
   */
  readonly secret?: string;
  /** Optional legacy signed HMAC token (only used when `secret` is not supplied). */
  readonly token?: string;
  /** Optional source broadcast — attributes the unsubscribe to the send (funnel). */
  readonly broadcastId?: string | null;
  /** Optional source campaign — attributes the unsubscribe to the send (funnel). */
  readonly campaignId?: string | null;
}

/** The header name/value pairs to attach to an outgoing message. */
export interface ListUnsubscribeHeaders {
  readonly 'List-Unsubscribe': string;
  readonly 'List-Unsubscribe-Post': string;
}

/**
 * Build the workspace-scoped unsubscribe URL.
 *
 * As of v0.60.0 the whole recipient identity travels inside ONE compact,
 * self-contained, signed `t` token (`packSubscriptionToken` over workspace_id +
 * email) — `…/manage-subscription?t=<token>` — instead of the old
 * `?workspace_id=<uuid>&email=<email>&token=<hmac>` triple (the uuid + email were
 * repeated AND a separate hmac was appended). The token both ENCODES the
 * workspace_id + email AND is tamper-proof (a truncated HMAC). The optional
 * per-send attribution ids stay as SEPARATE short params (`&b=` / `&c=`) — they
 * only feed the funnel metric and are NOT trust-sensitive.
 *
 * The function needs the signing `secret` to build `t`. For backward
 * compatibility a caller MAY still pass a precomputed legacy `token` (the old
 * HMAC) — if `secret` is omitted we fall back to emitting the legacy
 * `workspace_id`+`email`+`token` triple so older callers keep working.
 */
export function buildUnsubscribeUrl(params: UnsubscribeLinkParams): string {
  if (!params.workspaceId) {
    throw new Error('buildUnsubscribeUrl: workspaceId is required (tenant-isolation guard)');
  }
  if (!params.baseUrl) {
    throw new Error('buildUnsubscribeUrl: baseUrl is required');
  }
  const url = new URL(params.baseUrl);
  if (params.secret) {
    // NEW: one opaque, self-contained signed token carries ws + email.
    url.searchParams.set('t', packSubscriptionToken(params.secret, params.workspaceId, params.email));
  } else {
    // LEGACY fallback (no secret supplied): emit the old triple.
    url.searchParams.set('workspace_id', params.workspaceId);
    url.searchParams.set('email', params.email);
    if (params.token) url.searchParams.set('token', params.token);
  }
  // Optional per-send attribution: which broadcast/campaign drove this opt-out.
  // Carried as SEPARATE short params (`b`/`c`, not in the token) so the
  // unsubscribe POST can record it (funnel metric).
  if (params.broadcastId) url.searchParams.set('b', params.broadcastId);
  if (params.campaignId) url.searchParams.set('c', params.campaignId);
  return url.toString();
}

/**
 * A FIXED dev/test fallback for the link secret so dev + the test suite are
 * deterministic without an env var. In production UNSUBSCRIBE_LINK_SECRET MUST be
 * set (see CLAUDE.md / .a5c/PROVIDERS-SETUP.md) — a real, random secret. The dev
 * value is intentionally well-known and is NOT a security boundary in prod.
 */
export const DEV_UNSUBSCRIBE_LINK_SECRET = 'dev-unsubscribe-link-secret-do-not-use-in-prod';

/**
 * Resolve the link-signing secret: `process.env.UNSUBSCRIBE_LINK_SECRET` when
 * set, else the fixed dev fallback. Centralized so the dispatcher (signer) and
 * the unsubscribe/manage handlers (verifier) resolve the SAME secret.
 */
export function unsubscribeLinkSecret(): string {
  const env = process.env.UNSUBSCRIBE_LINK_SECRET;
  if (env) return env;
  // Fail-fast in production: a missing secret would silently sign/verify every
  // unsubscribe token with the repo-committed dev constant, letting anyone forge
  // a valid opt-out / preference-center link for any recipient. The dev fallback
  // is only ever acceptable outside production.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('UNSUBSCRIBE_LINK_SECRET must be set in production (refusing the dev fallback).');
  }
  return DEV_UNSUBSCRIBE_LINK_SECRET;
}

/**
 * Sign a stateless unsubscribe token over (workspace_id, lower(email)):
 *   token = base64url(HMAC_SHA256(secret, workspace_id + '\n' + lower(email)))
 * The email is lowercased so the token matches regardless of the casing in the
 * link (the handler lowercases the email too). Deterministic — the same inputs
 * always produce the same token (so a re-sent link verifies).
 */
export function signUnsubscribeToken(secret: string, workspaceId: string, email: string): string {
  if (!secret) throw new Error('signUnsubscribeToken: secret is required');
  if (!workspaceId) throw new Error('signUnsubscribeToken: workspaceId is required');
  const payload = `${workspaceId}\n${(email ?? '').trim().toLowerCase()}`;
  return createHmac('sha256', secret).update(payload, 'utf8').digest('base64url');
}

/**
 * Verify an unsubscribe token in CONSTANT TIME. Recomputes the expected token
 * for (workspace_id, lower(email)) and compares with `timingSafeEqual` (length
 * mismatch → false without leaking via timing). A falsy/garbled token → false.
 * Forging a link for another email/workspace is impossible without the secret.
 */
export function verifyUnsubscribeToken(
  secret: string,
  workspaceId: string,
  email: string,
  token: string | null | undefined,
): boolean {
  if (!secret || !workspaceId || !token) return false;
  const expected = signUnsubscribeToken(secret, workspaceId, email);
  // Compare as bytes; timingSafeEqual throws on a length mismatch, so guard it.
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(token, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ── Compact self-contained subscription token (v0.60.0) ─────────────────────
//
// The whole recipient identity (workspace_id + email) travels inside ONE opaque,
// tamper-proof, base64url `t` param — replacing the old repeated
// `workspace_id=<36-char uuid>&email=<email>&token=<43-char hmac>` querystring.
//
// Wire format (bytes), then base64url-encoded:
//   [ version(1) | uuid(16 raw bytes) | email(utf8 bytes) | MAC(16 bytes) ]
// where MAC = HMAC-SHA256(secret, version|uuid|email) TRUNCATED to 16 bytes.
//
// - The uuid is packed as 16 RAW bytes (not the 36-char string) → ~20 chars saved.
// - The MAC is truncated to 16 bytes (128-bit) — ample to make forgery infeasible.
// - The email is stored VERBATIM (NOT lowercased) — the recipient's EXACT address
//   is what we send to / suppress on; lowercasing would change identity.
// - Deterministic: the same inputs always yield the same token (a re-sent link
//   still verifies). Tamper-proof: any altered byte fails the constant-time MAC
//   compare → unpack returns null (the handler 403s).

const SUBSCRIPTION_TOKEN_VERSION = 1;
const SUBSCRIPTION_MAC_BYTES = 16; // truncated HMAC-SHA256 (128-bit)
const UUID_BYTES = 16;

/** Encode a canonical UUID string (with dashes) to 16 raw bytes. */
function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32 || /[^0-9a-fA-F]/.test(hex)) {
    throw new Error('packSubscriptionToken: workspaceId is not a uuid');
  }
  return Buffer.from(hex, 'hex');
}

/** Decode 16 raw bytes back to a canonical dashed UUID string. */
function bytesToUuid(buf: Buffer): string {
  const h = buf.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function subscriptionMac(secret: string, payload: Buffer): Buffer {
  return createHmac('sha256', secret).update(payload).digest().subarray(0, SUBSCRIPTION_MAC_BYTES);
}

/**
 * Pack (workspace_id, email) into one compact, self-contained, tamper-proof
 * base64url token. See the wire format above. The email is stored verbatim.
 * Throws on a falsy secret/workspaceId or a non-uuid workspaceId (guards).
 */
export function packSubscriptionToken(secret: string, workspaceId: string, email: string): string {
  if (!secret) throw new Error('packSubscriptionToken: secret is required');
  if (!workspaceId) throw new Error('packSubscriptionToken: workspaceId is required');
  const version = Buffer.from([SUBSCRIPTION_TOKEN_VERSION]);
  const uuid = uuidToBytes(workspaceId);
  const emailBytes = Buffer.from(email ?? '', 'utf8');
  const payload = Buffer.concat([version, uuid, emailBytes]);
  const mac = subscriptionMac(secret, payload);
  return Buffer.concat([payload, mac]).toString('base64url');
}

/**
 * Unpack + VERIFY a compact subscription token. Returns the {workspaceId, email}
 * only when the trailing MAC matches (CONSTANT-TIME compare); otherwise null
 * (garbled base64url, too short, bad version, or a tampered byte / wrong secret).
 * Never throws.
 */
export function unpackSubscriptionToken(
  secret: string,
  token: string | null | undefined,
): { workspaceId: string; email: string } | null {
  if (!secret || !token) return null;
  let raw: Buffer;
  try {
    raw = Buffer.from(token, 'base64url');
  } catch {
    return null;
  }
  // Minimum = version(1) + uuid(16) + MAC(16); email may be empty.
  const minLen = 1 + UUID_BYTES + SUBSCRIPTION_MAC_BYTES;
  if (raw.length < minLen) return null;
  const payload = raw.subarray(0, raw.length - SUBSCRIPTION_MAC_BYTES);
  const mac = raw.subarray(raw.length - SUBSCRIPTION_MAC_BYTES);
  const expected = subscriptionMac(secret, payload);
  // Constant-time compare; both are SUBSCRIPTION_MAC_BYTES long.
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return null;
  if (payload[0] !== SUBSCRIPTION_TOKEN_VERSION) return null;
  const workspaceId = bytesToUuid(payload.subarray(1, 1 + UUID_BYTES));
  const email = payload.subarray(1 + UUID_BYTES).toString('utf8');
  return { workspaceId, email };
}

/**
 * Build the RFC 8058 one-click unsubscribe headers for a workspace-scoped send.
 * `List-Unsubscribe` wraps the URL in angle brackets; `List-Unsubscribe-Post`
 * is the fixed `List-Unsubscribe=One-Click` directive.
 */
export function buildListUnsubscribeHeaders(
  params: UnsubscribeLinkParams,
): ListUnsubscribeHeaders {
  const url = buildUnsubscribeUrl(params);
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}
