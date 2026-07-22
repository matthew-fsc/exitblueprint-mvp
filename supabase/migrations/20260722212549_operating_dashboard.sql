-- Company operating dashboard (docs/40 §4b, docs/38). Turns the ops metrics rail
-- into the COMPANY'S operating dashboard: the business plan expressed as a live
-- readout of real tables (activation funnel, revenue plan, unit economics, and
-- the churn book), not a quarterly slide reconstruction. These are the
-- go-to-market and financial KPIs docs/40 §4b names — leading indicators derived
-- from the SAME append-only spine the app already writes (firms, profiles,
-- engagements, assessments, generated_documents, firm_subscriptions, llm_calls).
--
-- docs/40 §4b pattern, followed exactly: "Adding a business metric is the docs/38
-- pattern: a new view + a block in the gated endpoint — never a parallel
-- pipeline, never a loosened tenant policy." So these are read-only rollup VIEWS
-- that EXTEND the existing `analytics` schema; no new table, no re-instrumentation.
--
-- ISOLATION GUARANTEE (CLAUDE.md §5, docs/38 §0): these views aggregate ACROSS
-- firms, so they live on the `analytics` schema that is granted to `service_role`
-- ONLY (20260721000700). `authenticated`/`anon` are never granted usage on the
-- schema or select on any view — a tenant role cannot read them, ever. The single
-- app-level reader is the superadmin-gated GET /internal/metrics route
-- (server/http.ts), on the service-role (RLS-bypass) connection. Counts + roll-up
-- aggregates only, no PII. scripts/rls-test.ts asserts the tenant-role denial.
--
-- READ-ONLY (CLAUDE.md §1-2, §4): views only. Nothing here writes a score, mutates
-- an immutable assessment, or touches client data. Per-unit economics ratios are
-- deliberately NOT computed here — the view exposes the raw components and the
-- superadmin console derives the ratios in a unit-tested pure helper
-- (src/lib/platformConsole.ts), so the division logic is testable and lives with
-- the rest of the console's derivations.
--
-- The schema, its lockdown, and its service-role default privileges already exist
-- (20260721000700). We ONLY add views; we do not recreate the schema.

-- ── Activation funnel (one row) — the go-to-market leading indicator ───── product
-- FIRM-level activation (distinct from analytics.assessment_funnel, which is
-- engagement/assessment-level): firm created → an advisor actually did something
-- (emitted any usage event) → the firm ran its first assessment → the firm got
-- its first AI deliverable. This is the go-to-market plan's leading indicator
-- (docs/40 §4b): where firms fall out of the activation path.
create view analytics.activation_funnel as
select
  (select count(*) from firms)                                as firms_created,
  (select count(distinct firm_id) from usage_events)          as firms_activated,
  (select count(distinct firm_id) from assessments)           as firms_first_assessment,
  (select count(distinct firm_id) from generated_documents)   as firms_first_deliverable;

-- ── Revenue plan (one row) — the revenue plan as unit counts ──────────── business
-- The revenue plan read from the cached Stripe reflection (firm_subscriptions).
-- Dollar amounts live in Stripe (docs/24); this rail carries the UNIT counts that
-- make the plan legible: how many firms are paying, trialing, comped, past-due,
-- and how many seats are live. Comped firms (beta/internal) are entitled but not
-- paying, so they are counted separately from paying firms.
create view analytics.revenue_summary as
select
  count(*) filter (where plan_code is not null)                              as subscribed_firms,
  count(*) filter (where status = 'active' and not comp)                     as paying_firms,
  count(*) filter (where comp)                                               as comped_firms,
  count(*) filter (where status = 'trialing')                                as trialing_firms,
  count(*) filter (where status = 'past_due')                                as past_due_firms,
  count(*) filter (where status = 'canceled')                                as canceled_firms,
  count(*) filter (where cancel_at_period_end)                               as canceling_firms,
  coalesce(sum(seats) filter (where status in ('active', 'trialing')), 0)    as active_seats
from firm_subscriptions;

-- ── Unit economics / COGS (one row) — the raw components ──────────────── business
-- The unit-economics inputs: AI spend (the dominant variable COGS, docs/40 §4b)
-- over the trailing 30 days and lifetime, alongside the denominators the console
-- divides by (active firms, completed assessments, engagements). The ratios
-- (cost per firm / per assessment) are derived in the console's unit-tested
-- helper, not here, so the division stays testable and null-safe.
create view analytics.unit_economics as
select
  (select coalesce(round(sum(cost_usd), 4), 0) from llm_calls
     where created_at >= current_date - interval '30 days')     as ai_cost_30d,
  (select count(*) from llm_calls
     where created_at >= current_date - interval '30 days')      as ai_calls_30d,
  (select coalesce(round(sum(cost_usd), 4), 0) from llm_calls)   as ai_cost_total,
  (select count(*) from llm_calls)                               as ai_calls_total,
  (select count(*) from firms where status = 'active')           as active_firms,
  (select count(*) from assessments where status = 'completed')  as completed_assessments,
  (select count(*) from engagements)                             as engagements;

-- ── Engagement health (one row) — the churn book's delivery signal ─────── business
-- The churn-risk book pairs firm last-activity (analytics.firm_overview, already
-- exposed) with STALLED delivery: active engagements that have not produced a
-- completed assessment in 60 days (or never have). A rising stalled count is the
-- leading churn signal — an engagement that is nominally live but not moving.
create view analytics.engagement_health as
select
  (select count(*) from engagements where status = 'active')      as active_engagements,
  (select count(*) from engagements e
     where e.status = 'active'
       and not exists (
         select 1 from assessments a
          where a.engagement_id = e.id
            and a.status = 'completed'
            and a.completed_at >= current_date - interval '60 days'
       ))                                                          as stalled_engagements;

-- Grant read on the four views just defined. The schema's default privileges
-- (20260721000700) already extend select to service_role for later views; this is
-- the explicit, belt-and-suspenders re-affirmation. service_role ONLY — never
-- authenticated/anon.
grant select on analytics.activation_funnel to service_role;
grant select on analytics.revenue_summary to service_role;
grant select on analytics.unit_economics to service_role;
grant select on analytics.engagement_health to service_role;
