# 37 - Plans — reusable initiative bundles (feature reference)

> **Status: Reference — SHIPPED.** Slices PL1–PL4 (schema+seed → authoring → apply →
> tracking/reconcile), the owner "Your plan" view (Q3), and score-suggested
> recommendation (Q5) all shipped 2026-07-21 (decisions log; commit "Production
> hardening + complete Plans feature"). All seven §6 product decisions were resolved
> by Matthew; the term is **"Plan"**. This doc is the durable design record *and* the
> as-built reference — the section bodies describe the shipped system; the phased
> slice plan (§7) is kept for provenance. When this doc and `CLAUDE.md` disagree,
> `CLAUDE.md` wins.
>
> **As built — where the code lives:**
> | Concern | Where |
> | --- | --- |
> | Schema (4 tables + 2 annotation cols) | `supabase/migrations/20260721000100_plans.sql`, `…000200_plan_lineage.sql`, `…000300_task_completed_at.sql` |
> | Server (author · apply · reconcile · recommend) | `server/plans.ts`; registry entries in `server/registry.ts` (engine `workflow`) |
> | System-Plan seed | `server/seed-methodology.ts` |
> | Advisor UI | `src/pages/PlansPage.tsx`, hooks in `src/lib/queries.ts` |
> | Owner UI | `src/pages/owner/OwnerPlanPage.tsx` |
> | Tests | `tests/plans.test.ts`, `tests/seed-plans.test.ts`, `scripts/rls-test.ts` |
>
> Read alongside `docs/02-data-model.md` (Plans tables), `docs/17`/`docs/19`
> (work streams), and `docs/27-engineering-patterns.md`.

## 0. The problem this solves

Today a remediation roadmap is assembled **bottom-up and gap-driven**: an
assessment opens `gaps`, `gap_playbook_map` maps each gap to a playbook, and
`server/roadmap.ts` copies that playbook's `playbook_task_templates` into `tasks`.
There is no way for an advisor to say *"apply my standard **Phase-1 Financial
Cleanup** package to this client"* — a named, curated bundle of playbooks + tasks +
education + milestones — as a coherent unit, track it as a unit, and reuse it across
clients. Advisors think in these packages (CEPA "90-day sprints", a firm's
signature engagement structure); the product has no first-class object for them.

This doc proposes that object. It is **prescription, not scoring** — it never
touches assessments, dimensions, sub-scores, or gaps as *writes* (rule 1), and it
needs **no new `rubric_version`**.

---

## 1. Concept & terminology

### 1.1 Reconciling program / plan / runbook → **Plan**

The three words in the request name the same thing. This doc recommends **"Plan"**
as the single product term, for concrete, code-grounded reasons:

- **"Program" is already taken.** Every seeded playbook is *titled* a "Program":
  `seed/playbooks/PB-ADDBACK-DOC.md` → "Addback Documentation Program",
  `PB-CLEAN-BOOKS.md` → "Clean Books Program". Introducing a **new** primitive also
  called "Program" would collide with the human name of the **existing** playbook
  primitive and confuse advisors and code alike.
- **"Runbook" is already taken** as a doc Status label and names our ops procedures
  (`docs/29`, `docs/30` are "Runbook"s). It also carries an ops/incident
  connotation that is wrong for a client engagement plan.
- **"Plan" is free and on-methodology.** CEPA's Discover gate produces a
  *"prioritized action plan"* (docs/19 §3); "apply a Plan to this engagement" reads
  naturally and does not overload an existing noun.

The rest of this doc uses **Plan** (template) and **Applied Plan** (the per-engagement
instance). The final term is an open question for Matthew (§6-Q1) — if he prefers
"Program", the seeded-playbook titles should be renamed in the same pass to avoid the
collision.

### 1.2 What a Plan **is** — a grouping layer, not a new scoring or content primitive

A **Plan is a curated, reusable, versioned bundle of *references* to existing
primitives**, plus a little inline content of its own. It is a **composition layer**,
not a new content type. A Plan item points at one of:

| Plan item kind | References existing table | What it contributes when applied |
| --- | --- | --- |
| `playbook` | `playbooks` (+ its `playbook_task_templates`) | Instantiates the playbook's tasks into `tasks` |
| `education` | `content_modules` / `advisory_library_items` (education) | Assigns/recommends the module to the engagement |
| `advisory` | `advisory_library_items` (buyer_question / initiative / risk_flag) | Surfaces the item as part of the plan's coaching set |
| `milestone` | *(inline)* → creates a `roadmap_milestones` row | A target state on the business or personal track |
| `manual_task` | *(inline)* → creates a `tasks` row | A one-off task not tied to a playbook |

This is deliberately **the same "bundle of references" shape** the codebase already
uses for `gap_playbook_map` and `gap_content_map` — but curated *by an advisor into a
named package* instead of derived from a gap. A Plan is **prescription authored
top-down**; the gap-driven roadmap is **prescription derived bottom-up**. They target
the *same* execution tables (`tasks`, `roadmap_milestones`), which is the point.

### 1.3 How a Plan differs from a playbook and from the generated roadmap

- **Playbook** = *one* remediation recipe for *one* problem (e.g. "Clean Books"),
  global methodology, with its own `playbook_task_templates`. A Plan **contains**
  playbooks; it is a level up.
- **Generated roadmap** = the current `tasks` set for an engagement, today produced
  *only* by the gap-driven path (`server/roadmap.ts`). A Plan is an **additional,
  advisor-chosen source** of the same `tasks`/`roadmap_milestones` rows. After this
  feature, an engagement's roadmap has two provenance streams — *gap-derived* and
  *plan-applied* — living in the same tables, distinguished by annotation columns.

### 1.4 One interaction the existing code forces us to resolve (important)

`server/roadmap.ts` is **idempotent per engagement on `(playbook_id, sequence)`** —
it will not create a second copy of a playbook's tasks it has already created,
*regardless of what triggered them*. Therefore a playbook must **instantiate once per
engagement**, and both the gap path and the plan path must respect the same
idempotency key. The recommended rule:

> A playbook's task rows exist **at most once per engagement**. `gap_id` and
> `engagement_plan_id` on those rows are **annotations of provenance**, not
> multipliers. If a plan applies a playbook that a gap already instantiated (or vice
> versa), the existing task rows are **claimed/tagged**, not duplicated.

This keeps the roadmap board honest (no double tasks) and means the plan-apply
function is a thin extension of the existing instantiation logic, not a parallel copy.

---

## 2. Data-model proposal

Four new tables — two **template** (reusable), two **instance** (applied) — plus two
additive annotation columns on existing execution tables. All follow the house
skeleton in `templates/migration.sql` and the **global-vs-tenant** RLS pattern
already proven in `advisory_library_items`
(`supabase/migrations/20260712000200_advisory_library.sql`).

> **Table naming (shipped in `20260721000100_plans.sql`).** The product term is
> "Plan", but the table name `plans` is **already taken** by the Stripe billing
> tier catalog (`20260719000200_billing.sql`, referenced by a `firm_subscriptions`
> FK). So the reusable template table is **`plan_templates`** and its rows table is
> **`plan_template_items`**; the applied instance is **`engagement_plans`** /
> **`engagement_plan_items`** (no collision). The instance FK to the template is
> `plan_template_id`. The tables below use these shipped names.

### 2.1 Templates (reusable, versioned)

**`plan_templates`** — the Plan header (the reusable template).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid pk | |
| `created_at` | timestamptz | |
| `firm_id` | uuid **null** refs firms | **null = system/seed methodology Plan**; set = firm-authored. Mirrors `advisory_library_items.firm_id`. |
| `source` | enum(`system`,`advisor`) | records provenance, like `advisory_source` |
| `code` | text null | stable code for system Plans (idempotent re-seed); null for firm-authored |
| `name` | text not null | e.g. "Phase 1 Risk Elimination" |
| `summary` | text | |
| `plan_version` | int not null default 1 | **versioning (rule 6), mirrors `playbooks.version`** |
| `status` | enum(`draft`,`active`,`retired`) | mirrors `agreement_versions.status` |
| `created_by` | uuid refs profiles | |
| | | `unique (code, plan_version) where firm_id is null` (system-row idempotency, exactly like `playbooks unique(code,version)` + the advisory system-code partial index) |

**`plan_template_items`** — the ordered contents of a Plan.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid pk | |
| `created_at` | timestamptz | |
| `firm_id` | uuid **null** refs firms | mirrors parent `plans.firm_id` (null for system) — carried so RLS is a plain firm predicate, not a join |
| `plan_template_id` | uuid not null refs plan_templates | |
| `item_kind` | enum(`playbook`,`education`,`advisory`,`milestone`,`manual_task`) | |
| `playbook_id` | uuid null refs playbooks | set when `item_kind='playbook'` |
| `content_module_id` | uuid null refs content_modules | set for `education` |
| `advisory_library_item_id` | uuid null refs advisory_library_items | set for `education`/`advisory` |
| `title`,`description` | text | inline copy for `milestone`/`manual_task` |
| `owner_role` | task_owner_role null | inline, for `manual_task` |
| `track` | milestone_track null | inline, for `milestone` (business\|personal) |
| `target_offset_days` | int null | inline, for `manual_task`/`milestone` due-date anchoring — same semantic as `playbook_task_templates.target_offset_days` |
| `sort_order` | int not null default 0 | |

A `check` constraint enforces the right reference column is populated per `item_kind`
(the same discipline `advisory_library_items` uses for its typed columns).

### 2.2 Instances (immutable application record)

Applying a Plan to an engagement creates an **Applied Plan** — the immutable record
of *"we applied Plan X, version N, on date D"* — and materializes its items into the
**existing** `tasks` and `roadmap_milestones` tables. The Applied Plan mirrors the
`assessments`-pins-`rubric_version` pattern (rule 4): the instance records the exact
template version in force, and is never rewritten when the template later changes.

**`engagement_plans`** — the applied-plan header (the instance).

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid pk | |
| `created_at` | timestamptz | |
| `firm_id` | uuid not null refs firms | standard firm scope |
| `engagement_id` | uuid not null refs engagements | |
| `plan_template_id` | uuid not null refs plan_templates | the source template |
| `applied_plan_version` | int not null | **the template version in force at apply time — the immutability/versioning pin, exactly like `assessments.rubric_version_id`** |
| `name` | text not null | **snapshot** of the Plan name at apply time (so later template renames don't rewrite history) |
| `anchor_date` | date | forward-lays task/milestone due dates, mirroring `instantiateTasksForGaps(anchorDate)` |
| `applied_by` | uuid refs profiles | |
| `applied_at` | timestamptz not null default now() | |
| `status` | enum(`active`,`completed`,`removed`) | soft lifecycle of the applied plan |

**`engagement_plan_items`** — the immutable snapshot of what was applied, with
pointers to the concrete execution rows it produced.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid pk | |
| `created_at` | timestamptz | |
| `firm_id` | uuid not null refs firms | |
| `engagement_plan_id` | uuid not null refs engagement_plans | |
| `source_plan_template_item_id` | uuid null refs plan_template_items | template lineage (null-safe if template item later deleted) |
| `item_kind` | enum(as above) | snapshotted, not joined, so history survives template edits |
| `task_id` | uuid null refs tasks | the concrete task this item produced/claimed |
| `milestone_id` | uuid null refs roadmap_milestones | the concrete milestone produced |
| `content_module_id` / `advisory_library_item_id` | uuid null | the referenced content/advisory item |
| `status` | text | derived/rolled-up progress convenience |

**Two additive annotation columns on existing tables** (nullable, backward-compatible):

- `tasks.engagement_plan_id uuid null references engagement_plans (id)`
- `roadmap_milestones.engagement_plan_id uuid null references engagement_plans (id)`

These let the existing roadmap board **group/filter by applied plan** without a
parallel task store, and encode the provenance annotation from §1.4. Progress for an
Applied Plan is **computed, not stored** (mirroring "score deltas are computed, not
stored", docs/02 rule 4): `count(done)/count(*)` over the tasks + milestones tagged
with that `engagement_plan_id`.

### 2.3 Apply semantics (the server function, not a schema concern)

A new server function `apply-plan` (engine `workflow`, scope `engagement`; pattern
per `docs/27` §2, registered in `server/registry.ts`) does, in one transaction:

1. Insert `engagement_plans` (snapshotting `name` + `applied_plan_version`).
2. For each `plan_item`:
   - `playbook` → run the **same** playbook→`tasks` instantiation the roadmap uses
     (extracted/shared with `server/roadmap.ts`), honoring the **once-per-engagement
     `(playbook_id, sequence)` idempotency** (§1.4); tag the resulting rows with
     `engagement_plan_id`; record an `engagement_plan_items` row pointing at them.
   - `manual_task` → insert a `tasks` row (`gap_id` null, `playbook_id` null,
     `engagement_plan_id` set).
   - `milestone` → insert a `roadmap_milestones` row tagged with `engagement_plan_id`.
   - `education`/`advisory` → record an `engagement_plan_items` row referencing the
     catalog item (no new task row; the advisory/education engines already surface it).

No assessment, gap, dimension, or sub-score row is written. Removing a Plan is a soft
`status='removed'` on `engagement_plans` (never a hard delete of client task history —
consistent with the engagement-lifecycle rules in docs/02; hard teardown remains
`delete-engagement`'s job).

### 2.4 RLS (firm isolation, rule 5)

- **Templates (`plan_templates`, `plan_template_items`)** — the exact `advisory_library_items` dual
  policy:
  - `system_read`: `for select to authenticated using (firm_id is null)` — everyone
    reads seeded methodology Plans; writes to system rows are **service_role only**
    (seed script), so firms **cannot edit** seeded Plans.
  - `advisor_all`: `for all to authenticated using (app.user_role() = 'advisor' and
    firm_id = app.user_firm_id())` — full CRUD on the firm's own Plans.
- **Instances (`engagement_plans`, `engagement_plan_items`)** — standard firm-scoped
  advisor-all block from `templates/migration.sql`. **Owner read policy is bespoke
  and gated on §6-Q3** — if Plans become owner-visible, mirror the
  `roadmap_milestones` `owner_engagement_read` policy one-for-one; default **staff-only**
  otherwise.
- The two new `engagement_plan_id` columns inherit their tables' existing policies —
  no policy change to `tasks`/`roadmap_milestones`.
- **Cross-firm reference guard:** a firm-authored `plan_item` may reference only
  **global** playbooks/content (`firm_id is null`) or **its own** firm's advisory
  items — never another firm's rows. Enforced by RLS on the referenced table at author
  time plus an `rls-test.ts` case (per `docs/27` §1 DoD).

---

## 3. Lifecycle / UX

### 3.1 Authoring (advisor, app-level Library)

Plan authoring lives with the other reusable methodology assets — the **Library**
cross-cutting surface (docs/17 IA table: "Library (Remediation content catalog)").
An advisor creates a Plan, gives it a name/summary, and adds items by picking from the
existing catalogs (playbooks, content modules, advisory items) or typing inline
milestones/manual tasks. Editing a used Plan creates a **new `plan_version`** (draft →
active); already-applied instances keep their pinned version. This is the
`agreement_versions` "new row, never edit" discipline applied to Plans.

### 3.2 Applying (advisor, on an engagement)

From the engagement's **Remediation** work stream (docs/17), an "Apply a Plan" action
lets the advisor pick a Plan (firm + system) and an anchor date, preview the items,
and apply. The tasks/milestones appear on the existing **Roadmap** board, now
groupable by "Applied plan: Phase 1 Risk Elimination" alongside the gap-derived tasks.

### 3.3 Tracking + "Needs attention"

Because plan-applied tasks are ordinary `tasks` rows, they already flow into the
existing progress + **stalled-task** surfacing (docs/05 S10 "stalled tasks";
docs/17 "Needs attention" worklist). An Applied Plan gets a computed progress
(`done/total` over its tagged rows). No new worklist engine — the applied plan is a
**lens/grouping** over rows the worklist already watches.

### 3.4 Where it sits in nav

- **Authoring** → app-level **Library** (cross-cutting, alongside Remediation content).
- **Applying + tracking** → engagement **Remediation** work stream, on/next to the
  **Roadmap** tab. A Plan is a Remediation-stream concept end-to-end — it never
  spreads across sibling tabs (docs/17 principle).

---

## 4. Non-negotiables compliance (`CLAUDE.md`)

| Rule | How this design complies |
| --- | --- |
| **1. Deterministic scoring** | Plans reference/produce **prescription** rows only (`tasks`, `roadmap_milestones`, catalog items). **No write** to `assessments`, `dimension_scores`, `sub_score_results`, `gaps`, or any scoring table. A Plan may *read* scores to recommend itself (future, optional) but never computes or adjusts one. **No LLM anywhere in the apply path.** |
| **2. AI is narrative-only** | Plans are authored and applied by **deterministic** advisor action. AI is not involved. (A future "draft a Plan summary from its items" would be narrative-only + labeled draft, like every other doc — out of scope here.) |
| **3 / 3a. Rubric lives in data; two score groups** | Plans add **no** dimension/question/sub-score/weight/band and **do not touch DRS or ORI**. They roll up nothing into either index. **No `rubric_version` change is required or implied.** |
| **4. Engagement is the unit; immutability** | `engagement_plans` is an **immutable application snapshot** pinned to `applied_plan_version` (mirroring `assessments`→`rubric_version_id`), with a snapshotted `name`. Editing a template = new `plan_version`; applied instances are never rewritten. Removal is soft (`status='removed'`), never a history-erasing mutation. |
| **5. Multi-tenant / RLS** | Every new table carries `firm_id`. Templates use the proven global-vs-tenant `advisory_library_items` policies; instances use the standard firm-scoped block. Cross-firm references are blocked by RLS on the referenced table + an `rls-test.ts` case. No cross-firm read, ever. |
| **6. Versioning** | `plan_version` on templates (mirrors `playbook_version`); `applied_plan_version` pins each instance. |
| **Seed = canonical methodology** | System Plans seed from `/seed` as methodology (idempotent upsert on `(code, plan_version)`), exactly like playbooks/rubric/advisory items — not placeholder. |

**Net:** this feature needs **zero new `rubric_version`** and touches **zero** scoring
logic. It is additive schema + one new server function + Library/Roadmap UI.

---

## 5. Seed vs firm-authored

**Both**, via the `firm_id`-null pattern already shipped for `advisory_library_items`
and `playbooks`:

- **System Plans (`firm_id null`, `source='system'`, coded).** A small set of
  canonical starter Plans seeded from `/seed` as methodology — e.g. **"Phase 1 Risk
  Elimination"** (bundles `PB-ADDBACK-DOC`, `PB-CLEAN-BOOKS`, key Phase-1 milestones),
  **"Owner-Dependence Reduction"** (`PB-OWNER-EXTRACT`, `PB-MGMT-DEPTH` + education),
  **"Customer Concentration"** (`PB-CUST-DIVERSIFY` + the `AL-BQ-CONC` buyer
  question). These compose only **global** playbooks/content, so they are safe to
  expose to every firm. Seeded idempotently, referential-integrity validated, like
  the rest of `/seed` (docs/02 §Seed data).
- **Firm-authored Plans (`firm_id` set, `source='advisor'`).** A firm curates its own
  signature packages, referencing global playbooks + its own advisory items.

**Multi-tenant implication:** firms **read but cannot edit** system Plans (service-role
writes only). To customize a seeded Plan, a firm **clones** it into a new firm-owned
Plan — the same clone-to-customize story as the advisory library. Whether cloning is
offered, and whether firms can even see which Plans are system vs their own, is a UX
detail; the isolation guarantee is structural.

---

## 6. Product decisions (resolved 2026-07-21, Matthew)

All seven questions are answered. The build follows these; the term is **"Plan"**.

1. **Q1 — Term → "Plan".** Confirmed over "Program" (avoids the seeded-playbook-title
   collision, §1.1).
2. **Q2 — Seed scope → both.** Ship canonical starter system Plans from `/seed` **and**
   allow firm-authored Plans (the `firm_id`-null vs. firm pattern, §5).
3. **Q3 — Owner visibility → owner-visible.** Applied Plans are visible in the owner
   portal. `engagement_plans` and `engagement_plan_items` therefore **get an owner-read
   RLS policy** mirroring `roadmap_milestones.owner_engagement_read` (pulled into PL1,
   §2.4).
4. **Q4 — Auto-generation vs. grouping → generate.** Applying a playbook item
   **generates its tasks**, reusing the shared instantiation + once-per-engagement
   `(playbook_id, sequence)` idempotency, tagging rows with `engagement_plan_id` for
   provenance (§1.4, §2.3, PL3). A Plan is an active driver, not a passive label.
5. **Q5 — Gap ↔ Plan → score-suggested.** Plans **are** recommendable from scores (like
   `advisory.ts` firing). Application stays a deliberate advisor action; the
   recommendation is read-only w.r.t. scoring and lands as the post-PL4 slice.
6. **Q6 — Clone-to-customize → yes.** A firm may clone a system Plan into an editable
   firm Plan; the system row itself stays service-role-only (uneditable in place).
7. **Q7 — Cross-cycle reuse → reconcile.** An active Applied Plan **re-reconciles** on
   re-assessment (surface newly-relevant items, flag completed ones) rather than staying
   a fixed snapshot. This is additive-only at the row level (new `engagement_plan_items`
   rows; the `engagement_plans` version pin and the `assessments` immutability rule are
   untouched) and is implemented in **PL4** — it does not change the PL1 schema.

---

## 7. Phased slice plan

One session = one slice = one commit (docs/05 discipline). Each slice ends with its
acceptance criteria demonstrated, `npm run test:rls` green where schema changed, and a
one-line entry in `docs/06-decisions.md`.

**Slice PL1 — Schema + seed (templates & instances).**
Migration for `plans`, `plan_items`, `engagement_plans`, `engagement_plan_items` +
the two `engagement_plan_id` columns; RLS per §2.4, **including the owner-read policy
on the instance tables (Q3=owner-visible)**; `rls-test.ts` firm-isolation +
cross-firm-reference + owner-visibility cases; seed the starter system Plans from
`/seed` (idempotent, integrity-validated).
*Accept:* migration applies to a fresh DB; seed loads idempotently; an advisor firm
cannot read/edit another firm's Plans or a system Plan's row; `npm run test:rls` green.

**Slice PL2 — Plan authoring (Library).**
Query hooks + an `upsert-plan` / `add-plan-item` server function (engine `workflow`,
scope `firm`); Library UI to create a Plan and add items from the existing catalogs;
editing an active Plan mints a new `plan_version`.
*Accept:* an advisor authors a firm Plan with mixed item kinds; editing a used Plan
creates a new version and leaves prior versions intact; foreign-firm write is denied.

**Slice PL3 — Apply to engagement.**
`apply-plan` server function (engine `workflow`, scope `engagement`) implementing §2.3,
sharing the playbook→`tasks` instantiation with `server/roadmap.ts` and honoring the
once-per-engagement `(playbook_id, sequence)` idempotency (§1.4); "Apply a Plan" UI on
the Remediation/Roadmap surface with anchor-date + preview.
*Accept:* applying a Plan creates a pinned `engagement_plans` snapshot and materializes
its tasks/milestones tagged with `engagement_plan_id`; re-applying is idempotent and
never double-creates a playbook's tasks; applying a Plan whose playbook a gap already
instantiated **claims/tags** the existing rows rather than duplicating them; no
scoring/assessment/gap row is written (assert in test).

**Slice PL4 — Tracking + roadmap grouping + re-assessment reconcile.**
Computed per-Applied-Plan progress; group/filter the Roadmap board by applied plan;
plan-applied tasks flow into the existing stalled-task/"Needs attention" surfacing;
soft `status='removed'`. **Re-assessment reconcile (Q7):** when an engagement is
re-assessed, an active Applied Plan re-reconciles — additively surfacing newly-relevant
items and flagging ones whose work is now complete — writing only new
`engagement_plan_items` rows, never rewriting the version pin or any scoring row.
*Accept:* an advisor sees Applied-Plan progress and can group the board by plan;
completing all a plan's tasks marks it complete; removing a plan hides its grouping
without deleting client task history; re-assessing an engagement reconciles its active
Plans additively.

**Owner portal (Q3) — shipped:** the owner "Your plan" page shows Applied-Plan
progress (`OwnerPlanPage`, on the owner-read RLS from PL1). **Q5 recommendation —
shipped:** `recommend-plans` surfaces Plans whose playbooks target the engagement's
open gaps (read-only over the gap state, like `advisory.ts`), rendered on the
Roadmap with one-click apply.

**PL5 — Roadmap redevelopment around real Plans (shipped 2026-07-21).** The
Roadmap board no longer groups tasks by playbook "workstream" (a UI-only grouping
that predated this feature); it groups by **applied Plan**. Each `engagement_plan`
is a collapsible group carrying its tasks (the source playbook shown as a quiet
sub-label), its milestones, and its computed progress; a **gap-driven / unplanned**
bucket holds everything not tied to a live Plan, and the Gantt draws one bar per
group instead of per playbook. Three additions land with it:

- **Add a plan on the Roadmap.** A first-class picker (active system + firm Plans
  not already applied) applies a Plan with the shared anchor date, alongside a soft
  **Remove plan** that sets `engagement_plans.status='removed'` and keeps the client
  task history (the rows fall back to the unplanned bucket) — never a hard delete.
- **Recommendation fires from gaps AND initiatives.** `recommendPlans` now matches
  on two deterministic signals: a Plan's playbook items targeting open gaps (as
  before) *and* its advisory items referencing a **fired initiative** (`advisory.ts`
  `item_type='initiative'`, reused verbatim), ranked by combined coverage
  (`match_score` = gap matches + initiative matches). Read-only over scoring/gaps.
- **Auto-apply on generate-roadmap (Q5b).** `generate-roadmap` now also lays down
  any Plan that is *substantively applicable* — a **majority (≥50%)** of its playbook
  items map to the engagement's open gaps — via `autoApplyQualifyingPlans`, reusing
  `applyPlan`'s once-per-engagement `(playbook_id, sequence)` idempotency (a claimed
  task is never doubled) and reporting what it applied. This bar is deliberately
  stricter than the single-match recommendation arm, so bulk generation only pulls
  in mostly-on-target Plans, not ones that merely graze a gap. No scoring/rubric/
  schema change; no LLM in any path.

---

## 8. Where the existing code revised the approach

- **"Program" was already the human name of a playbook** (seed titles like "Clean
  Books Program") → recommended **"Plan"** instead of the request's lead word
  "Program" to avoid overloading an existing primitive (§1.1).
- **`server/roadmap.ts` is idempotent per engagement on `(playbook_id, sequence)`**
  regardless of trigger → a Plan **cannot** naively re-instantiate a playbook a gap
  already created; the design makes a playbook instantiate **once per engagement** and
  treats `gap_id`/`engagement_plan_id` as provenance annotations, and reuses (rather
  than forks) the instantiation code (§1.4, §2.3, Slice PL3).
- **`advisory_library_items` already solved global-vs-tenant methodology + RLS** →
  Plans copy that exact pattern (`firm_id` null = system, partial unique index on
  `code`, dual `system_read` + `advisor_all` policies) rather than inventing a new one
  (§2.1, §2.4, §5).
- **`roadmap_milestones` already models dual-track (business/personal) milestones with
  an owner-read policy** → Plan `milestone` items produce `roadmap_milestones` rows and,
  if owner-visible, reuse its RLS verbatim rather than adding a parallel milestone store
  (§2.1, §2.4).
- **Immutability precedent (`assessments`→`rubric_version`)** → `engagement_plans`
  pins `applied_plan_version` + snapshots `name`, so template edits never rewrite
  applied history (§2.2, §4).
- **`plans` was already taken** by the Stripe billing tier catalog
  (`20260719000200_billing.sql`, `firm_subscriptions.plan_code` FK) → the template
  table shipped as **`plan_templates`** / **`plan_template_items`** (instances keep
  `engagement_plans` / `engagement_plan_items`); the product term stays "Plan" (§2).
