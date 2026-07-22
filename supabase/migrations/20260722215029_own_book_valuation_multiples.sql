-- Own-book valuation multiples, aligned to the valuation key-space (docs/09 moat 2).
--
-- Builds ON the verified financial corpus (20260721001000_financial_corpus.sql):
-- that migration's `analytics.own_book_multiples` rolls realized deal multiples up
-- by RAW company.industry × revenue_band. This adds one more rollup keyed by the
-- advisor-chosen VALUATION industry_key (valuation_inputs.industry_key) instead of
-- the raw industry string, so the cross-firm calibration signal lands in exactly
-- the key-space server/valuation.ts looks multiples up in — the substrate a future
-- valuation_rules_version recalibration reads (CLAUDE.md §6: recalibration ships as
-- a new version, never an in-place edit).
--
-- ISOLATION (CLAUDE.md §5): this is a view in the service-role-only `analytics`
-- schema created in 20260721000700_platform_analytics.sql. That migration set
-- `alter default privileges in schema analytics grant select on tables to
-- service_role` and granted schema usage to service_role ONLY, so this view is
-- readable by service_role and NEVER by authenticated/anon — the same cross-firm
-- boundary every analytics object sits behind. scripts/rls-test.ts asserts the
-- tenant-role denial on the schema. This is INTERNAL calibration substrate, NOT a
-- client-facing benchmark (that surface stays out of scope). The firm-facing
-- own-book multiple the valuation page shows is a SEPARATE, firm-scoped read over
-- the firm's own deal_outcomes (server/comparables.ts ownBookMultiple).
--
-- DE-IDENTIFIED, COUNTS-ONLY: groups by industry_key × size band and emits counts
-- + multiple distribution stats + a contributing_firms breadth count. No firm_id,
-- no company/engagement id, no PII. A cell with contributing_firms = 1 is a single
-- firm's own numbers and should be treated as low-confidence by any consumer.
--
-- READ-ONLY (CLAUDE.md §1-2, §4): a view; nothing here writes a score or mutates an
-- assessment. Advisor-reported FACT from closed deal_outcomes, never inferred.

create view analytics.own_book_valuation_multiples as
select
  coalesce(vi.industry_key, 'unmapped')                              as industry_key,
  c.revenue_band                                                     as size_band,
  count(*)                                                           as closed_deals,
  count(distinct o.firm_id)                                          as contributing_firms,
  round(avg(o.final_multiple), 2)                                    as avg_multiple,
  round(
    percentile_cont(0.5) within group (order by o.final_multiple)::numeric,
    2)                                                               as median_multiple,
  round(
    percentile_cont(0.25) within group (order by o.final_multiple)::numeric,
    2)                                                               as p25_multiple,
  round(
    percentile_cont(0.75) within group (order by o.final_multiple)::numeric,
    2)                                                               as p75_multiple,
  round(min(o.final_multiple), 2)                                    as min_multiple,
  round(max(o.final_multiple), 2)                                    as max_multiple
from deal_outcomes o
join engagements     e  on e.id = o.engagement_id
join companies       c  on c.id = e.company_id
left join valuation_inputs vi on vi.engagement_id = o.engagement_id
where o.outcome = 'closed'
  and o.final_multiple is not null
group by coalesce(vi.industry_key, 'unmapped'), c.revenue_band;

-- Re-assert the service_role-only grant (default privileges from 700 already cover
-- future views; this makes the boundary explicit next to the object).
grant select on analytics.own_book_valuation_multiples to service_role;
