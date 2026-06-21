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
import { expandCustomerToken, type WorkspaceStatus } from '@cdp/shared';

/** A parameterized query ready for `pool.query(text, values)` (shared shape). */
export interface SqlStatement {
  readonly text: string;
  readonly values: unknown[];
}

/** Quiet-hours window in UTC hours (this phase: UTC, no per-recipient tz). */
export interface QuietHoursConfig {
  /** Inclusive start hour [0..23] of the quiet window. */
  readonly startHour: number;
  /** Exclusive end hour [0..23] when sending resumes. */
  readonly endHour: number;
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
  /** Merge values substituted into the compiled HTML. */
  readonly merge: Readonly<Record<string, string>>;
  /** Frequency cap (max sends per window); null/0 → no cap. */
  readonly frequencyCapPerDays: number | null | undefined;
  /** Quiet-hours window; null → never quiet. */
  readonly quietHours: QuietHoursConfig | null;
  /** Count of sends in the rolling window (from messages_log). */
  readonly recentSendCount: number;
  /** Whether the recipient is suppressed (per-workspace OR global hard bounce). */
  readonly isSuppressed: boolean;
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
 * True iff the recent send count has reached/exceeded the cap (so the NEXT send
 * is blocked). A null/undefined/zero cap means "no cap" → never over.
 */
export function isOverCap(recentCount: number, cap: number | null | undefined): boolean {
  if (!cap || cap <= 0) return false;
  return recentCount >= cap;
}

// ── quiet-hours ──────────────────────────────────────────────────────────────

/**
 * Whether `now` falls inside the quiet-hours window (UTC). Handles the
 * midnight-wrap case (start > end spans midnight, e.g. 22:00–06:00). A null
 * config means quiet hours are never in effect.
 */
export function isInQuietHours(now: Date, config: QuietHoursConfig | null): boolean {
  if (!config) return false;
  const h = now.getUTCHours();
  const { startHour, endHour } = config;
  if (startHour === endHour) return false;
  if (startHour < endHour) {
    // Same-day window [start, end).
    return h >= startHour && h < endHour;
  }
  // Midnight-wrap window: [start, 24) ∪ [0, end).
  return h >= startHour || h < endHour;
}

/**
 * The next instant the send is eligible. If not in quiet hours, returns `now`
 * unchanged. Otherwise returns the upcoming window-end (the `endHour` boundary),
 * rolling to the next day when the wrap window pushes the end past midnight.
 */
export function nextSendableAt(now: Date, config: QuietHoursConfig | null): Date {
  if (!config || !isInQuietHours(now, config)) return now;
  const result = new Date(now.getTime());
  result.setUTCHours(config.endHour, 0, 0, 0);
  // If the computed end is at/before now, the window-end is on the next day
  // (midnight-wrap, late-night case).
  if (result.getTime() <= now.getTime()) {
    result.setUTCDate(result.getUTCDate() + 1);
  }
  return result;
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
  // 1. gate
  if (!canSend(ctx.workspace)) {
    return {
      action: 'refuse',
      reason: 'workspace not active/verified',
      stoppedAt: 'gate',
    };
  }
  // 2. suppression
  if (ctx.isSuppressed) {
    return { action: 'skip', reason: 'recipient suppressed', stoppedAt: 'suppression' };
  }
  // 2b. soft-bounce cooldown — give a transiently-failing mailbox time to clear
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
  if (isOverCap(ctx.recentSendCount, ctx.frequencyCapPerDays)) {
    return {
      action: 'skip',
      reason: 'frequency cap reached',
      stoppedAt: 'frequency-cap',
    };
  }
  // 4. quiet hours
  if (isInQuietHours(ctx.now, ctx.quietHours)) {
    return {
      action: 'defer',
      reason: 'within quiet hours',
      stoppedAt: 'quiet-hours',
      deferUntil: nextSendableAt(ctx.now, ctx.quietHours),
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
 *  Attributed to its campaign OR broadcast (whichever queued it) for per-send stats. */
export function buildMessagesLogInsert(
  workspaceId: string,
  profileId: string,
  campaignId: string | null,
  sesMessageId: string,
  broadcastId: string | null = null,
): SqlStatement {
  if (!workspaceId) throw new Error('buildMessagesLogInsert: workspaceId is required');
  return {
    text: `INSERT INTO messages_log (workspace_id, profile_id, campaign_id, broadcast_id, ses_message_id, status)
           VALUES ($1, $2, $3, $4, $5, 'sent')`,
    values: [workspaceId, profileId, campaignId, broadcastId, sesMessageId],
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
