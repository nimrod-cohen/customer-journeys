// Self-hosted SMTP transport — the third email provider beside SES and Resend.
//
// Like the Resend client, it satisfies the `sendEmail` half of SesEmailClient (the
// only method the Dispatcher calls), so it is a DROP-IN wherever the dispatcher
// uses `deps.ses`. The SES-specific identity/config-set methods throw: domain
// verification for this provider is our own DKIM CNAME flow, not SES's.
//
// Two things make this transport different from the hosted providers:
//
//   1. WE set the Message-ID, before sending, from the outbox message id. SES and
//      Resend assign one after the fact and hand it back; owning it up front makes
//      bounce correlation exact rather than best-effort.
//   2. The envelope sender is a per-message VERP address, so an asynchronous
//      bounce arriving hours later identifies the exact message. The recipient
//      never sees it — the visible From: header is still the sending company's.
//
// The SMTP conversation is injectable so tests assert the exact envelope and
// headers without opening a socket.
import type { EmailAttachment, SendEmailInput, SendEmailResult, SesEmailClient } from './ses-client.js';
import { verpReturnPath } from './verp.js';

/** One SMTP submission: envelope plus the already-rendered RFC 5322 message. */
export interface SmtpEnvelope {
  /** MAIL FROM — the VERP bounce address, never the visible From:. */
  readonly returnPath: string;
  /** RCPT TO. */
  readonly to: string;
  /** The full message: headers and body. */
  readonly raw: string;
}

export interface SmtpTransport {
  send(envelope: SmtpEnvelope): Promise<void>;
}

export interface SmtpEmailConfig {
  /** Host running our MTA, e.g. `mail.journeys.on-grow.com`. */
  readonly host: string;
  /** Submission port. 587, never 25 — providers block outbound 25. */
  readonly port: number;
  /** Domain the VERP return path lives in, e.g. `bounce.journeys.on-grow.com`. */
  readonly bounceDomain: string;
  /** HMAC secret for the VERP token; the ingestion side must share it. */
  readonly verpSecret: string;
  /** Message-ID domain — the sending company's, so it aligns with the From:. */
  readonly messageIdDomain?: string;
}

/** Fold a header value onto one line; strips CR/LF so a merged value cannot inject headers. */
function headerValue(v: string): string {
  return String(v ?? '').replace(/[\r\n]+/g, ' ').trim();
}

// ── attachments ──────────────────────────────────────────────────────────────
//
// The multipart wrapper is built here rather than by nodemailer's MailComposer
// for one reason: this transport already composes its single-part message by hand
// (it owns the Message-ID, which is what makes a VERP bounce attributable), and
// handing composition to the composer would rewrite every header of live
// self-hosted mail to fix a part that is thirty deterministic lines. SES needs no
// raw MIME at all — SESv2 takes attachments on its Simple content.

/** RFC 2045 caps an encoded line at 76 characters; longer lines get mangled in transit. */
function wrapBase64(b64: string): string {
  const clean = String(b64 ?? '').replace(/\s+/g, '');
  const lines: string[] = [];
  for (let i = 0; i < clean.length; i += 76) lines.push(clean.slice(i, i + 76));
  return lines.join('\r\n');
}

/** Strip anything that could end a header line or reach a filesystem. */
function safeFilename(name: string): string {
  const clean = String(name ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\r\n\x00-\x1F\x7F]/g, '')
    .replace(/[\\/]/g, '_')
    .trim();
  return clean || 'attachment';
}

/**
 * The ASCII form for `filename="…"`. A quote or a backslash would close the
 * parameter early and let the rest of the name be read as header syntax.
 */
function asciiFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  const ascii = safeFilename(name).replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_').trim();
  return ascii || 'attachment';
}

/** Only a well-formed type is emitted; anything else could carry header syntax. */
function safeMimeType(v: string): string {
  const t = String(v ?? '').trim();
  return /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(t) ? t : 'application/octet-stream';
}

