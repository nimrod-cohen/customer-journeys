-- A company's registering owner. Self-service registration creates a COMPANY
-- (and this owner user) but NO workspace — the owner must create their first
-- workspace manually afterwards. Until a workspace exists there is no
-- workspace_users row to link the owner to anything, so this column is the
-- company-level link that (a) lets the owner log in (no-workspace state) and
-- (b) authorizes them to create the first workspace in THEIR company.
--
-- Nullable + ON DELETE SET NULL: seeded/demo companies and platform-admin-created
-- companies need no owner here, and once workspaces exist, workspace_users remains
-- the access mechanism. Never client-supplied (inv.2): it is set server-side to
-- the registrant and read by the bootstrap flow as owner_user_id = <token sub>.
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES users (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS companies_owner_user_id_idx ON companies (owner_user_id);
