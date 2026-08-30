// Transactional send: a designed template, triggered by API with parameters.
//
//   POST /v1/send { template: 'otp', to: 'a@b.com', data: { code: '123456' } }
//
// The distinction from a broadcast is not the content — it is the CONSENT model. A
// broadcast is marketing and every consent gate applies. A transactional message is
// something the recipient asked for by acting: a password reset, a one-time code, a
// receipt. Refusing to send it because the person unsubscribed from a newsletter
// would lock them out of their own account.
//
// The DEFAULT is conservative — an unsubscribe is honoured even here — because the
// safe failure is not sending. A caller that knows the message is genuinely
// essential (a one-time code, a password reset) opts out per request:
//
//                                  default   with ignoreMarketingConsent
//   hard bounce / dead mailbox     BLOCKS    BLOCKS
//   reported as spam               BLOCKS    BLOCKS
//   unsubscribed from marketing    BLOCKS    sends
//   manually suppressed            BLOCKS    sends
//
// The override covers CONSENT only, never deliverability: no flag should let you
// mail a dead mailbox or someone who reported you as spam, because that damages the
// sending reputation of every other tenant on the IP and cannot help the recipient.
//
// `suppressions` mixes both kinds behind one row, so the check is by REASON.
import { renderExpression } from '@cdp/shared';

/** Reasons in `suppressions.reason` that mean the ADDRESS is bad, not that the person refused. */
const DELIVERABILITY_REASONS = new Set(['hard_bounce', 'permanent_soft_bounce']);

/** What we know about the recipient at decision time. */
export interface TransactionalRecipient {
  readonly email: string;
  /** The suppression reason on file, or null when not suppressed. */
  readonly suppressionReason: string | null;
  /** profiles.email_status — 'active' | 'bounced' | 'complained'. */
  readonly emailStatus: string | null;
}

export type TransactionalVerdict =
  | { readonly send: true }
  | { readonly send: false; readonly reason: string };

export interface TransactionalOptions {
  /**
   * Send even though the recipient unsubscribed from marketing. For messages the
   * recipient triggered and needs — a login code, a password reset — where not
   * sending locks them out of their own account. Never overrides deliverability.
   */
  readonly ignoreMarketingConsent?: boolean;
}

/**
 * Decide whether a transactional message may go out. Pure.
 *
 * A COMPLAINT blocks even transactional mail: someone who marked our messages as
 * spam has told the mailbox provider not to accept them, and continuing to send
 * damages the sending reputation for every other tenant on the IP. That is a
 * different judgement from an unsubscribe, which is about marketing only.
 */
export function decideTransactionalSend(
  r: TransactionalRecipient,
  opts: TransactionalOptions = {},
): TransactionalVerdict {
  if (!r.email || !r.email.includes('@')) {
    return { send: false, reason: 'recipient has no valid email address' };
  }
  if (r.suppressionReason && DELIVERABILITY_REASONS.has(r.suppressionReason)) {
    return { send: false, reason: `address is undeliverable (${r.suppressionReason})` };
  }
  if (r.suppressionReason === 'complaint' || r.emailStatus === 'complained') {
    return { send: false, reason: 'recipient reported this sender as spam' };
  }
  if (r.emailStatus === 'bounced') {
    return { send: false, reason: 'address is undeliverable (bounced)' };
  }
  // Consent. Honoured by default; overridden only when the caller says this
  // message is essential.
  if (r.suppressionReason && !opts.ignoreMarketingConsent) {
    return {
      send: false,
      reason:
        r.suppressionReason === 'unsubscribe'
          ? 'recipient unsubscribed — pass ignore_unsubscribe to send anyway'
          : `recipient is suppressed (${r.suppressionReason})`,
    };
  }
  return { send: true };
}

/** Is this a syntactically valid email address? */
export function isEmailAddress(v: string): boolean {
  return /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(v.trim());
}

/**
 * Decide whether a transactional TEXT message may go out.
 *
 * Text has no deliverability signal of its own — there is no bounce and no
 * complaint feedback loop — so the only gate is consent: an opt-out of the
 * sms/whatsapp channel group. As with email it blocks by default and the caller
 * overrides per request for a message the recipient triggered.
 */
