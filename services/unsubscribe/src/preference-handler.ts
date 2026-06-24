// Preference-center HTTP handler (CLAUDE.md topic-subscriptions). Serves the
// public "manage your subscription" page, alongside /unsubscribe. Like the
// two-step opt-out, the workspace_id + email come ONLY from the scoped link.
//
// GET  → render the preference center: the workspace's active topics (each a
//        checkbox = subscribed), the two channel groups (Email, WhatsApp & SMS),
//        and an "Unsubscribe from everything" action. Changes NOTHING.
// POST → write the granular prefs in ONE workspace-scoped tx:
//        - per-topic subscribed rows,
//        - per-group channel_optouts,
//        - "everything" = opt out both groups + all topics + the existing full
//          suppression + profiles.attributes.unsubscribed=true + activity_log.
//        A PARTIAL opt-out NEVER sets the global suppression / unsubscribed flag.
import { verifyUnsubscribeToken, unpackSubscriptionToken, unsubscribeLinkSecret } from '@cdp/email';
import {
  buildUnsubscribeSuppression,
  buildUnsubscribedAttribute,
  buildUnsubscribeActivity,
  buildGlobalUnsubscribedQuery,
  buildResubscribeSuppressionDelete,
  buildResubscribedAttribute,
  parseUnsubscribeRequest,
  FAVICON_LINK,
  type SqlStatement,
} from './core.js';
import {
  confirmPage,
  donePage,
  acceptLanguageFromEvent,
  simpleUnsubscribeStatements,
  type UnsubscribeHttpEvent,
  type UnsubscribeHttpResponse,
} from './handler.js';
import { resolveLanguage, dirFor, stringsFor, type Lang } from './i18n.js';
import {
  parsePreferenceUpdate,
  buildActiveTopicsQuery,
  buildTopicStateQuery,
  buildGroupStateQuery,
  buildTopicSubscriptionUpsert,
  buildChannelOptOutWrite,
  buildOptOutAllTopics,
  toTopicChoices,
  MEDIUM_GROUPS,
  type TopicChoice,
} from './preference-center.js';
import { renderCompanyLogo } from './logo.js';

const HTML_HEADERS = { 'content-type': 'text/html; charset=utf-8' } as const;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * `{email}` → an LTR email span so the address reads cleanly inside an RTL
 * (Hebrew) sentence.
 */
function withEmail(template: string, email: string): string {
  return template.replace('{email}', `<span class="email" dir="ltr">${esc(email)}</span>`);
}

/**
 * The preference-center page shell. Language-aware: `<html lang dir>` follows the
 * resolved language (Hebrew → `dir="rtl"`). The card aligns to the START edge so
 * RTL reads right; the email span is forced LTR. `lang` default 'en' keeps the
 * page byte-for-byte as before for unset/English workspaces.
 */
