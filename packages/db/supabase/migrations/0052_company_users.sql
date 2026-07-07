-- 0052_company_users.sql
-- Company-centric RBAC (supersedes the per-workspace membership model). A user now
-- belongs to a COMPANY with a single company-level ROLE:
--   - owner       → all workspaces + all company settings + user management
--   - marketer    → marketing (manage_content) ONLY in workspaces GRANTED to them
--   - accounting  → the company Billing & usage section only (no workspace access)
-- `workspace_users` is REPURPOSED as the marketer→workspace GRANT list: owners access
-- every workspace implicitly (no rows needed), accounting has none. See §3A.

CREATE TABLE IF NOT EXISTS company_users (
  company_id uuid NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL,                                    -- Supabase auth user id (no FK, like workspace_users)
  role       text NOT NULL DEFAULT 'marketer' CHECK (role IN ('owner', 'marketer', 'accounting')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, user_id)
);
CREATE INDEX IF NOT EXISTS company_users_user_id_idx ON company_users (user_id);

-- Company-scoped RLS (mirrors companies/0012 + company_ses_config/0024). Backend Lambdas
-- use the service role and scope by company_id in code; this is defense-in-depth for the
-- user-context (admin app) connection.
ALTER TABLE company_users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON company_users;
CREATE POLICY tenant_isolation ON company_users
  USING (
    app_is_platform_admin()
    OR company_id = (SELECT w.company_id FROM workspaces w WHERE w.id = app_current_workspace_id())
  )
  WITH CHECK (app_is_platform_admin());

-- ── Migrate existing memberships → company_users ──────────────────────────────
-- 1) The registered company owner (companies.owner_user_id) is a company OWNER.
INSERT INTO company_users (company_id, user_id, role)
SELECT c.id, c.owner_user_id, 'owner'
  FROM companies c
 WHERE c.owner_user_id IS NOT NULL
ON CONFLICT (company_id, user_id) DO UPDATE SET role = 'owner';

-- 2) Every existing workspace_users membership → a company_users row, taking the HIGHEST
--    role the user holds anywhere in that company (owner > marketer > accounting).
INSERT INTO company_users (company_id, user_id, role)
SELECT w.company_id,
       wu.user_id,
       (ARRAY['owner', 'marketer', 'accounting'])[
         MIN(CASE wu.role WHEN 'owner' THEN 1 WHEN 'marketer' THEN 2 ELSE 3 END)
       ]
  FROM workspace_users wu
  JOIN workspaces w ON w.id = wu.workspace_id
 GROUP BY w.company_id, wu.user_id
ON CONFLICT (company_id, user_id) DO UPDATE
  SET role = CASE
    WHEN company_users.role = 'owner' OR EXCLUDED.role = 'owner' THEN 'owner'
    WHEN company_users.role = 'marketer' OR EXCLUDED.role = 'marketer' THEN 'marketer'
    ELSE 'accounting'
  END;

-- 3) workspace_users becomes the MARKETER grant list: drop rows for users whose company
--    role is owner/accounting (owners access all implicitly; accounting has none). Marketer
--    grant rows stay. (Safe to run repeatedly.)
DELETE FROM workspace_users wu
 USING workspaces w, company_users cu
 WHERE wu.workspace_id = w.id
   AND cu.company_id = w.company_id
   AND cu.user_id = wu.user_id
   AND cu.role IN ('owner', 'accounting');

-- 4) Normalize surviving grant rows to role='marketer' (workspace_users.role is now vestigial).
UPDATE workspace_users SET role = 'marketer' WHERE role <> 'marketer';
