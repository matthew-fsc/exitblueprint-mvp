-- Copy to: supabase/migrations/<UTC-timestamp>_<name>.sql   (e.g. 20260720000100_widgets.sql)
-- One new file per change; NEVER edit an applied migration. See docs/02 + docs/27.

-- <one line: what this table is and why it exists>
create table <table> (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),          -- every domain table carries firm_id (rule 5)
  engagement_id uuid references engagements (id),       -- if engagement-scoped
  -- ... domain columns ...
  <col> text not null
);
create index on <table> (firm_id);
create index on <table> (engagement_id);

-- Standard firm-scoped RLS. Role set: array['advisor'] (advisor-only) or
-- array['advisor','reviewer'] (staff). Owner policies, if any, are bespoke — add
-- them explicitly below and cover them with an rls-test check.
grant select, insert, update, delete on <table> to authenticated;
grant all on <table> to service_role;
alter table <table> enable row level security;
create policy <table>_firm_all on <table> for all to authenticated
  using (app.user_role() = any (array['advisor']::app_role[]) and firm_id = app.user_firm_id())
  with check (app.user_role() = any (array['advisor']::app_role[]) and firm_id = app.user_firm_id());

-- DoD: `npm run db:migrate` on a fresh DB, add a firm-isolation check to
-- scripts/rls-test.ts, `npm run test:rls` green, append a line to docs/06.
