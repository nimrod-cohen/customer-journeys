// Dispatcher pure core (§9). No I/O — the orchestrator (dispatch.ts) and the
// handler inject readers + the SES client + a workspace-scoped tx runner and
// wire these. Everything here is deterministic (injected clock) and unit-tested
// without AWS or Postgres.
//
// The single most important property is the guard ORDER (CLAUDE.md invariant 7):
//   gate(canSend) → suppression → frequency-cap → quiet-hours → send
// decideDispatch runs them in that fixed order and SHORT-CIRCUITS at the first
// block (lazy — later predicates are not evaluated once blocked). SES SendEmail
// is reached ONLY on the all-pass 'send' path.
import { createHash } from 'node:crypto';
import { canSend, buildListUnsubscribeHeaders, type SendingIdentity } from '@cdp/email';
import type { SendEmailInput } from '@cdp/email';
import { expandCustomerToken, zonedComponents, type WorkspaceStatus } from '@cdp/shared';
import type { ChannelMessage, Medium, MediumGroup } from '@cdp/channels';

/** A parameterized query ready for `pool.query(text, values)` (shared shape). */
export interface SqlStatement {
  readonly text: string;
  readonly values: unknown[];
}

/**
 * A quiet window in the weekly cycle: from (startDay, startMinute) to (endDay,
 * endMinute). Days are 0=Sunday … 6=Saturday; minutes are minutes-past-midnight
 * (0..1439, 30-minute steps in the UI). A window may span days (Fri 16:00 → Sat
 * 21:00) and may wrap the week (Sat 22:00 → Sun 06:00). Evaluated in the workspace
 * timezone.
 */
export interface QuietWindow {
  readonly startDay: number;
  readonly startMinute: number;
  readonly endDay: number;
  readonly endMinute: number;
}
/** A set of quiet windows; a moment is quiet if it falls in ANY window (union). */
export type QuietSchedule = readonly QuietWindow[];

/** Frequency cap: at most `max` messages per recipient in a rolling `days`-day window. */
export interface FrequencyCap {
  readonly max: number;
  readonly days: number;
}

/** The minimal workspace shape the dispatcher inspects (§10). */
export interface DispatchWorkspace {
  readonly id: string;
  readonly status: WorkspaceStatus | string;
  readonly sending_identity: SendingIdentity | null | undefined;
}

/** The minimal profile shape (the recipient). */
export interface DispatchProfile {
  readonly id: string;
  readonly email: string | null | undefined;
}

/** The compiled template body to render + send (no hand-rolled HTML). */
export interface DispatchTemplate {
  readonly compiledHtml: string;
}

/**
 * Everything decideDispatch / buildSendEmailInput need, already loaded by the
 * orchestrator (DB reads happen there, not here). The decision is a pure
 * function of this context.
 */
