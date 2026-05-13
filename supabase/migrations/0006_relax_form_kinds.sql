-- Pappy & Co — AI Deployment Hub — relax the form_kind CHECK so we can add new
-- intake-form types (customer-personas, competitors, etc.) without a
-- schema migration each time. The form definitions live as JSON in the
-- app, and there's no value in enforcing the enum at the DB level.

alter table public.intake_responses drop constraint if exists intake_responses_form_kind_check;
