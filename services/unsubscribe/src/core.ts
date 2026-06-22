// Unsubscribe Lambda pure core (§10). No I/O — the handler injects the
// workspace-scoped tx runner and wires this. Everything here is deterministic
// and unit-tested without AWS or Postgres.
//
// CRITICAL invariant: an unsubscribe is SCOPED to the sending workspace. The
// workspace_id comes from the workspace-scoped link (built by @cdp/email's
// buildUnsubscribeUrl on each send) — unsubscribing from Company A never affects
// Company B. The suppression builder binds workspace_id at $1 and throws on a
// falsy id (service role bypasses RLS → in-code scoping is the guard).

/** A parameterized query ready for `pool.query(text, values)` (shared shape). */
export interface SqlStatement {
  readonly text: string;
  readonly values: unknown[];
}

/** A successfully parsed unsubscribe request. */
export interface ParsedUnsubscribe {
  readonly valid: true;
  /** The sending workspace (from the verified `t` token, or the legacy link). */
  readonly workspaceId: string;
  /** The opting-out recipient (verbatim from the `t` token; lowercased for legacy links). */
  readonly email: string;
  /** Whether this is an RFC 8058 one-click POST confirmation. */
  readonly oneClick: boolean;
  /**
   * The NEW compact self-contained token (`?t=`), already verified+decoded by the
   * parser into `workspaceId`/`email`. When present, the handler does NOT need a
   * separate HMAC check — the token IS the proof. Null on a legacy link.
   */
  readonly compactVerified: boolean;
  /** The legacy signed HMAC token (`?token=`); verified by the handler on the legacy path. */
  readonly token: string | null;
  /** Optional source broadcast (from the link) for per-send attribution. */
  readonly broadcastId: string | null;
  /** Optional source campaign (from the link) for per-send attribution. */
  readonly campaignId: string | null;
}

/** A request that could not be parsed into a workspace-scoped unsubscribe. */
export interface InvalidUnsubscribe {
  readonly valid: false;
  readonly reason: string;
  /**
   * True when a compact `?t=` token was PRESENT but failed to decode/verify (a
   * forged/tampered link) — the handler maps this to 403 (vs 400 for a link that
   * carried no identity at all).
   */
  readonly tokenInvalid?: boolean;
}

export type UnsubscribeRequest = ParsedUnsubscribe | InvalidUnsubscribe;

/**
 * Resolve the recipient identity (workspace + email) from a request URL.
 *
 * NEW (v0.60.0): a single compact, self-contained, tamper-proof `t` token
 * (`packSubscriptionToken`) — the parser is given an unpack closure (it carries
 * the secret) and tries `t` FIRST. When `t` decodes, the email is VERBATIM (the
 * exact address we send to / suppress on) and the token IS the forgery proof
 * (`compactVerified=true`, no separate HMAC needed).
 *
 * LEGACY (back-compat for already-sent links): falls back to
 * `workspace_id`+`email`+`token` (the email is lowercased; the handler verifies
 * the HMAC `token` separately).
 *
 * RFC 8058: a POST whose body is `List-Unsubscribe=One-Click` is the mail
 * client's one-click confirmation; surfaced as `oneClick`.
 */
export function parseUnsubscribeRequest(
  method: string,
  url: string,
  body: string | null | undefined,
  unpackToken?: (t: string) => { workspaceId: string; email: string } | null,
): UnsubscribeRequest {
  let parsed: URL;
  try {
    // Tolerate a path-only url by giving it a dummy base.
    parsed = new URL(url, 'https://unsubscribe.local');
  } catch {
    return { valid: false, reason: 'malformed url' };
  }

  const oneClick =
    method.toUpperCase() === 'POST' &&
    typeof body === 'string' &&
    /(^|[&\s])List-Unsubscribe=One-Click([&\s]|$)/i.test(body.trim());

  // Optional per-send attribution (the dispatcher puts these on the link). They
  // are NOT trust-sensitive: they only feed the funnel metric, and the
  // suppression/profile writes stay scoped to the verified workspace_id. Accept
  // BOTH the new short `b`/`c` and the legacy `broadcast_id`/`campaign_id`.
  const broadcastId =
    parsed.searchParams.get('b') || parsed.searchParams.get('broadcast_id') || null;
  const campaignId =
    parsed.searchParams.get('c') || parsed.searchParams.get('campaign_id') || null;

  // NEW: the compact self-contained token. When present + it decodes, it IS the
  // identity + the forgery proof.
  const t = parsed.searchParams.get('t');
  if (t) {
    const decoded = unpackToken ? unpackToken(t) : null;
    if (!decoded || !decoded.workspaceId || !decoded.email) {
      // A `t` was present but didn't verify → forged/tampered → 403 (not 400).
      return { valid: false, reason: 'invalid token', tokenInvalid: true };
    }
    return {
      valid: true,
      workspaceId: decoded.workspaceId,
      email: decoded.email,
      oneClick,
      compactVerified: true,
      token: null,
      broadcastId,
      campaignId,
    };
  }

  // LEGACY path — the old workspace_id + email + token triple.
  const workspaceId = parsed.searchParams.get('workspace_id');
  const emailRaw = parsed.searchParams.get('email');
  if (!workspaceId) return { valid: false, reason: 'missing workspace_id' };
  if (!emailRaw) return { valid: false, reason: 'missing email' };

  const email = emailRaw.trim().toLowerCase();
  if (!email) return { valid: false, reason: 'empty email' };

  // The signed token (proves the link wasn't forged). The handler verifies it
  // against (workspace_id, email) with the shared secret before any write.
  const token = parsed.searchParams.get('token') || null;

  return { valid: true, workspaceId, email, oneClick, compactVerified: false, token, broadcastId, campaignId };
}

