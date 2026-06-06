// One-click List-Unsubscribe header builders (§9 step 5, §10).
//
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
  return url.toString();
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
