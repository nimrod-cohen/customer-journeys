// @cdp/channels — the MULTI-CHANNEL sending abstraction (broadcasts, this phase).
//
// Email is NOT modeled here — it keeps its own dedicated, MJML/SES pipeline in
// @cdp/email (template → compiled HTML → SES, with the verified-domain gate,
// open/click tracking, List-Unsubscribe headers). This package covers the NEW
// parallel text channels — SMS and WhatsApp — behind a single narrow
// `ChannelProvider` interface so the Dispatcher routes by `Medium` and a future
// real Twilio/Meta adapter slots in WITHOUT touching the dispatcher.
//
// This phase ships MOCK providers ONLY (the user explicitly chose "architecture
// + mock only"): they are DETERMINISTIC and NEVER touch the network — the exact
// twin of the local SES mock — so everything works end-to-end in dev/tests.
import { createHash } from 'node:crypto';

/** The sending medium of a broadcast (and a messages_log row). */
export type Medium = 'email' | 'sms' | 'whatsapp';

/** The text channels this package owns (email is handled by @cdp/email). */
export type TextMedium = Exclude<Medium, 'email'>;

/** All valid mediums (for validation / check constraints / UI). */
export const MEDIUMS: readonly Medium[] = ['email', 'sms', 'whatsapp'] as const;

/** Whether `m` is a recognised medium. */
export function isMedium(m: unknown): m is Medium {
  return typeof m === 'string' && (MEDIUMS as readonly string[]).includes(m);
}

/** Whether a medium is one of the text channels owned by @cdp/channels. */
export function isTextMedium(m: unknown): m is TextMedium {
  return m === 'sms' || m === 'whatsapp';
}

/**
 * A subscription MEDIUM GROUP — the granularity at which a recipient opts out of
 * a whole channel family (CLAUDE.md topic-subscriptions). The user's model groups
 * WhatsApp + SMS together: `email` and `sms_whatsapp`. A `channel_optouts` row is
 * keyed on one of these.
 */
export type MediumGroup = 'email' | 'sms_whatsapp';

/** The two medium groups (for validation / UI). */
export const MEDIUM_GROUPS: readonly MediumGroup[] = ['email', 'sms_whatsapp'] as const;

/** Whether `g` is a recognised medium group. */
export function isMediumGroup(g: unknown): g is MediumGroup {
  return g === 'email' || g === 'sms_whatsapp';
}

/** The medium group a sending medium belongs to (email→email; sms/whatsapp→sms_whatsapp). */
export function mediumGroupOf(m: Medium): MediumGroup {
  return m === 'email' ? 'email' : 'sms_whatsapp';
}

/** Human label for a medium group (UI / preference center). */
export function mediumGroupLabel(g: MediumGroup): string {
  return g === 'email' ? 'Email' : 'WhatsApp & SMS';
}

/** Human label for a medium (UI badges / messages). */
export function mediumLabel(m: Medium): string {
  switch (m) {
    case 'email':
      return 'Email';
    case 'sms':
      return 'SMS';
    case 'whatsapp':
      return 'WhatsApp';
  }
}

/** A single outbound text message, fully prepared by the Dispatcher core. */
export interface ChannelMessage {
  /** Recipient address (a phone number for sms/whatsapp), already merge-rendered. */
  readonly to: string;
  /** Message body, already merge-rendered (plain text — NO MJML, NO HTML). */
  readonly body: string;
  /** Optional sender id/number (e.g. a Twilio number) — unused by the mock. */
  readonly from?: string;
}

/** Result of a successful provider send — the provider's message id. */
export interface ChannelSendResult {
  /** The provider's message id, written to messages_log.ses_message_id. */
  readonly providerMessageId: string;
}

/**
 * The injectable channel surface (SMS / WhatsApp). The Dispatcher depends on
 * THIS narrow interface, never a concrete provider — so tests inject the mock
 * and a future real adapter (Twilio/Meta) is a drop-in. Mirrors the role
 * `SesEmailClient.sendEmail` plays for email.
 */
export interface ChannelProvider {
  /** The medium this provider serves (for assertion / logging). */
  readonly medium: TextMedium;
  /** Send one prepared message; resolves with the provider message id. */
  send(msg: ChannelMessage): Promise<ChannelSendResult>;
}