function shell(title: string, inner: string, logoHtml = '', lang: Lang = 'en', wide = false): string {
  const dir = dirFor(lang);
  const header = logoHtml ? `<div class="header">${logoHtml}</div>` : '';
  return (
    `<!doctype html><html lang="${lang}" dir="${dir}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>` +
    FAVICON_LINK +
    `<style>*{box-sizing:border-box}body{font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:#f3f4f6;` +
    `color:#1c1917;display:flex;min-height:100vh;align-items:flex-start;justify-content:center;margin:0;padding:32px 16px}` +
    `.card{background:#fff;border-radius:18px;max-width:${wide ? '760px' : '460px'};width:100%;` +
    `box-shadow:0 10px 40px rgba(0,0,0,.08);overflow:hidden}` +
    `.header{padding:24px;border-bottom:1px solid #eef0f2;text-align:center}.content{padding:28px 32px}` +
    `h1{font-size:24px;font-weight:800;margin:0 0 6px;text-align:start}` +
    `.intro{color:#78716c;font-size:14px;line-height:1.5;margin:0 0 24px;text-align:start}` +
    `.email{font-weight:700;color:#1c1917;unicode-bidi:isolate}` +
    // Two columns: Topics | divider | Channels — collapses to one column on mobile.
    `.cols{display:grid;grid-template-columns:1fr 1px 1fr;gap:28px;align-items:start}` +
    `.vdiv{background:#eef0f2;align-self:stretch}` +
    `.sec-label{font-size:12px;font-weight:600;letter-spacing:.05em;color:#a8a29e;text-align:start;margin-bottom:6px}` +
    // Each option: name (bold) + a light description, with a toggle (and an icon for channels).
    `.opt{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 0}` +
    `.opt-text{display:flex;flex-direction:column;gap:3px;text-align:start;min-width:0}` +
    `.opt-name{font-weight:700;color:#1c1917;font-size:15px;line-height:1.3}` +
    `.opt-desc{font-weight:400;color:#9ca3af;font-size:13px;line-height:1.45}` +
    `.opt-end{display:flex;align-items:center;gap:12px;flex:none}` +
    `.ch-icon{width:40px;height:40px;border-radius:10px;background:#f0fdfa;color:#0f766e;display:flex;align-items:center;justify-content:center;flex:none}` +
    // CSS toggle switch (direction-aware via inset-inline so the knob slides to the END when on).
    `.switch{position:relative;display:inline-block;width:46px;height:26px;flex:none}` +
    `.switch input{position:absolute;inset:0;width:100%;height:100%;opacity:0;margin:0;cursor:pointer;z-index:2}` +
    `.switch .track{position:absolute;inset:0;background:#d1d5db;border-radius:999px;transition:.2s}` +
    `.switch .knob{position:absolute;top:3px;inset-inline-start:3px;width:20px;height:20px;background:#fff;border-radius:50%;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:.2s}` +
    `.switch input:checked~.track{background:#0d9488}.switch input:checked~.knob{inset-inline-start:auto;inset-inline-end:3px}` +
    `button{border:0;border-radius:12px;padding:15px 20px;font-size:15px;font-weight:700;cursor:pointer;width:100%;display:block}` +
    `.primary{background:#0d9488;color:#fff;margin-top:24px;box-shadow:0 8px 20px rgba(13,148,136,.30)}.primary:hover{background:#0f766e}` +
    `.danger{background:#fff;color:#b91c1c;border:1px solid #fecaca;margin-top:12px}.danger:hover{background:#fef2f2}` +
    `.ok{color:#0f766e}.muted{color:#9ca3af;font-size:14px}` +
    `@media(max-width:640px){.content{padding:24px 20px}.cols{grid-template-columns:1fr;gap:0}.vdiv{height:1px;width:auto;margin:18px 0}}</style></head>` +
    `<body><div class="card">${header}<div class="content">${inner}</div></div></body></html>`
  );
}

function centerPage(
  email: string,
  actionUrl: string,
  topics: TopicChoice[],
  groupSubscribed: Record<string, boolean>,
  logoHtml = '',
  lang: Lang = 'en',
): string {
  const s = stringsFor(lang);
  // A green toggle SWITCH backed by a real checkbox (so the existing POST handling +
  // testids are unchanged); the input sits on top (clickable, but opacity 0).
  const toggle = (name: string, checked: boolean, testid: string): string =>
    `<span class="switch"><input type="checkbox" name="${name}" ${checked ? 'checked' : ''} data-testid="${testid}">` +
    `<span class="track"></span><span class="knob"></span></span>`;
  const row = (name: string, desc: string, sw: string, icon = ''): string =>
    `<label class="opt"><span class="opt-text"><span class="opt-name">${esc(name)}</span>` +
    (desc ? `<span class="opt-desc">${esc(desc)}</span>` : '') +
    `</span><span class="opt-end">${icon}${sw}</span></label>`;

  const topicRows = topics.length
    ? topics
        .map((t) =>
          row(
            t.name,
            t.description ?? '',
            toggle(`topic.${esc(t.id)}`, t.subscribed, `pref-topic-${esc(t.id)}`),
          ),
        )
        .join('')
    : `<p class="muted">${esc(s.noTopics)}</p>`;

  const groupRows = MEDIUM_GROUPS.map((g) => {
    const label = g === 'email' ? s.channelEmail : s.channelSmsWhatsapp;
    const desc = g === 'email' ? s.channelEmailDesc : s.channelSmsWhatsappDesc;
    const icon = `<span class="ch-icon">${g === 'email' ? ICON_EMAIL : ICON_CHAT}</span>`;
    return row(label, desc, toggle(`group.${g}`, groupSubscribed[g] ?? false, `pref-group-${g}`), icon);
  }).join('');

  const topicsCol = `<div class="col"><div class="sec-label">${esc(s.topicsHeading)}</div>${topicRows}</div>`;
  const channelsCol = `<div class="col"><div class="sec-label">${esc(s.channelsHeading)}</div>${groupRows}</div>`;

  return shell(
    s.manageTitle,
    `<h1>${esc(s.manageHeading)}</h1>` +
      `<p class="intro">${withEmail(s.manageIntro, email)}</p>` +
      `<form method="POST" action="${esc(actionUrl)}" data-testid="pref-form">` +
      `<div class="cols">${topicsCol}<div class="vdiv"></div>${channelsCol}</div>` +
      `<button type="submit" class="primary" data-testid="pref-save">${esc(s.savePreferences)}</button>` +
      `</form>` +
      // A SEPARATE form so "unsubscribe from everything" is an unambiguous action.
      `<form method="POST" action="${esc(actionUrl)}" data-testid="pref-all-form">` +
      `<input type="hidden" name="unsubscribe_all" value="1">` +
      `<button type="submit" class="danger" data-testid="pref-unsub-all">${esc(s.unsubscribeFromEverything)}</button>` +
      `</form>`,
    logoHtml,
    lang,
    true, // wide layout (two columns)
  );
}

