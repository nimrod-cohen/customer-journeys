-- 0043_company_logo.sql
-- Company logo (CLAUDE.md company-settings; renders atop the public unsubscribe +
-- manage-subscription pages). A SOFT reference to an uploaded asset: the column
-- holds the asset's uuid; the public asset URL is built at render time
-- (<origin>/assets/<id>). No hard FK — assets are workspace-scoped and served
-- public-by-uuid, while a logo is set once per COMPANY (which may own several
-- workspaces); a deleted asset simply yields a broken/absent image (the pages
-- render fine with no logo), so a dangling id is harmless and never blocks
-- deletes. The logo is OPTIONAL: a NULL keeps the current behavior (no logo).
--
-- companies already has company-scoped RLS (0012), so adding a column needs no
-- new policy.
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS logo_asset_id uuid;