/**
 * Deterministic mock SMS provider — the local/test default (the twin of the
 * local SES mock). Returns `mock-sms-<hash>` where the hash is a stable digest
 * of (to, body) so the SAME message always yields the SAME id (idempotent,
 * assertable in tests) and a DIFFERENT message yields a different id. NEVER
 * hits the network.
 */
export class MockSmsProvider implements ChannelProvider {
  readonly medium = 'sms' as const;
  async send(msg: ChannelMessage): Promise<ChannelSendResult> {
    return { providerMessageId: mockMessageId('sms', msg) };
  }
}

/**
 * Deterministic mock WhatsApp provider — mirrors MockSmsProvider. Returns
 * `mock-wa-<hash>`. NEVER hits the network.
 */
export class MockWhatsAppProvider implements ChannelProvider {
  readonly medium = 'whatsapp' as const;
  async send(msg: ChannelMessage): Promise<ChannelSendResult> {
    return { providerMessageId: mockMessageId('whatsapp', msg) };
  }
}

/** Build the deterministic mock provider message id for a message. */
function mockMessageId(medium: TextMedium, msg: ChannelMessage): string {
  const prefix = medium === 'sms' ? 'mock-sms' : 'mock-wa';
  const hash = createHash('sha256')
    .update(`${medium}|${msg.to}|${msg.body}`)
    .digest('hex')
    .slice(0, 16);
  return `${prefix}-${hash}`;
}

// ── HTTP client seam (for real providers) ───────────────────────────────────
// Real adapters do ONE HTTP POST. We depend on a narrow injectable client so
// unit tests assert the exact request + map responses WITHOUT touching the
// network (mirrors how the dispatcher injects SES / the webhook client).

/** A minimal HTTP response surface a channel adapter needs. */
export interface ChannelHttpResponse {
  readonly status: number;
  readonly body: string;
}

/** A narrow HTTP client (one POST) — injected so tests never hit the network. */
export interface ChannelHttpClient {
  post(
    url: string,
    headers: Record<string, string>,
    body: string,
    timeoutMs: number,
  ): Promise<ChannelHttpResponse>;
}

