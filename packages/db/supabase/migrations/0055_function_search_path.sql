-- 0055_function_search_path.sql
-- SECURITY HARDENING (Supabase Security Advisor warning: "Function Search Path
-- Mutable"). A function without a pinned search_path resolves unqualified names
-- against the CALLER's search_path — for a SECURITY DEFINER function that is a
-- privilege-escalation vector (a caller can prepend a schema whose objects shadow
-- the ones the function meant to use). Pin search_path on our four functions.
--
-- The three app_* RLS helpers use ONLY built-ins (current_setting, casts,
-- COALESCE/NULLIF — all in pg_catalog, which is always implicitly searched), so
-- the strictest empty search_path is safe.
ALTER FUNCTION public.app_current_user_id()      SET search_path = '';
ALTER FUNCTION public.app_current_workspace_id() SET search_path = '';
ALTER FUNCTION public.app_is_platform_admin()    SET search_path = '';

-- ensure_workspace_company is a SECURITY DEFINER trigger that touches a table, so
-- pin the empty search_path AND fully-qualify every object reference (public.*) so
-- nothing can be shadowed. Body is otherwise identical to 0013's.
CREATE OR REPLACE FUNCTION public.ensure_workspace_company()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $function$
DECLARE cid uuid;
BEGIN
  IF NEW.company_id IS NULL THEN
    SELECT id INTO cid FROM public.companies WHERE name = 'Unassigned' LIMIT 1;
    IF cid IS NULL THEN
      INSERT INTO public.companies (name, status) VALUES ('Unassigned', 'active') RETURNING id INTO cid;
    END IF;
    NEW.company_id := cid;
  END IF;
  RETURN NEW;
END;
$function$;
