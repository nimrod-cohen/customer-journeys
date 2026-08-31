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
import { renderExpression, renderExpressionHtml, sanitizeHrefSchemes } from '@cdp/shared';

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
    // The subject is PLAIN TEXT: entity-escaping it would put a literal `&amp;` in
    // front of the recipient in their inbox list.
    subject: renderExpression(parts.subject ?? '', merge),
    // The body is HTML, so values are escaped — a `data.*` parameter carrying
    // `<b>` or `&` should show as text, not reshape the message. A caller that
    // genuinely passes a designed HTML block asks for it with `{{{data.body_html}}}`.
    html: sanitizeHrefSchemes(renderExpressionHtml(parts.html ?? '', merge)),
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

// ── attachments ──────────────────────────────────────────────────────────────
//
// Files ride INLINE, base64 in the JSON body — the shape every other transactional
// API uses, so an integrator moving over brings their existing code. There is no
// upload-then-reference flow and no URL fetch: a URL would make our sender fetch
// arbitrary hosts on request, which is the SSRF surface the webhook node needs a
// whole allowlist to contain.

/** Most files a single send may carry. */
export const MAX_ATTACHMENTS = 20;

/**
 * Cap on the DECODED total across a send. 25 MB is what mailbox providers accept
 * in practice (Gmail's own limit) and leaves room under the 40 MB message ceiling
 * both SES and Resend enforce AFTER base64 inflates the payload by a third.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Extensions we refuse outright. Not a security boundary — the caller holds a
 * secret key and is trusted — but mail carrying an executable is either a mistake
 * or an abused key, and either way it gets the sending domain blocklisted. SES
 * blocks most of these itself; failing here means the caller learns why.
 */
const REFUSED_EXTENSIONS = new Set([
  'ade', 'adp', 'app', 'asp', 'bas', 'bat', 'cer', 'chm', 'cmd', 'com', 'cpl', 'crt', 'csh',
  'der', 'dll', 'exe', 'fxp', 'gadget', 'hlp', 'hta', 'inf', 'ins', 'isp', 'its', 'jar', 'js',
  'jse', 'ksh', 'lib', 'lnk', 'mad', 'maf', 'mag', 'mam', 'maq', 'mar', 'mas', 'mat', 'mau',
  'mav', 'maw', 'mda', 'mdb', 'mde', 'mdt', 'mdw', 'mdz', 'msc', 'msi', 'msp', 'mst', 'ops',
  'pcd', 'pif', 'plg', 'prf', 'prg', 'reg', 'scf', 'scr', 'sct', 'shb', 'shs', 'sys', 'tmp',
  'url', 'vb', 'vbe', 'vbs', 'vps', 'vsmacros', 'vss', 'vst', 'vsw', 'vxd', 'ws', 'wsc',
  'wsf', 'wsh',
]);

/** Extension → content type for the common cases; anything else is a generic blob. */
const CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  csv: 'text/csv',
  txt: 'text/plain',
  html: 'text/html',
  json: 'application/json',
  xml: 'application/xml',
  ics: 'text/calendar',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** One validated attachment, ready for any of the three transports. */
export interface ParsedAttachment {
  readonly filename: string;
  readonly contentType: string;
  /** Base64, unwrapped — no newlines, no `data:` prefix. */
  readonly content: string;
  /** Decoded size, derived from the base64 length (the bytes are never allocated). */
  readonly bytes: number;
}

/** A filename crosses into the recipient's filesystem: keep it a plain leaf name. */
function safeFilename(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const noControl = raw.replace(/[\r\n\t\x00-\x1F\x7F]/g, '');
  const leaf = noControl.split(/[\\/]/).pop() ?? '';
  return leaf.trim().slice(0, 255);
}

function extensionOf(filename: string): string {
  const i = filename.lastIndexOf('.');
  return i > 0 ? filename.slice(i + 1).toLowerCase() : '';
}

/**
 * Decoded byte count of a base64 string, WITHOUT decoding it. The point is to
 * refuse an oversize payload before allocating it — decoding first to measure is
 * how a size limit becomes the thing that exhausts memory.
 */
function base64Bytes(b64: string): number {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return (b64.length / 4) * 3 - padding;
}

export interface ParsedAttachments {
  readonly attachments: readonly ParsedAttachment[];
}

/**
 * Validate the caller's `attachments`. Pure — the bytes are never decoded and no
 * transport is touched, so an oversize or malformed batch is refused before we do
 * any work on it.
 *
 * Every rejection names the offending file, because the caller is a developer
 * integrating against this and a request carrying twenty files gets one message.
 */