/** Inline channel icons (SVG, no emoji) shown in the rounded square per channel group. */
const ICON_EMAIL =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>';
const ICON_CHAT =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.5 8.5 0 0 1-12.2 7.6L3 21l1.9-5.8A8.5 8.5 0 1 1 21 11.5z"/></svg>';

function savedPage(email: string, all: boolean, logoHtml = '', lang: Lang = 'en'): string {
  const s = stringsFor(lang);
  // "unsubscribe from everything" lands on the SIMPLE unsubscribed page copy; a
  // partial save lands on the preferences-saved copy.
  const heading = all ? s.unsubscribedHeading : s.preferencesSavedHeading;
  const title = all ? s.unsubscribedTitle : s.preferencesSavedTitle;
  const body = all ? s.unsubscribedBody : s.preferencesSavedBody;
  return shell(
    title,
    `<h1 class="ok">${esc(heading)}</h1>` + `<p>${withEmail(body, email)}</p>`,
    logoHtml,
    lang,
  );
}

/** A minimal row reader (scoped queries) the preference center needs for the GET page. */
export interface PreferenceReader {
  query<T = Record<string, unknown>>(text: string, values: readonly unknown[]): Promise<{ rows: T[] }>;
}

/** Injected dependencies for the preference center. */
export interface PreferenceCenterDeps {
  /** Service-role reader (scoped in code) for the GET page's current state. */
  readonly reader: PreferenceReader;
  /** Apply the preference writes in ONE workspace-scoped tx. */
  runInWorkspaceTx(workspaceId: string, statements: readonly SqlStatement[]): Promise<void>;
  /**
   * The HMAC link secret used to VERIFY the token (same secret the dispatcher
   * signs with). Defaults to `unsubscribeLinkSecret()` (env or the dev fallback).
   */
  readonly linkSecret?: string;
  /**
   * The public ORIGIN that serves uploaded assets (`<assetsBaseUrl>/assets/<id>`),
   * for the company logo atop the page. Derived from the SAME origin as the link.
   * Omitted ⇒ no logo (page renders as before).
   */
  readonly assetsBaseUrl?: string;
}

/**
 * Whether the workspace's `settings.topics_enabled` flag is on. DEFAULT TRUE: a
 * workspace that never touched the setting (no key) is topic-managed. Only an
 * explicit `false` disables it.
 */
export async function readTopicsEnabled(reader: PreferenceReader, workspaceId: string): Promise<boolean> {
  if (!workspaceId) throw new Error('readTopicsEnabled: workspaceId is required (tenant-isolation guard)');
  const { rows } = await reader.query<{ topics_enabled: boolean | null }>(
    `SELECT (settings->>'topics_enabled')::boolean AS topics_enabled FROM workspaces WHERE id = $1`,
    [workspaceId],
  );
  // Missing/NULL → default ON; only an explicit false disables.
  return rows[0]?.topics_enabled !== false;
}

/**
 * The workspace's persisted `settings.front_facing_language` ('auto'|'en'|'he').
 * Missing/unknown ⇒ undefined (the caller's resolveLanguage normalizes to 'auto').
 * Workspace-scoped (tenant-isolation guard).
 */
export async function readFrontFacingLanguage(
  reader: PreferenceReader,
  workspaceId: string,
): Promise<string | undefined> {
  if (!workspaceId) throw new Error('readFrontFacingLanguage: workspaceId is required (tenant-isolation guard)');
  const { rows } = await reader.query<{ lang: string | null }>(
    `SELECT settings->>'front_facing_language' AS lang FROM workspaces WHERE id = $1`,
    [workspaceId],
  );
  return rows[0]?.lang ?? undefined;
}

