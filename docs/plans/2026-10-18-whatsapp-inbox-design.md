# WhatsApp as a two-way channel — per-workspace config, inbound, chat inbox

Status: PLAN (not started). Date: 2026-10-18.

## Where we are today

Already built (outbound only):
- `MetaWhatsAppProvider` (`packages/channels/src/index.ts`) — real Graph API `/messages`, text + template sends, retry on 5xx only.
- WhatsApp in broadcasts (`medium='whatsapp'`, `text_body`, `whatsapp_template`), automation send nodes (`wa_template`), text templates, transactional text.
- Template management proxied live to Meta (`/whatsapp/templates`, `WhatsAppTemplates.tsx`).
- Consent: `channel_optouts` `sms_whatsapp` gate in the dispatcher.

Missing:
- **Config is per-COMPANY** (`company_connectors` `meta_whatsapp` + legacy `company_whatsapp_config`). Must become per-WORKSPACE.
- **Bug:** `whatsappTemplatesConfig()` (`handlers.ts`) reads only the legacy table, so a company set up via Connectors sees "not configured".
- No inbound: no webhook, no stored conversations, no delivery/read statuses, no chat UI, no realtime.

**Meta constraint that shapes everything:** the Cloud API has NO "fetch conversation history" endpoint. Messages and statuses reach us ONLY as webhooks. So "pull chats when the user opens the screen" = read what our webhook already stored. Anything that arrives while the webhook is down is retried by Meta (with backoff, for up to ~7 days) — the endpoint must be durable and idempotent.

## Decisions (agreed 2026-10-18)

| | Decision |
|---|---|
| Meta app | **One platform-owned Meta app**, one webhook URL. Each workspace connects its own WABA + phone number to it. |
| Config scope | **Workspace-only.** WhatsApp moves out of Company Connectors into a Workspace settings tab. One phone number belongs to exactly one workspace (globally unique) → inbound routing is unambiguous. |
| Live updates | **SSE + Postgres LISTEN/NOTIFY**, polling as fallback. No extra cost (auto-stop is off in `fly.toml`). |
| Unknown sender | **Auto-create a phone-only profile**, name from WhatsApp contact. |
| Shared numbers | **Never.** A number belongs to one workspace system-wide (enforced, v0.138.0). Migrated config went to each company's oldest workspace. |
| Opt-outs | **SMS and WhatsApp stay ONE opt-out group** (`sms_whatsapp`): opting out of either opts out of both. |
| Replies vs. opt-out | An agent's reply **inside the 24h window** is sent even to someone opted out of marketing, because they messaged first. |
| Connecting a number | **Partner sharing now, Embedded Signup later** (see Human prerequisites). |

## Phase 1 — Per-workspace config (minor bump)

- Migration `0073_workspace_whatsapp_config.sql`: table `workspace_whatsapp_config`
  - `workspace_id` UNIQUE FK, `phone_number_id` **UNIQUE globally** (routing key), `waba_id`, `display_phone_number`, `verified_name`, `api_version`, `access_token` (encrypted, write-only), `enabled`, `webhook_subscribed_at`, timestamps. RLS = workspace pattern (`sending_domains`).
  - Data copy: each company's existing WhatsApp config goes to its **oldest workspace only** (the number can't be shared). Other workspaces start unconfigured — listed in release notes.
- API (owner-gated, like Sending domains): `GET/PUT/DELETE /workspace/whatsapp`, `POST /workspace/whatsapp/test`.
  - On save: `GET /<phone_number_id>` to verify the token and capture the display number / verified name; `POST /<waba_id>/subscribed_apps` to subscribe our app to this WABA's webhooks. Either failing → 400 with Meta's reason, nothing written.
  - `phone_number_id` already used by another workspace → 409.
- Rewire every reader to the new table (one resolver, `whatsappConfigForWorkspace`): dispatcher `channelConfigForWorkspace`, `whatsappTemplatesConfig` (fixes the bug), readiness (`hasWhatsappConnector` → workspace-scoped, readiness item `scope:'workspace'`), runner `resolveChannels`.
- UI: Workspace settings → **WhatsApp** tab (form + connection status + "test"). Remove the WhatsApp box from `Connectors.tsx`. Legacy `/company/whatsapp-config` routes deleted; old tables left dormant.

## Phase 2 — Data model for conversations (part of Phase 3 release)

