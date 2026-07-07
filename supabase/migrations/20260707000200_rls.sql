-- Row-level security per docs/02 rule 5:
--   advisors: scoped to their firm_id
--   owners: read-only, scoped to their company's engagements (completed
--           assessments, dimension/sub-score results, gaps, tasks, owner reports)
--   admin: server-side only via service_role (bypasses RLS); no admin policies here

-- Helper functions (security definer so policies can read profiles without
-- recursing into profiles' own RLS).

create schema if not exists app;
grant usage on schema app to authenticated;

create or replace function app.user_role() returns app_role
language sql stable security definer set search_path = public
as $$
  select role from public.profiles where user_id = auth.uid()
$$;

create or replace function app.user_firm_id() returns uuid
language sql stable security definer set search_path = public
as $$
  select firm_id from public.profiles where user_id = auth.uid()
$$;

create or replace function app.user_company_id() returns uuid
language sql stable security definer set search_path = public
as $$
  select company_id from public.profiles where user_id = auth.uid()
$$;

grant execute on function app.user_role(), app.user_firm_id(), app.user_company_id()
  to authenticated;

-- Present when migrations are applied by scripts/migrate.ts; created here for
-- environments that apply migrations another way (e.g. supabase db push).
create table if not exists public.schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);

-- Grants: authenticated gets table access gated by RLS; service_role bypasses RLS.
grant usage on schema public to authenticated, service_role;
grant select, insert, update, delete on all tables in schema public
  to authenticated, service_role;
revoke all on public.schema_migrations from authenticated;

-- Enable RLS everywhere (deny-by-default for anything without a policy).
alter table firms enable row level security;
alter table companies enable row level security;
alter table profiles enable row level security;
alter table engagements enable row level security;
alter table rubric_versions enable row level security;
alter table dimensions enable row level security;
alter table questions enable row level security;
alter table sub_scores enable row level security;
alter table gap_definitions enable row level security;
alter table playbooks enable row level security;
alter table playbook_task_templates enable row level security;
alter table gap_playbook_map enable row level security;
alter table content_modules enable row level security;
alter table gap_content_map enable row level security;
alter table assessments enable row level security;
alter table answers enable row level security;
alter table sub_score_results enable row level security;
alter table dimension_scores enable row level security;
alter table gaps enable row level security;
alter table tasks enable row level security;
alter table generated_documents enable row level security;
alter table schema_migrations enable row level security;

-- Methodology tables: readable by any authenticated user; writes via service_role only.

create policy methodology_read on rubric_versions for select to authenticated using (true);
create policy methodology_read on dimensions for select to authenticated using (true);
create policy methodology_read on questions for select to authenticated using (true);
create policy methodology_read on sub_scores for select to authenticated using (true);
create policy methodology_read on gap_definitions for select to authenticated using (true);
create policy methodology_read on playbooks for select to authenticated using (true);
create policy methodology_read on playbook_task_templates for select to authenticated using (true);
create policy methodology_read on gap_playbook_map for select to authenticated using (true);
create policy methodology_read on content_modules for select to authenticated using (true);
create policy methodology_read on gap_content_map for select to authenticated using (true);

-- Tenancy and people.

create policy firm_member_read on firms for select to authenticated
  using (id = app.user_firm_id());

create policy own_profile_read on profiles for select to authenticated
  using (user_id = auth.uid());

create policy advisor_firm_profiles_read on profiles for select to authenticated
  using (app.user_role() = 'advisor' and firm_id = app.user_firm_id());

-- Advisor firm-scoped access on domain tables.

create policy advisor_firm_all on companies for all to authenticated
  using (app.user_role() = 'advisor' and firm_id = app.user_firm_id())
  with check (app.user_role() = 'advisor' and firm_id = app.user_firm_id());

