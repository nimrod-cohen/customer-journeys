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
  /** Optional signed token proving the link wasn't forged. */
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
 * Build the workspace-scoped unsubscribe URL. `workspace_id` and `email` are
 * always URL-encoded; an optional `token` is appended when provided.
 */
export function buildUnsubscribeUrl(params: UnsubscribeLinkParams): string {
  if (!params.workspaceId) {
    throw new Error('buildUnsubscribeUrl: workspaceId is required (tenant-isolation guard)');
  }
  if (!params.baseUrl) {
    throw new Error('buildUnsubscribeUrl: baseUrl is required');
  }
  const url = new URL(params.baseUrl);
  url.searchParams.set('workspace_id', params.workspaceId);
  url.searchParams.set('email', params.email);
  if (params.token) url.searchParams.set('token', params.token);
  // Optional per-send attribution: which broadcast/campaign drove this opt-out.
  // Carried in the link so the unsubscribe POST can record it (funnel metric).
  if (params.broadcastId) url.searchParams.set('broadcast_id', params.broadcastId);
  if (params.campaignId) url.searchParams.set('campaign_id', params.campaignId);
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
  return process.env.UNSUBSCRIBE_LINK_SECRET || DEV_UNSUBSCRIBE_LINK_SECRET;
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
