-- 0012: Company → Workspaces hierarchy.
--
-- A `company` groups one or more `workspaces`. Tenant ISOLATION is unchanged —
-- it stays at the WORKSPACE level (every tenant row still carries workspace_id;
-- RLS still keys on workspace_id). A company is purely an organizational parent
-- so a platform admin can pick a company, then a workspace within it.
--
-- Every workspace belongs to exactly one company. To keep that invariant without
-- breaking the many existing INSERTs (tests/seeds that don't know about
-- companies), a BEFORE INSERT trigger auto-creates a company (named after the
-- workspace) when company_id is omitted. Existing rows are backfilled the same
-- way, then the column is made NOT NULL.

CREATE TABLE companies (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  status     text NOT NULL DEFAULT 'active',           -- active|suspended
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES companies(id);

-- A workspace always has a company; if none is supplied, create one named after
-- the workspace. SECURITY DEFINER so the implicit company INSERT isn't blocked by
-- RLS on the companies table (workspace creation is an admin/onboarding action).
CREATE OR REPLACE FUNCTION ensure_workspace_company() RETURNS trigger AS $$
DECLARE cid uuid;
BEGIN
  IF NEW.company_id IS NULL THEN
    INSERT INTO companies (name, status) VALUES (NEW.name, 'active') RETURNING id INTO cid;
    NEW.company_id := cid;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER workspaces_ensure_company
  BEFORE INSERT ON workspaces
  FOR EACH ROW EXECUTE FUNCTION ensure_workspace_company();

-- Backfill existing workspaces: one company each, named after the workspace.
DO $$
DECLARE w RECORD; cid uuid;
BEGIN
  FOR w IN SELECT id, name, created_at FROM workspaces WHERE company_id IS NULL LOOP
    INSERT INTO companies (name, status, created_at) VALUES (w.name, 'active', w.created_at) RETURNING id INTO cid;
    UPDATE workspaces SET company_id = cid WHERE id = w.id;
  END LOOP;
END;
$$;

ALTER TABLE workspaces ALTER COLUMN company_id SET NOT NULL;
CREATE INDEX ON workspaces (company_id);

-- RLS: a company is visible to a platform admin, or to a workspace context whose
-- workspace belongs to it. Writes are platform-admin only (mirrors §3A / 0006).
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON companies
  USING (
    app_is_platform_admin()
    OR id = (SELECT w.company_id FROM workspaces w WHERE w.id = app_current_workspace_id())
  )
  WITH CHECK (app_is_platform_admin());
