// Dispatcher orchestrator (§9). Loads the outbox row + workspace + profile +
// template (all workspace-scoped), runs the FIXED guard pipeline, and on the
// all-pass path sends via SES then writes messages_log + usage_counters + marks
// the outbox row sent in ONE workspace-scoped transaction (runPlanInWorkspaceTx).
//
// CRITICAL invariants enforced here:
//   - workspace_id is loaded FROM the outbox row, never from the SQS body.
//   - The atomic claim (UPDATE ... WHERE status='pending' RETURNING) means a
//     replay/concurrent invocation that loses the claim does NOT send again.
//   - SES SendEmail is called ONLY on the all-pass 'send' path.
//   - On a send, messages_log + usage_counters + outbox-mark-sent commit
//     together (one tx) — a forced failure rolls back all three.
import { buildUnsubscribeUrl, type SendEmailInput, type SesEmailClient } from '@cdp/email';
import {
  decideDispatch,
  windowStart,
  buildOutboxClaim,
  buildRecentSendCountQuery,
  buildIsSuppressedQuery,
  buildLastSoftBounceQuery,
  buildMessagesLogInsert,
  buildUsageCounterIncrement,
  buildOutboxMarkSent,
  buildSendEmailInput,
  rewriteTrackingLinks,
  buildTrackedLinkInsert,
  type DispatchContext,
  type DispatchDecision,
  type QuietHoursConfig,
  type SqlStatement,
  type TrackedLink,
} from './core.js';
import { customerMerge } from '@cdp/shared';

/** A minimal query reader (returns rows). The orchestrator never opens a tx. */
export interface Reader {
  query<T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
}

/** Injected dependencies for the orchestrator — all I/O lives behind these. */
export interface DispatchDeps {
  /** Service-role reader (bypasses RLS → in-code scoping is the guard). */
  readonly reader: Reader;
  /** The injectable SES client (mocked in tests; never sends real mail). */
  readonly ses: SesEmailClient;
  /** Apply a list of statements in ONE workspace-scoped tx (atomic write). */
  runInWorkspaceTx(workspaceId: string, statements: readonly SqlStatement[]): Promise<void>;
  /** Injected clock for cap/quiet determinism. */
  now(): Date;
  /** Public base URL of the unsubscribe endpoint (§9 step 5). */
  readonly unsubscribeBaseUrl: string;
  /** Public base URL the click-tracking redirect (/t/<token>) is served from. */
  readonly linkTrackingBaseUrl: string;
}

/** The terminal result of dispatching one outbox id. */
export type DispatchOutcome =
  | { readonly result: 'send'; readonly sesMessageId: string }
  | { readonly result: 'skip'; readonly reason: string }
  | { readonly result: 'refuse'; readonly reason: string }
  | { readonly result: 'defer'; readonly reason: string; readonly deferUntil: Date }
  | { readonly result: 'noop'; readonly reason: string }
  | { readonly result: 'retryable-failure'; readonly reason: string };

interface OutboxRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly profile_id: string;
  readonly campaign_id: string | null;
  readonly template_id: string | null;
  readonly dedupe_key: string | null;
  readonly attempts: number;
  readonly payload: Record<string, unknown> | null;
}

function parseQuietHours(raw: unknown): QuietHoursConfig | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const startHour = r['startHour'] ?? r['start_hour'];
  const endHour = r['endHour'] ?? r['end_hour'];
  if (typeof startHour !== 'number' || typeof endHour !== 'number') return null;
  return { startHour, endHour };
}

function asStringRecord(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw === null) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
  }
  return out;
}

/**
 * Dispatch one outbox id. Returns a DispatchOutcome the handler maps to
 * ack/retry. Never sends real mail (SES is injected). The atomic claim makes
 * this safe under retries and concurrent invocations.
 */
