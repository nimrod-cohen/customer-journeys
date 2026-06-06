-- 0004_segments.sql
-- Segments (dynamic + manual), memberships, change log.
-- See CDP-BUILD-SPEC.md §6, §8, §1A.

CREATE TABLE segments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name         text NOT NULL,
  definition   jsonb,                                   -- rule AST for dynamic kinds; null for manual
  kind         text NOT NULL DEFAULT 'dynamic_realtime', -- dynamic_realtime|dynamic_batch|manual
  status       text NOT NULL DEFAULT 'active',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON segments (workspace_id, status);

-- Works for both kinds: dynamic kinds are written by the evaluator; manual kind is
-- edited directly by the user (hand-pick / CSV import). source distinguishes them.
CREATE TABLE segment_memberships (
  segment_id   uuid NOT NULL REFERENCES segments(id),
  profile_id   uuid NOT NULL REFERENCES profiles(id),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  source       text NOT NULL DEFAULT 'evaluator',       -- evaluator|manual
  entered_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (segment_id, profile_id)
);
CREATE INDEX ON segment_memberships (workspace_id, segment_id);

CREATE TABLE segment_change_log (
  id           bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  segment_id   uuid NOT NULL REFERENCES segments(id),
  profile_id   uuid NOT NULL REFERENCES profiles(id),
  action       text NOT NULL,                          -- entered|exited
  occurred_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON segment_change_log (workspace_id, segment_id, occurred_at);
