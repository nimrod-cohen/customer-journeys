// Unsubscribe Lambda — thin HTTP handler (§10). Backs the workspace-scoped
// List-Unsubscribe link (GET shows/handles, POST is the RFC 8058 one-click).
// Per request: parse workspace_id + email from the link, write the per-workspace
// suppression in ONE workspace-scoped tx. The handler NEVER throws; a malformed
// or unscoped request → 400 (no guessed/default workspace).
import {
  parseUnsubscribeRequest,
  buildUnsubscribeSuppression,
  buildUnsubscribedAttribute,
  type SqlStatement,
} from './core.js';

/** The minimal HTTP request shape (API Gateway proxy or synthetic). */
export interface UnsubscribeHttpEvent {
  readonly httpMethod?: string;
  readonly rawPath?: string;
  readonly path?: string;
  readonly rawQueryString?: string;
  readonly queryStringParameters?: Record<string, string | undefined> | null;
  readonly body?: string | null;
}

/** The HTTP response the handler returns. */
export interface UnsubscribeHttpResponse {
  readonly statusCode: number;
  readonly body: string;
}

/** Injected dependencies — all I/O behind these (scoped by the link's workspace). */
export interface UnsubscribeDeps {
  /** Apply the suppression in ONE workspace-scoped tx. */
  runInWorkspaceTx(workspaceId: string, statements: readonly SqlStatement[]): Promise<void>;
}

/** Reconstruct a URL string (with query) from an API-Gateway-style event. */
function urlFromEvent(event: UnsubscribeHttpEvent): string {
  const path = event.rawPath ?? event.path ?? '/unsubscribe';
  if (event.rawQueryString) return `${path}?${event.rawQueryString}`;
  const qs = event.queryStringParameters;
  if (qs) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(qs)) {
      if (v !== undefined) params.set(k, v);
    }
    const s = params.toString();
    if (s) return `${path}?${s}`;
  }
  return path;
}

/** Build the unsubscribe handler from its injected dependencies. */
export function makeUnsubscribeHandler(deps: UnsubscribeDeps) {
  return async function handler(event: UnsubscribeHttpEvent): Promise<UnsubscribeHttpResponse> {
    try {
      const method = event.httpMethod ?? 'GET';
      const url = urlFromEvent(event);
      const parsed = parseUnsubscribeRequest(method, url, event.body);
      if (!parsed.valid) {
        return { statusCode: 400, body: JSON.stringify({ ok: false, reason: parsed.reason }) };
      }
      // Workspace-scoped writes in ONE tx — never touches another workspace:
      //   1. the suppression (authoritative SEND gate, §10),
      //   2. the profile `unsubscribed = true` attribute (so it's segmentable).
      await deps.runInWorkspaceTx(parsed.workspaceId, [
        buildUnsubscribeSuppression(parsed.workspaceId, parsed.email),
        buildUnsubscribedAttribute(parsed.workspaceId, parsed.email),
      ]);
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    } catch {
      // Never throw out of the handler; surface a 500 the caller can retry.
      return { statusCode: 500, body: JSON.stringify({ ok: false, reason: 'internal error' }) };
    }
  };
}
