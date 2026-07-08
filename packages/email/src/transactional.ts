// Transactional (SYSTEM) email — invites, password resets, verification. This is
// DELIBERATELY separate from the per-company MARKETING pipeline (SES): transactional
// and marketing must not share a domain/reputation, and the marketing SES is per-
// company + sandboxed. The provider is Resend (a dedicated transactional service).
//
// A deterministic MOCK is the default when RESEND_API_KEY is unset (dev / tests /
// e2e), so nothing hits the network without real credentials — the twin of the SES
// mock used for marketing.

/** One transactional email to a single recipient. */
export interface TxEmail {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text?: string;
}

export interface TxSendResult {
  readonly id: string;
}

/** The narrow send seam the app depends on (never the raw provider SDK). */
export interface TransactionalMailer {
  send(email: TxEmail): Promise<TxSendResult>;
}

/** Injectable HTTP so tests assert the exact request without touching the network. */
export interface TxHttpClient {
  post(url: string, headers: Record<string, string>, body: string): Promise<{ status: number; body: string }>;
}

/** Default fetch-based HTTP client (10s timeout). */
export function fetchTxHttpClient(): TxHttpClient {
  return {
    async post(url, headers, body) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10_000);
      try {
        const res = await fetch(url, { method: 'POST', headers, body, signal: ctrl.signal });
        return { status: res.status, body: await res.text() };
      } finally {
        clearTimeout(t);
      }
    },
  };
}

/** Config for the Resend mailer (apiKey decrypted/resolved by the caller). */
export interface ResendConfig {
  readonly apiKey: string;
  /** The From header, e.g. `On-Grow <no-reply@notifications.on-grow.com>`. */
  readonly from: string;
  readonly apiUrl?: string; // defaults to https://api.resend.com/emails
}

/** Thrown when the provider rejects a send (surfaced to the caller for logging). */
export class TxSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TxSendError';
  }
}

/** Resend transactional mailer — POST /emails with a Bearer API key. */
export class ResendMailer implements TransactionalMailer {
  constructor(
    private readonly cfg: ResendConfig,
    private readonly http: TxHttpClient = fetchTxHttpClient(),
  ) {}

  async send(email: TxEmail): Promise<TxSendResult> {
    const url = this.cfg.apiUrl && this.cfg.apiUrl.trim() ? this.cfg.apiUrl : 'https://api.resend.com/emails';
    const payload: Record<string, unknown> = {
      from: this.cfg.from,
      to: [email.to],
      subject: email.subject,
      html: email.html,
    };
    if (email.text) payload.text = email.text;
    const res = await this.http.post(
      url,
      { authorization: `Bearer ${this.cfg.apiKey}`, 'content-type': 'application/json' },
      JSON.stringify(payload),
    );
    if (res.status < 200 || res.status >= 300) {
      throw new TxSendError(`Resend rejected the email (${res.status}): ${res.body.slice(0, 300)}`);
    }
    let id = '';
    try {
      id = (JSON.parse(res.body) as { id?: string }).id ?? '';
    } catch {
      /* tolerate a non-JSON 2xx body */
    }
    return { id: id || `resend-${res.status}` };
  }
}

/** Deterministic, offline mailer — the default without RESEND_API_KEY. Records sends. */
export class MockTransactionalMailer implements TransactionalMailer {
  readonly sends: TxEmail[] = [];
  async send(email: TxEmail): Promise<TxSendResult> {
    this.sends.push(email);
    // Deterministic id (no network, no randomness).
    const key = `${email.to}|${email.subject}`;
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
    return { id: `mock-tx-${(h >>> 0).toString(16)}` };
  }
}

/**
 * Resolve the transactional mailer: Resend when `apiKey` is present, else the
 * deterministic mock (dev / tests / before the key is configured).
 */
export function resolveTransactionalMailer(
  cfg: { apiKey?: string | null; from?: string | null },
  http?: TxHttpClient,
): TransactionalMailer {
  if (cfg.apiKey && cfg.apiKey.trim()) {
    return new ResendMailer(
      { apiKey: cfg.apiKey, from: cfg.from && cfg.from.trim() ? cfg.from : DEFAULT_SYSTEM_FROM },
      http,
    );
  }
  return new MockTransactionalMailer();
}

/** Fallback From identity (override via SYSTEM_EMAIL_FROM). */
export const DEFAULT_SYSTEM_FROM = 'On-Grow <no-reply@notifications.on-grow.com>';
