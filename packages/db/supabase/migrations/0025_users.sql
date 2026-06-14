-- 0025_users.sql
-- A minimal profile row per user so they can edit their own details (a display
-- name) in-app. Identity (email/password) lives in the auth provider (Supabase
-- Auth) — this table only holds app-owned profile fields. `id` is the auth user
-- id (the same value as workspace_users.user_id / the JWT `sub`).
CREATE TABLE IF NOT EXISTS users (
  id         uuid PRIMARY KEY,
  name       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The current user id from the authorizer-injected JWT (`sub`), mirroring the
-- workspace/admin helpers in 0006.
CREATE OR REPLACE FUNCTION app_current_user_id()
RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid
$$;

-- RLS: a user may only see/edit their OWN row (platform admin may read any).
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS self_only ON users;
CREATE POLICY self_only ON users
  USING (app_is_platform_admin() OR id = app_current_user_id())
  WITH CHECK (id = app_current_user_id());
