-- 0053_user_auth_tokens.sql
-- One-time, expiring tokens for system-email flows: INVITE (a new teammate sets a
-- password to join) and password RESET. Security model: the raw token travels ONLY
-- in the emailed link; we store its SHA-256 HASH here, so a DB read can't reconstruct
-- a usable link. Single-use (used_at) + expiring (expires_at).
--
-- No RLS: this is pre-auth identity infrastructure (like `users`), touched only by
-- the service role during the public accept-invite / reset endpoints, where there is
-- no workspace/JWT context to scope by.

CREATE TABLE IF NOT EXISTS user_auth_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,                              -- sha256(raw token)
  user_id    uuid NOT NULL,                                     -- users.id
  purpose    text NOT NULL CHECK (purpose IN ('invite', 'reset')),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_auth_tokens_user_idx ON user_auth_tokens (user_id);
