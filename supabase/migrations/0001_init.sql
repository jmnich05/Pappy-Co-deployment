-- Pappy & Co — AI Deployment Hub — initial schema
-- One Supabase project, multi-tenant. Isolation via row-level security.
-- See docs/ARCHITECTURE.md and docs/SETUP.md.

-- ============================================================
-- Extensions
-- ============================================================
create extension if not exists "pgcrypto";

-- ============================================================
-- tenants — one row per client company
-- ============================================================
create table if not exists public.tenants (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique,            -- matches the brands/{slug} directory
  name            text not null,
  allowed_domains text[] not null default '{}',    -- e.g. {'clientco.com'} — Google Workspace domains that may sign in
  created_at      timestamptz not null default now()
);

-- ============================================================
-- tenant_members — links auth.users to a tenant + role
-- A user belongs to exactly one tenant in v1.
-- ============================================================
create table if not exists public.tenant_members (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  email      text not null,
  full_name  text,
  role       text not null default 'member',       -- 'member' | 'tenant_admin' | 'animo_admin'
  team_role  text,                                 -- free text, e.g. 'marketing', 'wholesale'
  created_at timestamptz not null default now()
);
create index if not exists tenant_members_tenant_idx on public.tenant_members(tenant_id);

-- ============================================================
-- documents — publishable onboarding docs (Read & Acknowledge)
-- ============================================================
create table if not exists public.documents (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  slug         text not null,
  title        text not null,
  summary      text,
  body_md      text not null default '',
  category     text,                                -- 'security' | 'governance' | 'how-to' | ...
  required     boolean not null default true,
  sort_order   int not null default 0,
  content_hash text not null default '',            -- hash of body_md at publish time, frozen into acks
  published    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, slug)
);
create index if not exists documents_tenant_idx on public.documents(tenant_id);

-- ============================================================
-- acknowledgments — immutable "I have read and understood this"
-- ============================================================
create table if not exists public.acknowledgments (
  id              uuid primary key default gen_random_uuid(),
  document_id     uuid not null references public.documents(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  acknowledged_at timestamptz not null default now(),
  doc_hash        text not null default '',         -- copy of documents.content_hash at ack time
  unique (document_id, user_id)
);
create index if not exists acknowledgments_tenant_idx on public.acknowledgments(tenant_id);
create index if not exists acknowledgments_user_idx   on public.acknowledgments(user_id);

-- ============================================================
-- Helper: the calling user's tenant_id (used in RLS policies)
-- ============================================================
create or replace function public.current_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select tenant_id from public.tenant_members where user_id = auth.uid()
$$;

create or replace function public.is_animo_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select role = 'animo_admin' from public.tenant_members where user_id = auth.uid()),
    false
  )
$$;

-- ============================================================
-- Row-level security
-- ============================================================
alter table public.tenants          enable row level security;
alter table public.tenant_members   enable row level security;
alter table public.documents        enable row level security;
alter table public.acknowledgments  enable row level security;

-- tenants: a member can see their own tenant; animo_admin sees all.
drop policy if exists tenants_select on public.tenants;
create policy tenants_select on public.tenants
  for select using (id = public.current_tenant_id() or public.is_animo_admin());

-- tenant_members: see fellow members of your tenant; animo_admin sees all.
drop policy if exists members_select on public.tenant_members;
create policy members_select on public.tenant_members
  for select using (tenant_id = public.current_tenant_id() or public.is_animo_admin());

-- documents: members read published docs in their tenant; animo_admin reads all.
drop policy if exists documents_select on public.documents;
create policy documents_select on public.documents
  for select using (
    (tenant_id = public.current_tenant_id() and published)
    or public.is_animo_admin()
  );

-- acknowledgments:
--   - a user may insert their OWN ack, for a doc in their OWN tenant
--   - a user may read their own acks; tenant_admin / animo_admin read the whole tenant matrix
--   - no update / no delete (immutable audit trail)
drop policy if exists acks_insert on public.acknowledgments;
create policy acks_insert on public.acknowledgments
  for insert with check (
    user_id = auth.uid()
    and tenant_id = public.current_tenant_id()
    and exists (
      select 1 from public.documents d
      where d.id = document_id and d.tenant_id = public.current_tenant_id()
    )
  );

drop policy if exists acks_select on public.acknowledgments;
create policy acks_select on public.acknowledgments
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

-- ============================================================
-- updated_at trigger for documents
-- ============================================================
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;
drop trigger if exists documents_touch on public.documents;
create trigger documents_touch before update on public.documents
  for each row execute function public.touch_updated_at();

-- ============================================================
-- Seed: demo tenants (safe to keep — these mirror app/brands/*)
-- Real client domains get added per engagement.
-- ============================================================
-- (Tenant seed removed by transfer-to-pappy.sh — the pappy-co tenant is
-- seeded by 0008_seed_pappy_tenant.sql instead.)
