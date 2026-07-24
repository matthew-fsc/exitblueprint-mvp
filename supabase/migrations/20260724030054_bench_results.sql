-- Deliverable-quality store — "ExitBlueprint Bench" persisted results (docs/sellside-ai/
-- 02-evaluation-bench.md, docs/09-moats.md). The bench GRADES a generated deliverable
-- (owner report, CIM, …) on two independent axes — answer completeness and source
-- traceability — with pure, rule-based checks (server/llm/evals/bench.ts). This
-- migration adds the store for the RESULTS of a bench run so the superadmin quality
-- dashboard can chart deliverable quality over time.
--
-- WHY A SNAPSHOT: each `recordBenchRun` groups its per-case grades under one
-- `bench_runs` header row; the results reference it. "Latest run" is simply the
-- max run_id — the `bench_latest` view. The scores are computed DETERMINISTICALLY by
-- the pure grader; no LLM computes, adjusts, or influences a score (CLAUDE.md rule
-- #1). The bench grades a deliverable's quality — it never writes to a scoring table.
--
-- ISOLATION GUARANTEE (CLAUDE.md rule #5): this is PLATFORM-QUALITY telemetry, not
-- tenant client data. Like platform_analytics / financial_corpus / moat_kpis /
-- calibration, it lives in the dedicated `analytics` schema granted to `service_role`
-- ONLY. `authenticated`/`anon` get no usage on the schema and no select on these
-- tables, so a tenant role can never read them (scripts/rls-test.ts asserts the
-- denial). The single reader is the superadmin-gated GET /internal/metrics route
-- (server/http.ts) on the service-role, RLS-bypass connection. Every row is a
-- de-identified quality aggregate keyed by doc_type/prompt_version/tier — NO firm_id,
-- NO company id, NO client PII. (The generated tier reads one completed assessment to
-- grade the real code path, but only the resulting scores are stored here.)
--
-- The `analytics` schema, its lockdown, and its service-role default privileges
-- already exist (20260721000700_platform_analytics.sql). We only add objects here.

-- ── Run header: one row per bench run (groups a run's per-case results) ── business
create table analytics.bench_runs (
  run_id bigint generated always as identity primary key,
  run_at timestamptz not null default now()
);

-- ── Per-case bench results, tied to a run ─────────────────────────────── business
-- One row per graded case. tier 'static' grades a frozen fixture deliverable;
-- 'generated' grades the deliverable the shipping deterministic composer actually
-- produces for a completed assessment. answer_score/source_score are the pure
-- grader's two axes, each in [0,1]. doc_type/prompt_version/model identify which
-- deliverable + generator version produced the graded output.
create table analytics.bench_results (
  id bigint generated always as identity primary key,
  run_id bigint not null references analytics.bench_runs (run_id) on delete cascade,
  run_at timestamptz not null default now(), -- denormalized from the run header for convenience
  doc_type text not null,
  prompt_version text not null,
  model text not null,
  case_name text not null,
  tier text not null check (tier in ('static', 'generated')),
  answer_score numeric not null,
  source_score numeric not null
);

create index on analytics.bench_results (run_id);

-- Convenience read: the results of the most recent run (what the operator rail
-- reads). service_role-only like everything in this schema.
create view analytics.bench_latest as
select r.run_id, r.run_at, r.doc_type, r.prompt_version, r.model, r.case_name,
       r.tier, r.answer_score, r.source_score
from analytics.bench_results r
where r.run_id = (select max(run_id) from analytics.bench_runs);

-- Grants. The schema default privileges (20260721000700) already extend SELECT on
-- future tables/views to service_role; the record path also needs INSERT (and the
-- identity sequences), so grant those explicitly. service_role ONLY — never
-- authenticated/anon (the schema has no usage grant to them, so this is
-- belt-and-suspenders).
grant select, insert on analytics.bench_runs to service_role;
grant select, insert on analytics.bench_results to service_role;
grant usage, select on sequence analytics.bench_runs_run_id_seq to service_role;
grant usage, select on sequence analytics.bench_results_id_seq to service_role;
grant select on analytics.bench_latest to service_role;
