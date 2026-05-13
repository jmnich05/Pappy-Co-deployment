-- Pappy & Co — AI Deployment Hub — tenant-assets storage bucket
-- Public-read bucket for things like logo files dropped in via the
-- Brand Kit intake form. Writes are RLS-gated: an authenticated user
-- can only put files into their own tenant's folder.
-- File path convention: {tenant_uuid}/{form_kind}/{field_id}/{filename}

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'tenant-assets', 'tenant-assets', true,
  20971520,  -- 20 MB per file
  array['image/png','image/jpeg','image/webp','image/svg+xml','image/gif','application/pdf']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Reads: open to anyone (it's a public bucket — sb.storage.from(...).getPublicUrl works).
drop policy if exists "tenant-assets read" on storage.objects;
create policy "tenant-assets read"
  on storage.objects for select
  using (bucket_id = 'tenant-assets');

-- Writes: only the authenticated user, only into their own tenant's folder.
-- storage.foldername(name) returns the path components as a text[]; element 1
-- (1-indexed) is the top folder, which we require to equal the tenant uuid.
drop policy if exists "tenant-assets insert" on storage.objects;
create policy "tenant-assets insert"
  on storage.objects for insert
  with check (
    bucket_id = 'tenant-assets'
    and auth.uid() is not null
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
  );

drop policy if exists "tenant-assets update" on storage.objects;
create policy "tenant-assets update"
  on storage.objects for update
  using (
    bucket_id = 'tenant-assets'
    and auth.uid() is not null
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
  );

drop policy if exists "tenant-assets delete" on storage.objects;
create policy "tenant-assets delete"
  on storage.objects for delete
  using (
    bucket_id = 'tenant-assets'
    and auth.uid() is not null
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
  );
