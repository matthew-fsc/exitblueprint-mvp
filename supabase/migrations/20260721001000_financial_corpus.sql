-- Verified financial corpus (docs/09-moats.md, moat 2). The internal calibration
-- substrate that lets us refine valuation multiples "from our own book of verified
-- deals" rather than generic comps: cross-firm rollups of DOCUMENT- or
-- CONNECTED-LEDGER-backed financial characteristics, plus realized multiples from
-- closed deal_outcomes, aggregated by industry and size band.
--
-- These are ADDED to the existing service-role-only `analytics` schema created in
-- 20260721000700_platform_analytics.sql. This migration does NOT recreate the
-- schema, re-grant schema usage, or alter any existing view — it only appends new
-- rollup VIEWS and re-asserts the service_role select grant.
--
-- ISOLATION GUARANTEE (CLAUDE.md §5, docs/38 §0): these views aggregate ACROSS
-- firms, so — like every object in `analytics` — they are readable by
-- `service_role` ONLY. `authenticated`/`anon` are never granted usage on the
-- schema (locked in 700) nor select on these views, so no tenant role can read
-- them, ever. scripts/rls-test.ts already asserts the tenant-role denial on the
-- schema, which covers every view added here. This is INTERNAL calibration
-- substrate, NOT a client-facing benchmark — the anonymized benchmarking surface
-- stays out of scope (CLAUDE.md §5, docs/09 build order step 3).
--
-- DE-IDENTIFIED, COUNTS-ONLY (docs/38 §0): every view groups by industry × size
-- band and emits COUNTS and aggregate statistics (avg / median / min / max /
-- percentiles) plus a `contributing_firms` breadth count. No firm_id, no
-- company/engagement identifier, no owner PII, and never a firm's raw client
-- financials leave a cell. A cell with contributing_firms = 1 is a single firm's
-- own numbers and should be treated as low-confidence by any consumer.
--
-- READ-ONLY (CLAUDE.md §1-2, §4): views only. Nothing here writes a score, mutates
-- an immutable assessment, or touches client data. Calibration informs a future
-- rubric_version / valuation_rules_version; it never edits a score directly.

-- ── Verified corpus coverage (depth of the verified pool) ─────────────── product
-- How many VERIFIED (document- or ledger-backed) financial data points we hold per
-- industry × size band, and how broadly across firms. This is the literal
-- "count of verified data points per industry×band".
create view analytics.verified_corpus_coverage as
select
  c.industry,
  c.revenue_band                                                     as size_band,
  count(*)                                                           as verified_data_points,
  count(*) filter (where ap.source = 'document')                     as document_verified,
  count(*) filter (where ap.source = 'connected_ledger')             as ledger_verified,
  count(distinct ap.firm_id)                                         as contributing_firms,
  count(distinct e.company_id)                                       as companies,
  count(distinct ap.assessment_id)                                   as assessments
from answer_provenance ap
join assessments a  on a.id = ap.assessment_id
join engagements e  on e.id = a.engagement_id
join companies   c  on c.id = e.company_id
where ap.source in ('document', 'connected_ledger')
group by c.industry, c.revenue_band;

-- ── Verified financial metric distributions (de-identified) ──────────── product
-- Distributions of the VERIFIED numeric financial inputs themselves — revenue /
-- EBITDA-margin / customer-concentration figures a buyer would substantiate —
-- keyed by the question (metric) that captured them. Only answers whose provenance
-- is document/ledger AND whose stored value is a JSON number are aggregated, so
-- the cast is always well-formed. Emits distribution stats only, never a raw row.
create view analytics.verified_financial_metrics as
select
  c.industry,
  c.revenue_band                                                     as size_band,
  d.code                                                             as dimension_code,
  q.code                                                             as metric_code,
  count(*)                                                           as verified_data_points,
  count(distinct ap.firm_id)                                         as contributing_firms,
  round(avg((ans.value #>> '{}')::numeric), 4)                       as avg_value,
  round(
    percentile_cont(0.5) within group (order by (ans.value #>> '{}')::numeric)::numeric,
    4)                                                               as median_value,
  round(min((ans.value #>> '{}')::numeric), 4)                       as min_value,
  round(max((ans.value #>> '{}')::numeric), 4)                       as max_value,
  round(
    percentile_cont(0.25) within group (order by (ans.value #>> '{}')::numeric)::numeric,
    4)                                                               as p25_value,
  round(
    percentile_cont(0.75) within group (order by (ans.value #>> '{}')::numeric)::numeric,
    4)                                                               as p75_value
from answer_provenance ap
join answers      ans on ans.assessment_id = ap.assessment_id and ans.question_id = ap.question_id
join assessments  a   on a.id = ap.assessment_id
join engagements  e   on e.id = a.engagement_id
join companies    c   on c.id = e.company_id
join questions    q   on q.id = ap.question_id
join dimensions   d   on d.id = q.dimension_id
where ap.source in ('document', 'connected_ledger')
  and q.scored = true
  and jsonb_typeof(ans.value) = 'number'
group by c.industry, c.revenue_band, d.code, q.code;

-- ── Own-book realized multiples (the calibration payoff) ─────────────── business
-- Realized multiples "from our own book of verified deals" — the closed
-- deal_outcomes rollup by industry × band that lets us refine valuation multiples
-- against reality instead of generic comps. Advisor-reported FACT (docs/09), not
-- inferred. Aggregate statistics only; no single deal is identifiable.
create view analytics.own_book_multiples as
select
  c.industry,
  c.revenue_band                                                     as size_band,
  count(*)                                                           as closed_deals,
  count(distinct o.firm_id)                                          as contributing_firms,
  round(avg(o.final_multiple), 2)                                    as avg_multiple,
  round(
    percentile_cont(0.5) within group (order by o.final_multiple)::numeric,
    2)                                                               as median_multiple,
  round(min(o.final_multiple), 2)                                    as min_multiple,
  round(max(o.final_multiple), 2)                                    as max_multiple,
  round(avg(o.final_ev))                                             as avg_final_ev,
  round(avg(o.ebitda_at_close))                                      as avg_ebitda_at_close,
  round(avg(o.days_on_market))                                       as avg_days_on_market,
  count(*) filter (where o.retrade)                                  as retrade_deals
from deal_outcomes o
join engagements e on e.id = o.engagement_id
join companies   c on c.id = e.company_id
where o.outcome = 'closed'
  and o.final_multiple is not null
group by c.industry, c.revenue_band;

-- ── Connected-ledger coverage (ground-truth breadth) ─────────────────── product
-- How much of the corpus is backed by a live QuickBooks/Xero connection — the
-- ground-truth layer (docs/09 moat 2) — by industry × band. Counts only.
create view analytics.ledger_verified_coverage as
select
  c.industry,
  c.revenue_band                                                     as size_band,
  count(distinct lc.company_id)                                      as ledger_connected_companies,
  count(distinct lc.firm_id)                                         as contributing_firms,
  count(*) filter (where lc.provider = 'quickbooks')                 as quickbooks_connections,
  count(*) filter (where lc.provider = 'xero')                       as xero_connections
from ledger_connections lc
join companies c on c.id = lc.company_id
where lc.status = 'connected'
group by c.industry, c.revenue_band;

-- Grant read on the views just defined. The default privileges set in 700 already
-- cover future views; this re-asserts it explicitly. service_role ONLY — never
-- authenticated/anon (the isolation guarantee).
grant select on all tables in schema analytics to service_role;
