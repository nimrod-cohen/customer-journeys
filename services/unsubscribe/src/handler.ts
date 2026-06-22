// Unsubscribe Lambda — thin HTTP handler (§10). Backs the workspace-scoped
// unsubscribe link. TWO-STEP by design: a GET (the link click from the email)
// returns a CONFIRMATION page and changes NOTHING — email clients/proxies
// prefetch GET links, so a GET must never opt anyone out. Only a POST (the
// page's "Yes, unsubscribe" button, or the RFC 8058 one-click confirmation)
// performs the opt-out: writes the per-workspace suppression AND sets the
// profile `unsubscribed = true`, in ONE workspace-scoped tx. The handler NEVER
// throws; a malformed/unscoped request → 400 (no guessed/default workspace).
import { verifyUnsubscribeToken, unpackSubscriptionToken, unsubscribeLinkSecret } from '@cdp/email';
import {
  parseUnsubscribeRequest,
  buildUnsubscribeSuppression,
  buildUnsubscribedAttribute,
  buildUnsubscribeActivity,
  buildUnsubscribeEvent,
  FAVICON_LINK,
  type SqlStatement,
} from './core.js';
import { renderCompanyLogo } from './logo.js';
import { resolveLanguage, dirFor, stringsFor, type Lang } from './i18n.js';
import type { PreferenceReader } from './preference-handler.js';

const HTML_HEADERS = { 'content-type': 'text/html; charset=utf-8' } as const;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * Render a body string that embeds the recipient email. `{email}` is replaced by
 * an `<span class="email" dir="ltr">` so the address stays LEFT-TO-RIGHT even
 * inside an RTL (Hebrew) sentence — emails/URLs read cleanly that way.
 */
function withEmail(template: string, email: string): string {
  return template.replace('{email}', `<span class="email" dir="ltr">${esc(email)}</span>`);
}

/**
 * A minimal self-contained HTML page (no external assets except the optional
 * company logo `<img>`, which is served public-by-uuid). `logoHtml` (default '')
 * is emitted at the TOP of the card; with no logo the page renders as before.
 *
 * The page is language-aware: `<html lang dir>` follows the resolved language
 * (Hebrew → `dir="rtl"`). The card text aligns to the START edge so RTL reads
 * right; the email span is forced LTR so a mixed sentence renders cleanly.
 */
function page(lang: Lang, title: string, inner: string, logoHtml = ''): string {
  const dir = dirFor(lang);
  return (
    `<!doctype html><html lang="${lang}" dir="${dir}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>` +
    FAVICON_LINK +
    `<style>body{font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:#fafaf9;color:#1c1917;` +
    `display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}` +
    `.card{background:#fff;border:1px solid #e7e5e4;border-radius:16px;padding:32px;max-width:440px;width:90%;` +
    `box-shadow:0 8px 24px rgba(0,0,0,.06);text-align:center}h1{font-size:20px;margin:0 0 8px}` +
    `p{color:#57534e;font-size:14px;line-height:1.5}.email{font-weight:600;color:#1c1917;unicode-bidi:isolate}` +
    `button{margin-top:20px;background:#b91c1c;color:#fff;border:0;border-radius:10px;padding:11px 20px;` +
    `font-size:14px;font-weight:600;cursor:pointer}button:hover{background:#991b1b}.ok{color:#047857}</style></head>` +
    `<body><div class="card">${logoHtml}${inner}</div></body></html>`
  );
}

/**
 * The SIMPLE unsubscribe confirm page (the one source of truth — the preference
 * center reuses this when topics are disabled / there are none). Exported so the
 * preference handler renders the IDENTICAL page. `logoHtml` (optional) renders the
 * company logo atop the card. `lang` selects the rendered language (default 'en'
 * keeps the page byte-for-byte as before for unset/English workspaces).
 */
export function confirmPage(email: string, actionUrl: string, logoHtml = '', lang: Lang = 'en'): string {
  const s = stringsFor(lang);
  return page(
    lang,
    s.unsubscribeTitle,
    `<h1>${esc(s.unsubscribeHeading)}</h1>` +
      `<p>${withEmail(s.unsubscribeBody, email)}</p>` +
      `<form method="POST" action="${esc(actionUrl)}">` +
      `<button type="submit" data-testid="confirm-unsubscribe">${esc(s.unsubscribeButton)}</button></form>`,
    logoHtml,
  );
}

/** The SIMPLE "you're unsubscribed" page (shared with the preference center). */
export function donePage(email: string, logoHtml = '', lang: Lang = 'en'): string {
  const s = stringsFor(lang);
  return page(
    lang,
    s.unsubscribedTitle,
    `<h1 class="ok">${esc(s.unsubscribedHeading)}</h1>` + `<p>${withEmail(s.unsubscribedBody, email)}</p>`,
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
  /**
   * The recipient's `Accept-Language` header — used when the workspace's
   * front_facing_language is 'auto' to pick Hebrew vs English from the browser.
   * Threaded in from the API Gateway event headers (local-api passes
   * `c.req.header('accept-language')`).
   */
  readonly acceptLanguage?: string | null;
}

/**
 * Read the Accept-Language header off an API-Gateway-style event (case-insensitive)
 * or the synthetic `acceptLanguage` field the local-api wires in. Null when absent.
 */
export function acceptLanguageFromEvent(
  event: UnsubscribeHttpEvent & { headers?: Record<string, string | undefined> | null },
): string | null {
  if (event.acceptLanguage != null) return event.acceptLanguage;
  const h = event.headers;
  if (!h) return null;
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === 'accept-language' && v != null) return v;
  }
  return null;
}