create policy advisor_firm_all on engagements for all to authenticated
  using (app.user_role() = 'advisor' and firm_id = app.user_firm_id())
  with check (app.user_role() = 'advisor' and firm_id = app.user_firm_id());

create policy advisor_firm_all on assessments for all to authenticated
  using (app.user_role() = 'advisor' and firm_id = app.user_firm_id())
  with check (app.user_role() = 'advisor' and firm_id = app.user_firm_id());

create policy advisor_firm_all on gaps for all to authenticated
  using (app.user_role() = 'advisor' and firm_id = app.user_firm_id())
  with check (app.user_role() = 'advisor' and firm_id = app.user_firm_id());

create policy advisor_firm_all on tasks for all to authenticated
  using (app.user_role() = 'advisor' and firm_id = app.user_firm_id())
  with check (app.user_role() = 'advisor' and firm_id = app.user_firm_id());

create policy advisor_firm_all on generated_documents for all to authenticated
  using (app.user_role() = 'advisor' and firm_id = app.user_firm_id())
  with check (app.user_role() = 'advisor' and firm_id = app.user_firm_id());

-- Tables without firm_id scope through their assessment.

create policy advisor_firm_all on answers for all to authenticated
  using (app.user_role() = 'advisor' and exists (
    select 1 from assessments a
    where a.id = assessment_id and a.firm_id = app.user_firm_id()))
  with check (app.user_role() = 'advisor' and exists (
    select 1 from assessments a
    where a.id = assessment_id and a.firm_id = app.user_firm_id()));

create policy advisor_firm_all on sub_score_results for all to authenticated
  using (app.user_role() = 'advisor' and exists (
    select 1 from assessments a
    where a.id = assessment_id and a.firm_id = app.user_firm_id()))
  with check (app.user_role() = 'advisor' and exists (
    select 1 from assessments a
    where a.id = assessment_id and a.firm_id = app.user_firm_id()));

create policy advisor_firm_all on dimension_scores for all to authenticated
  using (app.user_role() = 'advisor' and exists (
    select 1 from assessments a
    where a.id = assessment_id and a.firm_id = app.user_firm_id()))
  with check (app.user_role() = 'advisor' and exists (
    select 1 from assessments a
    where a.id = assessment_id and a.firm_id = app.user_firm_id()));

-- Owner portal read access (docs/02 rule 5). Owners never write in v1.

create policy owner_company_read on companies for select to authenticated
  using (app.user_role() = 'owner' and id = app.user_company_id());

create policy owner_company_read on engagements for select to authenticated
  using (app.user_role() = 'owner' and company_id = app.user_company_id());

create policy owner_completed_read on assessments for select to authenticated
  using (app.user_role() = 'owner' and status = 'completed' and engagement_id in (
    select e.id from engagements e where e.company_id = app.user_company_id()));

create policy owner_results_read on dimension_scores for select to authenticated
  using (app.user_role() = 'owner' and exists (
    select 1 from assessments a
    join engagements e on e.id = a.engagement_id
    where a.id = assessment_id and a.status = 'completed'
      and e.company_id = app.user_company_id()));

create policy owner_results_read on sub_score_results for select to authenticated
  using (app.user_role() = 'owner' and exists (
    select 1 from assessments a
    join engagements e on e.id = a.engagement_id
    where a.id = assessment_id and a.status = 'completed'
      and e.company_id = app.user_company_id()));

create policy owner_engagement_read on gaps for select to authenticated
  using (app.user_role() = 'owner' and engagement_id in (
    select e.id from engagements e where e.company_id = app.user_company_id()));

create policy owner_engagement_read on tasks for select to authenticated
  using (app.user_role() = 'owner' and engagement_id in (
    select e.id from engagements e where e.company_id = app.user_company_id()));

create policy owner_report_read on generated_documents for select to authenticated
  using (app.user_role() = 'owner' and doc_type = 'owner_report' and engagement_id in (
    select e.id from engagements e where e.company_id = app.user_company_id()));