export interface DispatchContext {
  readonly workspace: DispatchWorkspace;
  readonly profile: DispatchProfile;
  readonly template: DispatchTemplate;
  readonly subject: string;
  /**
   * The sending medium (CLAUDE.md multi-channel). Defaults to `email` when
   * absent (every legacy send is email). For `sms`/`whatsapp` the send goes via
   * a `ChannelProvider` to the recipient PHONE using `textBody` (no MJML/HTML),
   * and the verified-domain gate is SKIPPED (that gate is email-only).
   */
  readonly medium?: Medium;
  /** The plain-text SMS/WhatsApp body (merge-tag enabled). Email uses `template`. */
  readonly textBody?: string | null;
  /**
   * WhatsApp only: an approved Meta message TEMPLATE for a business-initiated send.
   * `params` are merge-tag expressions rendered per recipient and mapped IN ORDER to
   * the template's {{1}},{{2}},… body variables. When present the WhatsApp send is a
   * `type:'template'` message; absent → free-form `textBody` text (24h window / mock).
   */
  readonly whatsappTemplate?: { readonly name: string; readonly language: string; readonly params: readonly string[] } | null;
  /** The recipient's phone (`customer.phone`) for sms/whatsapp. */
  readonly phone?: string | null;
  /** Merge values substituted into the compiled HTML. */
  readonly merge: Readonly<Record<string, string>>;
  /** Frequency cap (max messages per rolling `days` window); null → no cap. */
  readonly frequencyCap: FrequencyCap | null;
  /** Per-weekday quiet schedule; null → never quiet. Evaluated in `timeZone`. */
  readonly quietHours: QuietSchedule | null;
  /** Workspace IANA timezone (default 'UTC') — the clock for quiet hours. */
  readonly timeZone: string;
  /** Count of sends in the rolling window (from messages_log). */
  readonly recentSendCount: number;
  /** Whether the recipient is suppressed (per-workspace OR global hard bounce). */
  readonly isSuppressed: boolean;
  /**
   * Whether the recipient has opted OUT of this message's MEDIUM GROUP
   * (CLAUDE.md topic-subscriptions): a `channel_optouts` row for `email` or
   * `sms_whatsapp`. A GLOBAL per-group opt-out — independent of any topic. When
   * true the send is SKIPPED (recorded, never crashes the batch). Defaults false.
   */
  readonly optedOutOfMedium?: boolean;
  /**
   * Whether the recipient is unsubscribed from this message's TOPIC: the message
   * carries a `topic_id` AND a `topic_subscriptions` row says `subscribed=false`.
   * Topic subscription is DEFAULT-ON (absence of a row = subscribed), so this is
   * true ONLY for an explicit topic opt-out. When true the send is SKIPPED.
   * Defaults false (an untopiced message, or a still-subscribed recipient).
   */
  readonly topicUnsubscribed?: boolean;
  /**
   * Timestamp of the recipient's most recent soft bounce, if any. While within
   * SOFT_BOUNCE_COOLDOWN_HOURS after it, the address is given time to recover and
   * is NOT mailed (the send is deferred). Absent/null → no cooldown.
   */
  readonly lastSoftBounceAt?: Date | null;
  /** Injected clock for cap/quiet determinism. */
  readonly now: Date;
  /** Public base URL of the unsubscribe endpoint (§9 step 5). */
  readonly unsubscribeBaseUrl: string;
  /**
   * The HMAC link secret. When present, the List-Unsubscribe header link carries
   * the NEW compact self-contained `?t=` token (packed from workspace+email). The
   * unsubscribe / manage-subscription handlers verify with the SAME secret.
   */
  readonly unsubscribeLinkSecret?: string | null;
  /**
   * LEGACY: a precomputed signed HMAC token (only used when no secret is supplied)
   * — emits the old `?token=` form for back-compat.
   */
  readonly unsubscribeToken?: string | null;
  /**
   * Optional named-sender override (a domain_senders row chosen on the broadcast
   * or campaign send-node). When present the From becomes `"name" <email>`
   * instead of the no-reply@<domain> fallback. The email must be on a verified
   * workspace domain (domain_senders are verified-domain-only).
   */
  readonly fromEmail?: string | null;
  readonly fromName?: string | null;
  /**
   * The recipient token from the email instance (default `{{customer.email}}`),
   * rendered per recipient via the merge map. Falls back to the profile email
   * when absent or when it renders empty.
   */
  readonly toAddress?: string | null;
  /** Source broadcast — carried into the List-Unsubscribe header for attribution. */
  readonly broadcastId?: string | null;
  /** Source campaign — carried into the List-Unsubscribe header for attribution. */
  readonly campaignId?: string | null;
}

/** Hours to hold off mailing an address after a soft bounce (give it time to clear). */
export const SOFT_BOUNCE_COOLDOWN_HOURS = 24;

/** Where in the fixed guard pipeline a decision stopped. */
export type GuardStage =
  | 'gate'
  | 'suppression'
  | 'medium-optout'
  | 'topic-optout'
  | 'soft-bounce-cooldown'
  | 'frequency-cap'
  | 'quiet-hours';

/** The outcome of the decision pipeline. */
export interface DispatchDecision {
  readonly action: 'send' | 'refuse' | 'skip' | 'defer';
  readonly reason: string;
  /** The guard that blocked (absent on a clean 'send'). */
  readonly stoppedAt?: GuardStage;
  /** For 'defer': the instant the send becomes eligible again. */
  readonly deferUntil?: Date;
}

// ── frequency-cap ──────────────────────────────────────────────────────────

/**
 * Lower bound of the rolling frequency-cap window: `now - capPerDays days`.
 * Pure; used to build the recent-send-count query bound.
 */
export function windowStart(now: Date, capPerDays: number): Date {
  return new Date(now.getTime() - capPerDays * 24 * 60 * 60 * 1000);
}