/**
 * Build the per-workspace unsubscribe suppression (reason='unsubscribe').
 * Scoped: ON CONFLICT (workspace_id, email) DO NOTHING keeps it idempotent and
 * never touches another workspace. workspace_id bound at $1; throws on a falsy
 * workspaceId (the central tenancy guard).
 */
export function buildUnsubscribeSuppression(
  workspaceId: string,
  email: string,
  source: string | null = 'one-click',
): SqlStatement {
  if (!workspaceId) {
    throw new Error('buildUnsubscribeSuppression: workspaceId is required (tenant-isolation guard)');
  }
  return {
    text: `INSERT INTO suppressions (workspace_id, email, reason, source)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (workspace_id, email) DO NOTHING`,
    values: [workspaceId, email, 'unsubscribe', source],
  };
}

/**
 * Flag the unsubscribed profile(s) so segments can target it: set the boolean
 * attribute `unsubscribed = true` on every profile with this email in the
 * workspace. The suppression list remains the authoritative SEND gate (§10); this
 * attribute exists purely so marketers can build "unsubscribed = true/false"
 * audiences. Workspace-scoped (workspace_id at $1); idempotent (jsonb merge);
 * throws on a falsy workspaceId (the central tenancy guard).
 */
export function buildUnsubscribedAttribute(workspaceId: string, email: string): SqlStatement {
  if (!workspaceId) {
    throw new Error('buildUnsubscribedAttribute: workspaceId is required (tenant-isolation guard)');
  }
  return {
    text: `UPDATE profiles
           SET attributes = attributes || '{"unsubscribed": true}'::jsonb, updated_at = now()
           WHERE workspace_id = $1 AND email = $2`,
    values: [workspaceId, email],
  };
}

/**
 * Record the opt-out as an `email_events` row (type='unsubscribe') attributed to
 * the SOURCE broadcast/campaign (from the link) + the recipient's profile, so the
 * broadcasts funnel can count unsubscribes per send. Returns NULL when there is
 * no source send to attribute (a generic List-Unsubscribe header click with no
 * broadcast/campaign id) — the suppression + profile flag still happen; there is
 * just nothing to attribute. Workspace-scoped (workspace_id at $1); the
 * ses_message_id stays NULL (NULLs are distinct → never collides with the
 * (workspace_id, ses_message_id, type) idempotency index). Throws on a falsy
 * workspaceId (the central tenancy guard).
 */
export function buildUnsubscribeEvent(
  workspaceId: string,
  email: string,
  broadcastId: string | null,
  campaignId: string | null,
): SqlStatement | null {
  if (!workspaceId) {
    throw new Error('buildUnsubscribeEvent: workspaceId is required (tenant-isolation guard)');
  }
  if (!broadcastId && !campaignId) return null;
  return {
    text: `INSERT INTO email_events (workspace_id, profile_id, broadcast_id, campaign_id, type)
           VALUES ($1, (SELECT id FROM profiles WHERE workspace_id = $1 AND email = $2 LIMIT 1),
                   $3, $4, 'unsubscribe')`,
    values: [workspaceId, email, broadcastId, campaignId],
  };
}

/**
 * Record the opt-out in the workspace Activity log (so the Activity screen shows
 * it). Workspace-scoped; links the row to the recipient's profile when one exists
 * (else profile_id stays NULL). Throws on a falsy workspaceId (tenancy guard).
 */
export function buildUnsubscribeActivity(workspaceId: string, email: string): SqlStatement {
  if (!workspaceId) {
    throw new Error('buildUnsubscribeActivity: workspaceId is required (tenant-isolation guard)');
  }
  return {
    text: `INSERT INTO activity_log (workspace_id, profile_id, source, type, outcome, detail)
           VALUES ($1, (SELECT id FROM profiles WHERE workspace_id = $1 AND email = $2 LIMIT 1),
                   'unsubscribe', 'unsubscribe', 'info', 'via email link')`,
    values: [workspaceId, email],
  };
}