/**
 * Read the workspace's persisted `settings.front_facing_language`
 * ('auto'|'en'|'he'). Missing/unknown ⇒ undefined (resolveLanguage normalizes to
 * 'auto'). Workspace-scoped (tenant-isolation guard). Kept here (not in
 * preference-handler) to avoid a circular import.
 */
async function readWorkspaceLanguage(reader: PreferenceReader, workspaceId: string): Promise<string | undefined> {
  if (!workspaceId) throw new Error('readWorkspaceLanguage: workspaceId is required (tenant-isolation guard)');
  const { rows } = await reader.query<{ lang: string | null }>(
    `SELECT settings->>'front_facing_language' AS lang FROM workspaces WHERE id = $1`,
    [workspaceId],
  );
  return rows[0]?.lang ?? undefined;
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
    // The recipient's browser language (for the 'auto' workspace setting).
    const acceptLanguage = acceptLanguageFromEvent(event);
    // The error pages are rendered BEFORE we know the workspace, so they fall back
    // to the recipient's browser language only (no workspace setting available).
    const fallbackLang = resolveLanguage('auto', acceptLanguage);
    const errStrings = stringsFor(fallbackLang);
    try {
      const method = (event.httpMethod ?? 'GET').toUpperCase();
      const url = urlFromEvent(event);
      // The shared HMAC secret (same on the signer + verifier sides).
      const secret = deps.linkSecret ?? unsubscribeLinkSecret();
      // The parser tries the compact `?t=` token FIRST (unpacked here with the
      // secret), then falls back to the legacy workspace_id+email+token triple.
      const parsed = parseUnsubscribeRequest(method, url, event.body, (t) =>
        unpackSubscriptionToken(secret, t),
      );
      if (!parsed.valid) {
        // A present-but-forged `t` token → 403; a link with no identity → 400.
        if (parsed.tokenInvalid) {
          return {
            statusCode: 403,
            headers: HTML_HEADERS,
            body: page(fallbackLang, errStrings.unsubscribeTitle, `<h1>${esc(errStrings.invalidOrExpiredTitle)}</h1><p>${esc(errStrings.couldNotVerify)}</p>`),
          };
        }
        return {
          statusCode: 400,
          headers: HTML_HEADERS,
          body: page(fallbackLang, errStrings.unsubscribeTitle, `<h1>${esc(errStrings.invalidLinkTitle)}</h1><p>${esc(parsed.reason)}</p>`),
        };
      }
      // TOKEN GATE (security): the link is UNGUESSABLE. The compact `?t=` token
      // is verified DURING parse (decode + constant-time MAC) → `compactVerified`.
      // A legacy link still needs the separate HMAC `token` checked here. Either
      // way a missing/invalid token → 403 (forging a link for someone else's
      // email is impossible without the secret). Applies to BOTH the GET confirm
      // page and the POST write — a forged link never even renders.
      if (!parsed.compactVerified && !verifyUnsubscribeToken(secret, parsed.workspaceId, parsed.email, parsed.token)) {
        return {
          statusCode: 403,
          headers: HTML_HEADERS,
          body: page(fallbackLang, errStrings.unsubscribeTitle, `<h1>${esc(errStrings.invalidOrExpiredTitle)}</h1><p>${esc(errStrings.couldNotVerify)}</p>`),
        };
      }
      // Now the workspace is known: resolve its front-facing language (forced
      // en/he, or browser-derived for 'auto'). Default keeps English/LTR.
      const lang = resolveLanguage(
        deps.reader ? await readWorkspaceLanguage(deps.reader, parsed.workspaceId) : 'auto',
        acceptLanguage,
      );
      // Resolve the sending company's logo (decorative; '' when none/not wired).
      const logoHtml = await renderCompanyLogo(deps.reader, deps.assetsBaseUrl, parsed.workspaceId);
      // GET = the link click. It is PREFETCHABLE (mail clients/proxies fetch it),
      // so it must NOT opt anyone out — just show the re-affirm page whose form
      // POSTs back to this same URL.
      if (method === 'GET') {
        return { statusCode: 200, headers: HTML_HEADERS, body: confirmPage(parsed.email, url, logoHtml, lang) };
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
      return { statusCode: 200, headers: HTML_HEADERS, body: donePage(parsed.email, logoHtml, lang) };
    } catch {
      // Never throw out of the handler; surface a 500 the caller can retry.
      return {
        statusCode: 500,
        headers: HTML_HEADERS,
        body: page(fallbackLang, errStrings.unsubscribeTitle, `<h1>${esc(errStrings.somethingWrongTitle)}</h1><p>${esc(errStrings.tryAgain)}</p>`),
      };
    }
  };
}
