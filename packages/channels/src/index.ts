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
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

/**
 * Normalize a raw phone string to E.164 (e.g. '+972529461566'), or `null` when it
 * is missing / unparseable / invalid. The single point all text-channel recipient
 * numbers pass through before a provider call.
 *
 * - An already-`+E.164` number is validated and returned as-is (the `defaultCountry`
 *   is irrelevant).
 * - A NATIONAL number (leading 0 / no `+`) is interpreted in `defaultCountry` (an
 *   ISO 3166-1 alpha-2 code, e.g. 'IL') and converted to E.164.
 * - A national number with NO `defaultCountry` (or an unrecognized one) cannot be
 *   inferred → `null`.
 * - Formatting noise (spaces, dashes, parens) is tolerated by the parser.
 * - NEVER throws — any bad input (junk, empty, null, bad country) yields `null`.
 */
export function normalizePhone(raw: string, defaultCountry?: string | null): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const country =
    typeof defaultCountry === 'string' && defaultCountry.trim()
      ? (defaultCountry.trim().toUpperCase() as CountryCode)
      : undefined;
  try {
    const parsed = parsePhoneNumberFromString(trimmed, country);
    if (!parsed || !parsed.isValid()) return null;
    return parsed.number; // E.164
  } catch {
    return null;
  }
}

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

/**
 * A WhatsApp APPROVED TEMPLATE message (§10). Meta forbids free-form outbound
 * WhatsApp to anyone who hasn't messaged the business in the last 24h, so a
 * business-INITIATED send (broadcast/campaign) MUST reference a pre-approved
 * template by `name` + `language` and supply its body variable values (already
 * merge-rendered). Free-form `ChannelMessage.body` is only valid inside the 24h
 * customer-service window (and for the mock).
 */
export interface WhatsAppTemplate {
  /** The approved template's name (from WhatsApp Manager). */
  readonly name: string;
  /** The template's language/locale code, e.g. 'en_US' or 'he'. */
  readonly language: string;
  /** The body `{{1}}`,`{{2}}`,… variable values IN ORDER, already merge-rendered. */
  readonly bodyParams: readonly string[];
}

