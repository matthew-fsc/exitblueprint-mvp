# Exit Blueprint — Capability Audit (Assessment Platform Repo)

**Session S0.5-A · Consolidation exercise · Audit date 2026-07-11**

This single file combines all four audit deliverables: Capability Inventory, Schema, Architecture Decisions, and Survivor Assessment. Each also exists as its own file in `/audit`. Documentation only — no application code was modified in this session.

---

## Executive summary

- **Fixtures pass byte-identical, verified by actual run.** company-1 DRS 82.6 (Sale Ready), company-2 DRS 16.1 (Not Saleable Yet), company-3 DRS 52.0 (High Risk); the Python reference matches the stored fixtures exactly. Full suite: **40/40 tests pass** against a live migrated+seeded Postgres; **16/16 RLS isolation checks pass**.
- **The core is production-leaning and target-aligned.** A pure, decoupled, deterministic scoring engine; rubric-as-data with versioning; an immutable, supersede-based, multi-tenant engagement spine; computed cross-version deltas; append-only outcome capture; an AI-narrative firewall with a deterministic fallback.
- **The gaps are in the application/operational tier, and they are additive, not baked-in mistakes.** No general server layer (Supabase + 3 functions only), production edge functions unbuilt, `tasks`/roadmap inert, content drip / owner portal / n8n / notifications unbuilt, 2 of 3 document types stubbed.
- **Recommendation: this repo is the SURVIVOR.** It holds the irreplaceable, hard-to-recreate, dangerous-to-get-wrong pieces. Port the dashboard repo's server tier, deploy plumbing, dashboards, and owner-portal UI *into* this base.
- **WM-layer readiness:** branded delta report, dual-milestone roadmap, and engagement activity log are **additive schema+UI** on primitives that already exist; cadence triggers **need net-new infrastructure** (a server tier + scheduler/n8n) — the one structural investment to make first.

---

## Table of contents

