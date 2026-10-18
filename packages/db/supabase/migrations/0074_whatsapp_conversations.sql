-- 0074_whatsapp_conversations.sql
-- Two-way WhatsApp: the conversations and messages Meta's webhooks deliver, plus a
-- raw inbox of every signed webhook POST.
--
-- Meta has NO "fetch history" API — a message exists for us only if our webhook
-- stored it. So the webhook stores the raw payload FIRST (whatsapp_webhook_inbox)
-- and processes it second; a processing failure is retried by a sweep from our own
-- copy rather than depending on Meta's redelivery.

-- Both tables reference profiles ON DELETE CASCADE (unlike the NO ACTION default
-- elsewhere): a chat is the person's own words, so erasing the person erases it,
-- and any send now creates one — a NO ACTION key would block every profile delete
-- that forgot it. deleteProfile still lists them explicitly.

-- One conversation per (workspace, WhatsApp phone). `last_inbound_at` drives Meta's
-- 24h customer-service window (free-form replies are allowed only inside it).
CREATE TABLE IF NOT EXISTS whatsapp_conversations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  profile_id            uuid REFERENCES profiles(id) ON DELETE CASCADE,
  wa_phone              text NOT NULL,              -- E.164
  contact_name          text,
  last_message_at       timestamptz,
  last_inbound_at       timestamptz,
  last_message_preview  text,
  unread_count          int NOT NULL DEFAULT 0,
  archived              boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, wa_phone)
);
CREATE INDEX IF NOT EXISTS whatsapp_conversations_recent_idx
  ON whatsapp_conversations (workspace_id, last_message_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS whatsapp_conversations_profile_idx
  ON whatsapp_conversations (workspace_id, profile_id);

-- Every message in or out. `wamid` is Meta's message id and the idempotency key:
-- Meta redelivers webhooks, so an inbound insert is ON CONFLICT DO NOTHING.
-- `conversation_id`/`profile_id` are NULLABLE for one reason: a delivery status can
-- arrive before the dispatcher has written the outbound row it describes, so the
-- status lands as a stub keyed by wamid and the send fills it in (order-convergent).
CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id  uuid REFERENCES whatsapp_conversations(id) ON DELETE CASCADE,
  profile_id       uuid REFERENCES profiles(id) ON DELETE CASCADE,
  direction        text NOT NULL CHECK (direction IN ('in', 'out')),
  wamid            text NOT NULL,
  type             text NOT NULL DEFAULT 'text',
  body             text,
  media            jsonb,                          -- {media_id, mime_type, filename, sha256, stored, attempts, error}
  template         jsonb,                          -- {name, language, params}
  status           text NOT NULL DEFAULT 'sent'
                   CHECK (status IN ('received', 'pending', 'sent', 'delivered', 'read', 'failed')),
  error            jsonb,
  broadcast_id     uuid,
  automation_id    uuid,
  sent_by_user_id  uuid,
  provider_ts      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, wamid)
);
CREATE INDEX IF NOT EXISTS whatsapp_messages_thread_idx
  ON whatsapp_messages (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS whatsapp_messages_profile_idx
  ON whatsapp_messages (workspace_id, profile_id);
CREATE INDEX IF NOT EXISTS whatsapp_messages_media_pending_idx
  ON whatsapp_messages (created_at)
  WHERE media IS NOT NULL AND media->>'media_id' IS NOT NULL AND media->>'stored' IS NULL;

ALTER TABLE whatsapp_conversations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON whatsapp_conversations;
CREATE POLICY tenant_isolation ON whatsapp_conversations
  USING (app_is_platform_admin() OR workspace_id = app_current_workspace_id());

ALTER TABLE whatsapp_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON whatsapp_messages;
CREATE POLICY tenant_isolation ON whatsapp_messages
  USING (app_is_platform_admin() OR workspace_id = app_current_workspace_id());

-- Media a customer sent (photos, documents, voice notes). Meta's download URLs expire
-- within minutes and the media itself is deleted after ~30 days, so a sweep copies
-- it here. Deliberately NOT `assets`: an asset is served PUBLICLY by id (it is
-- embedded in emails), and a customer's ID card or invoice must only ever be served
-- to a signed-in user of the workspace. Bytes live in the company's R2 bucket when
-- one is configured (`r2_key`), else inline in `data`.
CREATE TABLE IF NOT EXISTS whatsapp_media (
  message_id    uuid PRIMARY KEY REFERENCES whatsapp_messages(id) ON DELETE CASCADE,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mime_type     text NOT NULL,
  size_bytes    int NOT NULL,
  storage       text NOT NULL CHECK (storage IN ('db', 'r2')),
  r2_key        text,
  data          bytea,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE whatsapp_media ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON whatsapp_media;
CREATE POLICY tenant_isolation ON whatsapp_media
  USING (app_is_platform_admin() OR workspace_id = app_current_workspace_id());

-- The raw signed webhook bodies. PLATFORM-level, not workspace-scoped: one POST can
-- carry entries for several WhatsApp accounts, and the workspace is resolved per
-- change from the phone number id. Pruned after 30 days.
CREATE TABLE IF NOT EXISTS whatsapp_webhook_inbox (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  received_at   timestamptz NOT NULL DEFAULT now(),
  payload       jsonb NOT NULL,
  processed_at  timestamptz,
  attempts      int NOT NULL DEFAULT 0,
  last_error    text
);
CREATE INDEX IF NOT EXISTS whatsapp_webhook_inbox_pending_idx
  ON whatsapp_webhook_inbox (received_at) WHERE processed_at IS NULL;

ALTER TABLE whatsapp_webhook_inbox ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_only ON whatsapp_webhook_inbox;
CREATE POLICY platform_only ON whatsapp_webhook_inbox
  USING (app_is_platform_admin()) WITH CHECK (app_is_platform_admin());