export function parseAttachments(raw: unknown): ParsedAttachments | { error: string } {
  if (raw === undefined || raw === null) return { attachments: [] };
  if (!Array.isArray(raw)) {
    return { error: "'attachments' must be an array of { filename, content } objects" };
  }
  if (raw.length > MAX_ATTACHMENTS) {
    return { error: `too many attachments: ${raw.length} — at most ${MAX_ATTACHMENTS} per message` };
  }

  const out: ParsedAttachment[] = [];
  let total = 0;
  for (let i = 0; i < raw.length; i++) {
    const at = `attachments[${i}]`;
    const item = raw[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { error: `${at} must be an object with 'filename' and 'content'` };
    }
    const a = item as Record<string, unknown>;

    const filename = safeFilename(typeof a.filename === 'string' ? a.filename : '');
    if (!filename) return { error: `${at} needs a 'filename'` };
    const ext = extensionOf(filename);
    if (REFUSED_EXTENSIONS.has(ext)) {
      return { error: `${filename}: '.${ext}' files can't be emailed — most providers reject them` };
    }

    // `content` is the field the docs name; `content_base64` is accepted because
    // it is what several other APIs call it and guessing wrong should not 400.
    const rawContent = typeof a.content === 'string' ? a.content : typeof a.content_base64 === 'string' ? a.content_base64 : '';
    // A browser's FileReader hands you a data: URI; take the payload rather than
    // attaching the prefix as if it were part of the file.
    const stripped = rawContent.replace(/^data:[^;,]*;base64,/, '').replace(/\s+/g, '');
    if (!stripped) return { error: `${filename}: 'content' is required — the file, base64-encoded` };
    if (stripped.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(stripped)) {
      return { error: `${filename}: 'content' is not valid base64` };
    }

    const bytes = base64Bytes(stripped);
    total += bytes;
    if (total > MAX_ATTACHMENT_BYTES) {
      return {
        error: `attachments are too large: ${Math.round(total / 1024 / 1024)} MB — the limit is ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB per message`,
      };
    }

    // An explicit type is honoured when it is well-formed; otherwise the extension
    // decides, since a mislabelled file is worse than a generic one.
    const declared = typeof a.content_type === 'string' ? a.content_type.trim() : '';
    const contentType = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(declared)
      ? declared
      : (CONTENT_TYPE_BY_EXTENSION[ext] ?? 'application/octet-stream');

    out.push({ filename, contentType, content: stripped, bytes });
  }
  return { attachments: out };
}

// ── copies (cc / bcc) ────────────────────────────────────────────────────────
//
// A copy is not a second send and not a subscriber. ONE message is rendered for
// the `to` profile and delivered to several addresses, so `{{customer.*}}` is the
// primary's throughout — a cc'd reader sees the primary's name, exactly as cc
// works everywhere else.

/** Cap on to + cc + bcc for one send. SES allows 50; this is friendlier and ample. */
export const MAX_RECIPIENTS = 20;

/**
 * Parse a `cc`/`bcc` field: a single address or a list of them.
 *
 * Addresses end up in message headers, so a CR or LF in one could append a header
 * of its own — `isEmailAddress` rejects those along with everything else malformed.
 * De-duplicated case-insensitively: the same address twice is one delivery, and
 * sending someone two copies of one message looks like a bug in the sender.
 */
export function parseRecipientList(raw: unknown, field: 'cc' | 'bcc'): string[] | { error: string } {
  if (raw === undefined || raw === null || raw === '') return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of list) {
    if (typeof v !== 'string') return { error: `'${field}' must be an email address or a list of them` };
    const addr = v.trim();
    if (!addr) continue;
    if (!isEmailAddress(addr)) return { error: `'${field}' contains an invalid email address: ${addr.slice(0, 80)}` };
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(addr);
  }
  return out;
}

/** A validated request body. */
export interface TransactionalRequest {
  readonly template: string;
  readonly to: string;
  readonly data: Record<string, unknown>;
  /** Send despite an unsubscribe. Deliverability blocks still apply. */
  readonly ignoreUnsubscribe: boolean;
  /** Files to attach. Email only — a text message has nowhere to put them. */
  readonly attachments: readonly ParsedAttachment[];
  /** Visible copies. Email only. */
  readonly cc: readonly string[];
  /** Blind copies. Email only, and never echoed anywhere a recipient can see. */
  readonly bcc: readonly string[];
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
  const att = parseAttachments(b.attachments);
  if ('error' in att) return { error: att.error };

  const cc = parseRecipientList(b.cc, 'cc');
  if ('error' in cc) return { error: cc.error };
  const bcc = parseRecipientList(b.bcc, 'bcc');
  if ('error' in bcc) return { error: bcc.error };
  const total = 1 + cc.length + bcc.length;
  if (total > MAX_RECIPIENTS) {
    return { error: `too many recipients: ${total} — at most ${MAX_RECIPIENTS} per message, counting to, cc and bcc` };
  }

  return {
    template,
    to,
    data: (data as Record<string, unknown>) ?? {},
    ignoreUnsubscribe: b.ignore_unsubscribe === true,
    attachments: att.attachments,
    cc,
    bcc,
  };
}


/**
 * Reasons a COPY is dropped. Deliberately narrower than the primary's gate.
 *
 * A cc'd accountant never subscribed to anything, so an unsubscribe says nothing
 * about whether they should receive an invoice copy — only that they do not want
 * marketing. What does apply is deliverability and complaints: mailing a dead box
 * or someone who reported us as spam damages the sending reputation of every other
 * tenant, whoever the message was for.
 */
const COPY_BLOCKING_REASONS = new Set(['hard_bounce', 'permanent_soft_bounce', 'complaint']);

/** Whether a suppression reason blocks a cc/bcc copy. PURE. */
export function blocksCopy(suppressionReason: string | null | undefined): boolean {
  return !!suppressionReason && COPY_BLOCKING_REASONS.has(suppressionReason);
}