1. [Capability Inventory](#1-capability-inventory)
2. [Schema](#2-schema)
3. [Architecture Decisions](#3-architecture-decisions)
4. [Survivor Assessment](#4-survivor-assessment)

---

## 1. Capability Inventory

# Capability Inventory — Assessment Platform Repo (`exitblueprint-mvp`)

Audit date: 2026-07-11 · Branch: `claude/exit-blueprint-audit-fvcgiu` · Commit base: current HEAD

**Status legend:** `WORKING` (functional, tested/verifiable) · `PARTIAL` (functional but incomplete) · `STUB` (scaffolded, no real logic) · `ABSENT`

**Verification note:** all test results below are actual run output. `npm test` was run with and without a database; a local Postgres 16 cluster was stood up via `scripts/devdb.sh`, migrated, seeded, and the full suite plus the RLS harness were run against it. No application code was modified.

---

## Scoring & assessment core

| Capability | Status | Location | Quality | Notes |
|---|---|---|---|---|
| DRS scoring engine (32 sub-scores) | **WORKING** | `shared/scoring/engine.ts`, seeded rubric in `seed/drs-rubric-subscores.csv` | production-leaning | All 32 sub-scores implemented across 12 `formula_type`s. Engine is a **pure function** `scoreFromAnswers(rubric, answers)` — no I/O, no LLM. TS is a faithful port of `seed/fixtures/reference_scorer.py`. Confirmed 32 scored questions → 32 sub-scores. |
| Dimension & DRS weighting | **WORKING** | `engine.ts` (`scoreFromAnswers`), `dimensions.drs_weight` | production-leaning | 6 business dims weighted REV .25 / FIN .20 / OPS .20 / CUS .15 / MGT .10 / GRW .10 = 1.0. DRS = weighted sum of business dims only. ORI computed separately from owner_readiness sub-scores. Matches spec exactly. |
| Band thresholds & tier assignment | **WORKING** | `engine.ts` `drsTier()`; band logic in `sub_scores.logic` JSON | production-leaning | 5 tiers: Institutional Grade ≥85, Sale Ready ≥70, Needs Work ≥55, High Risk ≥40, else Not Saleable (Yet). Band-boundary edge cases explicitly tested (`tests/engine.test.ts`). |
| **Fixture regression tests (3 companies, byte-identical)** | **WORKING** | `tests/engine.test.ts`, `tests/helpers.ts`, `seed/fixtures/*.json` | production-leaning | **All three pass byte-identical — verified by actual run.** See run output below. Tests assert every sub-score, dimension score, DRS, tier, ORI, gap set, flags, AND computed intermediates (HHI, CAGR, down-years, pipeline coverage). |
| Python↔TS parity | **WORKING** | `reference_scorer.py` vs `engine.ts` | production-leaning | Ran the Python reference against the stored fixtures directly: `match_stored = True` for all three. The `pyRound` BigInt implementation reproduces Python round-half-even on the exact binary double (fixture-3 ORI 40.25→40.2 is irreproducible with JS `Math.round`; this was a real decision, logged 2026-07-07). |
| Intake flow (54 questions) | **WORKING** | `src/pages/IntakePage.tsx`, `src/lib/intakeFields.ts`, `src/lib/answerFields.tsx` | production-leaning | 54 questions total (32 scored, 22 context-only). Multi-step wizard with progress bar, unit adornments ($/%/mo/hrs), labeled list rows, humanized option labels, "Not tracked" toggle. Persisted answer format is plain number/number[]/string so scoring is untouched. |
| Question→sub-score mapping | **WORKING** | `sub_scores.input_question_codes`, `shared/rubric-seed.ts` `validateRubric()` | production-leaning | Referential integrity validated at seed time (unknown dimension/question/sub-score/playbook/content codes all flagged; per-dimension weight sums must equal 1.0). |
| Gap identification (24 definitions) | **WORKING** | `engine.ts` `evaluateTrigger()`, `seed/gap-definitions.csv` | production-leaning | 24 gaps. 5 trigger types: `sub_score_below`, `answer_in`, `answer_lte`, `composite_below`, `all` (nested). Gap sets asserted in fixtures (company-2 fires 23, company-3 fires 18, company-1 fires 0). |
| Playbooks (13) & task templates | **PARTIAL** | `seed/playbooks/*.md` (13), `playbook_task_templates` table (55 rows seeded) | prototype | Playbooks and their 55 task templates are seeded as **reference data** and map to gaps (`gap_playbook_map`, 24 rows). **BUT no code instantiates tasks onto an engagement when a gap fires** — the `tasks` table is never written to anywhere in `src/`, `server/`, or `dev/`. Roadmap/task generation is unbuilt. |
| Content modules (12) keyed to gaps | **PARTIAL** | `seed/content-modules.csv` (12), `gap_content_map` (24 rows) | prototype | Content and gap→content drip mapping are seeded, but there is **no assignment/drip logic and no owner-facing content view** (that is build-plan S11, not built). Data layer only. |

### Actual fixture test run output

```
$ npm test    (no DATABASE_URL)
 ✓ tests/engine.test.ts (22 tests) 13ms
 ↓ tests/scoring-db.test.ts (3 tests | 3 skipped)     # skipped: no DB
 ↓ tests/supersede-compare.test.ts (3 tests | 3 skipped)
 ✓ tests/narrative.test.ts (12 tests | 6 skipped)
 Test Files  2 passed | 2 skipped (4)
      Tests  28 passed | 12 skipped (40)

$ python3 (reference_scorer score_company vs stored fixtures)
 company-1-meridian-managed-it  DRS=82.6 Sale Ready         ORI=79.2  match_stored=True
 company-2-apex-fabrication     DRS=16.1 Not Saleable (Yet) ORI=7.8   match_stored=True
 company-3-harborview-staffing  DRS=52.0 High Risk          ORI=40.2  match_stored=True

$ DATABASE_URL=… npm test    (against migrated + seeded local Postgres 16)
 ✓ tests/narrative.test.ts        (12 tests) 189ms
 ✓ tests/supersede-compare.test.ts (3 tests) 408ms
 ✓ tests/scoring-db.test.ts        (3 tests) 431ms
 ✓ tests/engine.test.ts           (22 tests) 13ms
 Test Files  4 passed (4)
      Tests  40 passed (40)
```

Fixture expected values (from `seed/fixtures/*.json`):
- **company-1 (Meridian Managed IT):** DRS 82.6 Sale Ready, ORI 79.2, 0 gaps, dims REV 86.75 / FIN 91.0 / OPS 72.75 / CUS 83.25 / MGT 82.0 / GRW 74.75
- **company-2 (Apex Fabrication):** DRS 16.1 Not Saleable (Yet), ORI 7.8, 23 gaps, flag "NRR not tracked"
- **company-3 (Harborview Staffing):** DRS 52.0 High Risk, ORI 40.2, 18 gaps

---

## Data model & persistence

| Capability | Status | Location | Quality | Notes |
|---|---|---|---|---|
| Full schema | **WORKING** | `supabase/migrations/*.sql` (5 migrations) | production-leaning | 28 tables + 1 view + enums + `app.*` helper fns. Full dump in `SCHEMA.md`. Migrations applied cleanly to a fresh DB in this audit. |
| Multi-tenancy (firm/advisor/client) | **WORKING** | `20260707000200_rls.sql`; every domain table carries `firm_id` | production-leaning | RLS deny-by-default; advisor scoped to `firm_id`, owner scoped to their company, methodology tables world-readable to authenticated. **Verified: 16/16 `test:rls` assertions pass against live DB** including cross-firm read/write denial and unauthenticated=nothing. |
| Engagement as first-class entity | **WORKING** | `engagements` table; `assessments.engagement_id` | production-leaning | Engagement is the spine unit exactly as specified (firm → company → engagement → assessments). Score history/trajectory read per engagement. |
| Assessment versioning | **WORKING** | `assessments.sequence_number`, unique(engagement_id, sequence_number) | production-leaning | Multiple assessments per engagement, sequenced (1 = baseline). Immutable once `completed` — re-scoring a completed assessment throws `immutable`. |
| Cross-version delta support | **WORKING** | `server/scoring.ts` `compareAssessments()` | production-leaning | **Computed, not stored** (per docs). Returns full sub-score/dim deltas + gaps opened/resolved. Cross-*rubric*-version comparison returns an explicit `{comparable:false, reason:'rubric_version_mismatch'}` marker rather than a misleading number. Tested. |
| Outcome capture schema | **WORKING (schema)** / **ABSENT (UI/API)** | `20260707010000_outcome_capture.sql` | production-leaning schema | `engagement_outcomes` (1/engagement) + `outcome_events` (**append-only**: SELECT+INSERT grants/policies only, no UPDATE/DELETE). RLS append-only behavior **verified in `test:rls`**. No UI or API surface exists (intentional per docs — "schema only in v1"). |
| Correction / supersede workflow | **WORKING** | `server/scoring.ts` `supersedeAssessment()`, `20260707010100_assessment_supersede.sql`, `active_assessments` view | production-leaning | Supersede-never-edit: new assessment created + scored, old row marked `record_status='superseded'` with linkage & reason, content untouched. `active_assessments` view is the longitudinal read path. Tested (content-unchanged assertions + can't-supersede-twice). |
| Audit/event logging | **PARTIAL** | `outcome_events` (append-only) ; `created_at`/`answered_by`/supersede reason | prototype | Domain-specific append-only event log exists for deal outcomes. There is **no general-purpose activity/audit log** (e.g. "advisor viewed report", "engagement touched") — relevant to the WM engagement-log requirement. |

---

## Application layer

| Capability | Status | Location | Quality | Notes |
|---|---|---|---|---|
| Auth & session handling | **WORKING** | `src/lib/auth.tsx`, `src/lib/supabase.ts`; dev emulator `dev/supabase-dev-server.ts` | production-leaning | Supabase Auth (real in deploy). `AuthProvider` loads session + profile + firm name. Dev emulator implements the auth/rest/functions surface against local Postgres **with real RLS per request** (HS256 JWT, fixed dev password) so the app runs with no Docker/Supabase stack. Clearly labeled dev-only. |
| Role / permission model | **WORKING** | `app_role` enum (admin/advisor/owner); `RequireAdvisor` guard; RLS policies | production-leaning | Enforced in two layers: React route guard + Postgres RLS (the real boundary). Owner role is fully modeled in RLS but has no dedicated portal pages yet (see below). |
| API surface | **PARTIAL** | `dev/supabase-dev-server.ts` (dev), `server/scoring.ts`, `server/narrative.ts` | prototype (dev), production-leaning (server fns) | See route list below. In production the app calls Supabase PostgREST (`/rest/v1/*`) directly + 3 edge-style functions. There are **no deployed Supabase Edge Function wrappers checked in** — functions run via the dev emulator; production deployment of `score-assessment`/`explain-assessment`/`generate-document` as edge functions is not present in-repo. |
| Frontend pages | **WORKING** | `src/pages/*` (9 pages) | production-leaning | Login, Clients, Engagement (+ DRS trajectory), Intake (54-q wizard), Results (score breakdown), Workbench (live what-if), Report (generate/edit/finalize/print), Health, dev Verify. Polished, semantic design tokens, full light/dark theme. |
| State management | **WORKING** | React hooks + context | prototype-appropriate | Local `useState`/`useMemo`/`useContext`; no Redux/Zustand. Appropriate for scope. Data fetched per-page via supabase-js; no caching layer (each page re-queries). |
| Report / document generation | **PARTIAL** | `server/narrative.ts`, `src/pages/ReportPage.tsx`, `prompts/owner_report.v1.md` | production-leaning | `owner_report` only. Dual path: Claude (`claude-opus-4-8`, adaptive thinking) when `ANTHROPIC_API_KEY` set, else a **deterministic composer** (`composeOwnerReport`) that always works. Strict **numeral post-check** rejects any number not in the payload (regenerates once, then fails loudly). Edit-before-finalize + print-to-PDF. `advisor_brief` and `engagement_summary` doc_types are enum'd but **throw "not implemented"**. |
| Notification / email / webhook infra | **ABSENT** | — | — | No email, no notifications, no webhook endpoints in code. Only `owner_contact_email` as a data field and dev-auth email lookups. |
| n8n / workflow integration | **ABSENT** | documented only (`docs/01`, `docs/05` S12) | — | The webhook endpoints n8n would call (stale-engagements, stalled-tasks, reassessment-due, next-content-module) are **specified but not built**. Directly relevant to the WM cadence-trigger requirement. |
| PDF/HTML export | **PARTIAL** | `ReportPage.tsx` `window.print()` + print CSS | prototype | "Print / save as PDF" via browser print of a finalized report. No server-side PDF renderer. |

### API / route surface (from `dev/supabase-dev-server.ts` + client usage)

| Route | Method(s) | Purpose |
|---|---|---|
| `/auth/v1/token?grant_type=password\|refresh_token` | POST | Login / refresh (dev emulator; real Supabase Auth in prod) |
| `/auth/v1/user` | GET | Current user from bearer JWT |
| `/auth/v1/logout` | POST | Sign out |
| `/rest/v1/<table>` | GET | Row read with `eq`/`in`/`order`/`limit` filters, RLS-enforced |
| `/rest/v1/<table>` | POST | Insert / upsert (`on_conflict` merge), RLS-enforced |
| `/rest/v1/<table>` | PATCH | Update by filter, RLS-enforced |
| `/functions/v1/score-assessment` | POST | Score + persist an in-progress assessment (RLS-authorized, then service-role write) |
| `/functions/v1/explain-assessment` | POST | Full explain trace, no writes |
| `/functions/v1/generate-document` | POST | Generate owner report (Claude or deterministic composer) |

---

## Operational

| Capability | Status | Location | Quality | Notes |
|---|---|---|---|---|
| Environment / config / secrets | **WORKING** | `.env.example`, `src/lib/supabase.ts`, `server/narrative.ts` | production-leaning | `VITE_SUPABASE_URL/ANON_KEY` (client), `DATABASE_URL` (scripts), `ANTHROPIC_API_KEY` (server-only, never shipped to browser). Sensible dev fallbacks. |
| Migrations tooling & state | **WORKING** | `scripts/migrate.ts`, `supabase/migrations/*`, `db/supabase-shim.sql` | production-leaning | Filename-ordered, tracked in `schema_migrations`, transactional per file. Shim auto-applied on plain Postgres (creates `auth` schema/roles/`auth.uid()`), skipped on real Supabase. **Verified: all 5 migrations applied cleanly to a fresh DB.** |
| Seed data / demo tenant | **WORKING** | `scripts/seed.ts`, `scripts/seed-demo.ts`, `seed/*` | production-leaning | `db:seed` loads canonical rubric/gaps/playbooks/content (idempotent — verified by running twice). `seed:demo` builds a demo firm + a longitudinal story (59.9 Needs Work → 72.3 Sale Ready) and **self-validates against the reference scorer** at seed time. Demo also inserts `engagement_outcomes`. |
| Test coverage beyond fixtures | **WORKING** | `tests/*` (40 tests), `scripts/rls-test.ts` (16 checks), `scripts/e2e-intake.mjs` | production-leaning | Engine (22), narrative incl. numeral post-check (12), scoring-db integration (3), supersede/compare (3), RLS isolation (16). Playwright is a dependency; `e2e-intake.mjs` is a scripted intake walkthrough. |
| CI | **WORKING** | `.github/workflows/ci.yml` | production-leaning | On PR + push to main: spin Postgres 16 → migrate → RLS test → seed twice (idempotency) → demo seed twice → `npm test` → `npm run build`. This is a genuinely thorough pipeline. |
| Admin provisioning | **WORKING (CLI)** | `scripts/admin.ts` | prototype | `create-firm`, `create-advisor`, `assign-company` via CLI. No admin UI (out of scope per decisions log). |
| Dev ergonomics | **WORKING** | `scripts/dev-demo.sh`, `scripts/devdb.sh`, README Codespaces badge | production-leaning | One-command `npm run dev:demo` boots DB + migrations + seed + demo advisor + Vite. `devdb.sh` stands up plain Postgres without Docker. |

---

## Additional significant capabilities (not in the original list)

| Capability | Status | Location | Notes |
|---|---|---|---|
| Explainability trace | **WORKING** | `engine.ts` `explainFromAnswers()`, `shared/scoring/interpret.ts` | Per-sub-score contribution decomposition + a 355-line plain-language interpretation layer shared by the results page and report composer (single source of truth so they never drift). |
| Client-side (isomorphic) scoring | **WORKING** | `src/lib/scoringClient.ts`, `WorkbenchPage.tsx` | The **same** shared engine runs in the browser for the live what-if Workbench — byte-for-byte identical to server scoring, zero round-trip. Enabled by `methodology_read` RLS making rubric tables world-readable. |
| DRS trajectory visualization | **WORKING** | `EngagementPage.tsx` `Trajectory` | Inline bar chart of DRS across an engagement's assessments with delta-since-baseline. |
| Rubric versioning | **WORKING** | `rubric_versions`, all rubric tables FK to it; assessments pin a version | Methodology change = new `rubric_version`, never edit engine per-dimension (CLAUDE.md rule 3 honored). |

---

## Out-of-scope items observed (noted, not acted on)

- Task generation from playbooks onto engagements — **not built** (schema + templates present).
- Content drip / owner content view — **not built** (schema + mappings present).
- n8n webhook endpoints — **not built** (specified).
- Owner portal pages — **not built** (RLS fully models the owner role).
- `advisor_brief` / `engagement_summary` document types — **stubbed** (enum present, generator throws).
- Deployed Supabase Edge Functions — **not in repo** (functions run via dev emulator; prod wrappers absent).
- No general activity/audit log table.

---

## 2. Schema

# Schema — Assessment Platform Repo

Source of truth: `supabase/migrations/*.sql` (5 migrations, applied in filename order). This dump reflects the **live migrations** and was verified by applying all five to a fresh Postgres 16 database during the audit. Every table has `id uuid pk default gen_random_uuid()` and `created_at timestamptz not null default now()` unless noted.

## Migrations

| File | Adds |
|---|---|
| `20260707000100_schema.sql` | All enums, all core tables, indexes |
| `20260707000200_rls.sql` | `app.*` helper fns, grants, RLS enable + all policies, `schema_migrations` |
| `20260707010000_outcome_capture.sql` | `engagement_outcomes`, `outcome_events` (append-only), `app.touch_updated_at` trigger |
| `20260707010100_assessment_supersede.sql` | `assessments.record_status/superseded_by/supersede_reason`, `active_assessments` view |
| `20260707020000_report_finalize.sql` | `generated_documents.finalized_at` |

## Enums

```
firm_status              active | suspended
app_role                 admin | advisor | owner
engagement_status        active | paused | exited | churned
rubric_status            draft | active | retired
score_group              business_readiness | owner_readiness
answer_type              numeric | numeric_list | numeric_or_unknown | select | scale_1_5 | rank | text
formula_type             band_gte | band_ascending | select_map | scale_map | hhi_from_top5 | durability |
                         growth_consistency | depth_ratio | cagr_band | pipeline_ratio | top1_band | top5_band
gap_severity             low | med | high | critical
assessment_status        in_progress | completed
gap_status               open | in_remediation | resolved
task_status              todo | doing | done | blocked
task_owner_role          owner | advisor | cpa | attorney | ops
doc_type                 owner_report | advisor_brief | engagement_summary
assessment_record_status active | superseded
process_status           not_in_market | preparing | in_market | under_loi | closed | withdrawn | broken
outcome_event_type       loi_received | loi_expired | ioi_received | qoe_started | qoe_findings_recorded |
                         retrade | price_change | deal_closed | deal_broken | withdrawn_from_market
```

## Tables

### Tenancy & people

**firms** — tenants
- `name text not null`, `status firm_status not null default 'active'`

**companies** — the "client"
- `firm_id → firms not null`, `name not null`, `industry`, `revenue_band`, `ebitda_band`, `state`, `notes`, `owner_contact_name`, `owner_contact_email`
- index: `(firm_id)`

**profiles** — extends `auth.users`
- `user_id → auth.users not null unique`, `firm_id → firms` (nullable), `role app_role not null`, `full_name`, `email`, `company_id → companies` (owners only)
- index: `(firm_id)`

**engagements** — the unit of work
- `firm_id → firms not null`, `company_id → companies not null`, `advisor_id → profiles`, `status engagement_status not null default 'active'`, `target_exit_window text`, `started_at timestamptz not null default now()`
- indexes: `(firm_id)`, `(company_id)`

### Methodology (rubric-as-data; FK to `rubric_versions`)

**rubric_versions** — `version_label text not null unique`, `status rubric_status default 'draft'`, `effective_date date`, `notes`

**dimensions** — `rubric_version_id → rubric_versions not null`, `code not null`, `name not null`, `description`, `score_group not null`, `drs_weight numeric not null default 0`, `sort_order int`. **unique(rubric_version_id, code)**. index `(rubric_version_id)`

**questions** — `dimension_id → dimensions not null`, `code`, `prompt not null`, `help_text`, `answer_type not null`, `options text` (pipe-delimited), `scored boolean not null default true`, `sort_order`. **unique(dimension_id, code)**. index `(dimension_id)`

**sub_scores** — `dimension_id → dimensions not null`, `code`, `name`, `weight numeric not null`, `formula_type not null`, `input_question_codes text not null` (comma-sep), `logic jsonb not null default '{}'`, `notes`. **unique(dimension_id, code)**. index `(dimension_id)`

**gap_definitions** — `rubric_version_id → rubric_versions not null`, `code`, `name`, `severity not null`, `dimension_id → dimensions not null`, `trigger jsonb not null`. **unique(rubric_version_id, code)**. index `(rubric_version_id)`

**playbooks** — `code`, `name`, `version int not null default 1`, `summary`, `dimension_code text`, `phase`, `ev_impact`, `body_md`. **unique(code, version)**

**playbook_task_templates** — `playbook_id → playbooks not null`, `title not null`, `description`, `default_owner_role task_owner_role not null`, `sequence int not null`, `target_offset_days int`. **unique(playbook_id, sequence)**

**gap_playbook_map** — `gap_definition_id → gap_definitions not null`, `playbook_id → playbooks not null`, `priority int default 1`. **unique(gap_definition_id, playbook_id)**

**content_modules** — `code text not null unique`, `title`, `dimension_code`, `body_md`

**gap_content_map** — `gap_definition_id → gap_definitions not null`, `content_module_id → content_modules not null`, `drip_order int default 1`. **unique(gap_definition_id, content_module_id)**

### Assessment lifecycle (immutable snapshots)

**assessments**
- `firm_id → firms not null`, `engagement_id → engagements not null`, `rubric_version_id → rubric_versions not null`
- `status assessment_status not null default 'in_progress'`, `completed_at`
- `sequence_number int not null default 1` — 1 = baseline
- `drs_score numeric`, `drs_tier text`, `ori_score numeric`
- `record_status assessment_record_status not null default 'active'`, `superseded_by_assessment_id → assessments`, `supersede_reason text`
- **unique(engagement_id, sequence_number)**
- indexes: `(firm_id)`, `(engagement_id)`, partial `assessments_active_by_engagement (engagement_id, sequence_number) where record_status='active'`

**active_assessments** (VIEW, `security_invoker = true`) — `select * from assessments where record_status='active'`. **The mandated longitudinal read path.**

**answers** — `assessment_id → assessments not null`, `question_id → questions not null`, `value jsonb not null`, `answered_by → profiles`. **unique(assessment_id, question_id)**. index `(assessment_id)`

**sub_score_results** — `assessment_id → assessments not null`, `sub_score_id → sub_scores not null`, `points numeric not null`, `computed_inputs jsonb not null default '{}'` (explain trace). **unique(assessment_id, sub_score_id)**. index `(assessment_id)`

**dimension_scores** — `assessment_id → assessments not null`, `dimension_id → dimensions not null`, `score numeric not null`. **unique(assessment_id, dimension_id)**. index `(assessment_id)`

**gaps** — instance of a fired gap on an engagement
- `firm_id → firms not null`, `engagement_id → engagements not null`, `gap_definition_id → gap_definitions not null`, `opened_by_assessment_id → assessments not null`, `status gap_status not null default 'open'`, `resolved_by_assessment_id → assessments`
- indexes: `(firm_id)`, `(engagement_id)`

**tasks** — `firm_id → firms not null`, `engagement_id → engagements not null`, `gap_id → gaps`, `playbook_id → playbooks`, `title not null`, `description`, `owner_role task_owner_role not null default 'owner'`, `assigned_to_name`, `status task_status not null default 'todo'`, `due_date date`, `sequence int`. indexes: `(firm_id)`, `(engagement_id)`. **⚠ Never written to by any application code.**

**generated_documents** — `firm_id → firms not null`, `engagement_id → engagements not null`, `assessment_id → assessments`, `doc_type not null`, `content_md text not null`, `prompt_version text not null`, `model text not null`, `finalized_at timestamptz`. indexes: `(firm_id)`, `(engagement_id)`

### Outcome capture (schema only in v1)

**engagement_outcomes** — one row/engagement, lazy, all nullable
- `firm_id → firms not null`, `engagement_id → engagements not null unique`, `updated_at` (touch trigger), `process_status`, `outcome_recorded_at`. index `(firm_id)`

**outcome_events** — **append-only** event log
- `firm_id → firms not null`, `engagement_id → engagements not null`, `event_type outcome_event_type not null`, `event_date date`, `recorded_by → profiles`, `numeric_value numeric`, `detail jsonb`, `notes`. indexes: `(firm_id)`, `(engagement_id)`
- Append-only enforced two ways: (1) grant is `select, insert` only for `authenticated`; (2) only SELECT + INSERT policies exist — no UPDATE/DELETE policy.

**schema_migrations** — `version text pk`, `applied_at`. RLS-enabled, all privileges revoked from `authenticated`.

## RLS policies

Helper functions (`security definer`, `search_path=public`): `app.user_role()`, `app.user_firm_id()`, `app.user_company_id()` read the caller's `profiles` row without recursing into profiles' RLS.

- **RLS enabled on every table** (deny-by-default). `service_role` bypasses RLS (used by server functions/edge).
- **Methodology tables** (`rubric_versions`, `dimensions`, `questions`, `sub_scores`, `gap_definitions`, `playbooks`, `playbook_task_templates`, `gap_playbook_map`, `content_modules`, `gap_content_map`): `select using(true)` for `authenticated`; writes via `service_role` only. *(This world-readability is what lets the browser Workbench score client-side.)*
- **firms**: member read `id = app.user_firm_id()`.
- **profiles**: own-row read; advisors read profiles in their firm.
- **Advisor firm-scoped `for all`** (`app.user_role()='advisor' and firm_id=app.user_firm_id()`, with matching `with check`): `companies`, `engagements`, `assessments`, `gaps`, `tasks`, `generated_documents`, `engagement_outcomes`.
- **Tables without `firm_id`** scope through their assessment via `exists(... assessments a where a.id=assessment_id and a.firm_id=app.user_firm_id())`: `answers`, `sub_score_results`, `dimension_scores`.
- **outcome_events**: advisor firm-scoped SELECT + INSERT only (append-only).
- **Owner (read-only)**: `companies`/`engagements` for own company; `assessments` only where `status='completed'`; `dimension_scores`/`sub_score_results` for completed assessments of own company; `gaps`/`tasks` for own engagements; `generated_documents` only `doc_type='owner_report'`.

RLS behavior was executed and verified — see `scripts/rls-test.ts`: **16/16 assertions pass** (cross-firm read denial, cross-firm write denial, owner sees only completed assessments, owner cannot write, outcome_events append-only update/delete blocked, unauthenticated sees nothing).

---

## Commentary: fit to the engagement-centric spine

Target spine: **firm → advisor → client → engagement → assessment versions → outcomes**.

### Where the schema matches the spine (nearly everywhere)

- **firm → advisor**: `firms` + `profiles(role, firm_id)`. ✅
- **advisor → client**: `companies(firm_id)` is the client; `engagements.advisor_id → profiles`. ✅ (naming: the spine's "client" = `companies` here.)
- **client → engagement**: `engagements(firm_id, company_id)` as an explicit first-class table — engagement is genuinely the unit, not an afterthought. ✅
- **engagement → assessment versions**: `assessments(engagement_id, sequence_number)`, immutable, unique-sequenced, rubric-pinned, with a supersede lineage and an `active_assessments` view for longitudinal reads. This is the strongest part of the model. ✅✅
- **assessment → outcomes**: `engagement_outcomes` + append-only `outcome_events` keyed on engagement. ✅
- **Deltas** are first-class (computed via `compareAssessments`, cross-rubric-version guarded). ✅
- **Tenancy**: `firm_id` on every domain table + RLS, verified isolating. ✅

This repo does **not** need a migration to reach the spine — it already implements it. That is the headline schema finding.

### Where it deviates / soft spots

1. **"client" is `companies`, and the UI assumes one engagement per company.** The schema permits many engagements per company, but `ClientsPage.tsx` does `engagements.find(e => e.company_id === c.id)` — surfacing only the first. A true multi-engagement client (re-engagement after a prior exit, multiple entities) works at the data layer but needs UI work. No schema change required.
2. **`tasks` / roadmap exist as tables but are inert.** Nothing populates `tasks`; `gap_playbook_map` + `playbook_task_templates` are reference data with no instantiation step. The **WM dual-milestone roadmap** (business + personal, advisor-entered) has no table at all — `tasks` is gap-derived and single-track, and milestones are a different concept (advisor-entered target states, not remediation tasks). This is a **schema addition**, not a migration of existing data.
3. **No branding/theme-per-firm columns.** `firms` has `name, status` only. The **WM branded delta report** needs firm branding (logo, colors, disclosure text) — a `firms`-column or `firm_branding` addition.
4. **No cadence/trigger or general activity-log tables.** `outcome_events` is deal-outcome-specific and advisor-append-only. The **WM cadence event triggers** and **engagement activity log** need either a generalization of `outcome_events` or new tables (`engagement_events` / `touch_cadence`). n8n endpoints to fire them are also absent.
5. **`playbooks`/`content_modules` are not rubric-versioned** (they key by `code`/`version` independently, not FK to `rubric_versions`), unlike dimensions/questions/sub_scores/gaps. Minor inconsistency; playbook/content evolution isn't pinned to a rubric version.

### What a migration to fully support the WM layer would require

All **additive** (no restructuring of the spine):
- `firm_branding` (or columns on `firms`): logo, palette, disclosures — for branded reports.
- `roadmap_milestones` (engagement_id, track ∈ {business, personal}, title, target_state, target_date, status, entered_by) — dual-milestone roadmap.
- Generalize event capture: either extend `outcome_events`/add `engagement_events` (event_type, occurred_at, actor, payload) for the activity log, plus a `touch_cadence` / trigger-rules concept for cadence.
- n8n webhook endpoints (application layer, not schema).
- Optionally FK `playbooks`/`content_modules` to `rubric_versions` for methodology-version consistency.

Net: the hard part (immutable versioned engagement spine + tenancy + outcomes) is done and verified; the WM layer is a set of additive tables + application code on top of a sound base.

---

## 3. Architecture Decisions

# Architecture Decisions — Assessment Platform Repo

Every silent (and explicit) architectural decision this prototype has baked in, stated plainly. For each: **what it is · where it lives · help or constraint for the engagement-centric, WM-extended target · estimated cost to reverse.** Costs are relative engineering effort, not calendar time.

Note: unusually, many of these are *not* silent — `docs/06-decisions.md` logs ~30 dated decisions. That log is itself an asset (it de-risks the survivor decision). Decisions below that are undocumented/implicit are flagged **[IMPLICIT]**.

---

### 1. Scoring is a pure function, fully decoupled from persistence
- **What:** `scoreFromAnswers(rubric, answers)` in `shared/scoring/engine.ts` takes plain data and returns plain data. No DB, no framework, no LLM. The DB (`server/scoring.ts`) and the browser (`src/lib/scoringClient.ts`) are thin adapters that load a rubric into the same shape and call the same function.
- **Where:** `shared/scoring/engine.ts`, `shared/scoring/types.ts`, `shared/rubric-seed.ts`.
- **Help/constrain:** Strong help. The single most portable asset in the repo — extractable to any codebase with zero persistence entanglement. Enables the client-side Workbench for free.
- **Reverse cost:** N/A (this is the good direction). Extraction cost ≈ trivial.

### 2. Scores are stored *and* recomputable, and must be byte-identical
- **What:** `scoreAssessment` persists `sub_score_results`, `dimension_scores`, and `assessments.drs_score/tier/ori_score`. But `compareAssessments` and `explainAssessment` **recompute from stored answers** rather than trusting stored scores, relying on determinism. Fixtures lock outputs byte-for-byte.
- **Where:** `server/scoring.ts`, `tests/engine.test.ts`, `seed/fixtures/*`.
- **Help/constrain:** Help. Stored scores make dashboards cheap; recomputation guarantees the explain/delta detail always matches. The byte-identical contract is a hard constraint any survivor must honor (it protects methodology credibility).
- **Reverse cost:** Low to change storage strategy; **prohibitively high** to change the numbers (would invalidate fixtures and all prior assessments).

### 3. Python round-half-even replicated exactly in TS (`pyRound`)
- **What:** A BigInt implementation reproducing Python's `round()` on the exact binary double, because the reference scorer used Python `round` and fixture-3 ORI 40.25→40.2 is irreproducible with JS `Math.round`.
- **Where:** `engine.ts` `pyRound()`; logged 2026-07-07.
- **Help/constrain:** Help, but a subtle trap: any port to another language must replicate this exact rounding or fixtures break. Well-commented, so the trap is signposted.
- **Reverse cost:** N/A; must be preserved.

### 4. Rubric lives in data (DB rows), seeded from `/seed`; methodology change = new `rubric_version`
- **What:** Dimensions, questions, sub-scores, weights, bands, gap triggers are rows; the engine reads them. No per-dimension logic in code. Assessments pin a `rubric_version_id`.
- **Where:** `seed/*.csv`, `supabase/migrations/...schema.sql`, `shared/rubric-seed.ts`.
- **Help/constrain:** Strong help. Methodology can evolve without code changes; old assessments stay comparable to their version; cross-version deltas are explicitly guarded.
- **Reverse cost:** N/A (target-aligned).

### 5. `/seed` (from `reference_scorer.py`) is canonical methodology, not placeholder
- **What:** The seed CSVs/playbooks are generated by the reference scorer and treated as the real Blueprint II methodology. 54 questions / 32 sub-scores / 24 gaps / 13 playbooks / 12 content modules.
- **Where:** `seed/`, `seed/fixtures/reference_scorer.py`.
- **Help/constrain:** Help. This is domain IP, not scaffolding — a major reason to weight this repo heavily as donor-or-survivor.
- **Reverse cost:** N/A.

### 6. Tenant isolation enforced in Postgres RLS, not application code
- **What:** Every table has RLS; advisor scoped to `firm_id`, owner to their company, methodology world-readable. The app trusts the DB as the security boundary; server functions use `service_role` to bypass only after RLS-authorizing the caller.
- **Where:** `20260707000200_rls.sql`, `dev/supabase-dev-server.ts` (`asUser` sets role + JWT claims per request).
- **Help/constrain:** Strong help. Isolation is verified (16/16 `test:rls`) and can't be bypassed by forgetting a `WHERE firm_id=` in app code. Constraint: ties the platform to Postgres/Supabase RLS semantics; a non-Postgres backend would lose this for free.
- **Reverse cost:** High to move off (would require re-implementing isolation in app middleware); low to extend (add policies for new tables).

### 7. Coupling to Supabase as the whole backend (Auth + PostgREST + RLS + Storage + Edge)
- **What:** The frontend talks supabase-js directly to PostgREST for CRUD, uses Supabase Auth, and calls `functions.invoke` for the 3 server functions. There is **no custom API/backend server** — business logic lives in RLS + 3 functions + client code.
- **Where:** `src/lib/supabase.ts`, all pages, `dev/supabase-dev-server.ts`.
- **Help/constrain:** Mixed. Help: minimal infra, fast. Constraint: business rules that don't fit RLS/PostgREST (e.g. n8n webhooks, cadence triggers, branded PDF rendering, the WM roadmap workflow) have **nowhere natural to live** — the repo has no general server tier. This is the biggest architectural gap for the WM layer.
- **Reverse cost:** Medium-High. Adding a real server tier (or many edge functions) is net-new infrastructure, though the pure engine and pure narrative service drop into one cleanly.

### 8. The production function tier is not actually deployed in-repo **[IMPLICIT]**
- **What:** `server/scoring.ts` / `server/narrative.ts` are invoked by the **dev emulator** (`dev/supabase-dev-server.ts`). There are no checked-in Supabase Edge Function entrypoints (no `supabase/functions/*`). Production deployment of `score-assessment` etc. is assumed, not present.
- **Where:** absence in `supabase/`; present only in `dev/`.
- **Help/constrain:** Constraint. "It works" today depends on the Vite dev middleware. A real deploy needs edge-function wrappers written. The logic is done; the deployment shell isn't.
- **Reverse cost:** Low-Medium (wrap 3 functions), but it *is* unbuilt work.

### 9. Isomorphic scoring — the engine runs in the browser
- **What:** The Workbench scores live client-side via `explainFromAnswers`, byte-identical to the server, no round-trip. Enabled by `methodology_read` making rubric tables world-readable to authenticated users.
- **Where:** `src/lib/scoringClient.ts`, `WorkbenchPage.tsx`.
- **Help/constrain:** Help for UX (instant what-if). Mild constraint: the rubric (methodology IP) is fully readable by any authenticated user; acceptable within a firm, but note it's not secret. The WM branded/interactive delta report benefits directly from this pattern.
- **Reverse cost:** Low (could move server-side).

### 10. Immutability via supersede, never in-place edit
- **What:** Completed assessments are immutable; corrections create a new scored assessment and mark the old `record_status='superseded'` with linkage + reason. `active_assessments` view is the only longitudinal read path.
- **Where:** `server/scoring.ts` `supersedeAssessment`, `20260707010100_...sql`.
- **Help/constrain:** Strong help — exactly the "supersede-based corrections" the target requires. Constraint (intentional): every read path must go through `active_assessments` or risk showing superseded rows; this discipline is documented but must be maintained.
- **Reverse cost:** N/A (target-aligned).

### 11. Deltas computed, never stored; cross-rubric-version comparison refuses to return a number
- **What:** `compareAssessments` recomputes both snapshots and diffs them; if rubric versions differ it returns `{comparable:false, reason:'rubric_version_mismatch'}`.
- **Where:** `server/scoring.ts`, tested in `tests/supersede-compare.test.ts`.
- **Help/constrain:** Strong help for the WM branded **delta report** — the delta primitive (sub-score, dimension, gaps opened/resolved) already exists and is honest about version boundaries.
- **Reverse cost:** N/A.

### 12. Two score groups (DRS vs ORI) never blended
- **What:** DRS = weighted business dims only; ORI = weighted owner sub-scores, computed separately. The UI shows them side-by-side with a divergence callout rather than a blended number (CLAUDE.md rule 3a).
- **Where:** `engine.ts`, `ResultsPage.tsx`, `WorkbenchPage.tsx`.
- **Help/constrain:** Help. The WM "dual milestone (business + personal)" framing maps directly onto the existing business/owner split.
- **Reverse cost:** Low to add a blended number (but forbidden without Matthew's ratification).

### 13. AI is narrative-only, with a deterministic fallback and a numeral firewall
- **What:** Claude writes prose *from* a structured payload; a strict `numeralPostCheck` rejects any number not present in the payload (regenerate once, then fail). If no API key, a rule-based `composeOwnerReport` produces the report from the same explain trace. Model label stored on each doc.
- **Where:** `server/narrative.ts`, `prompts/owner_report.v1.md`.
- **Help/constrain:** Strong help. Reports always generate (demos, keyless envs); no hallucinated numbers can reach a client. Directly reusable for WM branded reports. Constraint: only `owner_report` implemented; `advisor_brief`/`engagement_summary` throw.
- **Reverse cost:** Low to extend (add doc types + prompts).

### 14. Dev emulator + Postgres shim to run without Docker/Supabase **[partly IMPLICIT]**
- **What:** `db/supabase-shim.sql` fakes the `auth` schema/roles/`auth.uid()` on plain Postgres; `dev/supabase-dev-server.ts` emulates auth/rest/functions with real RLS per request. Lets the whole app + CI run on a bare Postgres.
- **Where:** `db/`, `dev/`, `scripts/migrate.ts`, `scripts/devdb.sh`.
- **Help/constrain:** Help for portability/CI (this audit ran the full stack with zero Docker). Constraint: two code paths (real vs emulated) to keep in sync; the emulator is a hand-rolled PostgREST subset that could drift from real PostgREST behavior.
- **Reverse cost:** Low (dev-only; deletable if a real stack is always available).

### 15. Frontend: React + Vite, hooks/context only, per-page fetching, no data cache **[IMPLICIT]**
- **What:** No Redux/Zustand/React-Query. Each page fetches its own data with supabase-js on mount; auth/theme via context. Custom minimal markdown renderer instead of a dependency.
- **Where:** `src/pages/*`, `src/lib/auth.tsx`, `src/lib/theme.tsx`.
- **Help/constrain:** Help for a prototype (simple, readable, boring — as CLAUDE.md asks). Constraint at scale: no shared cache means refetch-on-navigate and some duplicated query logic; the WM layer's richer client views may want a data layer.
- **Reverse cost:** Low-Medium (add React-Query incrementally; no architectural blocker).

### 16. One-engagement-per-company assumption in the UI **[IMPLICIT]**
- **What:** `ClientsPage` surfaces only the first engagement per company (`engagements.find(...)`). Schema allows many.
- **Where:** `src/pages/ClientsPage.tsx`.
- **Help/constrain:** Constraint (UI-only). The engagement-centric model is honored in data but under-exposed in UI.
- **Reverse cost:** Low (UI change; schema already supports it).

### 17. `tasks` table + playbook templates exist but are never instantiated **[IMPLICIT]**
- **What:** Firing a gap does not create tasks; `gap_playbook_map`/`playbook_task_templates` are inert reference data. No roadmap generation.
- **Where:** absence in `server/`/`src/`; tables in schema.
- **Help/constrain:** Constraint. The remediation-roadmap loop (a core product promise and a WM requirement) is unbuilt below the data layer. The WM dual-track (advisor-entered) roadmap is a different shape than gap-derived tasks and has no table at all.
- **Reverse cost:** Medium (net-new feature: generation logic + roadmap milestone tables + UI).

### 18. Outcome capture is advisor-append-only and deal-specific **[partly explicit]**
- **What:** `outcome_events` is grant-and-policy append-only (no UPDATE/DELETE for advisors), scoped to deal-process events.
- **Where:** `20260707010000_outcome_capture.sql`.
- **Help/constrain:** Help (immutable moat dataset, mirrors assessment immutability). Constraint for WM: it is *not* a general activity/touch log — the WM engagement-activity-log and cadence triggers need a broader event model or a sibling table.
- **Reverse cost:** Medium (generalize events or add a parallel activity table + n8n triggers).

### 19. Secrets: `ANTHROPIC_API_KEY` server-only; anon/service split honored **[explicit]**
- **What:** Claude key read only from server env, never bundled; browser gets anon key + RLS; server functions use service role.
- **Where:** `server/narrative.ts`, `src/lib/supabase.ts`, `.env.example`.
- **Help/constrain:** Help. Correct secret hygiene from day one.
- **Reverse cost:** N/A.

---

## Summary of the constraint surface

The **decisions that help the target architecture** dominate: pure decoupled engine, rubric-as-data, RLS tenancy, immutable versioned engagement spine, computed deltas, two-group scoring, AI-narrative firewall. These are precisely the target's hard requirements, already built and tested.

The **decisions that constrain** are concentrated in the **application/operational tier, not the core**: no general server layer (Supabase-only), production edge functions unbuilt, tasks/roadmap inert, no cadence/branding/activity-log tables, one-engagement-per-company UI. None of these require *undoing* a baked-in decision — they are additive. The only genuinely expensive-to-reverse decisions (byte-identical scoring, pyRound, RLS-as-boundary) are ones you would *want* to keep.

---

## 4. Survivor Assessment

# Survivor Assessment — Assessment Platform Repo

**Position, stated up front:** This repo should be the **survivor**. It already implements the two things that are hardest to build and most dangerous to get wrong — a verified, byte-identical deterministic scoring engine and a correct immutable, versioned, multi-tenant engagement spine — and it implements them at production-leaning quality with a real test suite and CI. The dashboard/infrastructure repo is far more likely to hold portable *presentation and ops* pieces (dashboards, deploy config, richer UI shell) than to hold anything as load-bearing or as risky-to-recreate as what lives here. Port the dashboard repo's strengths *into* this base; do not rebuild this core inside the dashboard repo.

This position assumes the second repo is roughly what its description implies (dashboard + software infrastructure). If that repo turns out to also contain a second, divergent scoring implementation or its own engagement schema, that changes the merge mechanics but not this recommendation: **there must be exactly one scoring engine and one engagement schema, and they should be the ones already proven here.**

---

## Case FOR this repo as survivor (strongest arguments)

1. **The scoring engine is correct, verified, and the irreplaceable asset — and it's here.** All three fixtures pass **byte-identical** (verified by actual run: 82.6 / 16.1 / 52.0, and the Python reference matches the stored fixtures exactly). 32 sub-scores, 6-dimension weighting, tiers, ORI, 24 gap triggers, explain trace — all implemented and locked by 22 engine tests. Recreating this elsewhere risks silently changing a number, which destroys advisor credibility. The methodology IP (`reference_scorer.py` + seed) lives here too.

2. **The engagement-centric spine is already built — not a migration target, a fact.** Immutable, rubric-pinned assessments; `sequence_number` versioning; supersede-with-lineage corrections; `active_assessments` read path; computed cross-version deltas with an explicit incomparable marker; append-only outcome capture. These are the target's architectural *requirements*, and they exist and are tested.

3. **Multi-tenancy is enforced at the database and proven.** RLS on every table, `firm_id` spine, 16/16 isolation assertions passing against a live DB (cross-firm read+write denied, owner read-only + completed-only, append-only outcomes, unauthenticated = nothing). Retrofitting tenancy is the classic high-risk rework; here it's done.

4. **Engineering discipline is unusually high for a prototype.** A thorough CI (fresh DB → migrate → RLS → double-seed idempotency → demo seed self-validated against the reference → tests → build), 40 passing tests, a ~30-entry dated decision log, clean separation of pure/adapter code, correct secret hygiene, and a dev stack that runs with no Docker. This is a base you can build on, not clean up.

5. **The WM layer's hard primitives already exist.** Cross-version deltas (for the branded delta report), the business/owner split (for dual milestones), append-only events (a starting point for the activity log), and an isomorphic engine + narrative firewall (for interactive/branded reports) are all present. The WM work is additive on a sound base.

## Case AGAINST this repo as survivor (strongest arguments)

1. **No general server tier — only Supabase + 3 functions.** Anything that doesn't fit RLS/PostgREST (n8n webhooks, cadence triggers, branded PDF rendering, roadmap workflow) has nowhere natural to live. If the dashboard repo already has a real backend, that's a genuine point in its favor and this is net-new here.

2. **The production function tier isn't actually deployed in-repo.** `score/explain/generate` run via the Vite **dev emulator**; there are no checked-in edge-function entrypoints. Today's "it works" leans on dev middleware. Real deployment is unbuilt (small, but real).

3. **The product loop past scoring is thin.** Tasks/roadmap are inert (tables + templates, zero instantiation), content drip is unbuilt, the owner portal is RLS-only with no pages, and two of three document types throw "not implemented." If the dashboard repo has a mature task/roadmap/dashboard experience, this repo trails badly on that surface.

4. **Frontend is capable but prototype-tier at scale.** Per-page fetching, no data cache, one-engagement-per-company UI assumption. Fine now; the WM client experience will want more.

5. **Heavy coupling to Supabase specifics.** RLS-as-boundary and the emulator/shim tie the platform to Postgres/Supabase. If the org's infra direction (possibly embodied in the dashboard repo) is different, there's friction.

## What must be ported IN if this repo wins (likely from the dashboard repo)

- **A real server/backend tier** (or the pattern for one) to host n8n webhooks, cadence triggers, PDF/report rendering, and the WM roadmap workflow — the biggest structural gap here.
- **Deployed function/edge wrappers and deploy/IaC config** — CI here is strong but there's no evidence of production deployment plumbing.
- **A mature dashboard / advisor-portfolio experience** — cross-engagement views, task/roadmap boards, richer visualizations (this repo has one inline trajectory chart and per-assessment pages only).
- **Owner-portal UI** — the role is fully modeled in RLS but has no pages.
- **Notification/email infrastructure** and any content-drip delivery.
- Possibly a **front-end data/state layer** (caching, shared queries) if the dashboard repo has one worth keeping.

## What must be ported OUT if this repo loses (the irreplaceable pieces)

The extraction is **clean**, because the core was deliberately decoupled. In order of importance:

1. **The scoring engine (`shared/scoring/*`) + rubric parser (`shared/rubric-seed.ts`).** Pure functions of `(rubric, answers)` — **zero persistence or framework entanglement.** Lift the directory as-is. *One landmine to carry with it:* `pyRound` must be preserved exactly, or fixtures break.
2. **The fixtures + reference scorer (`seed/fixtures/*`, `reference_scorer.py`) and the full `/seed` methodology.** These are the regression guard and the domain IP. Non-negotiable; must remain byte-identical in the survivor.
3. **The engine test suite (`tests/engine.test.ts`, `tests/helpers.ts`).** The byte-identical contract, portable with the engine.
4. **The narrative service (`server/narrative.ts`) + prompt + interpretation layer (`shared/scoring/interpret.ts`).** The deterministic composer and numeral firewall are near-standalone (depend only on the explain trace + a `pg` client for I/O). Extract with light rewiring.
5. **The schema + RLS migrations and the server scoring adapter (`server/scoring.ts`).** More entangled (Postgres/Supabase-specific) but the *design* — immutable supersede spine, `active_assessments`, compare/delta semantics — is the reference even if re-expressed on another backend.

**Entanglement verdict:** the engine and fixtures are **fully decoupled** (trivial extraction). The persistence layer is **appropriately coupled to Postgres/RLS** — portable as a design, moderate to re-host on a different backend. Nothing critical is tangled into React or Vite.

---

## Readiness for the WM strategic layer

| WM capability | Rating | Why (one sentence) |
|---|---|---|
| **Branded client-facing delta report** | **NEEDS SCHEMA CHANGE** | The delta engine, narrative service, numeral firewall, and finalize/print path all exist and are reusable; only firm-branding fields (logo/palette/disclosures on `firms` or a `firm_branding` table) plus a branded template are missing. |
| **Dual-milestone roadmap (business + personal, advisor-entered)** | **NEEDS SCHEMA CHANGE** | The business/owner score split maps cleanly onto dual tracks, but advisor-entered milestones are a different shape than gap-derived `tasks` (which are also never instantiated) and require a new `roadmap_milestones` table + UI — no rearchitecture, just additive tables and CRUD. |
| **Touch-cadence event triggers** | **NEEDS REARCHITECTURE** | There is no general server tier and no n8n endpoints; `outcome_events` is deal-specific and advisor-append-only, so cadence rules + scheduled triggers need both a new event/trigger model and the missing backend surface to run them. |
| **Engagement activity log** | **NEEDS SCHEMA CHANGE** | Append-only immutable event capture is already an established, tested pattern (`outcome_events`); a general `engagement_events` table generalizing it (event_type, actor, occurred_at, payload) plus write-throughs from existing flows gets there without rearchitecture. |

**Overall WM readiness:** three of four are additive schema+UI on primitives that already exist; only cadence triggers need net-new infrastructure (a general server tier + scheduler/n8n), which is the same gap identified in the case-against. That single infrastructure investment unblocks the hardest WM item and should be the first thing ported in from the dashboard repo (if it has one) or built.
