// The ONE definition of "can this workspace send email?". Shared by local-api's
// configuration readiness (which gates the broadcast composer) and the automation
// runner (which skips email send nodes when it is false) — the runner cannot import
// local-api, and two copies had already drifted (the runner forgot `smtp`).

/** The DB-derived facts the email-readiness decision needs. */
export interface EmailReadinessFacts {
  hasResendConnector: boolean;
  /** A From is configured for Resend (workspace default_from, or the connector's legacy config.from). */
  resendFromSet: boolean;
  hasSesConnector: boolean;
  /** Self-hosted mail server. */
  hasSmtpConnector?: boolean;
  verifiedDomainCount: number;
  senderCount: number;
}

/**
 * Resend is trusted (domains are verified in its own dashboard), so it only needs a
 * From. SES and self-hosted SMTP need a verified sending domain AND a named sender:
 * there WE vouch for the domain, so it must be verified in-app.
 */
export function isEmailChannelReady(f: EmailReadinessFacts): boolean {
  if (f.hasResendConnector) return f.resendFromSet;
  return (f.hasSesConnector || f.hasSmtpConnector === true) && f.verifiedDomainCount > 0 && f.senderCount > 0;
}