/**
 * True iff the recent send count (over the cap's `days` window) has reached the
 * cap's `max` (so the NEXT send is blocked). A null cap / non-positive max|days
 * means "no cap" → never over.
 */
export function isOverCap(recentCount: number, cap: FrequencyCap | null | undefined): boolean {
  if (!cap || cap.max <= 0 || cap.days <= 0) return false;
  return recentCount >= cap.max;
}

// ── quiet-hours ──────────────────────────────────────────────────────────────

/** Absolute minute-of-week (0..10079) for a (day 0=Sun..6=Sat, minute-of-day). */
function weekMinute(day: number, minuteOfDay: number): number {
  return day * 1440 + minuteOfDay;
}

/** Whether week-minute `wm` falls inside window `w` (handles the week wrap). */
function inQuietWindow(wm: number, w: QuietWindow): boolean {
  const start = weekMinute(w.startDay, w.startMinute);
  const end = weekMinute(w.endDay, w.endMinute);
  if (start === end) return false; // empty window
  return start < end ? wm >= start && wm < end : wm >= start || wm < end;
}

/**
 * Whether `now` falls in ANY quiet window, evaluated in the workspace `timeZone`.
 * A null/empty schedule means quiet hours are off.
 */
export function isInQuietHours(now: Date, schedule: QuietSchedule | null, timeZone: string): boolean {
  if (!schedule || schedule.length === 0) return false;
  const { weekday, hour, minute } = zonedComponents(now, timeZone);
  const wm = weekMinute(weekday, hour * 60 + minute);
  return schedule.some((w) => inQuietWindow(wm, w));
}

/**
 * The next instant sending is allowed: `now` if not quiet, else the next 30-minute
 * boundary (the picker granularity) that falls outside every window. Steps in
 * 30-min increments (bounded to 8 days), re-evaluating in `timeZone` each step, so
 * it handles multi-day windows, week-wraps, and DST.
 */
export function nextSendableAt(now: Date, schedule: QuietSchedule | null, timeZone: string): Date {
  if (!isInQuietHours(now, schedule, timeZone)) return now;
  const STEP = 30 * 60_000; // 30 minutes
  let t = new Date(Math.ceil((now.getTime() + 1) / STEP) * STEP); // next 30-min boundary strictly after now
  for (let i = 0; i < 8 * 48; i++) {
    if (!isInQuietHours(t, schedule, timeZone)) return t;
    t = new Date(t.getTime() + STEP);
  }
  return t; // fallback (quiet all week — misconfig)
}

// ── rendering + SES input ────────────────────────────────────────────────────

/**
 * Substitute `{{key}}` merge tags in the compiled template HTML with the merge
 * values. Whitespace inside the braces is tolerated; unknown tags are left
 * untouched. No hand-rolled HTML — the template body is the workspace's compiled
 * HTML (§11), this only fills merge fields.
 *
 * `customer.*` tags get the systemwide shorthand expanded first, so
 * `{{customer.tier}}` and `{{customer.attributes.tier}}` resolve to the SAME
 * value (the merge map is keyed by the canonical token; see `customerMerge`).
 */
export function renderTemplateBody(
  compiledHtml: string,
  merge: Readonly<Record<string, string>>,
): string {
  return compiledHtml.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key: string) => {
    const value = merge[expandCustomerToken(key)] ?? merge[key];
    return value === undefined ? match : value;
  });
}

/**
 * Rewrite http(s) links in an email body to tracked `/<baseUrl>/t/<token>` links
 * (§10 click tracking). The token is DETERMINISTIC per (workspace, source, url)
 * so every recipient of the same send shares it (we count total clicks per link),
 * and re-sends/retries are idempotent. Returns the rewritten HTML + the unique
 * links to persist. Pure (sha256-based token; no randomness → safe to re-run).
 */
