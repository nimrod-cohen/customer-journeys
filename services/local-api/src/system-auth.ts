// System-auth flows: one-time invite / password-reset tokens + the transactional
// emails that carry them. Tokens are random, stored HASHED (raw only in the email
// link), single-use, and expiring. The mailer + app base URL come from LocalApiDeps
// (Resend in prod, a deterministic mock in dev/tests).
import { randomBytes, createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { buildInviteEmail, buildPasswordResetEmail, type TransactionalMailer } from '@cdp/email';

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

export type TokenPurpose = 'invite' | 'reset';

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Mint a token for `userId`, store its HASH, and return the RAW token (for the link). */
export async function createAuthToken(
  pool: Pool,
  userId: string,
  purpose: TokenPurpose,
  ttlMs: number,
): Promise<string> {
  const raw = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  await pool.query(
    'INSERT INTO user_auth_tokens (token_hash, user_id, purpose, expires_at) VALUES ($1, $2, $3, $4)',
    [hashToken(raw), userId, purpose, expiresAt],
  );
  return raw;
}

/**
 * Consume a token: atomically mark it used and return its `user_id` — but only if it
 * is unused, unexpired, and of the expected purpose. Returns null otherwise (invalid,
 * expired, already used). The UPDATE…WHERE…RETURNING makes it single-use even under
 * concurrent requests.
 */
export async function consumeAuthToken(
  pool: Pool,
  raw: string,
  purpose: TokenPurpose,
): Promise<string | null> {
  if (!raw) return null;
  const r = await pool.query<{ user_id: string }>(
    `UPDATE user_auth_tokens SET used_at = now()
      WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
      RETURNING user_id`,
    [hashToken(raw), purpose],
  );
  return r.rows[0]?.user_id ?? null;
}

/** Build the SPA link (hash route) that carries a token — no server route needed. */
export function inviteLink(appBaseUrl: string, token: string): string {
  return `${appBaseUrl}/#/accept-invite?token=${encodeURIComponent(token)}`;
}
export function resetLink(appBaseUrl: string, token: string): string {
  return `${appBaseUrl}/#/reset-password?token=${encodeURIComponent(token)}`;
}

/** Mint an invite token and email it. */
export async function sendInvite(
  deps: { mailer: TransactionalMailer; appBaseUrl: string; pool: Pool },
  opts: { userId: string; email: string; companyName: string; inviterName?: string | null },
): Promise<void> {
  const token = await createAuthToken(deps.pool, opts.userId, 'invite', INVITE_TTL_MS);
  const email = buildInviteEmail({
    companyName: opts.companyName,
    acceptUrl: inviteLink(deps.appBaseUrl, token),
    inviterName: opts.inviterName ?? null,
  });
  await deps.mailer.send({ to: opts.email, subject: email.subject, html: email.html, text: email.text });
}

/** Mint a reset token and email it. */
export async function sendPasswordReset(
  deps: { mailer: TransactionalMailer; appBaseUrl: string; pool: Pool },
  opts: { userId: string; email: string },
): Promise<void> {
  const token = await createAuthToken(deps.pool, opts.userId, 'reset', RESET_TTL_MS);
  const email = buildPasswordResetEmail({ resetUrl: resetLink(deps.appBaseUrl, token) });
  await deps.mailer.send({ to: opts.email, subject: email.subject, html: email.html, text: email.text });
}
