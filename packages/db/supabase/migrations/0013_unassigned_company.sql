-- 0013: stop the workspace→company trigger from creating a NEW company for every
-- workspace that omits company_id. 0012 did that to preserve the "every workspace
-- has a company" invariant, but it pollutes dev/test DBs with one empty company
-- per throwaway test workspace (hundreds of orphans). Instead, unassigned
-- workspaces now all share a single 'Unassigned' company — the invariant holds
-- with no proliferation. A platform admin can still move them into real
-- companies from the System Admin console.
CREATE OR REPLACE FUNCTION ensure_workspace_company() RETURNS trigger AS $$
DECLARE cid uuid;
BEGIN
  IF NEW.company_id IS NULL THEN
    SELECT id INTO cid FROM companies WHERE name = 'Unassigned' LIMIT 1;
    IF cid IS NULL THEN
      INSERT INTO companies (name, status) VALUES ('Unassigned', 'active') RETURNING id INTO cid;
    END IF;
    NEW.company_id := cid;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