- `whatsapp_conversations`: `workspace_id`, `profile_id`, `wa_phone` (E.164), `contact_name`, `last_message_at`, `last_inbound_at` (drives the 24h window), `last_message_preview`, `unread_count`, `archived`. UNIQUE(`workspace_id`, `wa_phone`).
- `whatsapp_messages`: `workspace_id`, `conversation_id`, `profile_id`, `direction` in|out, `wamid` UNIQUE(`workspace_id`, `wamid`), `type` (text|image|video|audio|document|sticker|location|reaction|interactive|button|template|unsupported), `body`, `media` jsonb `{media_id, mime, filename, asset_id}`, `template` jsonb, `status` (pending|sent|delivered|read|failed), `error` jsonb, source columns (`broadcast_id`, `automation_id`, `sent_by_user_id`, `transactional_key`), `provider_ts`, `created_at`.
- `whatsapp_webhook_inbox`: raw signed payloads, for replay/debug (pruned after 30 days).
- Both conversation tables are added to `PROFILE_CHILD_TABLES` (GDPR delete) and `customerMerge` reassignment.
- **Every outbound send writes a `whatsapp_messages` row**: broadcasts, automations and transactional sends included, in the same tx as `messages_log` in `dispatchTextChannel`. That is how the chat shows the full history. `messages_log` stays unchanged.

## Phase 3 — Webhook ingest (minor bump)

- `GET /webhooks/whatsapp` — Meta's verification handshake: `hub.mode=subscribe` + `hub.verify_token === META_WEBHOOK_VERIFY_TOKEN` → echo `hub.challenge`, else 403.
- `POST /webhooks/whatsapp`:
  1. Verify `X-Hub-Signature-256` = HMAC-SHA256(`META_APP_SECRET`, **raw body**), constant-time. Bad/missing → 401. (Needs the raw body before JSON parsing.)
  2. Store raw in `whatsapp_webhook_inbox`, then process; return 200 quickly. Processing failure still returns 200 after the raw row is stored, and a sweep reprocesses it later. Meta's retries are not our durability.
  3. **Workspace = lookup of `entry.changes.value.metadata.phone_number_id` in `workspace_whatsapp_config`** (inv.2 — the body is signed by Meta, but the tenant still comes from OUR table). Unknown number → 200 + drop + log.
