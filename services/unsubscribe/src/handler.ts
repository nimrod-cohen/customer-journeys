// Unsubscribe Lambda — thin HTTP handler (§10). Backs the workspace-scoped
// unsubscribe link. TWO-STEP by design: a GET (the link click from the email)
// returns a CONFIRMATION page and changes NOTHING — email clients/proxies
// prefetch GET links, so a GET must never opt anyone out. Only a POST (the
// page's "Yes, unsubscribe" button, or the RFC 8058 one-click confirmation)
// performs the opt-out: writes the per-workspace suppression AND sets the
// profile `unsubscribed = true`, in ONE workspace-scoped tx. The handler NEVER
// throws; a malformed/unscoped request → 400 (no guessed/default workspace).
import { verifyUnsubscribeToken, unsubscribeLinkSecret } from '@cdp/email';
import {
  parseUnsubscribeRequest,
  buildUnsubscribeSuppression,
  buildUnsubscribedAttribute,
  buildUnsubscribeActivity,
  buildUnsubscribeEvent,
  type SqlStatement,
} from './core.js';
import { renderCompanyLogo } from './logo.js';
import type { PreferenceReader } from './preference-handler.js';

const HTML_HEADERS = { 'content-type': 'text/html; charset=utf-8' } as const;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * A minimal self-contained HTML page (no external assets except the optional
 * company logo `<img>`, which is served public-by-uuid). `logoHtml` (default '')
 * is emitted at the TOP of the card; with no logo the page renders as before.
 */
function page(title: string, inner: string, logoHtml = ''): string {
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
    `<body><div class="card">${logoHtml}${inner}</div></body></html>`
  );
}

/**
 * The SIMPLE unsubscribe confirm page (the one source of truth — the preference
 * center reuses this when topics are disabled / there are none). Exported so the
 * preference handler renders the IDENTICAL page. `logoHtml` (optional) renders the
 * company logo atop the card.
 */
export function confirmPage(email: string, actionUrl: string, logoHtml = ''): string {
  return page(
    'Unsubscribe',
    `<h1>Unsubscribe from these emails?</h1>` +
      `<p><span class="email">${esc(email)}</span> will no longer receive emails from this sender.</p>` +
      `<form method="POST" action="${esc(actionUrl)}">` +
      `<button type="submit" data-testid="confirm-unsubscribe">Yes, unsubscribe me</button></form>`,
    logoHtml,
  );
}

/** The SIMPLE "you're unsubscribed" page (shared with the preference center). */
export function donePage(email: string, logoHtml = ''): string {
  return page(
    'Unsubscribed',
    `<h1 class="ok">You're unsubscribed</h1>` +
      `<p><span class="email">${esc(email)}</span> won't receive further emails from this sender. ` +
      `You can close this page.</p>`,
    logoHtml,
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
  /**
   * The HMAC link secret used to VERIFY the token (the dispatcher signs with the
   * SAME secret). Defaults to `unsubscribeLinkSecret()` (env or the dev fallback)
   * so the prod Lambda + local-api resolve it consistently.
   */
  readonly linkSecret?: string;
  /**
   * Optional service-role reader to resolve the sending company's logo (scoped in
   * code to the link's workspace). Omitted ⇒ no logo (page renders as before).
   */
  readonly reader?: PreferenceReader;
  /**
   * The public ORIGIN that serves uploaded assets (`<assetsBaseUrl>/assets/<id>`).
   * Derived from the SAME origin as the unsubscribe link. Omitted ⇒ no logo.
   */
  readonly assetsBaseUrl?: string;
}

/**
 * The statements for a SIMPLE (full) opt-out — the per-workspace suppression, the
 * profile `unsubscribed=true` flag, the activity-log row, and (when the link
 * carried a source) the attribution email_event. Shared so the preference center,
 * when topics are disabled, performs the IDENTICAL write as /unsubscribe.
 */
export function simpleUnsubscribeStatements(
  workspaceId: string,
  email: string,
  broadcastId: string | null,
  campaignId: string | null,
  source: string | null = 'one-click',
): SqlStatement[] {
  const attribution = buildUnsubscribeEvent(workspaceId, email, broadcastId, campaignId);
  return [
    buildUnsubscribeSuppression(workspaceId, email, source),
    buildUnsubscribedAttribute(workspaceId, email),
    buildUnsubscribeActivity(workspaceId, email),
    ...(attribution ? [attribution] : []),
  ];
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
      // TOKEN GATE (security): the link is UNGUESSABLE — a valid HMAC token over
      // (workspace_id, email) signed with the shared secret is REQUIRED. A
      // missing/invalid token → 403 (forging a link for someone else's email is
      // impossible without the secret). Applies to BOTH the GET confirm page and
      // the POST write — a forged link never even renders the re-affirm page.
      const secret = deps.linkSecret ?? unsubscribeLinkSecret();
      if (!verifyUnsubscribeToken(secret, parsed.workspaceId, parsed.email, parsed.token)) {
        return {
          statusCode: 403,
          headers: HTML_HEADERS,
          body: page('Unsubscribe', `<h1>Invalid or expired link</h1><p>This unsubscribe link could not be verified.</p>`),
        };
      }
      // Resolve the sending company's logo (decorative; '' when none/not wired).
      const logoHtml = await renderCompanyLogo(deps.reader, deps.assetsBaseUrl, parsed.workspaceId);
      // GET = the link click. It is PREFETCHABLE (mail clients/proxies fetch it),
      // so it must NOT opt anyone out — just show the re-affirm page whose form
      // POSTs back to this same URL.
      if (method === 'GET') {
        return { statusCode: 200, headers: HTML_HEADERS, body: confirmPage(parsed.email, url, logoHtml) };
      }
      // POST = the user re-affirmed (Confirm button) OR an RFC 8058 one-click.
      // Workspace-scoped writes in ONE tx — never touches another workspace:
      //   1. the suppression (authoritative SEND gate, §10),
      //   2. the profile `unsubscribed = true` attribute (so it's segmentable).
      //   3. an email_events 'unsubscribe' row attributed to the source
      //      broadcast/campaign (when the link carried one) — feeds the funnel.
      await deps.runInWorkspaceTx(
        parsed.workspaceId,
        simpleUnsubscribeStatements(parsed.workspaceId, parsed.email, parsed.broadcastId, parsed.campaignId),
      );
      return { statusCode: 200, headers: HTML_HEADERS, body: donePage(parsed.email, logoHtml) };
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
