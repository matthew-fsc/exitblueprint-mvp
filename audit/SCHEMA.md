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
