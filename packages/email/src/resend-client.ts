// Resend email transport (§10) — an alternate email provider to Amazon SES, chosen
// per company via a connector. It satisfies the `sendEmail` half of SesEmailClient
// (the only method the Dispatcher calls), so it's a DROP-IN wherever the dispatcher
// uses `deps.ses`. The SES-specific identity/config-set methods throw — a Resend
// company verifies its domain in Resend's OWN dashboard (trusted From), so the
// in-app SES verification flow never runs for it. HTTP is injectable so tests
// assert the exact request without touching the network.
import type { SendEmailInput, SendEmailResult, SesEmailClient } from './ses-client.js';

export interface ResendHttpResponse {
  readonly status: number;
  readonly body: string;
}
export interface ResendHttpClient {
  post(url: string, headers: Record<string, string>, body: string, timeoutMs: number): Promise<ResendHttpResponse>;
}

/** Real fetch-based client (AbortController timeout). */
export function fetchResendHttpClient(): ResendHttpClient {
  return {
    async post(url, headers, body, timeoutMs) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, { method: 'POST', headers, body, signal: ctrl.signal });
        return { status: res.status, body: await res.text() };
      } finally {
        clearTimeout(t);
      }
    },
  };
}

export interface ResendEmailConfig {
  /** Resend API key (decrypted at call time). */
  readonly apiKey: string;
  /** The trusted From (verified in Resend by the company), e.g. `Acme <news@acme.com>`. */
  readonly from: string;
}

/**
 * Build a Resend-backed email client. `from` comes from the connector (trusted);
 * To/Subject/HTML + headers (List-Unsubscribe etc.) are passed through from the
 * SAME rendered SendEmailInput the SES path uses — so tracking/unsubscribe/merge
 * are identical, only the transport differs.
 */
export function createResendEmailClient(
  cfg: ResendEmailConfig,
  http: ResendHttpClient = fetchResendHttpClient(),
): SesEmailClient {
  const notSupported = (): never => {
    throw new Error('operation not supported for the Resend email provider');
  };
  return {
    async sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
      const payload: Record<string, unknown> = {
        from: cfg.from || input.from,
        to: input.to,
        subject: input.subject,
        html: input.html,
      };
      if (input.headers && Object.keys(input.headers).length > 0) payload.headers = input.headers;
      const res = await http.post(
        'https://api.resend.com/emails',
        { Authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
        JSON.stringify(payload),
        15_000,
      );
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`Resend send failed (HTTP ${res.status}): ${res.body.slice(0, 200)}`);
      }
      let id = '';
      try {
        id = String((JSON.parse(res.body) as { id?: string }).id ?? '');
      } catch {
        /* Resend returned non-JSON on 2xx — treat as sent with no id */
      }
      return { sesMessageId: id };
    },
    createDomainIdentity: notSupported,
    getIdentityVerificationAttributes: notSupported,
    // Resend has no configuration sets — a no-op keeps any generic caller happy.
    createConfigurationSet: async () => {},
    provisionDedicatedIp: notSupported,
  };
}