- Pure core `classifyWhatsAppWebhook(payload)` → `{messages[], statuses[], contacts[]}` (unit-tested against Meta's sample payloads).
- **Inbound message** (one workspace tx):
  - Resolve the profile by phone (`resolveIdentity`, normalized E.164). If none exists, auto-create a phone-only profile; the contact name goes to the `whatsapp_name` attribute. This fires `profile` triggers as usual.
  - Upsert the conversation: `last_inbound_at`, `unread_count+1`, preview.
  - Insert the message `ON CONFLICT (workspace_id, wamid) DO NOTHING` (Meta retries → idempotent).
  - Record a behavioral event `whatsapp_message_received` (payload: text, type, wamid) via `recomputeFeaturesAndSegments`, so **event-triggered automations and segments can react to replies**.
  - `pg_notify('wa_events', {workspace_id, conversation_id, message_id})`. Ids only; the payload limit is 8 KB.
- **Status** (sent/delivered/read/failed):
  - Update `whatsapp_messages.status` **monotonically**: never `read` → `delivered`. `failed` always wins and stores Meta's error code.
  - Order-convergent (inv.3): a status that arrives before our outbound row exists upserts a stub by wamid. The send then fills it in.
  - Also feeds the broadcast funnel for WhatsApp (Delivered / Read / Failed, joined via `messages_log.ses_message_id` = wamid).
- **Media:** (built, v0.139.0)
  - Meta's media URLs expire within minutes, and the media itself is deleted after 30 days.
  - A sweep downloads each file into **`whatsapp_media`** (the company's R2 bucket, else bytea). It deliberately does **not** use `assets`: assets are served publicly by id, and a customer's ID card or invoice must only be served to signed-in users.
  - Phase 4 adds the authenticated `GET /whatsapp/media/:messageId`.
- New secrets: `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`. Store them in all 3 locations (password manager, SSM, Fly).

## Phase 4 — Chat UI + live updates (minor bump)

**Read API** (`manage_content`, workspace-scoped):
- `GET /whatsapp/conversations?q=&cursor=` — the inbox list, newest first.
- `GET /whatsapp/conversations/:id/messages?before=` — paginated, 50 per page.
- `POST /whatsapp/conversations/:id/read` — zeroes the unread count. It can also send Meta read receipts (blue ticks) if the workspace turns that setting on.
- `GET /profiles/:id/whatsapp` — returns the conversation for that profile.

**Live updates:** `GET /whatsapp/stream` (SSE):
- **Auth:** EventSource can't send headers. The client first gets a short-lived stream ticket from `POST /whatsapp/stream-ticket`, then opens `?ticket=`.
- **Server side:** each web machine holds ONE `LISTEN wa_events` connection on the direct (non-pooled) `DATABASE_URL`. The Supabase pooler in transaction mode can't LISTEN. The machine fans each notification out to the open streams of that workspace only.
- **Events:** `message.new`, `message.status`, `conversation.updated`. The client refetches by id, so no message content travels over NOTIFY.
- **Keep-alive:** a heartbeat every 25 seconds keeps Fly's proxy from closing idle streams.
- **Fallback:** if the stream drops, the client polls (open chat every 5 seconds, inbox every 20 seconds) until it reconnects.

**Screens:**
- **`/inbox`** — a top-level nav item, "WhatsApp inbox". It is hidden when the workspace has no WhatsApp config, and shows an unread badge.
  - **Layout:** like WhatsApp Web. The left pane is a searchable conversation list (name/number, preview, time, unread count). The right pane is the thread: bubbles, date separators, ✓ / ✓✓ / blue ✓✓ / failed indicators, media, template bubbles labelled with the template name, and labels for messages sent by a broadcast or automation (with a link). The header has a link to the profile.
  - **Mobile:** the two panes stack.
- **Profile → "WhatsApp" tab** — the SAME `ChatThread` component, scoped to the profile. It shows a "No conversation yet" state with the template composer.
- **Shared components** in `web/src/whatsapp/`: `ConversationList`, `ChatThread`, `Composer`, and `useWhatsAppStream()`.

## Phase 5 — Replying from the chat (part of Phase 4 release)

- `POST /whatsapp/conversations/:id/messages` `{text}` | `{template:{name, language, params}}`. Profile-only start: `POST /profiles/:id/whatsapp/messages`.
- **24h customer-service window** (Meta rule):
  - Free-form text is allowed only within 24h of `last_inbound_at`.
  - Outside the window, **template only**: the composer turns into a template picker with a banner saying why.
  - The server enforces the same rule with a 409, so we don't spend a call on Meta's error 131047.
- **Consent:** a reply inside the 24h window is sent even if the person opted out of marketing (they messaged first). A template send outside the window respects the `sms_whatsapp` opt-out like any other send.
- Sends go directly through `MetaWhatsAppProvider` (an interactive send; no outbox delay). The message row is written `pending`, then becomes `sent` with the wamid, or `failed` with a **Retry** action. Metered as `usage_counters.whatsapp_sent`. The send button auto-locks.
- Later (not v1): sending attachments, emoji reactions, assignment / multiple agents, quick replies.

## Phase 6 — Make broadcast/automation/transactional WhatsApp correct (patch/minor)

Sending already works; these close the gaps:
- **Warn or force template mode for WhatsApp broadcasts.** A free-form WhatsApp broadcast fails for anyone outside the 24h window, which is most of an audience. The composer should default to template mode, and a text-mode broadcast should show a warning.
- **Transactional WhatsApp:** add template support (`text_templates` → a Meta template reference). Today it is free-form only.
- **New automation trigger:** a "WhatsApp reply received" event, plus an optional "Wait until reply" gate. Both reuse the `whatsapp_message_received` event and the existing `wait_until` condition. No new node type.
- **Opt-out from WhatsApp:**
  - An inbound `STOP` / `הסר` writes the `sms_whatsapp` `channel_optouts` row, which opts the person out of WhatsApp AND SMS (one group, by decision).
  - Meta error 131050 ("user stopped marketing messages") does the same.
- Fix the stale `TODO(real-providers)` mentions in `CLAUDE.md` and `.a5c/PROVIDERS-SETUP.md`.

## Testing (§16A, test-first)

- **Unit (pure):**
  - signature verification: good, bad and missing; raw body vs a re-serialized body
  - `classifyWhatsAppWebhook` against Meta sample payloads (every message type, statuses, errors)
  - status monotonicity
  - the 24h window decision
  - media type mapping
- **Integration (real Postgres, Meta HTTP mocked):**
  - routing by `phone_number_id`
  - **cross-workspace isolation**: workspace A's number can never write into B, and B's user gets a 404 on A's conversation
  - idempotent replay of the same webhook
  - status arriving before the send
  - auto-created profile
  - event recorded → event-triggered automation enrolls
  - outbound broadcast send appears in the conversation
  - GDPR delete removes the chat
  - migration copies company config to the oldest workspace
- **SSE:** a NOTIFY reaches only that workspace's streams.
- **e2e** (only when asked): inject a signed mock webhook → message shows up in the inbox and the profile tab → reply → ticks update.

## Human prerequisites (cannot be done by Claude)

1. Create the platform **Meta app** (Business type) and add the WhatsApp product.
2. Set the webhook URL `https://journeys.on-grow.com/webhooks/whatsapp` with the verify token, and subscribe the `messages` field.
3. **Tokens must be issued for OUR app.** `POST /<waba>/subscribed_apps` subscribes the app the token belongs to. A token the customer creates in their own Meta app would route their webhooks to *their* app, and no reply would ever reach us.
   - **Now: partner sharing.** The customer opens Meta Business Manager → Partners and shares their WhatsApp Business Account with OUR business. We create a System User token on our side, for our app, and paste it into their workspace's WhatsApp tab.
   - **Later: Embedded Signup.** A "Connect with Facebook" button that does this self-serve. It needs our app approved as a Meta **Tech Provider** (business verification + App Review for `whatsapp_business_messaging` / `whatsapp_business_management`). Start that process in parallel; it takes days to weeks.
## Open questions

None. All four were answered on 2026-10-19 and recorded under Decisions.

## Release order

Phase 1 → 3 (with 2) → 4 + 5 → 6. Each phase gets its own branch, minor bump, and green typecheck + Vitest before merging to main.
