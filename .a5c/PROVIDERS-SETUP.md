# Real SMS / WhatsApp provider connection — human prerequisites

The multi-channel architecture is built and works end-to-end in dev/tests with a
**deterministic mock provider** (`MockSmsProvider` / `MockWhatsAppProvider` in
`packages/channels/src/index.ts`). Connecting a **real** provider is a human step —
it needs accounts + credentials this codebase cannot create (the same situation as
SES production access). Nothing about the app is blocked: SMS/WhatsApp broadcasts and
campaign send nodes already render, enqueue, route by medium, gate by
suppression/topic/medium-group, and "send" via the mock.

## What's already in place
- `@cdp/channels`: `Medium` (`email|sms|whatsapp`), `ChannelProvider` interface
  (`send({to, body, from?}) → {providerMessageId}`), the mock providers, the **real
  `Sms019Provider`**, and `resolveChannelProvider(medium, config, http?)` — the single
  seam where a real adapter slots in.
- Dispatcher routes `sms`/`whatsapp` outbox rows through the resolved provider; email
  keeps its SES pipeline (`@cdp/email`).
- `messages_log.medium`, `broadcasts.medium`/`text_body`, campaign send-node
  `medium`/`text_body`, recipient `{{customer.phone}}` resolution.

## SMS via 019 — WIRED (v0.57.0)
The Israeli **019 SMS gateway** is a fully-connected real SMS provider. Per-company
credentials live in **`company_channel_config`** (migration `0041`; company-scoped + RLS,
the twin of `company_ses_config`): `provider='019'`, `api_url`, `username`, `source`, and
the **bearer** (`secret`, write-only over the API, envelope-encrypted at rest via
`@cdp/db` secret-crypto, decrypted only at send time). The dispatcher builds an
`Sms019Provider` from a company's row (`channelConfigForWorkspace`) and falls back to the
deterministic MOCK when there is no row — so dev/tests/e2e keep working with zero creds.

**What the company admin pastes** (Company settings → "Text messaging (019 SMS)" card):
- **API URL** — the 019 SMS send endpoint (e.g. `https://019sms.co.il/api`).
- **Username** — the 019 account username.
- **Source (sender)** — the registered sender id/name shown to recipients.
- **Bearer token** — the 019 API bearer (write-only; leave blank on edit to keep the
  stored one).

A request is `POST <api_url>` with `Authorization: Bearer <bearer>` and JSON body
`{ sms: { user:{username}, source, destinations:{phone}, message, add_dynamic:'0',
add_unsubscribe:'0', response:'0', includes_international:'0' } }`; success is response
`status === 0`. (Human prerequisite: an 019 account + a registered sender — the platform
cannot create these.) WhatsApp + a real SMS adapter for other gateways (Twilio) are still
follow-ups below.

## Human prerequisites
1. **Pick + open a provider account.**
   - SMS: e.g. Twilio (Messaging Service / a sending number).
   - WhatsApp: Meta WhatsApp Business (Cloud API) — a Business account, a phone-number
     id, and **pre-approved message templates** (WhatsApp requires template approval for
     business-initiated messages).
2. **Obtain credentials** (Twilio: Account SID + Auth Token + from-number/Messaging
   Service SID; Meta: phone-number id + permanent access token + template names).
3. **Decide where credentials live.** Mirror `company_ses_config` (per-company, secret
   write-only, envelope-encrypted via `@cdp/db` secret-crypto): add a
   `company_channel_config` table (provider kind + region/account + encrypted secret)
   and a Company-settings UI, then feed it into `ChannelProviderConfig`.
4. **Sender registration / compliance** (human): A2P 10DLC / sender-id registration for
   SMS; WhatsApp template approval; opt-in records. The preference center
   (`/manage-subscription`) + `channel_optouts` already cover opt-out.

## Where to implement the adapter (no other code should need to change)
In `packages/channels/src/index.ts`, `resolveChannelProvider` has a `TODO(real-providers)`:

```ts
// case 'twilio': return new TwilioSmsProvider(config);
// case 'meta_whatsapp': return new MetaWhatsAppProvider(config);
```

Add the adapter class implementing `ChannelProvider.send(...)` (a thin REST call with a
timeout; on failure throw so the dispatcher's existing retry/DLQ handling applies),
extend `ChannelProviderConfig` with the provider's fields, and resolve the config from
`company_channel_config` instead of `DEFAULT_CHANNEL_CONFIG` (`{kind:'mock'}`). Keep the
mock as the default for local dev + tests.

## Required prod secret (v0.56.0)
`UNSUBSCRIBE_LINK_SECRET` — the HMAC key that signs/verifies the tokenized
unsubscribe + manage-subscription links. MUST be set (a strong random value) on
BOTH the dispatcher (signer) and the unsubscribe/manage handlers (verifier); they
must share the SAME value. In dev/tests a fixed fallback (`DEV_UNSUBSCRIBE_LINK_SECRET`)
is used so links verify deterministically — never use it in production.
