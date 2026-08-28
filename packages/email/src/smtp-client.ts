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
import type { SendEmailInput, SendEmailResult, SesEmailClient } from './ses-client.js';
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
  const headers: string[] = [
    `From: ${headerValue(input.from)}`,
    `To: ${headerValue(input.to)}`,
    `Subject: ${headerValue(input.subject)}`,
    `Message-ID: <${messageId}@${messageIdDomain}>`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
  ];
  for (const [k, v] of Object.entries(input.headers ?? {})) {
    // Never let a caller-supplied header overwrite one we control.
    const key = headerValue(k);
    if (!key || /^(from|to|subject|message-id|date|mime-version|content-type|content-transfer-encoding)$/i.test(key)) {
      continue;
    }
    headers.push(`${key}: ${headerValue(v)}`);
  }
  return `${headers.join('\r\n')}\r\n\r\n${input.html ?? ''}`;
}

/**
 * Build a self-hosted SMTP email client.
 *
 * `messageId` must be the outbox/message uuid: it is both the Message-ID and the
 * VERP token payload, which is what lets an inbound bounce be tied back to this
 * exact send. It is passed per-call through `SendEmailInput.configurationSetName`
 * — reusing that field rather than widening the shared interface, since it is
 * meaningless for a non-SES transport.
 */
export function createSmtpEmailClient(cfg: SmtpEmailConfig, transport: SmtpTransport): SesEmailClient {
  const notSupported = (): never => {
    throw new Error('operation not supported for the self-hosted SMTP email provider');
  };

  return {
    async sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
      const messageId = input.configurationSetName;
      if (!messageId) {
        throw new Error('createSmtpEmailClient: a message id is required for VERP bounce attribution');
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