/**
 * One `multipart/mixed` part per file. The filename is written TWICE — the plain
 * `filename=` for old clients and RFC 2231's `filename*=UTF-8''…` — so a Hebrew or
 * accented name survives instead of arriving as underscores.
 */
function attachmentPart(a: EmailAttachment): string {
  const name = asciiFilename(a.filename);
  const encoded = encodeURIComponent(safeFilename(a.filename)).replace(/'/g, '%27');
  const type = safeMimeType(a.contentType);
  return [
    `Content-Type: ${type}; name="${name}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${name}"; filename*=UTF-8''${encoded}`,
    '',
    wrapBase64(a.content),
  ].join('\r\n');
}

/**
 * Build the RFC 5322 message. Header injection is the risk here: `subject` and
 * `to` are merge-rendered per recipient, so a value containing CRLF could append
 * arbitrary headers (a second Bcc:, say). Every header value is flattened.
 */
export function buildMimeMessage(
  input: SendEmailInput,
  messageId: string,
  messageIdDomain: string,
): string {
  const attachments = input.attachments ?? [];
  // A message with no attachment stays SINGLE-PART: wrapping every send in a
  // multipart container to serve the few that carry a file would change the shape
  // of mail that has none.
  const boundary = attachments.length > 0 ? `----=_cdp_${messageId.replace(/[^A-Za-z0-9]/g, '')}` : '';
  const headers: string[] = [
    `From: ${headerValue(input.from)}`,
    `To: ${headerValue(input.to)}`,
    `Subject: ${headerValue(input.subject)}`,
    `Message-ID: <${messageId}@${messageIdDomain}>`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    ...(boundary
      ? [`Content-Type: multipart/mixed; boundary="${boundary}"`]
      : ['Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: 8bit']),
  ];
  for (const [k, v] of Object.entries(input.headers ?? {})) {
    // Never let a caller-supplied header overwrite one we control.
    const key = headerValue(k);
    if (!key || /^(from|to|subject|message-id|date|mime-version|content-type|content-transfer-encoding)$/i.test(key)) {
      continue;
    }
    headers.push(`${key}: ${headerValue(v)}`);
  }
  const head = headers.join('\r\n');
  if (!boundary) return `${head}\r\n\r\n${input.html ?? ''}`;

  const parts = [
    ['Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', input.html ?? ''].join('\r\n'),
    ...attachments.map(attachmentPart),
  ];
  return `${head}\r\n\r\n${parts.map((p) => `--${boundary}\r\n${p}\r\n`).join('')}--${boundary}--\r\n`;
}

/**
 * Build a self-hosted SMTP email client.
 *
 * `input.messageId` must be the outbox/message uuid: it is both the Message-ID and
 * the VERP token payload, which is what lets an inbound bounce be tied back to this
 * exact send.
 *
 * It has its own field rather than borrowing `configurationSetName`, which in the
 * dispatcher carries the workspace's real SES configuration-set name — signing VERP
 * tokens with that would produce bounce addresses that resolve to nothing while
 * appearing to work.
 */
export function createSmtpEmailClient(cfg: SmtpEmailConfig, transport: SmtpTransport): SesEmailClient {
  const notSupported = (): never => {
    throw new Error('operation not supported for the self-hosted SMTP email provider');
  };

  return {
    async sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
      const messageId = input.messageId;
      if (!messageId) {
        throw new Error('createSmtpEmailClient: input.messageId is required for VERP bounce attribution');
      }
      const fromDomain = cfg.messageIdDomain ?? (input.from.split('@')[1] ?? '').replace(/>$/, '') ?? cfg.host;
      const raw = buildMimeMessage(input, messageId, fromDomain || cfg.host);

      await transport.send({
        returnPath: verpReturnPath(cfg.bounceDomain, cfg.verpSecret, messageId),
        to: input.to,
        raw,
      });

      // We assigned the id, so we return it — no provider round-trip needed.
      return { sesMessageId: messageId };
    },
    createDomainIdentity: notSupported,
    getIdentityVerificationAttributes: notSupported,
    createConfigurationSet: notSupported,
    provisionDedicatedIp: notSupported,
  } as SesEmailClient;
}
