-- 0057_revoke_definer_anon.sql
-- 0056 revoked EXECUTE on ensure_workspace_company from PUBLIC, but Supabase also
-- grants EXECUTE to the `anon` and `authenticated` roles EXPLICITLY (via default
-- privileges), so those grants survived a PUBLIC-only revoke — the advisor still
-- flagged "Public/Signed-In Users Can Execute SECURITY DEFINER Function". Revoke
-- from those roles too. They don't exist on a plain Postgres (local/test), so
-- guard on role existence to keep this migration portable.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.ensure_workspace_company() FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.ensure_workspace_company() FROM authenticated';
  END IF;
END $$;
