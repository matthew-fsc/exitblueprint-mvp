-- Moat KPIs on the platform analytics rail (docs/40 §4a-§4b, docs/09-moats.md).
-- "The moats ARE the business plan": the company's core KPI is not MRR alone but
-- the GROWTH and PREDICTIVE POWER of the calibration corpus — the paired
-- prediction/reality records in deal_outcomes. These views turn that corpus into
-- a live operator readout on the EXISTING service-role `analytics` schema
-- (supabase/migrations/20260721000700_platform_analytics.sql), expressed in the
-- same terms server/outcomes.ts firmCalibration already computes per-firm, but
-- rolled up PLATFORM-WIDE across every firm.
--
-- This is the operator/superadmin rail ONLY. It does NOT reintroduce the
-- deliberately-removed firm-facing predicted-vs-actual UI; nothing here is exposed
-- to a tenant.
--
-- ISOLATION GUARANTEE (CLAUDE.md §5): these views aggregate ACROSS firms, so they
-- extend the dedicated `analytics` schema that is granted to `service_role` ONLY.
-- `authenticated`/`anon` are never granted usage on the schema or select on any
-- view — a tenant role cannot read them, ever. The single app-level reader is the
-- superadmin-gated GET /internal/metrics route (server/http.ts), on the
-- service-role (RLS-bypass) connection. Counts + aggregate stats only, no PII.
--
-- READ-ONLY (CLAUDE.md §1-2, §4): views only. Nothing here writes a score, mutates
-- an immutable assessment, recalibrates a rubric, or touches client data. A
-- recalibration of the rubric ships as a new rubric_version, never from here.
--
-- The schema, its lockdown, and its service-role default privileges already exist
-- (20260721000700). We ONLY add views; we do not recreate the schema or alter any
-- existing view.

-- ── Calibration corpus (one row) — the business plan's core KPI ─────── business
-- Platform-wide predicted-vs-actual, mirroring server/outcomes.ts firmCalibration
-- so operator and firm numbers use identical definitions:
--   * paired_outcomes   — closed deals holding BOTH a predicted EV base and a
--                         realized final EV (firmCalibration `with_prediction`):
--                         a prediction that now has a realized result.
--   * within_range_pct  — over closed deals with a full predicted [low,high] band
--                         and a final EV, the share whose final EV landed inside.
--   * avg_ev_variance_pct — mean (final − predicted_base) / predicted_base, %,
--                         over paired outcomes.
--   * avg_final_multiple, retrade_rate_pct, avg_days_on_market — over closed deals.
create view analytics.calibration_corpus as
with closed as (
  select * from deal_outcomes where outcome = 'closed'
)
select
  (select count(*) from deal_outcomes)                             as deals_recorded,
  (select count(*) from closed)                                    as closed_deals,
  (select count(*) from deal_outcomes where outcome = 'broken')    as broken_deals,
  (select count(*) from deal_outcomes where outcome = 'withdrawn') as withdrawn_deals,
  -- Paired outcomes: the corpus's headline growth number.
  (select count(*) from closed
     where predicted_ev_base is not null and final_ev is not null) as paired_outcomes,
  -- Within-range hit rate (integer %); same eligibility as firmCalibration.
  (select round(avg(case when final_ev >= predicted_ev_low
                          and final_ev <= predicted_ev_high then 1 else 0 end) * 100)
     from closed
    where predicted_ev_low is not null
      and predicted_ev_high is not null
      and final_ev is not null)                                    as within_range_pct,
  -- Avg EV variance % (1 decimal) over paired outcomes.
  (select round(avg((final_ev - predicted_ev_base) / predicted_ev_base * 100)::numeric, 1)
     from closed
    where predicted_ev_base is not null and final_ev is not null)  as avg_ev_variance_pct,
  (select round(avg(final_multiple)::numeric, 1)
     from closed where final_multiple is not null)                 as avg_final_multiple,
  (select round(avg(case when retrade then 1 else 0 end) * 100) from closed) as retrade_rate_pct,
  (select round(avg(days_on_market))
     from closed where days_on_market is not null)                 as avg_days_on_market;

-- ── Corpus growth over time (paired outcomes by month) ──────────────── business
-- The "growth of the calibration corpus" curve: how many paired outcomes the
-- platform booked each month. Bucketed by close_date (falling back to created_at
-- where a close date was never recorded).
create view analytics.calibration_corpus_monthly as
select
  date_trunc('month', coalesce(close_date, created_at::date))::date as month,
  count(*) filter (where outcome = 'closed')                        as closed_deals,
  count(*) filter (
    where outcome = 'closed'
      and predicted_ev_base is not null
      and final_ev is not null)                                     as paired_outcomes,
  round(avg(final_multiple) filter (
    where outcome = 'closed' and final_multiple is not null)::numeric, 1)
                                                                    as avg_final_multiple
from deal_outcomes
group by 1;

-- Grant read on the two views just defined. The schema's default privileges
-- (20260721000700) already extend select to service_role for views added later;
-- this is the explicit, belt-and-suspenders re-affirmation. service_role ONLY —
-- never authenticated/anon.
grant select on analytics.calibration_corpus to service_role;
grant select on analytics.calibration_corpus_monthly to service_role;