export function decideTransactionalText(
  r: { phone: string | null; optedOut: boolean },
  opts: TransactionalOptions = {},
): TransactionalVerdict {
  if (!r.phone) return { send: false, reason: 'recipient has no valid phone number' };
  if (r.optedOut && !opts.ignoreMarketingConsent) {
    return { send: false, reason: 'recipient opted out of SMS/WhatsApp — pass ignore_unsubscribe to send anyway' };
  }
  return { send: true };
}

/**
 * Flatten API-supplied parameters into `data.*` merge keys.
 *
 * A separate namespace from `customer.*` and `event.*` so there is never doubt
 * about where a value came from — and so a caller cannot shadow profile fields by
 * naming a parameter `email`.
 *
 * Nested objects flatten with dots (`data.order.id`); arrays index (`data.items.0`).
 * Values are stringified because they are being substituted into text.
 */
export function dataMerge(
  data: unknown,
  prefix = 'data',
  out: Record<string, string> = {},
  depth = 0,
): Record<string, string> {
  // A hostile or accidental deep structure must not blow the stack.
  if (depth > 6 || data === null || data === undefined) return out;
  if (typeof data !== 'object') {
    out[prefix] = String(data);
    return out;
  }
  if (Array.isArray(data)) {
    data.forEach((v, i) => dataMerge(v, `${prefix}.${i}`, out, depth + 1));
    return out;
  }
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (v === null || v === undefined) continue;
    dataMerge(v, `${prefix}.${k}`, out, depth + 1);
  }
  return out;
}

/**
 * Render subject and body with the combined merge map.
 *
 * Both go through the SAME engine, so `Your code is {{data.code}}` works in a
 * subject exactly as it does in a body — a subject rendered by a different path is
 * how `{{data.code}}` ends up visible in someone's inbox.
 */
export function renderTransactional(
  parts: { subject: string; html: string },
  merge: Record<string, string>,
): { subject: string; html: string } {
  return {
    subject: renderExpression(parts.subject ?? '', merge),
    html: renderExpression(parts.html ?? '', merge),
  };
}

/**
 * Normalize a transactional key. Applied on BOTH the write and the lookup, so a
 * caller sending 'OTP' reaches the template saved as 'otp' rather than a 404 they
 * cannot see the cause of.
 */
export function normalizeTransactionalKey(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

/**
 * Keys appear in integrators' source code and in our error messages, so keep the
 * character set boring: lowercase, digits, dash, underscore.
 */
export function validateTransactionalKey(key: string): string | null {
  if (key.length > 64) return 'The key must be 64 characters or fewer.';
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(key)) {
    return 'The key may use lowercase letters, digits, dashes and underscores, and must start with a letter or digit.';
  }
  return null;
}

/** A validated request body. */
export interface TransactionalRequest {
  readonly template: string;
  readonly to: string;
  readonly data: Record<string, unknown>;
  /** Send despite an unsubscribe. Deliverability blocks still apply. */
  readonly ignoreUnsubscribe: boolean;
}

/**
 * Validate the API payload. Returns the request or a caller-facing message —
 * deliberately specific, because the caller is a developer integrating against
 * this and a vague 400 costs them an afternoon.
 */
export function parseTransactionalRequest(body: unknown): TransactionalRequest | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const template = normalizeTransactionalKey(b.template);
  const to = typeof b.to === 'string' ? b.to.trim() : '';
  if (!template) return { error: "'template' is required — the template's transactional key, e.g. 'otp'" };
  // A key can resolve to an email or a text message, so what a valid `to` looks
  // like is not known until the template is found. Only emptiness is decidable here.
  if (!to) return { error: "'to' is required — the recipient's email address or phone number" };
  const data = b.data;
  if (data !== undefined && (typeof data !== 'object' || data === null || Array.isArray(data))) {
    return { error: "'data' must be an object of merge parameters" };
  }
  return {
    template,
    to,
    data: (data as Record<string, unknown>) ?? {},
    ignoreUnsubscribe: b.ignore_unsubscribe === true,
  };
}