export async function dispatchOutbox(
  deps: DispatchDeps,
  outboxId: string,
): Promise<DispatchOutcome> {
  // 1. Load the outbox row (NO workspace scoping yet — workspace_id comes FROM
  //    the row, never from the SQS body). Only a pending row matters.
  const { rows: obRows } = await deps.reader.query<OutboxRow>(
    `SELECT id, workspace_id, profile_id, campaign_id, template_id, dedupe_key, attempts, payload
     FROM outbox WHERE id = $1`,
    [outboxId],
  );
  const ob = obRows[0];
  if (!ob) return { result: 'noop', reason: 'outbox row not found' };
  const workspaceId = ob.workspace_id;

  // 2. ATOMIC CLAIM — flip pending→sending; only the winner proceeds. A replay
  //    or concurrent invocation gets no row and must NOT send again.
  const claim = buildOutboxClaim(workspaceId, outboxId);
  const { rows: claimedRows } = await deps.reader.query<OutboxRow>(claim.text, claim.values);
  if (claimedRows.length === 0) {
    return { result: 'noop', reason: 'outbox row not pending (already claimed/sent)' };
  }

  try {
    // 3. Load workspace + profile + template (scoped by workspace_id in code).
    const { rows: wsRows } = await deps.reader.query<{
      id: string;
      status: string;
      sending_identity: Record<string, unknown> | null;
      settings: Record<string, unknown> | null;
    }>(`SELECT id, status, sending_identity, settings FROM workspaces WHERE id = $1`, [workspaceId]);
    const ws = wsRows[0];
    if (!ws) return { result: 'noop', reason: 'workspace not found' };
    const linkTrackingOn = ws.settings?.['link_tracking'] === true;

    // Sending identity: the gate (canSend) + the no-reply@<domain> fallback
    // historically read `workspaces.sending_identity` (§10A). The current model
    // verifies sending domains per-row in `sending_domains`, so derive the
    // effective identity from a VERIFIED sending domain — otherwise a workspace
    // whose domain was verified through the per-domain flow is wrongly refused and
    // has no from_domain. Falls back to any legacy workspace identity (older data).
    const legacyIdentity = (ws.sending_identity ?? {}) as {
      verified?: boolean;
      from_domain?: string;
      config_set?: string;
    };
    const { rows: verifiedDomains } = await deps.reader.query<{ domain: string }>(
      `SELECT domain FROM sending_domains WHERE workspace_id = $1 AND verified = true ORDER BY domain LIMIT 1`,
      [workspaceId],
    );
    const fromDomain = verifiedDomains[0]?.domain ?? legacyIdentity.from_domain;
    const sendingIdentity = {
      verified: verifiedDomains.length > 0 || legacyIdentity.verified === true,
      ...(fromDomain ? { from_domain: fromDomain } : {}),
      ...(legacyIdentity.config_set ? { config_set: legacyIdentity.config_set } : {}),
    };

    const { rows: profRows } = await deps.reader.query<{
      id: string;
      email: string | null;
      external_id: string | null;
      email_status: string | null;
      created_at: string | null;
      attributes: Record<string, unknown> | null;
    }>(
      `SELECT id, email, external_id, email_status, created_at, attributes
       FROM profiles WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, ob.profile_id],
    );
    const profile = profRows[0];
    if (!profile) return { result: 'noop', reason: 'profile not found' };

    // The email instance (template) holds the body AND the envelope (subject /
    // From sender / To token) — NOT the broadcast/campaign. Load all of them.
    let compiledHtml = '';
    let subject = '';
    let toAddress = '';
    let senderId: string | null = null;
    if (ob.template_id) {
      const { rows: tplRows } = await deps.reader.query<{
        compiled_html: string;
        subject: string | null;
        sender_id: string | null;
        to_address: string | null;
      }>(
        `SELECT compiled_html, subject, sender_id, to_address FROM email_templates WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, ob.template_id],
      );
      const tpl = tplRows[0];
      compiledHtml = tpl?.compiled_html ?? '';
      subject = tpl?.subject ?? '';
      toAddress = tpl?.to_address ?? '';
      senderId = tpl?.sender_id ?? null;
    }

    const payload = ob.payload ?? {};
    // Resolve the named sender (if any) → From email/name. Done HERE, the one
    // point all sends cross. No sender → the no-reply@<domain> fallback.
    let fromEmail: string | null = null;
    let fromName: string | null = null;
    if (senderId) {
      const { rows: sndRows } = await deps.reader.query<{ email: string; name: string }>(
        `SELECT email, name FROM domain_senders WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, senderId],
      );
      if (sndRows[0]) {
        fromEmail = sndRows[0].email;
        fromName = sndRows[0].name;
      }
    }
    // Broadcasts tag their outbox rows with broadcast_id (campaigns use ob.campaign_id);
    // carry it into messages_log so per-broadcast stats are a simple GROUP BY.
    const broadcastId = typeof payload['broadcast_id'] === 'string' ? (payload['broadcast_id'] as string) : null;
    // The recipient's own data populates the `customer.*` namespace; an explicit
    // per-send `payload.merge` provides any extra tags. Profile-derived customer
    // values are authoritative (override a stale payload customer key).
    const merge: Record<string, string> = { ...asStringRecord(payload['merge']), ...customerMerge(profile) };
    // `{{unsubscribe}}` / `{{unsubscribe_url}}` resolve to THIS recipient's
    // workspace-scoped unsubscribe link (the page re-affirms before opting out;
    // confirming sets the profile `unsubscribed = true`). unsubscribe_url is the
    // raw URL (for a custom-text link); unsubscribe is a ready-made anchor.
    if (profile.email) {
      const unsubUrl = buildUnsubscribeUrl({ baseUrl: deps.unsubscribeBaseUrl, workspaceId, email: profile.email });
      merge.unsubscribe_url = unsubUrl;
      merge.unsubscribe = `<a href="${unsubUrl}">Unsubscribe</a>`;
    }
    const frequencyCapPerDays =
      typeof payload['frequency_cap_per_days'] === 'number'
        ? (payload['frequency_cap_per_days'] as number)
        : null;
    const quietHours = parseQuietHours(payload['quiet_hours']);

    // Click tracking (§10): when the workspace enables it, rewrite every link in
    // the email to a /t/<token> tracking link. Applies to EVERY outgoing email
    // (broadcast or campaign) — this is the one place all sends pass through.
    let trackedLinks: TrackedLink[] = [];
    if (linkTrackingOn && compiledHtml) {
      const rw = rewriteTrackingLinks(compiledHtml, {
        baseUrl: deps.linkTrackingBaseUrl,
        workspaceId,
        broadcastId,
        campaignId: ob.campaign_id ?? null,
      });
      compiledHtml = rw.html;
      trackedLinks = rw.links;
    }

    const now = deps.now();

    // suppression (DB): per-workspace OR global hard bounce. Only consulted when
    // the gate would pass — but querying is cheap and side-effect-free; the
    // decision pipeline still enforces the ORDER (gate before suppression).
    let isSuppressed = false;
    let lastSoftBounceAt: Date | null = null;
    if (profile.email) {
      const supp = buildIsSuppressedQuery(workspaceId, profile.email);
      const { rows } = await deps.reader.query<{ suppressed: boolean }>(supp.text, supp.values);
      isSuppressed = rows[0]?.suppressed === true;
      // Soft-bounce cooldown input: the most recent soft bounce for this address.
      const sb = buildLastSoftBounceQuery(workspaceId, profile.email);
      const { rows: sbRows } = await deps.reader.query<{ at: string | null }>(sb.text, sb.values);
      lastSoftBounceAt = sbRows[0]?.at ? new Date(sbRows[0].at) : null;
    }

    // recent-send count for the frequency cap window.
    let recentSendCount = 0;
    if (frequencyCapPerDays && frequencyCapPerDays > 0) {
      const since = windowStart(now, frequencyCapPerDays);
      const q = buildRecentSendCountQuery(workspaceId, profile.id, since);
      const { rows } = await deps.reader.query<{ n: number }>(q.text, q.values);
      recentSendCount = rows[0]?.n ?? 0;
    }

    const ctx: DispatchContext = {
      workspace: { id: ws.id, status: ws.status, sending_identity: sendingIdentity },
      profile: { id: profile.id, email: profile.email },
      template: { compiledHtml },
      subject,
      merge,
      frequencyCapPerDays,
      quietHours,
      recentSendCount,
      isSuppressed,
      lastSoftBounceAt,
      now,
      unsubscribeBaseUrl: deps.unsubscribeBaseUrl,
      fromEmail,
      fromName,
      toAddress,
    };

    const decision: DispatchDecision = decideDispatch(ctx);

    // Non-send outcomes: release the claim back so the row reflects a terminal
    // (skip/refuse) or re-runnable (defer) state, but NEVER call SES.
    if (decision.action !== 'send') {
      return finalizeNonSend(deps, workspaceId, outboxId, decision);
    }

    // 5/6. all-pass: build the SES input and SEND (the only SES call site).
    const input: SendEmailInput = buildSendEmailInput(ctx);
    const { sesMessageId } = await deps.ses.sendEmail(input);

    // 7. ONE tx: tracked links (idempotent) + messages_log + usage + mark sent.
    await deps.runInWorkspaceTx(workspaceId, [
      ...trackedLinks.map((l) => buildTrackedLinkInsert(workspaceId, l, broadcastId, ob.campaign_id ?? null)),
      buildMessagesLogInsert(workspaceId, profile.id, ob.campaign_id, sesMessageId, broadcastId),
      buildUsageCounterIncrement(workspaceId, now),
      buildOutboxMarkSent(workspaceId, outboxId),
    ]);

    return { result: 'send', sesMessageId };
  } catch (err) {
    // SES or DB failure after a successful claim → reset to pending so a retry
    // can re-claim it (bounded by attempts in the handler → DLQ).
    await resetClaim(deps, workspaceId, outboxId);
    const reason = err instanceof Error ? err.message : String(err);
    return { result: 'retryable-failure', reason };
  }
}

/** Set a claimed row to a terminal/deferred state for a non-send decision. */
async function finalizeNonSend(
  deps: DispatchDeps,
  workspaceId: string,
  outboxId: string,
  decision: DispatchDecision,
): Promise<DispatchOutcome> {
  if (decision.action === 'defer') {
    // Re-queue: reset to pending so a later sweep/redrive re-evaluates it.
    await resetClaim(deps, workspaceId, outboxId);
    return {
      result: 'defer',
      reason: decision.reason,
      deferUntil: decision.deferUntil ?? deps.now(),
    };
  }
  // skip / refuse → terminal: mark the row so it isn't retried.
  const status = decision.action === 'refuse' ? 'refused' : 'skipped';
  await deps.runInWorkspaceTx(workspaceId, [
    {
      text: `UPDATE outbox SET status = $3, sent_at = now() WHERE workspace_id = $1 AND id = $2`,
      values: [workspaceId, outboxId, status],
    },
  ]);
  return decision.action === 'refuse'
    ? { result: 'refuse', reason: decision.reason }
    : { result: 'skip', reason: decision.reason };
}

/** Reset a claimed (status='sending') row back to pending for a retry/defer. */
async function resetClaim(
  deps: DispatchDeps,
  workspaceId: string,
  outboxId: string,
): Promise<void> {
  try {
    await deps.runInWorkspaceTx(workspaceId, [
      {
        text: `UPDATE outbox SET status = 'pending' WHERE workspace_id = $1 AND id = $2 AND status = 'sending'`,
        values: [workspaceId, outboxId],
      },
    ]);
  } catch {
    /* best-effort; the row stays 'sending' and a redrive/sweep recovers it */
  }
}
