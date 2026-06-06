-- 0005_messaging.sql
-- Campaigns (§9B), broadcasts (§9A), templates, outbox, messages_log,
-- suppressions, email_events, usage_counters.
-- See CDP-BUILD-SPEC.md §6, §9, §9A, §9B, §10, §20.

-- email_templates is created first: broadcasts and outbox reference it.
CREATE TABLE email_templates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  name          text NOT NULL,
  mjml          text NOT NULL,
  compiled_html text NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON email_templates (workspace_id);

-- Campaign = a multi-step workflow (graph of nodes). See §9B.
CREATE TABLE campaigns (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           uuid NOT NULL REFERENCES workspaces(id),
  name                   text NOT NULL,
  definition             jsonb NOT NULL,                -- workflow graph: nodes [trigger|wait|condition|action|exit] + edges
  trigger_segment_id     uuid REFERENCES segments(id),  -- enrollment trigger (segment entry); other triggers live in definition
  frequency_cap_per_days int,
  quiet_hours            jsonb,
  status                 text NOT NULL DEFAULT 'draft',  -- draft|active|paused|archived
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON campaigns (workspace_id, status);

-- Per-profile journey state (the "waits" + position live here). See §9B.
CREATE TABLE campaign_enrollments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  campaign_id  uuid NOT NULL REFERENCES campaigns(id),
  profile_id   uuid NOT NULL REFERENCES profiles(id),
  current_node text NOT NULL,
  status       text NOT NULL DEFAULT 'active',          -- active|completed|exited|failed
  next_run_at  timestamptz,                             -- when the current wait/step is due
  state        jsonb NOT NULL DEFAULT '{}',
  enrolled_at  timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, profile_id)                      -- one active enrollment per profile (re-enrollment policy TBD per phase)
);
CREATE INDEX ON campaign_enrollments (status, next_run_at);  -- the runner's sweep query
CREATE INDEX ON campaign_enrollments (workspace_id, campaign_id);

-- Broadcast = a single email sent once to a segment or manual group. See §9A.
CREATE TABLE broadcasts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  name          text NOT NULL,
  template_id   uuid REFERENCES email_templates(id),
  audience_kind text NOT NULL,                          -- segment|manual_group
  audience_ref  uuid NOT NULL,                          -- segment_id (segment or manual segment)
  scheduled_at  timestamptz,                            -- null = send now
  status        text NOT NULL DEFAULT 'draft',          -- draft|scheduled|sending|sent|cancelled
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz
);
CREATE INDEX ON broadcasts (workspace_id, status);

CREATE TABLE outbox (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  profile_id   uuid NOT NULL REFERENCES profiles(id),
  campaign_id  uuid REFERENCES campaigns(id),
  template_id  uuid REFERENCES email_templates(id),
  dedupe_key   text UNIQUE,
  status       text NOT NULL DEFAULT 'pending',
  attempts     int NOT NULL DEFAULT 0,
  payload      jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz
);
CREATE INDEX ON outbox (status, created_at);
CREATE INDEX ON outbox (workspace_id, status);

CREATE TABLE messages_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id),
  profile_id     uuid NOT NULL REFERENCES profiles(id),
  campaign_id    uuid REFERENCES campaigns(id),
  ses_message_id text,
  status         text NOT NULL DEFAULT 'sent',
  sent_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON messages_log (workspace_id, sent_at);
CREATE INDEX ON messages_log (workspace_id, profile_id, sent_at);

-- Suppression list, scoped per workspace (an unsubscribe is relative to the sender).
CREATE TABLE suppressions (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  email        citext NOT NULL,
  reason       text NOT NULL,                          -- hard_bounce|complaint|unsubscribe|manual
  source       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, email)
);

-- Optional global hard-bounce list for invalid mailboxes (cross-workspace).
CREATE TABLE global_hard_bounces (
  email      citext PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE email_events (
  id             bigserial PRIMARY KEY,
  workspace_id   uuid NOT NULL REFERENCES workspaces(id),
  ses_message_id text,
  profile_id     uuid REFERENCES profiles(id),
  type           text NOT NULL,                         -- delivery|bounce|complaint|open|click
  sub_type       text,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  raw            jsonb
);
CREATE INDEX ON email_events (workspace_id, occurred_at);

-- Usage metering for per-workspace cost attribution (§20).
CREATE TABLE usage_counters (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  period       date NOT NULL,                           -- month bucket (first day)
  metric       text NOT NULL,                           -- emails_sent|events_ingested|image_storage_bytes|image_egress_bytes
  value        numeric NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, period, metric)
);
