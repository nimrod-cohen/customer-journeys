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
  /** The sending workspace (from the workspace-scoped link). */
  readonly workspaceId: string;
  /** The opting-out recipient, lowercased. */
  readonly email: string;
  /** Whether this is an RFC 8058 one-click POST confirmation. */
  readonly oneClick: boolean;
}

/** A request that could not be parsed into a workspace-scoped unsubscribe. */
export interface InvalidUnsubscribe {
  readonly valid: false;
  readonly reason: string;
}

export type UnsubscribeRequest = ParsedUnsubscribe | InvalidUnsubscribe;

/**
 * Parse a one-click unsubscribe request. Extracts `workspace_id` + `email` from
 * the workspace-scoped link's query string (the link is built per-send by
 * @cdp/email). RFC 8058: a POST whose body is `List-Unsubscribe=One-Click` is
 * the mail client's one-click confirmation; we surface that as `oneClick`.
 * Both `workspace_id` and `email` are REQUIRED — a request missing either is
 * invalid (never a guessed/default workspace).
 */
export function parseUnsubscribeRequest(
  method: string,
  url: string,
  body: string | null | undefined,
): UnsubscribeRequest {
  let parsed: URL;
  try {
    // Tolerate a path-only url by giving it a dummy base.
    parsed = new URL(url, 'https://unsubscribe.local');
  } catch {
    return { valid: false, reason: 'malformed url' };
  }

  const workspaceId = parsed.searchParams.get('workspace_id');
  const emailRaw = parsed.searchParams.get('email');
  if (!workspaceId) return { valid: false, reason: 'missing workspace_id' };
  if (!emailRaw) return { valid: false, reason: 'missing email' };

  const email = emailRaw.trim().toLowerCase();
  if (!email) return { valid: false, reason: 'empty email' };

  const oneClick =
    method.toUpperCase() === 'POST' &&
    typeof body === 'string' &&
    /(^|[&\s])List-Unsubscribe=One-Click([&\s]|$)/i.test(body.trim());

  return { valid: true, workspaceId, email, oneClick };
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
