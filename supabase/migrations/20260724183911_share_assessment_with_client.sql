-- Send the assessment to the client: collaborative client-portal intake, 2026-07-24.
--
-- Until now the owner portal was strictly read-only (docs/02 rule 5;
-- 20260707000200_rls.sql: "Owners never write in v1") and could only see
-- COMPLETED assessments. This migration adds the one v2 write path: an advisor can
-- SHARE an in-progress assessment with the business owner, who then fills out the
-- questionnaire in their portal while the advisor keeps full co-editing access to
-- the same assessment (answers.answered_by attributes each side). Only the advisor
-- submits/scores (advisor-only submit) — enforced in the compute layer by the new
-- 'assessment-staff' scope, not here.
--
-- Two nullable timestamps carry both the boolean and the "when" (mirrors
-- completed_at; an enum would entangle the status/immutability triggers, a side
-- table is overkill for one owner<->assessment relation):
--   shared_with_client_at  — non-null => client portal enabled for this in-progress assessment
--   client_submitted_at    — non-null => client signalled "ready for advisor review"

alter table assessments
  add column shared_with_client_at timestamptz,
  add column client_submitted_at   timestamptz;

-- Owner may SELECT the shared, still-in-progress assessment for their company.
-- Additive to owner_completed_read (permissive policies OR together): owners keep
-- their completed assessments AND gain the one shared in-progress row. A non-shared
-- in-progress assessment stays invisible (shared_with_client_at is null), so it is
-- neither readable nor (below) writable by the owner.
create policy owner_shared_intake_read on assessments for select to authenticated
  using (
    app.user_role() = 'owner'
    and status = 'in_progress'
    and shared_with_client_at is not null
    and engagement_id in (
      select e.id from engagements e where e.company_id = app.user_company_id()
    )
  );

-- Owner may INSERT/UPDATE/DELETE answers on a shared, in-progress assessment of
-- their company (the questionnaire fill). The exists() subquery runs under the
-- owner's own RLS, so it can only resolve a row visible via owner_shared_intake_read
-- above (shared + in_progress); the shared/in_progress predicate is inlined too as
-- defense in depth. A completed assessment is not visible here, and its answers stay
-- frozen by freeze_completed_assessment_child (20260718000200) — so on score the
-- row becomes read-only via owner_completed_read with no further change. This is the
-- same subquery-under-RLS mechanic advisor_firm_all on answers already relies on.
create policy owner_shared_intake_answers on answers for all to authenticated
  using (
    app.user_role() = 'owner'
    and exists (
      select 1 from assessments a
      where a.id = answers.assessment_id
        and a.status = 'in_progress'
        and a.shared_with_client_at is not null
        and a.engagement_id in (
          select e.id from engagements e where e.company_id = app.user_company_id()
        )
    )
  )
  with check (
    app.user_role() = 'owner'
    and exists (
      select 1 from assessments a
      where a.id = answers.assessment_id
        and a.status = 'in_progress'
        and a.shared_with_client_at is not null
        and a.engagement_id in (
          select e.id from engagements e where e.company_id = app.user_company_id()
        )
    )
  );
