-- 0040_topics_subscriptions.sql
-- TOPIC-BASED subscription management + a public preference center.
--
-- The user's model: a person can unsubscribe from specific TOPICS and/or from a
-- whole MEDIUM GROUP, and is only fully removed if they choose "unsubscribe from
-- everything". Subscription state has THREE independent layers:
--   1. (profile x topic)  subscribed bool  — topic_subscriptions
--   2. (profile x medium_group) opted-out  — channel_optouts (groups: email, sms_whatsapp)
--   3. the existing HARD suppression (bounces/complaints/full unsubscribe) — UNTOUCHED.
-- A partial opt-out (e.g. a topic, or just email) must NOT set the global hard
-- suppression / profiles.attributes.unsubscribed — the person stays reachable on
-- the still-subscribed channels.
--
-- Tenant isolation: every table carries workspace_id NOT NULL, has the standard
-- workspace_id RLS policy (the service-role dispatcher/unsubscribe scope in code),
-- and a workspace_id-leading index.

-- A workspace-defined topic (e.g. "Product news", "Weekly digest"). A broadcast/
-- campaign may be tagged with a topic; a recipient unsubscribed from that topic
-- is skipped. Archived topics are hidden from the default admin list but their
-- subscription rows are preserved.
CREATE TABLE IF NOT EXISTS topics (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name         text NOT NULL,
  description  text,
  archived     boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS topics_workspace_idx ON topics (workspace_id);

ALTER TABLE topics ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON topics;
CREATE POLICY tenant_isolation ON topics
  USING (app_is_platform_admin() OR workspace_id = app_current_workspace_id());

-- Per-(profile, topic) subscription state. DEFAULT-SUBSCRIBED: the ABSENCE of a
-- row means the profile is subscribed to that topic; we only store EXPLICIT
-- opt-outs (subscribed=false) and re-opt-ins (subscribed=true). FK to topics so
-- a topic delete cascades its subscription rows.
CREATE TABLE IF NOT EXISTS topic_subscriptions (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  profile_id   uuid NOT NULL REFERENCES profiles(id),
  topic_id     uuid NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  subscribed   boolean NOT NULL DEFAULT true,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, profile_id, topic_id)
);
CREATE INDEX IF NOT EXISTS topic_subscriptions_workspace_idx
  ON topic_subscriptions (workspace_id, profile_id);

ALTER TABLE topic_subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON topic_subscriptions;
CREATE POLICY tenant_isolation ON topic_subscriptions
  USING (app_is_platform_admin() OR workspace_id = app_current_workspace_id());

-- Per-(profile, medium_group) GLOBAL opt-out. A ROW means the profile has opted
-- OUT of that whole medium group. The two groups are 'email' and 'sms_whatsapp'
-- (WhatsApp + SMS are grouped). Default (no row) = still subscribed to the group.
CREATE TABLE IF NOT EXISTS channel_optouts (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  profile_id   uuid NOT NULL REFERENCES profiles(id),
  medium_group text NOT NULL CHECK (medium_group IN ('email', 'sms_whatsapp')),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, profile_id, medium_group)
);
CREATE INDEX IF NOT EXISTS channel_optouts_workspace_idx
  ON channel_optouts (workspace_id, profile_id);

ALTER TABLE channel_optouts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON channel_optouts;
CREATE POLICY tenant_isolation ON channel_optouts
  USING (app_is_platform_admin() OR workspace_id = app_current_workspace_id());

-- A broadcast/campaign may be tagged with a topic (NULL = untopiced, sends to
-- everyone not hard-suppressed/medium-opted-out). Gating is wired for broadcasts
-- now; the campaigns column is ready for the follow-up.
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS topic_id uuid REFERENCES topics(id);
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS topic_id uuid REFERENCES topics(id);
