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
import {
  buildUnsubscribeUrl,
  signUnsubscribeToken,
  unsubscribeLinkSecret,
  type SendEmailInput,
  type SesEmailClient,
} from '@cdp/email';
import {
  decideDispatch,
  windowStart,
  buildOutboxClaim,
  buildRecentSendCountQuery,
  buildIsSuppressedQuery,
  buildMediumOptOutQuery,
  buildTopicUnsubscribedQuery,
  buildLastSoftBounceQuery,
  buildMessagesLogInsert,
  buildMessagesLogFailure,
  buildUsageCounterIncrement,
  buildOutboxMarkSent,
  buildSendEmailInput,
  buildChannelMessage,
  resolveTextRecipient,
  rewriteTrackingLinks,
  buildTrackedLinkInsert,
  injectOpenPixel,
  buildTrackedOpenInsert,
  type DispatchContext,
  type DispatchDecision,
  type QuietHoursConfig,
  type SqlStatement,
  type TrackedLink,
} from './core.js';
import { customerMerge, expandCustomerToken } from '@cdp/shared';
import {
  resolveChannelProvider,
  isTextMedium,
  mediumGroupOf,
  type ChannelProvider,
  type Medium,
} from '@cdp/channels';

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
  /**
   * The injectable text-channel provider resolver (sms/whatsapp). Defaults to
   * `@cdp/channels` `resolveChannelProvider` (the deterministic MOCK this phase —
   * never hits the network). Tests inject a counting fake; a future real
   * Twilio/Meta adapter slots in here without touching the orchestrator.
   */
  readonly resolveChannel?: (medium: Medium) => ChannelProvider;
  /** Apply a list of statements in ONE workspace-scoped tx (atomic write). */
  runInWorkspaceTx(workspaceId: string, statements: readonly SqlStatement[]): Promise<void>;
  /** Injected clock for cap/quiet determinism. */
  now(): Date;
  /** Public base URL of the unsubscribe endpoint (§9 step 5). */
  readonly unsubscribeBaseUrl: string;
  /** Public base URL the click-tracking redirect (/t/<token>) is served from. */
  readonly linkTrackingBaseUrl: string;
  /**
   * The HMAC secret used to SIGN each recipient's unsubscribe/manage link token.
   * The unsubscribe / manage-subscription handlers verify with the SAME secret.
   * Defaults to `unsubscribeLinkSecret()` (env or the dev fallback).
   */
  readonly unsubscribeLinkSecret?: string;
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

    // MEDIUM routing (CLAUDE.md multi-channel). For a BROADCAST the medium +
    // text_body live on the broadcast row (the payload carries `medium` as the
    // authoritative hint). For a CAMPAIGN send there is NO broadcast row, so the
    // runner carries the medium + plain text_body in the OUTBOX PAYLOAD (the
    // campaign send-node config); email is the default for anything untagged.
    let medium: Medium = 'email';
    let textBody: string | null = null;
    // The message's optional TOPIC (CLAUDE.md topic-subscriptions): lives on the
    // broadcast/campaign row. A recipient unsubscribed from it is skipped.
    let topicId: string | null = null;
    const payloadMedium = payload['medium'];
    if (broadcastId) {
      // Load the broadcast row once: it carries text_body (sms/whatsapp) AND topic_id.
      const { rows: bcRows } = await deps.reader.query<{
        medium: string;
        text_body: string | null;
        topic_id: string | null;
      }>(`SELECT medium, text_body, topic_id FROM broadcasts WHERE workspace_id = $1 AND id = $2`, [
        workspaceId,
        broadcastId,
      ]);
      if (bcRows[0]) {
        topicId = bcRows[0].topic_id ?? null;
        if (
          (payloadMedium === 'sms' || payloadMedium === 'whatsapp') &&
          (bcRows[0].medium === 'sms' || bcRows[0].medium === 'whatsapp')
        ) {
          medium = bcRows[0].medium;
          textBody = bcRows[0].text_body;
        }
      }
    } else if (ob.campaign_id) {
      // Campaign send: the medium + text body ride the OUTBOX PAYLOAD (no broadcast
      // row to read). Carry the campaign's topic for the uniform topic gate.
      const { rows: cmRows } = await deps.reader.query<{ topic_id: string | null }>(
        `SELECT topic_id FROM campaigns WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, ob.campaign_id],
      );
      topicId = cmRows[0]?.topic_id ?? null;
      if (payloadMedium === 'sms' || payloadMedium === 'whatsapp') {
        medium = payloadMedium;
        const pt = payload['text_body'];
        textBody = typeof pt === 'string' ? pt : null;
      }
    }

    // The recipient's own data populates the `customer.*` namespace; an explicit
    // per-send `payload.merge` provides any extra tags. Profile-derived customer
    // values are authoritative (override a stale payload customer key).
    const merge: Record<string, string> = { ...asStringRecord(payload['merge']), ...customerMerge(profile) };
    // `{{unsubscribe}}` / `{{unsubscribe_url}}` resolve to THIS recipient's
    // workspace-scoped PREFERENCE CENTER (manage your subscription) — where they
    // can opt out of specific topics / a channel group, or unsubscribe from
    // everything (CLAUDE.md topic-subscriptions). unsubscribe_url is the raw URL
    // (for a custom-text link); unsubscribe is a ready-made anchor. The RFC 8058
    // one-click List-Unsubscribe header (built in @cdp/email) still points at
    // /unsubscribe — a full email-group opt-out — for mail-client compliance.
    // Sign the per-recipient HMAC token over (workspace_id, email) once; it goes
    // on BOTH the body {{unsubscribe}} link and the List-Unsubscribe header so the
    // handlers can verify the link wasn't forged (a missing/invalid token → 403).
    const linkSecret = deps.unsubscribeLinkSecret ?? unsubscribeLinkSecret();
    const unsubscribeToken = profile.email
      ? signUnsubscribeToken(linkSecret, workspaceId, profile.email)
      : null;
    if (profile.email) {
      // The preference center shares the scoped-link shape; derive its base from
      // the unsubscribe base (…/unsubscribe → …/manage-subscription).
      const manageBaseUrl = deps.unsubscribeBaseUrl.replace(/\/unsubscribe$/, '/manage-subscription');
      // Carry the source broadcast/campaign in the link so a full opt-out can be
      // attributed to the send (per-broadcast funnel metric).
      const unsubUrl = buildUnsubscribeUrl({
        baseUrl: manageBaseUrl,
        workspaceId,
        email: profile.email,
        ...(unsubscribeToken ? { token: unsubscribeToken } : {}),
        broadcastId,
        campaignId: ob.campaign_id ?? null,
      });
      merge.unsubscribe_url = unsubUrl;
      merge.unsubscribe = `<a href="${unsubUrl}">Unsubscribe</a>`;
    }
    const frequencyCapPerDays =
      typeof payload['frequency_cap_per_days'] === 'number'
        ? (payload['frequency_cap_per_days'] as number)
        : null;
    const quietHours = parseQuietHours(payload['quiet_hours']);

    // Text channels send to the recipient PHONE. The To token defaults to
    // {{customer.phone}} (resolves to attributes.phone via the customer.* resolver),
    // rendered per recipient at decision time. The raw phone is also kept for the
    // no-phone skip check (mirrors how a missing email is handled for email).
    const phone = merge[expandCustomerToken('customer.phone')] ?? null;
    const effectiveToAddress = isTextMedium(medium) ? toAddress || '{{customer.phone}}' : toAddress;

    // Click tracking (§10): when the workspace enables it, rewrite every link in
    // the email to a /t/<token> tracking link. Applies to EVERY outgoing email
    // (broadcast or campaign) — this is the one place all sends pass through.
    // Text channels (sms/whatsapp) carry no HTML, so tracking is email-only.
    let trackedLinks: TrackedLink[] = [];
    // Open tracking shares the same per-workspace opt-in as click tracking. The
    // pixel token is per-recipient (one tracked_opens row per profile) so the
    // funnel counts DISTINCT-profile opens. The row is pre-created at send (opens=0)
    // so an unopened send is still attributed; the /o/<token> endpoint bumps it.
    let openToken: string | null = null;
    if (linkTrackingOn && compiledHtml) {
      const rw = rewriteTrackingLinks(compiledHtml, {
        baseUrl: deps.linkTrackingBaseUrl,
        workspaceId,
        broadcastId,
        campaignId: ob.campaign_id ?? null,
      });
      compiledHtml = rw.html;
      trackedLinks = rw.links;

      const op = injectOpenPixel(compiledHtml, {
        baseUrl: deps.linkTrackingBaseUrl,
        workspaceId,
        broadcastId,
        campaignId: ob.campaign_id ?? null,
        profileId: profile.id,
      });
      compiledHtml = op.html;
      openToken = op.token;
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

    // Topic / medium-group opt-outs (CLAUDE.md topic-subscriptions). Scoped by
    // (workspace_id, profile_id). The medium-group opt-out is GLOBAL (the whole
    // email or sms_whatsapp family); the topic opt-out only applies when the
    // message carries a topic AND the profile explicitly unsubscribed from it
    // (default-on: absence of a row = still subscribed).
    const moq = buildMediumOptOutQuery(workspaceId, profile.id, mediumGroupOf(medium));
    const { rows: moRows } = await deps.reader.query<{ opted_out: boolean }>(moq.text, moq.values);
    const optedOutOfMedium = moRows[0]?.opted_out === true;

    let topicUnsubscribed = false;
    if (topicId) {
      const tq = buildTopicUnsubscribedQuery(workspaceId, profile.id, topicId);
      const { rows: tRows } = await deps.reader.query<{ unsubscribed: boolean }>(tq.text, tq.values);
      topicUnsubscribed = tRows[0]?.unsubscribed === true;
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
      medium,
      textBody,
      phone,
      merge,
      frequencyCapPerDays,
      quietHours,
      recentSendCount,
      isSuppressed,
      optedOutOfMedium,
      topicUnsubscribed,
      lastSoftBounceAt,
      now,
      unsubscribeBaseUrl: deps.unsubscribeBaseUrl,
      unsubscribeToken,
      fromEmail,
      fromName,
      toAddress: effectiveToAddress,
      broadcastId,
      campaignId: ob.campaign_id ?? null,
    };

    const decision: DispatchDecision = decideDispatch(ctx);

    // Non-send outcomes: release the claim back so the row reflects a terminal
    // (skip/refuse) or re-runnable (defer) state, but NEVER call SES/the provider.
    if (decision.action !== 'send') {
      return finalizeNonSend(deps, workspaceId, outboxId, decision, {
        profileId: profile.id,
        campaignId: ob.campaign_id ?? null,
        broadcastId,
        medium,
      });
    }

    // 5/6. all-pass — ROUTE BY MEDIUM. Email keeps the SES path UNCHANGED. The
    // text channels (sms/whatsapp) render text_body merge tags + the recipient
    // phone and send via the injected ChannelProvider (the deterministic mock).
    if (isTextMedium(medium)) {
      return dispatchTextChannel(deps, {
        workspaceId,
        outboxId,
        ctx,
        medium,
        campaignId: ob.campaign_id ?? null,
        broadcastId,
        profileId: profile.id,
        now,
      });
    }

    // EMAIL: build the SES input and SEND (the only SES call site).
    const input: SendEmailInput = buildSendEmailInput(ctx);
    const { sesMessageId } = await deps.ses.sendEmail(input);

    // 7. ONE tx: tracked links (idempotent) + messages_log + usage + mark sent.
    await deps.runInWorkspaceTx(workspaceId, [
      ...trackedLinks.map((l) => buildTrackedLinkInsert(workspaceId, l, broadcastId, ob.campaign_id ?? null)),
      ...(openToken
        ? [buildTrackedOpenInsert(workspaceId, openToken, broadcastId, ob.campaign_id ?? null, profile.id)]
        : []),
      buildMessagesLogInsert(workspaceId, profile.id, ob.campaign_id, sesMessageId, broadcastId, 'email'),
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

/** Args for the text-channel (sms/whatsapp) send path. */
interface TextSendArgs {
  readonly workspaceId: string;
  readonly outboxId: string;
  readonly ctx: DispatchContext;
  readonly medium: Medium;
  readonly campaignId: string | null;
  readonly broadcastId: string | null;
  readonly profileId: string;
  readonly now: Date;
}

/**
 * Send one sms/whatsapp message through the injected ChannelProvider (the mock
 * this phase). Runs AFTER the decision pipeline has passed (gate/suppression/
 * cap/quiet-hours). A recipient with NO phone is SKIPPED — we record a
 * messages_log skip row and mark the outbox row done, NEVER crashing the batch
 * (mirrors how a missing email is handled). On success we write a messages_log
 * row (medium + provider message id) + usage + mark sent in ONE tx; a provider
 * failure resets the claim for a retry (bounded → DLQ).
 */
async function dispatchTextChannel(deps: DispatchDeps, args: TextSendArgs): Promise<DispatchOutcome> {
  const { workspaceId, outboxId, ctx, medium, campaignId, broadcastId, profileId, now } = args;
  // No phone → skip (terminal). Record a skipped messages_log row + mark done.
  const renderedTo = resolveTextRecipient(ctx);
  if (!renderedTo) {
    await deps.runInWorkspaceTx(workspaceId, [
      buildMessagesLogFailure(workspaceId, profileId, campaignId, broadcastId, medium, 'skipped'),
      buildOutboxMarkSent(workspaceId, outboxId),
    ]);
    return { result: 'skip', reason: 'recipient has no phone' };
  }

  const provider = (deps.resolveChannel ?? resolveChannelProvider)(medium);
  const message = buildChannelMessage(ctx);
  const { providerMessageId } = await provider.send(message);

  await deps.runInWorkspaceTx(workspaceId, [
    buildMessagesLogInsert(workspaceId, profileId, campaignId, providerMessageId, broadcastId, medium),
    buildUsageCounterIncrement(workspaceId, now, `${medium}_sent`),
    buildOutboxMarkSent(workspaceId, outboxId),
  ]);
  return { result: 'send', sesMessageId: providerMessageId };
}

/** The send identity a non-send finalize needs to record a messages_log row. */
interface NonSendTarget {
  readonly profileId: string;
  readonly campaignId: string | null;
  readonly broadcastId: string | null;
  readonly medium: Medium;
}

/** Set a claimed row to a terminal/deferred state for a non-send decision. */
async function finalizeNonSend(
  deps: DispatchDeps,
  workspaceId: string,
  outboxId: string,
  decision: DispatchDecision,
  target: NonSendTarget,
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
  // skip / refuse → terminal: mark the row so it isn't retried. A SKIP (suppression,
  // medium-group opt-out, topic opt-out, frequency cap) is ALSO recorded as a
  // messages_log 'skipped' row so the skip is auditable (per-send stats / activity)
  // and the batch never silently drops a recipient. A 'refuse' (workspace not
  // active/verified) is an operator state, not a per-recipient outcome, so it only
  // marks the outbox row. Both commit in ONE workspace-scoped tx.
  const status = decision.action === 'refuse' ? 'refused' : 'skipped';
  await deps.runInWorkspaceTx(workspaceId, [
    ...(decision.action === 'skip'
      ? [
          buildMessagesLogFailure(
            workspaceId,
            target.profileId,
            target.campaignId,
            target.broadcastId,
            target.medium,
            'skipped',
          ),
        ]
      : []),
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
