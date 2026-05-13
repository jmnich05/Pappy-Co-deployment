-- Pappy & Co — AI Deployment Hub — function hardening (addresses Supabase security linter)
-- Applied to the live project as migration 20260512205618_harden_functions.

-- Pin search_path on the trigger function (linter 0011_function_search_path_mutable)
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin new.updated_at = now(); return new; end;
$$;

-- current_tenant_id() / is_animo_admin() are SECURITY DEFINER helpers used only
-- inside RLS policies. RLS evaluates them as the querying role, so `authenticated`
-- still needs EXECUTE — but anon/public should not be able to hit them as RPC
-- endpoints. (linter 0028_anon_security_definer_function_executable)
revoke execute on function public.current_tenant_id() from public, anon;
revoke execute on function public.is_animo_admin()   from public, anon;
grant  execute on function public.current_tenant_id() to authenticated;
grant  execute on function public.is_animo_admin()   to authenticated;