export interface TrackedLink {
  readonly token: string;
  readonly url: string;
}
export function rewriteTrackingLinks(
  html: string,
  opts: { baseUrl: string; workspaceId: string; broadcastId: string | null; campaignId: string | null },
): { html: string; links: TrackedLink[] } {
  const seen = new Map<string, string>(); // url → token
  const links: TrackedLink[] = [];
  const source = opts.broadcastId ?? opts.campaignId ?? '';
  const out = html.replace(/(\bhref\s*=\s*)(["'])(https?:\/\/[^"']+)\2/gi, (_m, pre: string, q: string, url: string) => {
    let token = seen.get(url);
    if (!token) {
      token = createHash('sha256').update(`${opts.workspaceId}|${source}|${url}`).digest('hex').slice(0, 16);
      seen.set(url, token);
      links.push({ token, url });
    }
    return `${pre}${q}${opts.baseUrl.replace(/\/$/, '')}/t/${token}${q}`;
  });
  return { html: out, links };
}

// ── open tracking (§10) ──────────────────────────────────────────────────────

/**
 * Deterministic open-pixel token per (workspace, source, profile). Unlike a
 * tracked LINK (shared across recipients to count total clicks), an open pixel is
 * PER-RECIPIENT so we can attribute the open to a specific profile and count
 * DISTINCT-profile opens (one tracked_opens row per token ⇒ per recipient). A
 * re-send/retry to the same recipient reuses the token (idempotent upsert).
 */
export function openPixelToken(opts: {
  workspaceId: string;
  broadcastId: string | null;
  campaignId: string | null;
  profileId: string;
}): string {
  const source = opts.broadcastId ?? opts.campaignId ?? '';
  return createHash('sha256')
    .update(`open|${opts.workspaceId}|${source}|${opts.profileId}`)
    .digest('hex')
    .slice(0, 24);
}

/** A 1x1 transparent tracking pixel `<img>` pointing at the /o/<token> endpoint. */
export function buildOpenPixelImg(url: string): string {
  return `<img src="${url}" width="1" height="1" alt="" style="display:none" />`;
}

/**
 * Inject the open-tracking pixel into the email HTML. The pixel loads the
 * /o/<token> endpoint (which records the open + returns a gif). Inserted just
 * before `</body>` when present, else appended. Returns the rewritten HTML +
 * the token (to upsert a tracked_opens row). Pure (deterministic token).
 */
export function injectOpenPixel(
  html: string,
  opts: { baseUrl: string; workspaceId: string; broadcastId: string | null; campaignId: string | null; profileId: string },
): { html: string; token: string } {
  const token = openPixelToken(opts);
  const url = `${opts.baseUrl.replace(/\/$/, '')}/o/${token}`;
  const img = buildOpenPixelImg(url);
  const lower = html.toLowerCase();
  const bodyClose = lower.lastIndexOf('</body>');
  const out =
    bodyClose >= 0 ? `${html.slice(0, bodyClose)}${img}${html.slice(bodyClose)}` : `${html}${img}`;
  return { html: out, token };
}

/**
 * Upsert-record (or pre-create) a tracked_opens row. Used by the dispatcher to
 * PRE-CREATE the row at send time (opens=0) so the funnel can attribute an open
 * even before the pixel loads, and by the /o/<token> endpoint to bump the count.
 * Idempotent on the token PK (workspace_id at $1).
 */
export function buildTrackedOpenInsert(
  workspaceId: string,
  token: string,
  broadcastId: string | null,
  campaignId: string | null,
  profileId: string | null,
): SqlStatement {
  // workspace_id bound at $1 — the tx scoping guard (runStatementsInWorkspaceTx)
  // requires the first param to be the workspace id (service role bypasses RLS).
  return {
    text: `INSERT INTO tracked_opens (workspace_id, token, broadcast_id, campaign_id, profile_id)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (token) DO NOTHING`,
    values: [workspaceId, token, broadcastId, campaignId, profileId],
  };
}

/** Upsert a tracked link (idempotent on the token PK). workspace_id at $1. */
export function buildTrackedLinkInsert(
  workspaceId: string,
  link: TrackedLink,
  broadcastId: string | null,
  campaignId: string | null,
): SqlStatement {
  // workspace_id bound at $1 — the tx scoping guard (runStatementsInWorkspaceTx)
  // requires the first param to be the workspace id (service role bypasses RLS).
  return {
    text: `INSERT INTO tracked_links (workspace_id, token, broadcast_id, campaign_id, url)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (token) DO NOTHING`,
    values: [workspaceId, link.token, broadcastId, campaignId, link.url],
  };
}

/**
 * Derive the From address: a chosen named sender (`"Name" <email>`) when set on
 * the send, otherwise the workspace's no-reply@<verified-domain> fallback (§10).
 */
function fromAddress(
  identity: SendingIdentity | null | undefined,
  fromEmail?: string | null,
  fromName?: string | null,
): string {
  if (fromEmail) {
    return fromName ? `${quotePhrase(fromName)} <${fromEmail}>` : fromEmail;
  }
  const domain = identity?.from_domain;
  if (!domain) throw new Error('buildSendEmailInput: workspace has no sending from_domain');
  return `no-reply@${domain}`;
}

/** Quote a display name for an RFC 5322 From phrase, escaping embedded quotes. */
function quotePhrase(name: string): string {
  return `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Build the SES SendEmailInput for an all-pass send (§9 step 5/6):
 *   - From   ← workspace sending_identity.from_domain
 *   - ConfigurationSetName ← workspace sending_identity.config_set (§10)
 *   - html   ← compiled template rendered with merge values (no hand-rolled HTML)
 *   - headers ← workspace-scoped RFC 8058 List-Unsubscribe pair (§9 step 5)
 */
export function buildSendEmailInput(ctx: DispatchContext): SendEmailInput {
  const email = ctx.profile.email;
  if (!email) throw new Error('buildSendEmailInput: profile has no email');
  // The To token (default {{customer.email}}) renders to the recipient; fall back
  // to the profile email when blank. Suppression/unsubscribe still key on the
  // profile email — the person — regardless of the rendered To.
  const renderedTo = ctx.toAddress ? renderTemplateBody(ctx.toAddress, ctx.merge).trim() : '';
  const to = renderedTo || email;
  const headers = buildListUnsubscribeHeaders({
    baseUrl: ctx.unsubscribeBaseUrl,
    workspaceId: ctx.workspace.id,
    email,
    // Prefer the secret (emits the compact `?t=` token); fall back to a legacy
    // precomputed token for back-compat.
    ...(ctx.unsubscribeLinkSecret
      ? { secret: ctx.unsubscribeLinkSecret }
      : ctx.unsubscribeToken
        ? { token: ctx.unsubscribeToken }
        : {}),
    broadcastId: ctx.broadcastId ?? null,
    campaignId: ctx.campaignId ?? null,
  });
  const configSet = ctx.workspace.sending_identity?.config_set;
  return {
    from: fromAddress(ctx.workspace.sending_identity, ctx.fromEmail, ctx.fromName),
    to,
    // The subject is personalized too — merge tags ({{customer.*}}) render per
    // recipient, exactly like the To and the body.
    subject: renderTemplateBody(ctx.subject, ctx.merge),
    html: renderTemplateBody(ctx.template.compiledHtml, ctx.merge),
    ...(configSet ? { configurationSetName: configSet } : {}),
    headers: { ...headers },
  };
}

// ── the decision pipeline ────────────────────────────────────────────────────

/**
 * Run the fixed guard pipeline in order, short-circuiting (lazily) at the first
 * block (CLAUDE.md invariant 7):
 *   1. gate(canSend)   — workspace active + verified, else 'refuse'
 *   2. suppression     — suppressed recipient, else 'skip'
 *   3. frequency-cap   — over cap, else 'skip'
 *   4. quiet-hours     — in quiet window, else 'defer' (with deferUntil)
 *   5. send            — all pass
 * Later predicates are NOT evaluated once a guard blocks.
 */
export function decideDispatch(ctx: DispatchContext): DispatchDecision {
  // 1. gate — MEDIUM-AWARE. The VERIFIED-DOMAIN gate (canSend) is EMAIL-ONLY
  //    (a verified sending domain is meaningless for SMS/WhatsApp). For the text
  //    channels we still refuse a non-active (onboarding/suspended) workspace —
  //    a suspended workspace must not send over ANY channel — but we do NOT
  //    require a verified email domain. The provider always resolves (the mock),
  //    so a text send's gate is purely the workspace-active check.
  const medium = ctx.medium ?? 'email';
  const gateOk = medium === 'email' ? canSend(ctx.workspace) : ctx.workspace.status === 'active';
  if (!gateOk) {
    return {
      action: 'refuse',
      reason: medium === 'email' ? 'workspace not active/verified' : 'workspace not active',
      stoppedAt: 'gate',
    };
  }
  // 2. suppression
  if (ctx.isSuppressed) {
    return { action: 'skip', reason: 'recipient suppressed', stoppedAt: 'suppression' };
  }
  // 2a. medium-group opt-out — the recipient opted out of this whole channel
  //     family (email or sms_whatsapp). A GLOBAL preference, independent of any
  //     topic; checked right after the hard suppression (both are recipient-level
  //     opt-outs that must short-circuit before topic / cap / quiet checks).
  if (ctx.optedOutOfMedium) {
    return { action: 'skip', reason: 'recipient opted out of this channel', stoppedAt: 'medium-optout' };
  }
  // 2b. topic opt-out — the message is tagged with a topic the recipient
  //     unsubscribed from (topic_subscriptions.subscribed=false). Default-on, so
  //     this only fires on an explicit topic opt-out.
  if (ctx.topicUnsubscribed) {
    return { action: 'skip', reason: 'recipient unsubscribed from this topic', stoppedAt: 'topic-optout' };
  }
  // 2c. soft-bounce cooldown — give a transiently-failing mailbox time to clear
  //     before mailing it again (defer, don't drop).
  if (ctx.lastSoftBounceAt) {
    const eligibleAt = new Date(
      ctx.lastSoftBounceAt.getTime() + SOFT_BOUNCE_COOLDOWN_HOURS * 60 * 60 * 1000,
    );
    if (ctx.now.getTime() < eligibleAt.getTime()) {
      return {
        action: 'defer',
        reason: 'within soft-bounce cooldown',
        stoppedAt: 'soft-bounce-cooldown',
        deferUntil: eligibleAt,
      };
    }
  }
  // 3. frequency cap
  if (isOverCap(ctx.recentSendCount, ctx.frequencyCap)) {
    return {
      action: 'skip',
      reason: 'frequency cap reached',
      stoppedAt: 'frequency-cap',
    };
  }
  // 4. quiet hours (per weekday, in the workspace timezone)
  if (isInQuietHours(ctx.now, ctx.quietHours, ctx.timeZone)) {
    return {
      action: 'defer',
      reason: 'within quiet hours',
      stoppedAt: 'quiet-hours',
      deferUntil: nextSendableAt(ctx.now, ctx.quietHours, ctx.timeZone),
    };
  }
  // 5. send
  return { action: 'send', reason: 'all guards passed' };
}

// ── SqlStatement builders (all workspace-scoped, workspace_id bound at $1) ────

/**
 * Atomically CLAIM a pending outbox row (idempotent dispatch). Flips
 * status='pending' → 'sending' and increments attempts in ONE statement,
 * RETURNING the row only if it WON the claim. A concurrent/replayed invocation
 * finds status already moved and gets no row — so the send happens once.
 * workspace_id is bound at $1 (in-code scoping; service role bypasses RLS).
 */
export function buildOutboxClaim(workspaceId: string, outboxId: string): SqlStatement {
  if (!workspaceId) throw new Error('buildOutboxClaim: workspaceId is required');
  return {
    text: `UPDATE outbox
           SET status = 'sending', attempts = attempts + 1
           WHERE workspace_id = $1 AND id = $2 AND status = 'pending'
           RETURNING id, workspace_id, profile_id, campaign_id, template_id,
                     dedupe_key, attempts, payload`,
    values: [workspaceId, outboxId],
  };
}

/** Mark a claimed outbox row sent (terminal). workspace_id bound at $1. */
export function buildOutboxMarkSent(workspaceId: string, outboxId: string): SqlStatement {
  if (!workspaceId) throw new Error('buildOutboxMarkSent: workspaceId is required');
  return {
    text: `UPDATE outbox
           SET status = 'sent', sent_at = now()
           WHERE workspace_id = $1 AND id = $2`,
    values: [workspaceId, outboxId],
  };
}

/**
 * Count this recipient's sends in the rolling cap window from messages_log
 * (§9 step 3, per workspace). Bound by (workspace_id, profile_id, sent_at >=
 * windowStart). workspace_id bound at $1.
 */
export function buildRecentSendCountQuery(
  workspaceId: string,
  profileId: string,
  since: Date,
): SqlStatement {
  if (!workspaceId) throw new Error('buildRecentSendCountQuery: workspaceId is required');
  return {
    text: `SELECT count(*)::int AS n
           FROM messages_log
           WHERE workspace_id = $1 AND profile_id = $2 AND sent_at >= $3::timestamptz`,
    values: [workspaceId, profileId, since.toISOString()],
  };
}

/**
 * Is this recipient suppressed? True if (workspace_id, email) is in suppressions
 * (per-workspace) OR email is in global_hard_bounces (cross-workspace). citext
 * makes the match case-insensitive. workspace_id bound at $1; the email param is
 * reused for both arms. Returns a single boolean column `suppressed`.
 */
export function buildIsSuppressedQuery(workspaceId: string, email: string): SqlStatement {
  if (!workspaceId) throw new Error('buildIsSuppressedQuery: workspaceId is required');
  return {
    text: `SELECT EXISTS (
             SELECT 1 FROM suppressions WHERE workspace_id = $1 AND email = $2
           ) OR EXISTS (
             SELECT 1 FROM global_hard_bounces WHERE email = $2
           ) AS suppressed`,
    values: [workspaceId, email],
  };
}

/**
 * Has this recipient opted OUT of the message's MEDIUM GROUP? True iff a
 * `channel_optouts` row exists for (workspace_id, profile_id, medium_group). A
 * GLOBAL per-group opt-out (CLAUDE.md topic-subscriptions). workspace_id at $1;
 * returns a single boolean column `opted_out`.
 */
export function buildMediumOptOutQuery(
  workspaceId: string,
  profileId: string,
  mediumGroup: MediumGroup,
): SqlStatement {
  if (!workspaceId) throw new Error('buildMediumOptOutQuery: workspaceId is required');
  return {
    text: `SELECT EXISTS (
             SELECT 1 FROM channel_optouts
             WHERE workspace_id = $1 AND profile_id = $2 AND medium_group = $3
           ) AS opted_out`,
    values: [workspaceId, profileId, mediumGroup],
  };
}

/**
 * Is this recipient unsubscribed from the message's TOPIC? Topic subscription is
 * DEFAULT-ON, so this is true ONLY when an explicit `topic_subscriptions` row
 * says `subscribed=false`. workspace_id at $1; returns a single boolean column
 * `unsubscribed`.
 */
export function buildTopicUnsubscribedQuery(
  workspaceId: string,
  profileId: string,
  topicId: string,
): SqlStatement {
  if (!workspaceId) throw new Error('buildTopicUnsubscribedQuery: workspaceId is required');
  return {
    text: `SELECT EXISTS (
             SELECT 1 FROM topic_subscriptions
             WHERE workspace_id = $1 AND profile_id = $2 AND topic_id = $3 AND subscribed = false
           ) AS unsubscribed`,
    values: [workspaceId, profileId, topicId],
  };
}

/**
 * The recipient's most recent soft-bounce time, or null. Powers the 24h cooldown
 * (don't re-mail a transiently-failing address immediately). workspace_id at $1.
 */
export function buildLastSoftBounceQuery(workspaceId: string, email: string): SqlStatement {
  if (!workspaceId) throw new Error('buildLastSoftBounceQuery: workspaceId is required');
  return {
    text: `SELECT max(occurred_at) AS at
           FROM email_events
           WHERE workspace_id = $1 AND type = 'bounce' AND sub_type = 'Transient'
             AND raw->>'recipient' = $2`,
    values: [workspaceId, email],
  };
}

/** A successful send's messages_log row (§9 step 7). workspace_id bound at $1.
 *  Attributed to its campaign OR broadcast (whichever queued it) for per-send stats.
 *  `medium` records the channel (email default; sms/whatsapp for text sends) and
 *  `ses_message_id` carries the provider message id regardless of channel. */
export function buildMessagesLogInsert(
  workspaceId: string,
  profileId: string,
  campaignId: string | null,
  sesMessageId: string,
  broadcastId: string | null = null,
  medium: Medium = 'email',
): SqlStatement {
  if (!workspaceId) throw new Error('buildMessagesLogInsert: workspaceId is required');
  return {
    text: `INSERT INTO messages_log (workspace_id, profile_id, campaign_id, broadcast_id, ses_message_id, status, medium)
           VALUES ($1, $2, $3, $4, $5, 'sent', $6)`,
    values: [workspaceId, profileId, campaignId, broadcastId, sesMessageId, medium],
  };
}

/**
 * A FAILED/SKIPPED send's messages_log row (a text send with no recipient phone /
 * an invalid phone, a recipient with no email, a guard skip, or a provider
 * failure) — recorded so the batch never crashes and the outcome is visible,
 * mirroring how email skips/refusals are handled. `ses_message_id` is null
 * (nothing was sent). The optional `reason` is the human WHY (e.g. 'recipient has
 * no phone', 'invalid phone number', 'frequency cap reached', or a captured
 * provider error) — surfaced in the activity feed. workspace_id bound at $1.
 */
export function buildMessagesLogFailure(
  workspaceId: string,
  profileId: string,
  campaignId: string | null,
  broadcastId: string | null,
  medium: Medium,
  status: 'failed' | 'skipped',
  reason: string | null = null,
): SqlStatement {
  if (!workspaceId) throw new Error('buildMessagesLogFailure: workspaceId is required');
  return {
    text: `INSERT INTO messages_log (workspace_id, profile_id, campaign_id, broadcast_id, ses_message_id, status, medium, reason)
           VALUES ($1, $2, $3, $4, NULL, $5, $6, $7)`,
    values: [workspaceId, profileId, campaignId, broadcastId, status, medium, reason],
  };
}

/**
 * Resolve the text-channel recipient (a PHONE) for an sms/whatsapp send. The To
 * is the `toAddress` token (default `{{customer.phone}}`), rendered per recipient
 * via the merge map. An UNRESOLVED token (the merge map had no value, so the
 * `{{...}}` is left intact) or an empty render means the recipient has NO phone —
 * we return '' so the orchestrator records a messages_log skip (mirroring how a
 * missing email is handled), never sending. Falls back to the raw `ctx.phone`.
 */
export function resolveTextRecipient(ctx: DispatchContext): string {
  if (ctx.toAddress) {
    const rendered = renderTemplateBody(ctx.toAddress, ctx.merge).trim();
    // A still-unresolved `{{...}}` token means the merge had no value → no phone.
    if (rendered && !rendered.includes('{{')) return rendered;
  }
  return (ctx.phone ?? '').trim();
}

/**
 * Build the prepared text-channel message for an sms/whatsapp send. The To is the
 * resolved recipient PHONE (see `resolveTextRecipient`) and the body is `textBody`
 * with merge tags rendered — NO MJML, NO HTML. Throws if the recipient has no
 * phone (the orchestrator checks `resolveTextRecipient` first and records a
 * messages_log skip instead of calling this).
 */
export function buildChannelMessage(ctx: DispatchContext): ChannelMessage {
  const to = resolveTextRecipient(ctx);
  if (!to) throw new Error('buildChannelMessage: recipient has no phone');
  // WhatsApp template: render each param expression per recipient (customer.*/event.* etc.)
  // and map IN ORDER to the template's body variables. Applies to whatsapp only.
  const tpl = ctx.medium === 'whatsapp' && ctx.whatsappTemplate ? ctx.whatsappTemplate : null;
  return {
    to,
    body: renderTemplateBody(ctx.textBody ?? '', ctx.merge),
    ...(tpl
      ? {
          template: {
            name: tpl.name,
            language: tpl.language,
            bodyParams: tpl.params.map((p) => renderTemplateBody(p, ctx.merge)),
          },
        }
      : {}),
  };
}

/**
 * Upsert-increment the monthly usage_counters row for `emails_sent` (§20). The
 * period is the first day of the send month (UTC). workspace_id bound at $1; an
 * ON CONFLICT bumps the existing month's value by 1.
 */
export function buildUsageCounterIncrement(
  workspaceId: string,
  now: Date,
  metric = 'emails_sent',
  delta = 1,
): SqlStatement {
  if (!workspaceId) throw new Error('buildUsageCounterIncrement: workspaceId is required');
  const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
  return {
    text: `INSERT INTO usage_counters (workspace_id, period, metric, value)
           VALUES ($1, $2::date, $3, $4)
           ON CONFLICT (workspace_id, period, metric)
           DO UPDATE SET value = usage_counters.value + EXCLUDED.value`,
    values: [workspaceId, period, metric, delta],
  };
}

// ── SQS parsing ──────────────────────────────────────────────────────────────

/**
 * Extract the outbox id from a (synthetic) SQS record body. The dispatch queue
 * carries `{ outbox_id }` — the workspace_id is NEVER trusted from the body; it
 * is loaded from the outbox row itself (CLAUDE.md invariant 2). Throws on a
 * malformed body so the handler reports a batch item failure.
 */
export function parseOutboxIdFromSqsRecord(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('parseOutboxIdFromSqsRecord: body is not valid JSON');
  }
  const outboxId =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)['outbox_id']
      : undefined;
  if (typeof outboxId !== 'string' || outboxId.length === 0) {
    throw new Error('parseOutboxIdFromSqsRecord: outbox_id is required');
  }
  return outboxId;
}