/** A single outbound text message, fully prepared by the Dispatcher core. */
export interface ChannelMessage {
  /** Recipient address (a phone number for sms/whatsapp), already merge-rendered. */
  readonly to: string;
  /** Message body, already merge-rendered (plain text — NO MJML, NO HTML). */
  readonly body: string;
  /** Optional sender id/number (e.g. a Twilio number) — unused by the mock. */
  readonly from?: string;
  /**
   * WhatsApp only: send an approved TEMPLATE instead of free-form text. Required
   * for business-initiated WhatsApp (a broadcast/campaign to a cold contact); the
   * real Meta adapter sends a `type:'template'` payload. Absent → free-form text.
   */
  readonly template?: WhatsAppTemplate;
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

/** Build the deterministic mock provider message id for a message. A template send
 *  folds the template name + params into the hash (its body may be empty). */
function mockMessageId(medium: TextMedium, msg: ChannelMessage): string {
  const prefix = medium === 'sms' ? 'mock-sms' : 'mock-wa';
  const tpl = msg.template ? `|tpl:${msg.template.name}|${msg.template.bodyParams.join('|')}` : '';
  const hash = createHash('sha256')
    .update(`${medium}|${msg.to}|${msg.body}${tpl}`)
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
  | { readonly kind: 'mock'; readonly defaultCountry?: string | null }
  | {
      readonly kind: '019';
      readonly apiUrl: string;
      readonly username: string;
      readonly source: string;
      readonly bearer: string;
      /** ISO 3166-1 alpha-2 default country for normalizing national numbers (e.g. 'IL'). */
      readonly defaultCountry?: string | null;
    }
  | {
      /** Real Meta WhatsApp Cloud API (per-company creds from company_whatsapp_config). */
      readonly kind: 'meta';
      /** API base — defaults to https://graph.facebook.com when omitted. */
      readonly apiUrl?: string | null;
      /** Graph API version, e.g. 'v21.0' (defaults to a pinned version when omitted). */
      readonly apiVersion?: string | null;
      /** The WhatsApp phone-number ID the message is sent FROM. */
      readonly phoneNumberId: string;
      /** The permanent system-user access token (decrypted at send time). */
      readonly accessToken: string;
      readonly defaultCountry?: string | null;
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

/** Default Graph API version for the Meta adapter when a company doesn't pin one. */
export const DEFAULT_META_API_VERSION = 'v21.0';
const DEFAULT_META_HTTP: ChannelHttpOptions = { timeoutMs: 10_000, maxRetries: 1 };

/**
 * Real WhatsApp provider over the Meta Cloud API. ONE JSON POST with a Bearer token:
 *   POST <apiUrl>/<version>/<phoneNumberId>/messages   Authorization: Bearer <accessToken>
 * The recipient is E.164 WITHOUT a leading '+' (Cloud API convention). A message with
 * `msg.template` sends a `type:'template'` payload (name + language + ordered body params)
 * — REQUIRED for business-initiated sends; otherwise a `type:'text'` payload (only valid
 * inside the 24h customer window). Success = 2xx AND a `messages[0].id` in the response;
 * a non-2xx, a missing id, or a network error THROWS (the dispatcher's retry/DLQ then
 * applies). Retries ONLY on 5xx / network (never 4xx). HTTP client injected — tests never
 * hit graph.facebook.com.
 */
export class MetaWhatsAppProvider implements ChannelProvider {
  readonly medium = 'whatsapp' as const;
  constructor(
    private readonly cfg: {
      apiUrl?: string | null;
      apiVersion?: string | null;
      phoneNumberId: string;
      accessToken: string;
    },
    private readonly http: ChannelHttpClient = fetchChannelHttpClient(),
    private readonly opts: ChannelHttpOptions = DEFAULT_META_HTTP,
  ) {}

  async send(msg: ChannelMessage): Promise<ChannelSendResult> {
    const base = (this.cfg.apiUrl && this.cfg.apiUrl.trim() ? this.cfg.apiUrl : 'https://graph.facebook.com').replace(/\/+$/, '');
    const version = this.cfg.apiVersion && this.cfg.apiVersion.trim() ? this.cfg.apiVersion : DEFAULT_META_API_VERSION;
    const url = `${base}/${version}/${this.cfg.phoneNumberId}/messages`;
    const to = msg.to.replace(/^\+/, ''); // Cloud API wants digits, no leading '+'
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.cfg.accessToken}`,
    };
    const payload = msg.template
      ? {
          messaging_product: 'whatsapp',
          to,
          type: 'template',
          template: {
            name: msg.template.name,
            language: { code: msg.template.language },
            ...(msg.template.bodyParams.length > 0
              ? {
                  components: [
                    {
                      type: 'body',
                      parameters: msg.template.bodyParams.map((t) => ({ type: 'text', text: t })),
                    },
                  ],
                }
              : {}),
          },
        }
      : { messaging_product: 'whatsapp', to, type: 'text', text: { preview_url: false, body: msg.body } };
    const body = JSON.stringify(payload);
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      let res: ChannelHttpResponse;
      try {
        res = await this.http.post(url, headers, body, this.opts.timeoutMs);
      } catch (e) {
        lastErr = e; // network/timeout → retry
        continue;
      }
      if (res.status >= 500) {
        lastErr = new Error(`Meta WhatsApp: HTTP ${res.status}`);
        continue; // server error → retry
      }
      let json: { messages?: Array<{ id?: unknown }>; error?: { message?: unknown }; [k: string]: unknown };
      try {
        json = JSON.parse(res.body) as typeof json;
      } catch {
        if (res.status < 200 || res.status >= 300) throw new Error(`Meta WhatsApp: HTTP ${res.status} — ${res.body.slice(0, 200)}`);
        throw new Error('Meta WhatsApp: response was not JSON');
      }
      if (res.status < 200 || res.status >= 300) {
        // 4xx → no retry; surface Meta's error message (bad template, expired token, …).
        const detail = typeof json.error?.message === 'string' ? json.error.message : res.body.slice(0, 200);
        throw new Error(`Meta WhatsApp: HTTP ${res.status} — ${detail}`);
      }
      const id = json.messages?.[0]?.id;
      if (typeof id !== 'string' || id.length === 0) {
        throw new Error(`Meta WhatsApp: no message id in response — ${res.body.slice(0, 200)}`);
      }
      return { providerMessageId: id };
    }
    throw lastErr instanceof Error ? lastErr : new Error('Meta WhatsApp: send failed');
  }
}

/**
 * Resolve a `ChannelProvider` for a text medium — the seam where a real adapter slots in.
 * Returns the deterministic MOCK whenever a company has no real credentials (so dev/e2e
 * send for real, locally, without any creds — unlike email, which needs real SES); a real
 * adapter is returned when the resolved `config` carries that provider's credentials.
 * `email` is NOT a channel here (it has its own SES pipeline); asking for it throws so a
 * mis-route is caught loudly.
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
  if (medium === 'whatsapp') {
    // Real Meta adapter when the company configured WhatsApp creds, else the mock.
    return config.kind === 'meta' ? new MetaWhatsAppProvider(config, http ?? fetchChannelHttpClient()) : new MockWhatsAppProvider();
  }
  // SMS: a real 019 adapter when the company configured it, else the mock.
  switch (config.kind) {
    case '019':
      return new Sms019Provider(config, http ?? fetchChannelHttpClient());
    case 'meta':
    case 'mock':
      return new MockSmsProvider();
    default: {
      const exhaustive: never = config;
      throw new Error(`resolveChannelProvider: unsupported provider kind '${String((exhaustive as { kind?: unknown }).kind)}'`);
    }
  }
}