/** The production fetch-based client: a POST bounded by an AbortController timeout. */
export function fetchChannelHttpClient(): ChannelHttpClient {
  return {
    async post(url, headers, body, timeoutMs) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, { method: 'POST', headers, body, signal: ctrl.signal });
        return { status: res.status, body: await res.text() };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Provider selection config. `mock` is the dev/test default; `019` is the real
 * Israeli SMS gateway (a static-bearer JSON POST). Per-company credentials live
 * in `company_channel_config` and are passed in here by the dispatcher.
 */
export type ChannelProviderConfig =
  | { readonly kind: 'mock' }
  | {
      readonly kind: '019';
      readonly apiUrl: string;
      readonly username: string;
      readonly source: string;
      readonly bearer: string;
    };

/** The default (mock) config — used everywhere a company has no real credentials. */
export const DEFAULT_CHANNEL_CONFIG: ChannelProviderConfig = { kind: 'mock' };

/** Tuning for a real adapter's HTTP call. */
export interface ChannelHttpOptions {
  readonly timeoutMs: number;
  /** Extra attempts on 5xx / network error (never on 4xx). */
  readonly maxRetries: number;
}
const DEFAULT_019_HTTP: ChannelHttpOptions = { timeoutMs: 10_000, maxRetries: 1 };

/**
 * Real SMS provider for the "019" gateway. ONE JSON POST with a static bearer:
 *   POST <apiUrl>  Authorization: Bearer <bearer>
 *   { sms: { user:{username}, source, destinations:{phone}, message,
 *            add_dynamic:'0', add_unsubscribe:'0', response:'0', includes_international:'0' } }
 * Success = response JSON `status === 0`. A non-2xx, a non-zero status, or a
 * network error THROWS (the dispatcher's retry/DLQ then applies). Retries ONLY on
 * 5xx / network (never 4xx). The HTTP client is injected — tests never hit 019.
 */
export class Sms019Provider implements ChannelProvider {
  readonly medium = 'sms' as const;
  constructor(
    private readonly cfg: { apiUrl: string; username: string; source: string; bearer: string },
    private readonly http: ChannelHttpClient = fetchChannelHttpClient(),
    private readonly opts: ChannelHttpOptions = DEFAULT_019_HTTP,
  ) {}

  async send(msg: ChannelMessage): Promise<ChannelSendResult> {
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.cfg.bearer}`,
    };
    const payload = {
      sms: {
        user: { username: this.cfg.username },
        source: this.cfg.source,
        destinations: { phone: msg.to },
        message: msg.body,
        add_dynamic: '0',
        add_unsubscribe: '0',
        response: '0',
        includes_international: '0',
      },
    };
    const body = JSON.stringify(payload);
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      let res: ChannelHttpResponse;
      try {
        res = await this.http.post(this.cfg.apiUrl, headers, body, this.opts.timeoutMs);
      } catch (e) {
        lastErr = e; // network/timeout → retry
        continue;
      }
      if (res.status >= 500) {
        lastErr = new Error(`019 SMS: HTTP ${res.status}`);
        continue; // server error → retry
      }
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`019 SMS: HTTP ${res.status} — ${res.body.slice(0, 200)}`); // 4xx → no retry
      }
      let json: { status?: unknown; [k: string]: unknown };
      try {
        json = JSON.parse(res.body) as typeof json;
      } catch {
        throw new Error('019 SMS: response was not JSON');
      }
      if (json.status !== 0) {
        throw new Error(`019 SMS: send rejected — ${res.body.slice(0, 200)}`);
      }
      const id =
        (typeof json.message_id === 'string' && json.message_id) ||
        (typeof json.unique_id === 'string' && json.unique_id) ||
        (json.message_id != null && String(json.message_id)) ||
        `019-${createHash('sha256').update(`${msg.to}|${msg.body}`).digest('hex').slice(0, 16)}`;
      return { providerMessageId: id };
    }
    throw lastErr instanceof Error ? lastErr : new Error('019 SMS: send failed');
  }
}

/**
 * Resolve a `ChannelProvider` for a text medium — the SEAM where a real adapter
 * slots in. This phase ALWAYS returns the deterministic mock (so dev/e2e send
 * for real, locally, without any credentials — unlike email which needs real
 * SES creds). `email` is NOT a channel here (it has its own SES pipeline);
 * asking for it throws so a mis-route is caught loudly.
 *
 * TODO(real-providers, follow-up): when bringing real Twilio (SMS) / Meta
 * (WhatsApp) credentials, extend `ChannelProviderConfig` with a per-provider
 * variant (e.g. `{ kind: 'twilio', accountSid, authToken, messagingServiceSid }`,
 * `{ kind: 'meta', phoneNumberId, accessToken }`) and add a `case` here that
 * constructs a real adapter implementing `ChannelProvider.send` over the
 * provider's HTTP API (with timeouts + bounded retries, mirroring
 * @cdp/runner-webhook). Per-company credentials would live in a `company_*_config`
 * table (like `company_ses_config`) and be passed in as the `config`. NO real
 * HTTP is implemented in this phase — mock only.
 */
export function resolveChannelProvider(
  medium: Medium,
  config: ChannelProviderConfig = DEFAULT_CHANNEL_CONFIG,
  http?: ChannelHttpClient,
): ChannelProvider {
  if (!isTextMedium(medium)) {
    throw new Error(
      `resolveChannelProvider: '${medium}' is not a text channel (email uses the SES pipeline in @cdp/email)`,
    );
  }
  // WhatsApp has no real adapter yet (Meta Cloud API is a follow-up) — always mock.
  if (medium === 'whatsapp') return new MockWhatsAppProvider();
  // SMS: a real 019 adapter when the company configured it, else the mock.
  switch (config.kind) {
    case '019':
      return new Sms019Provider(config, http ?? fetchChannelHttpClient());
    case 'mock':
      return new MockSmsProvider();
    // TODO(real-providers): case 'meta': return new MetaWhatsAppProvider(config) for whatsapp.
    default: {
      const exhaustive: never = config;
      throw new Error(`resolveChannelProvider: unsupported provider kind '${String((exhaustive as { kind?: unknown }).kind)}'`);
    }
  }
}
