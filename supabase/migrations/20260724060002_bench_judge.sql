-- ExitBlueprint Bench — add the LLM-JUDGE axis to the persisted results
-- (docs/sellside-ai/02-evaluation-bench.md, WS-JUDGE). The two-axis deterministic
-- bench (answer + source) already persists into analytics.bench_results
-- (20260724030054_bench_results.sql). This migration adds the THIRD axis: the
-- subjective LLM-judge score ("explains why a buyer cares in plain language"),
-- graded by the versioned judge (prompts/bench_judge.v1.md, server/llm/evals/judge.ts).
--
-- NULLABLE BY DESIGN: the judge tier is secret-gated (AI_GATEWAY_API_KEY +
-- RUN_LLM_JUDGE) and OFF by default, so almost every recorded row is graded with
-- deterministic checks only and carries judge_score = NULL. A value is present in
-- [0,1] only for a row a judge actually graded on a labeled [eval] run. No LLM ever
-- computes a DRS/ORI score (CLAUDE.md rule #1) — this is a de-identified PROSE-quality
-- number, advisory to CI, never written to a scoring table.
--
-- ISOLATION GUARANTEE (CLAUDE.md rule #5): unchanged from the base bench store. This
-- lives in the `analytics` schema granted to `service_role` ONLY (no usage for
-- authenticated/anon — scripts/rls-test.ts asserts the denial). Every row is a
-- de-identified quality aggregate keyed by doc_type/prompt_version/tier — NO firm_id,
-- NO company id, NO client PII. The single reader is the superadmin-gated
-- GET /internal/metrics route on the service-role, RLS-bypass connection.

-- The subjective judge axis, in [0,1]; NULL when no judge graded the row.
alter table analytics.bench_results
  add column judge_score numeric;

-- Recreate the "latest run" convenience view to surface the new axis. service_role-
-- only like everything in this schema (the base grant is re-applied below).
drop view if exists analytics.bench_latest;
create view analytics.bench_latest as
select r.run_id, r.run_at, r.doc_type, r.prompt_version, r.model, r.case_name,
       r.tier, r.answer_score, r.source_score, r.judge_score
from analytics.bench_results r
where r.run_id = (select max(run_id) from analytics.bench_runs);

grant select on analytics.bench_latest to service_role;