/** Reconstruct a URL string (with query) from an API-Gateway-style event. */
function urlFromEvent(event: UnsubscribeHttpEvent): string {
  const path = event.rawPath ?? event.path ?? '/manage-subscription';
  if (event.rawQueryString) return `${path}?${event.rawQueryString}`;
  const qs = event.queryStringParameters;
  if (qs) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(qs)) if (v !== undefined) params.set(k, v);
    const s = params.toString();
    if (s) return `${path}?${s}`;
  }
  return path;
}

/** Build the preference-center handler from its injected dependencies. */
export function makePreferenceCenterHandler(deps: PreferenceCenterDeps) {
  return async function handler(event: UnsubscribeHttpEvent): Promise<UnsubscribeHttpResponse> {
    // The recipient's browser language (for the 'auto' workspace setting).
    const acceptLanguage = acceptLanguageFromEvent(event);
    // Error pages render before the workspace is known → browser language only.
    const fallbackLang = resolveLanguage('auto', acceptLanguage);
    const errStrings = stringsFor(fallbackLang);
    try {
      const method = (event.httpMethod ?? 'GET').toUpperCase();
      const url = urlFromEvent(event);
      // The shared HMAC secret (same on the signer + verifier sides).
      const secret = deps.linkSecret ?? unsubscribeLinkSecret();
      // Reuse the SAME scoped-link parser as /unsubscribe — workspace_id + email
      // come ONLY from the verified compact `?t=` token (or the legacy triple),
      // never a body field.
      const parsed = parseUnsubscribeRequest(method, url, event.body, (t) =>
        unpackSubscriptionToken(secret, t),
      );
      if (!parsed.valid) {
        // A present-but-forged `t` token → 403; a link with no identity → 400.
        if (parsed.tokenInvalid) {
          return {
            statusCode: 403,
            headers: HTML_HEADERS,
            body: shell(errStrings.manageTitle, `<h1>${esc(errStrings.invalidOrExpiredTitle)}</h1><p>${esc(errStrings.couldNotVerify)}</p>`, '', fallbackLang),
          };
        }
        return {
          statusCode: 400,
          headers: HTML_HEADERS,
          body: shell(errStrings.manageTitle, `<h1>${esc(errStrings.invalidLinkTitle)}</h1><p>${esc(parsed.reason)}</p>`, '', fallbackLang),
        };
      }
      const { workspaceId, email } = parsed;

      // TOKEN GATE (security): the compact `?t=` token is verified during parse
      // (`compactVerified`); a legacy link needs the separate HMAC check. A
      // missing/invalid token → 403 — a forged manage link never renders.
      if (!parsed.compactVerified && !verifyUnsubscribeToken(secret, workspaceId, email, parsed.token)) {
        return {
          statusCode: 403,
          headers: HTML_HEADERS,
          body: shell(errStrings.manageTitle, `<h1>${esc(errStrings.invalidOrExpiredTitle)}</h1><p>${esc(errStrings.couldNotVerify)}</p>`, '', fallbackLang),
        };
      }

      // The workspace is known: resolve its front-facing language (forced en/he,
      // or browser-derived for 'auto'). Default keeps English/LTR.
      const lang = resolveLanguage(await readFrontFacingLanguage(deps.reader, workspaceId), acceptLanguage);

      // Resolve the sending company's logo (decorative; '' when none/not wired).
      const logoHtml = await renderCompanyLogo(deps.reader, deps.assetsBaseUrl, workspaceId);

      // Load the workspace's active topics + the recipient's current state.
      const topicsQ = buildActiveTopicsQuery(workspaceId);
      const { rows: activeTopics } = await deps.reader.query<{ id: string; name: string; description: string | null }>(
        topicsQ.text,
        topicsQ.values,
      );

      // ADAPTIVE page: only show the topics preference center when the workspace
      // has topic management ENABLED (settings.topics_enabled, default ON) AND it
      // has ≥1 active topic. Otherwise this falls back to the SIMPLE /unsubscribe
      // confirm page (one source of truth) — a plain full opt-out.
      const topicsEnabled = await readTopicsEnabled(deps.reader, workspaceId);
      const showTopics = topicsEnabled && activeTopics.length > 0;

      if (!showTopics) {
        // SIMPLE flow — identical page + write as GET/POST /unsubscribe.
        if (method === 'GET') {
          return { statusCode: 200, headers: HTML_HEADERS, body: confirmPage(email, url, logoHtml, lang) };
        }
        await deps.runInWorkspaceTx(
          workspaceId,
          simpleUnsubscribeStatements(workspaceId, email, parsed.broadcastId, parsed.campaignId, 'preference-center'),
        );
        return { statusCode: 200, headers: HTML_HEADERS, body: donePage(email, logoHtml, lang) };
      }

      const tStateQ = buildTopicStateQuery(workspaceId, email);
      const { rows: tState } = await deps.reader.query<{ topic_id: string; subscribed: boolean }>(
        tStateQ.text,
        tStateQ.values,
      );
      const gStateQ = buildGroupStateQuery(workspaceId, email);
      const { rows: gState } = await deps.reader.query<{ medium_group: string }>(gStateQ.text, gStateQ.values);
      const optedOutGroups = new Set(gState.map((r) => r.medium_group));

      // The GLOBAL kill switch (a full /unsubscribe sets the suppression + flag but
      // NO granular rows). When set, the recipient is unsubscribed from EVERYTHING —
      // so the page must show every toggle OFF, not the default-on granular view.
      const guQ = buildGlobalUnsubscribedQuery(workspaceId, email);
      const { rows: guRows } = await deps.reader.query<{ unsubscribed: boolean }>(guQ.text, guQ.values);
      const globallyUnsubscribed = Boolean(guRows[0]?.unsubscribed);

      const groupSubscribed: Record<string, boolean> = {};
      for (const g of MEDIUM_GROUPS) groupSubscribed[g] = globallyUnsubscribed ? false : !optedOutGroups.has(g);

      const choices = globallyUnsubscribed
        ? toTopicChoices(activeTopics, tState).map((c) => ({ ...c, subscribed: false }))
        : toTopicChoices(activeTopics, tState);

      if (method === 'GET') {
        return {
          statusCode: 200,
          headers: HTML_HEADERS,
          body: centerPage(email, url, choices, groupSubscribed, logoHtml, lang),
        };
      }

      // POST — write the desired end-state. ONE workspace-scoped tx.
      const update = parsePreferenceUpdate(event.body, activeTopics.map((t) => t.id));

      if (update.unsubscribeAll) {
        // FULL opt-out: every group + every topic + the hard suppression + the
        // global flag + activity. This is the only path that touches suppression.
        const statements: SqlStatement[] = [
          ...MEDIUM_GROUPS.map((g) => buildChannelOptOutWrite(workspaceId, email, g, true)),
          buildOptOutAllTopics(workspaceId, email),
          buildUnsubscribeSuppression(workspaceId, email, 'preference-center'),
          buildUnsubscribedAttribute(workspaceId, email),
          buildUnsubscribeActivity(workspaceId, email),
        ];
        await deps.runInWorkspaceTx(workspaceId, statements);
        return { statusCode: 200, headers: HTML_HEADERS, body: savedPage(email, true, logoHtml, lang) };
      }

      // PARTIAL update: per-topic + per-group writes. NEVER sets the global
      // suppression / unsubscribed flag — the person stays on the list for the
      // still-subscribed channels (the user's key requirement). BUT if they're
      // RE-ENABLING a channel while currently globally unsubscribed, LIFT the
      // master kill switch (delete only the unsubscribe-reason suppression — never
      // a bounce/complaint — and clear the flag) so the choice actually takes
      // effect; otherwise the dispatcher's suppression gate keeps blocking sends.
      const statements: SqlStatement[] = [];
      for (const [topicId, subscribed] of update.topics) {
        statements.push(buildTopicSubscriptionUpsert(workspaceId, email, topicId, subscribed));
      }
      for (const [group, subscribed] of update.groups) {
        statements.push(buildChannelOptOutWrite(workspaceId, email, group, !subscribed));
      }
      const anyChannelOn = MEDIUM_GROUPS.some((g) => update.groups.get(g) === true);
      if (globallyUnsubscribed && anyChannelOn) {
        statements.push(
          buildResubscribeSuppressionDelete(workspaceId, email),
          buildResubscribedAttribute(workspaceId, email),
        );
      }
      if (statements.length) await deps.runInWorkspaceTx(workspaceId, statements);
      return { statusCode: 200, headers: HTML_HEADERS, body: savedPage(email, false, logoHtml, lang) };
    } catch {
      return {
        statusCode: 500,
        headers: HTML_HEADERS,
        body: shell(errStrings.manageTitle, `<h1>${esc(errStrings.somethingWrongTitle)}</h1><p>${esc(errStrings.tryAgain)}</p>`, '', fallbackLang),
      };
    }
  };
}
