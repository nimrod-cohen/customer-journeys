-- 0003_identity.sql
-- Identity (system of record): profiles, events, profile_features.
-- See CDP-BUILD-SPEC.md §6, §7.

CREATE TABLE profiles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id),
  external_id   text,
  email         citext,
  email_status  text NOT NULL DEFAULT 'active',
  attributes    jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, external_id)                   -- external_id unique per workspace
);
CREATE INDEX ON profiles (workspace_id, email);
CREATE INDEX ON profiles USING gin (attributes);

CREATE TABLE events (
  event_id     uuid PRIMARY KEY,                       -- producer-supplied; dedupe key
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  profile_id   uuid NOT NULL REFERENCES profiles(id),
  type         text NOT NULL,
  occurred_at  timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  payload      jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX ON events (workspace_id, profile_id, occurred_at);

CREATE TABLE profile_features (
  profile_id         uuid PRIMARY KEY REFERENCES profiles(id),
  workspace_id       uuid NOT NULL REFERENCES workspaces(id),
  total_events       int NOT NULL DEFAULT 0,
  last_event_at      timestamptz,
  last_email_open_at timestamptz,
  counters           jsonb NOT NULL DEFAULT '{}',
  monetary_total     numeric NOT NULL DEFAULT 0,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON profile_features (workspace_id);
