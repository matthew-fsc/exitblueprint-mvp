-- Admins are firm staff in the workspace (production-debug, 2026-07-20).
--
-- The frontend admits role='admin' to the advisor/staff surfaces (App.tsx
-- RequireAdvisor / RequireStaff), but every firm-scoped RLS policy gated on
-- 'advisor' (or 'advisor'/'reviewer') only — so an admin signed in through the
-- browser could read/write NOTHING firm-scoped: firm-scoped reads returned 0 rows
-- and writes were denied, surfacing as pervasive "database errors" (docs/31).
--
-- This grants admins the same firm-scoped access ADDITIVELY. Postgres combines
-- permissive policies for a command with OR, so these new admin_* policies sit
-- alongside the existing advisor/staff policies and change none of them —
-- advisor, reviewer, and owner access is byte-for-byte untouched, and firm
-- isolation is preserved because every admin policy still requires
-- firm_id = app.user_firm_id() (or the assessment's firm for the child tables).
--
-- profiles.role stays the RLS source of truth; admin is now a firm-staff role for
-- data access while remaining org:admin in Clerk for organization management.
-- Each admin policy MIRRORS the command and scoping of the advisor/staff policy it
-- shadows: full access where staff have `for all`, read-only where staff are
-- SELECT-only (audit/usage/billing rows are written by service_role, never a user).

do $$
declare t text;
begin
  -- Full firm-scoped access (mirrors advisor_firm_all / staff_firm_all:
  -- `for all` gated on firm_id = app.user_firm_id()).
  foreach t in array array[
    'advisory_library_items','answer_provenance','assessments','companies',
    'deal_outcomes','ebitda_addbacks','ebitda_recasts','engagement_agreements',
    'engagement_outcomes','engagements','firm_branding','gaps',
    'generated_documents','ledger_connections','roadmap_milestones','tasks',
    'valuation_inputs','assessment_values','document_blobs','document_fields',
    'documents','engagement_data_room_items','engagement_log','field_corrections',
    'findings','graph_edges','graph_nodes','jobs','review_items','scores'
  ]
  loop
    execute format($f$
      create policy admin_firm_all on public.%I for all to authenticated
        using (app.user_role() = 'admin' and firm_id = app.user_firm_id())
        with check (app.user_role() = 'admin' and firm_id = app.user_firm_id())
    $f$, t);
  end loop;

  -- Read-only firm-scoped (mirrors the staff SELECT-only policies on audit /
  -- usage / billing tables — those rows are written by service_role, not users).
  foreach t in array array[
    'data_access_log','firm_subscriptions','llm_calls','usage_events'
  ]
  loop
    execute format($f$
      create policy admin_firm_read on public.%I for select to authenticated
        using (app.user_role() = 'admin' and firm_id = app.user_firm_id())
    $f$, t);
  end loop;

  -- Child tables scoped through their assessment's firm (no firm_id column):
  -- mirror the advisor exists() shape.
  foreach t in array array['answers','sub_score_results','dimension_scores']
  loop
    execute format($f$
      create policy admin_firm_all on public.%I for all to authenticated
        using (app.user_role() = 'admin' and exists (
          select 1 from assessments a where a.id = assessment_id and a.firm_id = app.user_firm_id()))
        with check (app.user_role() = 'admin' and exists (
          select 1 from assessments a where a.id = assessment_id and a.firm_id = app.user_firm_id()))
    $f$, t);
  end loop;
end $$;

-- profiles: admins read every profile in their firm (mirrors advisor_firm_profiles_read).
create policy admin_firm_profiles_read on public.profiles for select to authenticated
  using (app.user_role() = 'admin' and firm_id = app.user_firm_id());

-- agreement_versions: INSERT-only for staff (firm_read covers reads); mirror it.
create policy admin_insert on public.agreement_versions for insert to authenticated
  with check (app.user_role() = 'admin' and firm_id = app.user_firm_id());

-- outcome_events: append-only for staff (SELECT + INSERT, no update/delete); mirror both.
create policy admin_firm_read on public.outcome_events for select to authenticated
  using (app.user_role() = 'admin' and firm_id = app.user_firm_id());
create policy admin_firm_insert on public.outcome_events for insert to authenticated
  with check (app.user_role() = 'admin' and firm_id = app.user_firm_id());
