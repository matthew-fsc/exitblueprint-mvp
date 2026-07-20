-- View-only collaborator RLS (the second half of 20260720000400), 2026-07-20.
--
-- These policies USE the 'collaborator' app_role value added in the prior
-- migration, so they must live in their own transaction (migrate.ts commits each
-- file separately). They mirror the owner portal read policies one-for-one, but
-- scope by the collaborator's single engagement_id (app.user_engagement_id())
-- instead of by their company — a collaborator sees exactly the one engagement
-- they were invited to, and never writes (read-only, like the owner role).
--
-- Everything a collaborator can read is a strict subset of what the engagement's
-- owner already sees: the company, that one engagement, its completed
-- assessments and their scored children, its gaps and tasks, and the owner
-- report. Firm branding + name come from the existing firm_member_read policies
-- (their profile carries firm_id). No advisor/admin/staff policy matches
-- role='collaborator', so no firm-scoped tenant data leaks across engagements.

-- The one engagement, and its company.
create policy collaborator_engagement_read on engagements for select to authenticated
  using (app.user_role() = 'collaborator' and id = app.user_engagement_id());

create policy collaborator_company_read on companies for select to authenticated
  using (app.user_role() = 'collaborator' and id = (
    select company_id from engagements where id = app.user_engagement_id()));

-- Completed assessments for that engagement (never in-progress drafts).
create policy collaborator_completed_read on assessments for select to authenticated
  using (app.user_role() = 'collaborator' and status = 'completed'
    and engagement_id = app.user_engagement_id());

-- Scored children, scoped through their (completed) assessment.
create policy collaborator_results_read on dimension_scores for select to authenticated
  using (app.user_role() = 'collaborator' and exists (
    select 1 from assessments a
    where a.id = assessment_id and a.status = 'completed'
      and a.engagement_id = app.user_engagement_id()));

create policy collaborator_results_read on sub_score_results for select to authenticated
  using (app.user_role() = 'collaborator' and exists (
    select 1 from assessments a
    where a.id = assessment_id and a.status = 'completed'
      and a.engagement_id = app.user_engagement_id()));

-- The engagement's gaps and remediation tasks.
create policy collaborator_engagement_read on gaps for select to authenticated
  using (app.user_role() = 'collaborator' and engagement_id = app.user_engagement_id());

create policy collaborator_engagement_read on tasks for select to authenticated
  using (app.user_role() = 'collaborator' and engagement_id = app.user_engagement_id());

-- The owner report only (the client-facing document), same as the owner role.
create policy collaborator_report_read on generated_documents for select to authenticated
  using (app.user_role() = 'collaborator' and doc_type = 'owner_report'
    and engagement_id = app.user_engagement_id());
