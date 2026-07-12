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
