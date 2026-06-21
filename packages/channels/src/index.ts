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

/**
 * Provider selection config. Today only `mock` is wired. When real adapters
 * land this grows (`{ kind: 'twilio', accountSid, authToken, ... }` etc.) —
 * see the TODO in `resolveChannelProvider`.
 */
export interface ChannelProviderConfig {
  /** The provider implementation to use. Only `mock` is implemented this phase. */
  readonly kind: 'mock';
}

/** The default (mock) config — used everywhere until real credentials exist. */
export const DEFAULT_CHANNEL_CONFIG: ChannelProviderConfig = { kind: 'mock' };

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
): ChannelProvider {
  if (!isTextMedium(medium)) {
    throw new Error(
      `resolveChannelProvider: '${medium}' is not a text channel (email uses the SES pipeline in @cdp/email)`,
    );
  }
  switch (config.kind) {
    case 'mock':
      return medium === 'sms' ? new MockSmsProvider() : new MockWhatsAppProvider();
    // TODO(real-providers): case 'twilio': return new TwilioSmsProvider(config);
    //                       case 'meta':   return new MetaWhatsAppProvider(config);
    default: {
      // Exhaustiveness guard — a new config kind must be handled above.
      const exhaustive: never = config.kind;
      throw new Error(`resolveChannelProvider: unsupported provider kind '${String(exhaustive)}'`);
    }
  }
}
