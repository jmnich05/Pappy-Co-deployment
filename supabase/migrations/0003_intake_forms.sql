-- Pappy & Co — AI Deployment Hub — client intake forms
-- One row per (tenant, user, form_kind). Holds a draft JSON until the user
-- submits. Tenant-isolated via RLS — a client's responses never leak across.

create table if not exists public.intake_responses (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id)   on delete cascade,
  user_id       uuid not null references auth.users(id)       on delete cascade,
  form_kind     text not null check (form_kind in ('brand-kit', 'company-context', 'data-sources', 'skills', 'workflows')),
  status        text not null default 'draft' check (status in ('draft','submitted')),
  responses     jsonb not null default '{}'::jsonb,
  progress_pct  int not null default 0 check (progress_pct between 0 and 100),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  submitted_at  timestamptz,
  unique (tenant_id, user_id, form_kind)
);
create index if not exists intake_responses_tenant_idx on public.intake_responses(tenant_id);
create index if not exists intake_responses_user_idx   on public.intake_responses(user_id);

alter table public.intake_responses enable row level security;

-- A user can see/upsert their own draft. Tenant admins and super-admins see
-- the whole tenant's responses (so the deployment lead can review everyone's
-- intake submissions and assemble the brand-kit / skills.md offline).
drop policy if exists intake_select on public.intake_responses;
create policy intake_select on public.intake_responses
  for select using (
    user_id = auth.uid()
    or public.is_animo_admin()
    or (
      tenant_id = public.current_tenant_id()
      and exists (
        select 1 from public.tenant_members m
        where m.user_id = auth.uid() and m.tenant_id = tenant_id and m.role in ('tenant_admin','animo_admin')
      )
    )
  );

drop policy if exists intake_insert on public.intake_responses;
create policy intake_insert on public.intake_responses
  for insert with check (
    user_id = auth.uid()
    and tenant_id = public.current_tenant_id()
  );

drop policy if exists intake_update on public.intake_responses;
create policy intake_update on public.intake_responses
  for update using (
    user_id = auth.uid()
    and status = 'draft'  -- a submitted response is read-only; users can't edit after submitting
  )
  with check (
    user_id = auth.uid()
    and tenant_id = public.current_tenant_id()
  );

-- updated_at trigger (reuses the helper from 0001)
drop trigger if exists intake_responses_touch on public.intake_responses;
create trigger intake_responses_touch before update on public.intake_responses
  for each row execute function public.touch_updated_at();
