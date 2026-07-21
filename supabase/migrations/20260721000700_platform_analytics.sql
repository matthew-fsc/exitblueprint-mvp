-- Platform monitoring rails (docs/38). The ExitBlueprint operating team's
-- cross-tenant analytics layer: read-only rollup VIEWS over the append-only
-- tables the app already writes during normal operation (usage_events,
-- data_access_log, billing_events, firm_subscriptions, llm_calls, and the core
-- firms/engagements/assessments spine). Four monitoring domains — infra/uptime,
-- product/usage, business/billing, security/compliance — on ONE set of rails.
--
-- ISOLATION GUARANTEE (CLAUDE.md §5): these views aggregate ACROSS firms, so they
-- live in a dedicated `analytics` schema that is granted to `service_role` ONLY.
-- `authenticated`/`anon` are never granted usage on the schema or select on any
-- view — a tenant role cannot read them, ever. The single app-level reader is the
-- superadmin-gated GET /internal/metrics route (server/http.ts), which queries
-- them on the service-role (RLS-bypass) connection. scripts/rls-test.ts asserts
-- the tenant-role denial so this can't silently regress into a cross-firm leak.
--
-- READ-ONLY (CLAUDE.md §1-2, §4): views only. Nothing here writes a score, mutates
-- an immutable assessment, or touches client data.

create schema if not exists analytics;

-- Lock the schema down: no PUBLIC access; service_role is the sole reader (both
-- for the views defined below and any added later, via default privileges).
revoke all on schema analytics from public;
grant usage on schema analytics to service_role;
alter default privileges in schema analytics grant select on tables to service_role;

-- ── Platform totals (one row) ────────────────────────────────────────── business
create view analytics.platform_totals as
select
  (select count(*) from firms)                                          as firms,
  (select count(*) from firms where status = 'active')                  as active_firms,
  (select count(*) from companies)                                      as companies,
  (select count(*) from engagements)                                    as engagements,
  (select count(*) from engagements where status = 'active')            as active_engagements,
  (select count(*) from assessments)                                    as assessments,
  (select count(*) from assessments where status = 'completed')         as completed_assessments,
  (select count(*) from generated_documents)                            as generated_documents;

-- ── Assessment funnel (one row) ───────────────────────────────────────── product
-- engagements → assessments started → completed → scored. The activation spine.
create view analytics.assessment_funnel as
select
  (select count(*) from engagements)                                    as engagements,
  (select count(*) from assessments)                                    as assessments_started,
  (select count(*) from assessments where status = 'completed')         as assessments_completed,
  (select count(*) from assessments where drs_score is not null)        as assessments_scored;

-- ── Usage by day (product analytics) ──────────────────────────────────── product
create view analytics.usage_daily as
select
  date_trunc('day', occurred_at)::date as day,
  event_type,
  event_name,
  count(*)                    as events,
  count(distinct firm_id)     as firms,
  count(distinct session_id)  as sessions
from usage_events
group by 1, 2, 3;

-- ── Per-firm overview (adoption + commercial) ─────────────────── business/product
create view analytics.firm_overview as
select
  f.id            as firm_id,
  f.name,
  f.created_at,
  f.status,
  fs.plan_code,
  fs.status       as subscription_status,
  fs.seats,
  fs.current_period_end,
  (select count(*) from companies  c where c.firm_id = f.id)                              as companies,
  (select count(*) from engagements e where e.firm_id = f.id)                             as engagements,
  (select count(*) from engagements e where e.firm_id = f.id and e.status = 'active')     as active_engagements,
  (select count(*) from assessments a where a.firm_id = f.id and a.status = 'completed')  as completed_assessments,
  (select max(occurred_at) from usage_events ue where ue.firm_id = f.id)                  as last_activity_at
from firms f
left join firm_subscriptions fs on fs.firm_id = f.id;

-- ── Subscriptions summary (unit counts; $ live in Stripe) ────────────── business
create view analytics.subscription_summary as
select
  coalesce(plan_code, 'none') as plan_code,
  status,
  count(*)                    as firms,
  sum(seats)                  as seats
from firm_subscriptions
group by 1, 2;

-- ── AI cost/latency by day (COGS) ───────────────────────────────── business/ops
create view analytics.ai_cost_daily as
select
  date_trunc('day', created_at)::date as day,
  model,
  count(*)                    as calls,
  sum(input_tokens)           as input_tokens,
  sum(output_tokens)          as output_tokens,
  round(sum(cost_usd), 4)     as cost_usd,
  round(avg(latency_ms))      as avg_latency_ms
from llm_calls
group by 1, 2;

-- ── Access-log rollup (compliance anomaly-spotting) ──────────────────── security
create view analytics.access_log_daily as
select
  date_trunc('day', created_at)::date as day,
  action,
  resource_type,
  count(*)                    as events,
  count(distinct firm_id)     as firms
from data_access_log
group by 1, 2, 3;

-- ── Webhook health (a stuck webhook is an outage /ready won't catch) ───────── ops
create view analytics.ops_webhook_health as
select
  type,
  count(*)                                     as events,
  count(*) filter (where processed_at is null) as unprocessed,
  max(received_at)                             as last_received_at
from billing_events
group by 1;

-- Grant read on the views just defined (default privileges above cover future
-- ones; this covers these). service_role ONLY — never authenticated/anon.
grant select on all tables in schema analytics to service_role;
