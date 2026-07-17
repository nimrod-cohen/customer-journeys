# Connectors — per-company provider registry + channel gating

## Goal
Rename **Sending → Connectors**. A company connects providers; each connector powers a
messaging **channel** (email / sms / whatsapp). A channel is **enabled** iff ≥1 connector
that can actually send on it is connected. Disabled channels are shown disabled and are
**ignored** in broadcasts + automations (the send is skipped as if the step doesn't exist).
Add **Resend** as an alternate email provider so we're not blocked on the SES sandbox.

## Decisions (locked with the user)
- **Unified table** `company_connectors` (extensible for future providers) — migrate the
  3 existing per-provider config tables into it and repoint the dispatcher's resolution.
- **Resend From = trust.** Company verifies their domain in Resend's dashboard; in our app
  the Resend connector carries a `from` address. No in-app Resend domain verification.
- **Broadcasts:** disable the medium in the composer when its channel has no connector; an
  existing broadcast on a now-disabled channel can't be sent.
- **Connectors tab = messaging only** (email/sms/whatsapp). R2 image storage stays its own
  card (moves to the Company tab).

## Data model
```sql
CREATE TABLE company_connectors (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  channel     text NOT NULL,              -- 'email' | 'sms' | 'whatsapp'
  provider    text NOT NULL,              -- 'ses' | 'resend' | '019' | 'meta_whatsapp'
  config      jsonb NOT NULL DEFAULT '{}',-- non-secret: region/access_key_id, from, api_url/username/source/default_country, phone_number_id/waba_id/api_version
  secret      text,                       -- encrypted (secret access key / api key / bearer / access token); write-only over API
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, channel, provider)
);
-- company-scoped RLS (mirror company_ses_config)
```
Data migration copies existing rows: ses_config→(email,ses), channel_config→(sms,019),
whatsapp_config→(whatsapp,meta_whatsapp), secrets carried verbatim (already encrypted).
Old tables kept (dormant) for one release for rollback; new writes go to connectors only.

## Channel availability (the gate source of truth)
`channelsForCompany(companyId) → { email, sms, whatsapp: boolean }`:
- **email** enabled iff an enabled `resend` connector, OR an enabled `ses` connector AND a
  verified `sending_domains` row (SES still needs a verified domain; Resend is trusted).
- **sms** enabled iff an enabled `019` connector.
- **whatsapp** enabled iff an enabled `meta_whatsapp` connector.
Exposed as `GET /company/channels` for the SPA gating.

## Send resolution (dispatcher)
Per channel, resolve the enabled connector (if >1, most-recently-updated wins). Repoint
`sesForWorkspace` (email) + `channelConfigForWorkspace` (sms/whatsapp) to read
`company_connectors`. Email transport branches on provider: `ses`→existing SES path;
`resend`→new Resend send adapter (`@cdp/email`), From = connector `from`, To/Subject/body
rendered as today. sms/whatsapp unchanged (019/meta from the connector config).

## Gating
- **Broadcasts:** composer medium picker greys out channels with no connector; `sendBroadcast`
  refuses a disabled-channel send with a clear reason.
- **Automations:** builder marks a send node whose channel is disabled as **inactive**; the
  **runner skips** such a send node (advance to `next`, no outbox) as if it doesn't exist;
  publish/activate no longer blocks on a disabled channel's send node.

## Connectors CRUD + UI
- `GET /company/connectors` (list, secrets never returned), `PUT /company/connectors`
  (upsert by channel+provider; blank secret keeps stored), `DELETE /company/connectors/:id`,
  `GET /company/channels`. Capability `manage_sending_domain`.
- Company settings tab **Sending → Connectors**: per channel (Email/SMS/WhatsApp) show its
  connector(s) with connect/edit/disconnect + an enabled/disabled badge; a channel with no
  connector reads "disabled". Email offers **Amazon SES** or **Resend**. R2 card → Company tab.

## Phases (build + verify locally each)
1. Table + data migration.
2. Resolution repoint + `channelsForCompany` (existing send tests stay green).
3. Connector CRUD + `/company/channels`.
4. Resend send adapter + provider-branching + email-enabled (SES-verified-or-Resend) gate.
5. UI: Connectors tab.
6. Gating: broadcasts + automation runner skip + builder inactive state.
7. Tests (unit/integration/e2e) + CLAUDE.md.
