-- MCP access tokens: let an AI assistant (Claude, via the hosted /mcp endpoint)
-- read and draft a workspace's automations, broadcasts, segments and templates.
--
-- Workspace-scoped, created by an owner, stored as a sha256 HASH only (the raw
-- token is shown once). A token acts as a marketer on behalf of the user who made
-- it and stops working the moment that user leaves the workspace or the token is
-- revoked. It can only DRAFT — publishing and sending stay human (enforced in code).
CREATE TABLE IF NOT EXISTS mcp_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name         text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  token_prefix text NOT NULL,
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX IF NOT EXISTS mcp_tokens_workspace_idx ON mcp_tokens (workspace_id);

ALTER TABLE mcp_tokens ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mcp_tokens;
CREATE POLICY tenant_isolation ON mcp_tokens
  USING (app_is_platform_admin() OR workspace_id = app_current_workspace_id());
