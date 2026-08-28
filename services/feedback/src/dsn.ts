// Parsing inbound SMTP bounces (DSN, RFC 3464) and spam reports (ARF, RFC 5965).
//
// This is the self-hosted twin of `classifySesEvent`: where SES hands us a JSON
// notification, our own mail server receives an actual EMAIL — a delivery status
// notification or an abuse report — and we must read the same facts out of it.
// Both paths converge on `ClassifiedEvent`, so every downstream SQL builder
// (suppression, email_events, profile email_status, soft-bounce counting) is
// shared rather than duplicated.
//
// Everything here is PURE and total: it parses untrusted text arriving from the
// public internet, so it never throws and never trusts a field it did not
// verify. An unparseable report yields category 'other' and is recorded but acts
// on nothing.
import type { ClassifiedEvent, FeedbackCategory, EmailEventType } from './core.js';

/** One parsed delivery-status report. */
export interface DsnReport {
  /** RFC 3463 enhanced status, e.g. '5.1.1'. Null when absent/unparseable. */
  readonly status: string | null;
  /** 'failed' | 'delayed' | 'delivered' | 'relayed' | 'expanded', when present. */
  readonly action: string | null;
  /** The address that failed, lowercased. */
  readonly recipient: string | null;
  /** Human-readable reason from the remote server, trimmed. */
  readonly diagnostic: string | null;
}

/** The subset of a raw message we care about. */
export interface ParsedBounceMessage {
  /** Token recovered from the VERP envelope recipient (X-Original-To). */
  readonly verpToken: string | null;
  /** Delivery-status report, when this is a DSN. */
  readonly dsn: DsnReport | null;
  /** True when the message is an ARF abuse/complaint report. */
  readonly isComplaint: boolean;
  /** Original recipient named by an ARF report, lowercased. */
  readonly complaintRecipient: string | null;
}

const HEADER_SPLIT = /\r?\n\r?\n/;

function lc(s: string | null | undefined): string | null {
  const v = (s ?? '').trim().toLowerCase();
  return v.length > 0 ? v : null;
}

/**
 * Unfold RFC 5322 headers (continuation lines begin with whitespace) and return
 * them as a lowercase-keyed map. Later duplicates do not clobber earlier ones —
 * `Received:` chains and repeated `X-Original-To:` keep their first value, which
 * is the one Postfix wrote for the final delivery.
 */
export function parseHeaders(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  const unfolded = block.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (!(key in out)) out[key] = val;
  }
  return out;
}

/** Split a raw RFC 822 message into its header block and body. */
export function splitMessage(raw: string): { headers: Record<string, string>; body: string } {
  const m = HEADER_SPLIT.exec(raw);
  if (!m) return { headers: parseHeaders(raw), body: '' };
  return {
    headers: parseHeaders(raw.slice(0, m.index)),
    body: raw.slice(m.index + m[0].length),
  };
}

/**
 * Extract the per-recipient delivery-status fields. These live in a
 * `message/delivery-status` MIME part as RFC 822-style field groups; rather than
 * fully decoding MIME we scan for the fields directly, which is robust across
 * the many shapes real MTAs emit.
 */
export function parseDeliveryStatus(raw: string): DsnReport | null {
  const status = /^Status:\s*([245]\.\d{1,3}\.\d{1,3})/im.exec(raw)?.[1] ?? null;
  const action = /^Action:\s*([A-Za-z-]+)/im.exec(raw)?.[1]?.toLowerCase() ?? null;
  const rcpt =
    /^Final-Recipient:\s*[^;]*;\s*(.+)$/im.exec(raw)?.[1] ??
    /^Original-Recipient:\s*[^;]*;\s*(.+)$/im.exec(raw)?.[1] ??
    null;
  const diag = /^Diagnostic-Code:\s*(.+)$/im.exec(raw)?.[1] ?? null;

  if (!status && !action && !rcpt) return null;
  return {
    status,
    action,
    recipient: lc(rcpt?.replace(/^</, '').replace(/>$/, '') ?? null),
    diagnostic: diag ? diag.trim().slice(0, 500) : null,
  };
}

