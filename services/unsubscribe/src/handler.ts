// Unsubscribe Lambda — thin HTTP handler (§10). Backs the workspace-scoped
// unsubscribe link. TWO-STEP by design: a GET (the link click from the email)
// returns a CONFIRMATION page and changes NOTHING — email clients/proxies
// prefetch GET links, so a GET must never opt anyone out. Only a POST (the
// page's "Yes, unsubscribe" button, or the RFC 8058 one-click confirmation)
// performs the opt-out: writes the per-workspace suppression AND sets the
// profile `unsubscribed = true`, in ONE workspace-scoped tx. The handler NEVER
// throws; a malformed/unscoped request → 400 (no guessed/default workspace).
import {
  parseUnsubscribeRequest,
  buildUnsubscribeSuppression,
  buildUnsubscribedAttribute,
  buildUnsubscribeActivity,
  type SqlStatement,
} from './core.js';

const HTML_HEADERS = { 'content-type': 'text/html; charset=utf-8' } as const;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** A minimal self-contained HTML page (no external assets — it's opened from email). */
function page(title: string, inner: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>` +
    `<style>body{font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:#fafaf9;color:#1c1917;` +
    `display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}` +
    `.card{background:#fff;border:1px solid #e7e5e4;border-radius:16px;padding:32px;max-width:440px;width:90%;` +
    `box-shadow:0 8px 24px rgba(0,0,0,.06);text-align:center}h1{font-size:20px;margin:0 0 8px}` +
    `p{color:#57534e;font-size:14px;line-height:1.5}.email{font-weight:600;color:#1c1917}` +
    `button{margin-top:20px;background:#b91c1c;color:#fff;border:0;border-radius:10px;padding:11px 20px;` +
    `font-size:14px;font-weight:600;cursor:pointer}button:hover{background:#991b1b}.ok{color:#0f766e}</style></head>` +
    `<body><div class="card">${inner}</div></body></html>`
  );
}

function confirmPage(email: string, actionUrl: string): string {
  return page(
    'Unsubscribe',
    `<h1>Unsubscribe from these emails?</h1>` +
      `<p><span class="email">${esc(email)}</span> will no longer receive emails from this sender.</p>` +
      `<form method="POST" action="${esc(actionUrl)}">` +
      `<button type="submit" data-testid="confirm-unsubscribe">Yes, unsubscribe me</button></form>`,
  );
}

function donePage(email: string): string {
  return page(
    'Unsubscribed',
    `<h1 class="ok">You're unsubscribed</h1>` +
      `<p><span class="email">${esc(email)}</span> won't receive further emails from this sender. ` +
      `You can close this page.</p>`,
  );
}

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
  readonly headers?: Record<string, string>;
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
      const method = (event.httpMethod ?? 'GET').toUpperCase();
      const url = urlFromEvent(event);
      const parsed = parseUnsubscribeRequest(method, url, event.body);
      if (!parsed.valid) {
        return {
          statusCode: 400,
          headers: HTML_HEADERS,
          body: page('Unsubscribe', `<h1>Invalid unsubscribe link</h1><p>${esc(parsed.reason)}</p>`),
        };
      }
      // GET = the link click. It is PREFETCHABLE (mail clients/proxies fetch it),
      // so it must NOT opt anyone out — just show the re-affirm page whose form
      // POSTs back to this same URL.
      if (method === 'GET') {
        return { statusCode: 200, headers: HTML_HEADERS, body: confirmPage(parsed.email, url) };
      }
      // POST = the user re-affirmed (Confirm button) OR an RFC 8058 one-click.
      // Workspace-scoped writes in ONE tx — never touches another workspace:
      //   1. the suppression (authoritative SEND gate, §10),
      //   2. the profile `unsubscribed = true` attribute (so it's segmentable).
      await deps.runInWorkspaceTx(parsed.workspaceId, [
        buildUnsubscribeSuppression(parsed.workspaceId, parsed.email),
        buildUnsubscribedAttribute(parsed.workspaceId, parsed.email),
        buildUnsubscribeActivity(parsed.workspaceId, parsed.email),
      ]);
      return { statusCode: 200, headers: HTML_HEADERS, body: donePage(parsed.email) };
    } catch {
      // Never throw out of the handler; surface a 500 the caller can retry.
      return {
        statusCode: 500,
        headers: HTML_HEADERS,
        body: page('Unsubscribe', `<h1>Something went wrong</h1><p>Please try again in a moment.</p>`),
      };
    }
  };
}
