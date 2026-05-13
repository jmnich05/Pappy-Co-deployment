-- Pappy & Co — AI Deployment Hub — auto-onboard new users
-- When a Google-signed-in user lands on a tenant's portal for the first
-- time, we want them to immediately be a member of that tenant so RLS
-- lets them read/write. This trigger looks up the tenant by the user's
-- email domain (against tenants.allowed_domains) and inserts the
-- tenant_members row automatically.
--
-- Without this, every new user is locked out (current_tenant_id() returns
-- null → RLS denies all reads/writes) until an admin manually adds them.

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_email   text;
  v_domain  text;
  v_tenant  uuid;
  v_name    text;
begin
  v_email := lower(coalesce(new.email, ''));
  if v_email = '' then return new; end if;
  v_domain := split_part(v_email, '@', 2);
  if v_domain = '' then return new; end if;

  -- Find the tenant whose allowed_domains contains this user's email domain.
  -- (allowed_domains is text[], lowercase. We lowercase the domain here too.)
  select id into v_tenant
  from public.tenants
  where v_domain = any (array(select lower(d) from unnest(allowed_domains) d))
  limit 1;

  if v_tenant is null then
    -- no tenant claims this domain — silently no-op; an admin can add them
    return new;
  end if;

  v_name := coalesce(
    (new.raw_user_meta_data->>'full_name')::text,
    (new.raw_user_meta_data->>'name')::text,
    null
  );

  insert into public.tenant_members (user_id, tenant_id, email, full_name, role)
  values (new.id, v_tenant, v_email, v_name, 'member')
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- Helper view: who's an admin on which tenant (handy for the admin matrix
-- view to know if the current user should see it).
create or replace view public.my_role as
  select tm.tenant_id, tm.role
  from public.tenant_members tm
  where tm.user_id = auth.uid();

grant select on public.my_role to authenticated;