/**
 * Classify a delivery status into our internal category.
 *
 *   5.x.x -> hard_bounce  (permanent: no such mailbox, no such domain)
 *   4.x.x -> soft_bounce  (transient: mailbox full, greylisted, deferred)
 *
 * The distinction is the one that protects the list: a transient failure must
 * NEVER suppress, because the MTA is still retrying on its own schedule. Only a
 * permanent failure, or a transient one whose queue lifetime finally expired,
 * removes an address.
 *
 * `action: failed` on a 4.x.x means the sending MTA gave up — the retries are
 * over — so it is reported as a soft bounce that the caller may count toward the
 * permanent-soft-bounce threshold, exactly as the SES path does.
 */
export function classifyDeliveryStatus(dsn: DsnReport | null): FeedbackCategory {
  if (!dsn) return 'other';
  const cls = dsn.status?.[0];
  if (cls === '5') return 'hard_bounce';
  if (cls === '4') return 'soft_bounce';
  // No enhanced status: fall back to the action verb.
  if (dsn.action === 'failed') return 'hard_bounce';
  if (dsn.action === 'delayed') return 'soft_bounce';
  return 'other';
}

/**
 * Parse one raw inbound message. Recognises three kinds:
 *   - a DSN  (`Content-Type: multipart/report; report-type=delivery-status`)
 *   - an ARF (`... report-type=feedback-report`) — a spam complaint
 *   - anything else, which is ignored
 *
 * `X-Original-To` is written by Postfix and preserves the full VERP recipient
 * including the `+token`, which is how the message is attributed.
 */
export function parseBounceMessage(raw: string): ParsedBounceMessage {
  const { headers, body } = splitMessage(raw ?? '');
  const originalTo = headers['x-original-to'] ?? headers['delivered-to'] ?? null;
  const verpToken = extractVerpToken(originalTo);

  const contentType = (headers['content-type'] ?? '').toLowerCase();
  const isArf =
    contentType.includes('report-type=feedback-report') || /Feedback-Type:\s*abuse/i.test(body);

  if (isArf) {
    const rcpt =
      /^Original-Rcpt-To:\s*(.+)$/im.exec(body)?.[1] ??
      /^Removal-Recipient:\s*(.+)$/im.exec(body)?.[1] ??
      null;
    return {
      verpToken,
      dsn: null,
      isComplaint: true,
      complaintRecipient: lc(rcpt?.replace(/^</, '').replace(/>$/, '') ?? null),
    };
  }

  return { verpToken, dsn: parseDeliveryStatus(body), isComplaint: false, complaintRecipient: null };
}

/** Local copy of the VERP local-part parse, kept here so this module stays dependency-free. */
function extractVerpToken(recipient: string | null): string | null {
  if (!recipient) return null;
  const addr = recipient.trim().replace(/^</, '').replace(/>$/, '');
  const at = addr.lastIndexOf('@');
  if (at <= 0) return null;
  const local = addr.slice(0, at);
  const plus = local.indexOf('+');
  if (plus <= 0) return null;
  if (local.slice(0, plus).toLowerCase() !== 'bounce') return null;
  const token = local.slice(plus + 1);
  return token.length > 0 ? token : null;
}

/**
 * Fold a parsed inbound report into the SAME `ClassifiedEvent` the SES path
 * produces, so both feed one set of SQL builders.
 *
 * `messageId` is our own Message-ID recovered from the verified VERP token, and
 * takes the place of SES's `mail.messageId` as the idempotency key component —
 * meaning duplicate reports for one message collapse via the existing
 * `(workspace_id, ses_message_id, type)` uniqueness.
 */
export function classifyInboundReport(
  parsed: ParsedBounceMessage,
  messageId: string | null,
  fallbackRecipient: string | null,
): ClassifiedEvent {
  if (parsed.isComplaint) {
    const rcpt = parsed.complaintRecipient ?? fallbackRecipient;
    return {
      category: 'complaint',
      type: 'complaint' as EmailEventType,
      subType: 'abuse',
      sesMessageId: messageId,
      recipients: rcpt ? [rcpt] : [],
    };
  }

  const category = classifyDeliveryStatus(parsed.dsn);
  const rcpt = parsed.dsn?.recipient ?? fallbackRecipient;
  return {
    category,
    type: category === 'other' ? ('other' as EmailEventType) : ('bounce' as EmailEventType),
    subType: parsed.dsn?.status ?? null,
    sesMessageId: messageId,
    recipients: rcpt ? [rcpt] : [],
  };
}
