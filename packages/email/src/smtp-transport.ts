// The real SMTP transport behind `createSmtpEmailClient`.
//
// nodemailer rather than a hand-rolled SMTP conversation: dot-stuffing, line-ending
// normalisation, STARTTLS negotiation, AUTH mechanism selection, connection reuse
// and per-error classification are all things that look simple and are not. This is
// the same reasoning that chose Postfix over writing an MTA — the protocol plumbing
// is exactly the part not worth owning.
//
// The envelope is set EXPLICITLY (`envelope.from`), which is the whole point: the
// Return-Path must be the per-message VERP address so a bounce can be attributed,
// while the visible `From:` header inside the raw message stays the sending
// company's own address. nodemailer would otherwise derive the envelope from the
// headers and we would lose bounce attribution entirely.
import { createTransport, type Transporter } from 'nodemailer';
import type { SmtpTransport, SmtpEnvelope } from './smtp-client.js';

export interface SmtpTransportConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly pass: string;
  /**
   * Accept a self-signed certificate. Our own MTA presents one until a publicly
   * trusted cert is installed; this affects only the app→MTA hop, never the
   * MTA→internet hop that recipients see.
   */
  readonly allowSelfSigned?: boolean;
  /** Cap on a single submission. Submission is fast; a hang must not be. */
  readonly timeoutMs?: number;
}

/**
 * Build a pooled SMTP transport.
 *
 * Pooling matters at volume: opening a TCP + TLS + AUTH handshake per message
 * would dominate the cost of sending and hammer the MTA with connections. The
 * pool is deliberately small — the throughput limit is the receiving side, not us.
 */
export function makeSmtpTransport(cfg: SmtpTransportConfig): SmtpTransport & { close(): void } {
  const timeout = cfg.timeoutMs ?? 20_000;
  const transporter: Transporter = createTransport({
    host: cfg.host,
    port: cfg.port,
    // 587 is submission: start plaintext then upgrade. `secure: true` would mean
    // implicit TLS (465), which our submission service does not offer.
    secure: cfg.port === 465,
    requireTLS: true,
    auth: { user: cfg.user, pass: cfg.pass },
    pool: true,
    maxConnections: 5,
    maxMessages: 100,
    connectionTimeout: timeout,
    greetingTimeout: timeout,
    socketTimeout: timeout,
    ...(cfg.allowSelfSigned ? { tls: { rejectUnauthorized: false } } : {}),
  });

  return {
    async send(envelope: SmtpEnvelope): Promise<void> {
      await transporter.sendMail({
        // The VERP bounce address — NOT the visible From. This is what makes an
        // asynchronous bounce attributable to one exact message.
        // Every recipient goes in the ENVELOPE — including bcc, which appears in no
        // header. nodemailer would otherwise derive the envelope from the headers
        // and silently never deliver the blind copies.
        envelope: { from: envelope.returnPath, to: [...envelope.recipients] },
        raw: envelope.raw,
      });
    },
    close() {
      transporter.close();
    },
  };
}

/**
 * Build the transport from environment, or null when self-hosted SMTP is not
 * configured. Null is a normal state: a deployment with no mail server of its own
 * simply uses SES or Resend.
 */
export function smtpTransportFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): (SmtpTransport & { close(): void }) | null {
  const host = env.SELF_HOSTED_SMTP_HOST;
  const user = env.SELF_HOSTED_SMTP_USER;
  const pass = env.SELF_HOSTED_SMTP_PASS;
  if (!host || !user || !pass) return null;
  return makeSmtpTransport({
    host,
    port: Number(env.SELF_HOSTED_SMTP_PORT ?? 587),
    user,
    pass,
    allowSelfSigned: env.SELF_HOSTED_SMTP_ALLOW_SELF_SIGNED !== 'false',
  });
}
