-- Pappy & Co — AI Deployment Hub — seed the Pappy & Co tenant
-- This is the sole tenant seed for the Pappy & Co Supabase project.
-- It creates the pappy-co tenant with pappyco.com as the allowed
-- email domain (so the 0004 auto-membership trigger can recognise
-- Pappy team members signing in via Google and add them as members).
--
-- Idempotent — safe to re-run; on-conflict makes it a no-op if the
-- pappy-co tenant row already exists.

insert into public.tenants (slug, name, allowed_domains)
values ('pappy-co', 'Pappy & Co', '{pappyco.com}')
on conflict (slug) do nothing;
