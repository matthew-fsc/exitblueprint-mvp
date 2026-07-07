# 05 - Build Plan (session-by-session)

Rule: one session = one slice = one commit. Each session prompt below is written to be pasted into Claude Code mostly as-is. Do not start a session until the previous slice's acceptance criteria pass. If a slice balloons, split it and log why in 06-decisions.md.

## Phase 1 - Foundation and scoring

**S1. Repo + Supabase scaffold.**
"Initialize the project: Vite React TS app, supabase CLI with local dev, folder structure per docs/01-architecture.md. Add CI step that runs migrations against a fresh local db. No UI beyond a health page."
Accept: fresh clone -> `supabase start` + migrate + app boots.

**S2. Schema migration + RLS.**
"Implement the full schema in docs/02-data-model.md as migrations, including enums, FKs, and RLS policies for admin/advisor/owner roles as specified. Write a policy test script that proves firm A advisor cannot read firm B rows."
Accept: migrations clean; RLS test passes.

**S3. Seed pipeline.**
"Build an idempotent seed script that loads /seed CSVs and playbook markdown into rubric_versions, dimensions, questions, gap_definitions, playbooks, playbook_task_templates, mapping tables, content_modules. Validate referential integrity and report row counts."
Accept: seed runs twice with identical end state; counts match CSVs.

**S4. Scoring engine + tests.**
"Implement scoreAssessment and explainAssessment per docs/03-scoring-engine-spec.md as a server function. Port the logic from seed/fixtures/reference_scorer.py; unit tests must reproduce the three fixture expected outputs exactly, plus determinism, immutability, and band-boundary tests from docs/03."
Accept: all fixture scores match hand-computed values exactly.

## Phase 2 - Intake and report (MVP)

**S5. Auth + advisor shell.**
"Supabase auth with email login; profiles with roles; minimal advisor layout: client list for their firm, create company, create engagement."
S5 builds login and the advisor shell only; firm/user provisioning stays CLI (scripts/admin.ts, see docs/08-operations.md) until explicitly promoted to UI.
Accept: two advisor accounts in different firms see only their own data. No admin panel or provisioning UI is scaffolded.

**S6. Assessment intake flow.**
"Build the intake: start assessment on an engagement (locks to active rubric_version), one dimension per step, all answer types from the schema, save-and-resume, completeness validation, submit triggers scoring."
Accept: full walkthrough on fixture answers reproduces fixture scores in the UI.

**S7. Score views.**
"Assessment results page: overall score with band, dimension breakdown, flagged gaps with severity, and an explain drawer per dimension using explainAssessment. The two score groups display distinctly — business DRS rollup and ORI rollup — plus the combined composite, never a flattened single list of dimensions; dimensions group under the correct rollup. All score views read active assessments only (active_assessments view)."
Accept: advisor can answer "why is this a 61" from the UI alone, AND can see business score, owner score, and composite as three separate figures and answer "the business is ready but the owner isn't" (or vice versa) from the UI alone.

**S8. Narrative service + owner report.**
"Implement generateDocument per docs/04-ai-layer-spec.md with owner_report.v1 prompt, the numeral post-check, and storage in generated_documents. Add report view with edit-before-finalize and clean print/PDF styling."
Accept: fixture assessment produces a report using only supplied numbers; advisor can edit and export.

MVP checkpoint: run a real (or pilot) client end to end. Stop and gather advisor feedback before Phase 3.

## Phase 3 - Roadmap and advisor workspace

**S9. Roadmap generator + task board.**
"From open gaps, instantiate mapped playbook task templates into tasks with sequencing and due dates from target_offset_days. Task board per engagement: status, owner_role, edit, add manual tasks."
Accept: closing a gap's tasks and re-assessing shows gap resolution flow working.

**S10. Advisor dashboard.**
"Portfolio view: engagements with current score, delta vs prior assessment, open gap count, stalled tasks (no status change in 14 days), next re-assessment due. Reads active assessments only (active_assessments view). Deltas come from compareAssessments; when the prior assessment is on a different rubric_version, the delta column shows the incomparable state distinctly (e.g. 'new rubric'), never blank or zero."

**S11. Advisor brief generation.**
"Add advisor_brief.v1 per docs/04, generated on demand from the dashboard, including deltas and stalled tasks."

**S12. n8n webhook endpoints.**
"Authenticated endpoints per docs/01: stale-engagements, stalled-tasks, reassessment-due, engagement summary payloads. Document the n8n flows to build against them (n8n flows themselves are configured outside this repo)."

## Phase 4 - Owner portal and education

**S13. Owner auth + portal.**
"Owner role login scoped to their company: current score, dimension summary, their roadmap tasks, finalized owner reports."

**S14. Content drip.**
"Content assignment from gap_content_map with drip_order; endpoint n8n calls to fetch/mark the next module per engagement; owner portal module view."

**S15. Re-assessment + trend view.**
"Start re-assessment (sequence_number increments, current rubric_version), and a score trend chart per engagement across assessments."

## Later (not scheduled)

Benchmarking, firm admin console, white-label, billing, external data ingestion. Decision point on external engineering help (e.g. real-time analytics) sits after meaningful assessment volume exists.
