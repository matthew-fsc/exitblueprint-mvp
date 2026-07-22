# 02 - Data Model

All tables have id uuid pk default gen_random_uuid(), created_at timestamptz default now(). All domain tables carry firm_id for RLS unless noted. Enums shown inline; implement as Postgres enums.

## Tenancy and people

**firms** - advisor firms (tenants)
- name, status (active|suspended)

**profiles** - extends Supabase auth.users
- user_id (fk auth.users), firm_id nullable, role (admin|advisor|reviewer|owner|collaborator), full_name, email
- owners also get company_id (fk companies) for portal scoping
- reviewer role exists for the beta document-review queue (Requirement 3); its
  table policies land with that slice.
- collaborator is a view-only external participant (a client's CPA, attorney, …)
  scoped to a SINGLE engagement via engagement_id — assembled through the same
  owner-portal invite workflow. Its RLS mirrors the owner portal one-for-one but
  scopes by engagement_id (app.user_engagement_id()), so it sees a strict subset
  of what that engagement's owner sees, and never a sibling engagement.

**engagement_collaborators** - the per-engagement view-only roster
- firm_id, engagement_id (on delete cascade), company_id, email, full_name,
  kind (cpa|attorney|advisor|other), status (invited|active|revoked), invited_by,
  user_id (set once the identity is provisioned), revoked_at; unique (engagement_id, email)
- Written by the invite/revoke functions (service role); staff read it under RLS
  to render + manage the team. A collaborator NEVER reads this table.
- This is a scoped-login roster; the firm-level *contact directory* of the same
  outside professionals is **firm_professionals** (below), a separate concern.

## Organizational controls (white-labeling for bigger firms)

For a practice of several people, **admin** is a real organizational role, not a
label: org-level assets are admin-administered while advisors do the client work.
Enforced in RLS + a matching UI guard (RequireAdmin, the `/organization` area),
not by convention. The two firm-scoped org assets:

**firm_professionals** - the firm's reusable directory of the clients' outside
professionals (CPAs, attorneys, M&A advisors, bankers, …)
- firm_id, full_name, organization, kind (professional_kind: cpa|attorney|
  ma_advisor|banker|wealth_manager|insurance|other), email, phone, notes,
  archived (bool), created_by, updated_at
- A CONTACT record, not a login (contrast engagement_collaborators). RLS: all firm
  staff (advisor/reviewer/admin) READ; only **admins** WRITE (org asset). Curated
  once, attached to any engagement.

**engagement_professionals** - which directory professional is on which
engagement's deal team
- firm_id, engagement_id (on delete cascade), professional_id (fk firm_professionals,
  on delete cascade), engagement_role (free text — their role on this deal),
  added_by; unique (engagement_id, professional_id)
- RLS: firm staff full CRUD (attaching a professional is client work, not org
  administration).

Two more enforcement points make admin an org control (migration
`20260721000500`): **firm_branding** is now admin-only to WRITE (any firm member
still READS it so client-facing surfaces render), and an engagement's owning
**advisor_id** is frozen against end-user roles by a guard trigger — reassignment
goes only through the admin-scoped `assign-engagement` server function
(service_role). Team management (`invite-advisor`) is likewise admin-scoped.

## Clients and engagements

**companies**
- firm_id, name, industry, revenue_band, ebitda_band, state, notes
- owner_contact_name, owner_contact_email

**engagements** - the unit of work; a company's readiness journey
- firm_id, company_id, advisor_id (fk profiles), status (active|paused|exited|churned)
- target_exit_window (text), started_at
- Lifecycle: `status` is the SOFT path — active/paused are working states, exited/churned
  are terminal — moved by a plain firm-scoped UPDATE (advisor RLS) on the engagement's
  Setup & admin tab. The HARD path is deletion: the `delete-engagement` function
  (server/engagements.ts) permanently removes the engagement and its entire subtree in
  one service-role transaction. This is intentionally the ONLY deletion path — the
  engagement's child foreign keys are deliberately NOT `on delete cascade` (nothing but
  this teardown may remove client history), and the completed-assessment immutability
  triggers exempt only service_role, so no advisor JWT can tear an engagement down. The
  teardown deletes children FK-safe-ordered, asserts no orphans remain (dynamically, over
  every public table carrying an engagement_id), and audits the removal into
  data_access_log (engagement_id null; the deleted ids live in `detail`). It is a true
  hard delete, not an archive — for undoing a mis-created engagement or honouring a
  "remove our data" request; the UI gates it behind a typed confirmation.

## Data-rights capture (beta Requirement 1)

Before any assessment data is collected for an engagement, the advisor records
acceptance of an immutable engagement-agreement version plus the client's
data-use consents. The agreement/consent layer only gates and annotates inputs;
it never writes to scoring.

**agreement_versions** - immutable, full-text agreement templates per firm
- firm_id, version_label (unique per firm), title, body_md, status (draft|active|retired)
- effective_date, created_by (fk profiles)
- Rows are never edited (UPDATE/DELETE withheld from authenticated); a new
  version is a new row. Acceptances reference the exact version.

**engagement_agreements** - per-engagement acceptance (one per engagement)
- firm_id, engagement_id (fk, unique), agreement_version_id (fk agreement_versions)
- accepted_by (fk profiles), accepted_signer_name, accepted_at
- consent_benchmarking, consent_anonymized_aggregation, consent_outcome_tracking (bool)

The sanctioned way to start an engagement is the `create-engagement` function,
which inserts the engagement and its acceptance in one transaction. `assessments`
gains **agreement_version_id** (the version in force when the data was collected);
a BEFORE-INSERT trigger blocks any assessment for an engagement with no acceptance
and stamps this column from the acceptance — the DB-hard guarantee behind "no
assessment data before acceptance."

## Document intake (beta Requirement 3)

Advisors (or clients) upload source documents per assessment category; each moves
through upload → virus scan → classification → extraction (ParserAdapter) → human
review → verified fact. Extraction accuracy is not a beta blocker — the manual
review path is complete; the automated path may be partial. Documents/fields
never write to scoring tables. The virus scan runs through a `ScannerAdapter` seam
(server/documents/scanner.ts): `noop` by default (records `scan_status='skipped'`),
`clamav` scans the plaintext BEFORE any bytes are stored, so an infected file is
recorded `scan_status='infected'`, marked `status='rejected'`, and never persisted.

**documents**
- firm_id, engagement_id, category, original_filename, mime_type, byte_size
- status (uploaded|scanning|scanned|classified|extracting|in_review|verified|rejected)
- scan_status (pending|clean|infected|skipped), classification, parser_name, storage_key
- uploaded_by, reviewed_by, reviewed_at

**document_blobs** — default byte store (document_id fk unique, firm_id, bytes bytea,
enc_algo). The `StorageAdapter` seam (server/documents/storage.ts) also has a Supabase
Storage backend (`EB_STORAGE=supabase`): the same AES-256-GCM envelope lives in a private
bucket keyed `firm_id/document_id` instead of Postgres, decrypted server-side and served on
the same audited signed-URL route — no caller changes. Bucket teardown is handled explicitly
(pipeline compensation + engagement delete) since a bucket object does not cascade.

**document_fields** — extracted or manually-entered data points
- firm_id, document_id, question_id (nullable link to a scored question), field_key, value
- verification_status (unverified|extracted|verified), confidence, verified_by, verified_at

**field_corrections** — parser-accuracy log (firm_id, document_field_id, original_value, corrected_value, corrected_by)

RLS: staff (advisor + reviewer) full CRUD within firm — the reviewer role's first
policies; owners upload+read their own company's documents/fields (not the QA log).
Extraction/parsing goes through the ParserAdapter (server/documents/parser.ts) and
storage through the StorageAdapter (server/documents/storage.ts) — no vendor is
hard-coded.

## Security + instrumentation (beta Requirements 5 & 6)

**document_blobs.enc_algo** — added: which envelope encrypts a row's bytes
('aes-256-gcm'; null = legacy plaintext). Document bytes are AES-256-GCM
encrypted at rest (server/documents/crypto.ts, key from EB_DOCUMENT_KEY) and
served only through short-expiry HMAC-signed URLs (GET /documents/download;
server/documents/signed-url.ts). MFA (TOTP) is required for advisor/admin
accounts, enforced in the app via Supabase AAL (bypassed on the dev stack).

**data_access_log** — append-only audit of access to client records
- firm_id, actor_user_id, actor_profile_id, action ('document.read', 'document.download', …),
  resource_type, resource_id, engagement_id, detail jsonb
- Written server-side (service_role); readable by the firm's advisors/reviewers.

**usage_events** — append-only advisor-journey instrumentation (SQL-queryable, no
third-party analytics)
- firm_id, actor_user_id, actor_profile_id, engagement_id, event_type
  ('onboarding'|'assessment'|'document'|'report'|'review'), event_name,
  properties jsonb, session_id, occurred_at
- Authenticated users insert events for their own firm; advisors/reviewers read
  their firm's stream. Emitted via src/lib/analytics.ts `track()`.

## Methodology (rubric lives in data; seeded from /seed)

**rubric_versions**
- version_label (e.g. "DRS-1.0"), status (draft|active|retired), effective_date, notes

**dimensions**
- rubric_version_id, code (REV|FIN|OPS|CUS|MGT|GRW|GOL|PFN|VAL), name, description
- score_group (business_readiness|owner_readiness)
- drs_weight numeric  -- 0 for owner_readiness dimensions
- sort_order

**questions** - raw intake inputs
- dimension_id, code, prompt, help_text
- answer_type (numeric|numeric_list|numeric_or_unknown|select|scale_1_5|rank|text)
- options text (pipe-delimited for select/rank)
- scored boolean  -- false = context-only: captured, shown to narrative layer, never scored
- sort_order

**sub_scores** - the scoring layer between questions and dimensions
- dimension_id, code, name, weight numeric
- formula_type (band_gte|band_ascending|select_map|scale_map|hhi_from_top5|durability|growth_consistency|depth_ratio|cagr_band|pipeline_ratio|top1_band|top5_band)
- input_question_codes text (comma-separated)
- logic jsonb (bands, maps, formulas - see docs/03)
- notes

**gap_definitions**
- rubric_version_id, code, name, severity (low|med|high|critical), dimension_id
- trigger jsonb (see docs/03 trigger types)

**library_tasks** (playbooks retired — docs/06 2026-07-22) — the atomic, reusable
remediation task; a first-class Library item like content_modules/advisory_library_items.
- firm_id (null = system), source, code, title, description, default_owner_role (owner|advisor|cpa|attorney|ops), dimension_code, target_offset_days int
- Referenced by `plan_template_items` (`item_kind='task'`, `library_task_id`) and `tasks.library_task_id` (the once-per-engagement idempotency key).

**gap_plan_map** (replaces gap_playbook_map) - gap_definition_id, plan_template_id, priority int — a gap links to its remediation Plan.
**content_modules** - firm_id, source, code, title, dimension_code, body_md — the single education library (owner Learn + Plan education items).
**gap_content_map** - gap_definition_id, content_module_id, drip_order int

## Institutional memory (docs/20/21 Category B)

**engagement_log** — advisor-authored record of the *reasoning*, not just the
action: meetings, decisions, and the rationale behind recommendations.
- firm_id, engagement_id, author_id (fk profiles)
- kind (meeting|decision|rationale|note), occurred_on date (backdatable for
  engagements already in flight), title, detail
- gap_id (nullable fk gaps, ON DELETE SET NULL) — the recommendation the entry explains
- Staff-only under RLS (advisor+reviewer, firm-scoped): internal advisory logic,
  never owner-facing. Never writes to a score (rule 2).

## Assessment lifecycle (immutable snapshots)

**assessments**
- firm_id, engagement_id, rubric_version_id, status (in_progress|completed), completed_at, sequence_number int (1 = baseline)
- drs_score numeric null, drs_tier text null, ori_score numeric null
- record_status (active|superseded) default active, superseded_by_assessment_id (fk assessments) null, supersede_reason text null
  (named record_status because status already tracks the intake lifecycle)

**active_assessments** (view, security_invoker)
- assessments where record_status = 'active'. ALL longitudinal reads — score
  history, deltas, dashboards — go through this view, never the raw table.

**answers**
- assessment_id, question_id, value jsonb, answered_by (fk profiles)

**sub_score_results**
- assessment_id, sub_score_id, points numeric, computed_inputs jsonb (e.g. hhi_est, cagr_pct, down_years - the explain trace)

**dimension_scores**
- assessment_id, dimension_id, score numeric

**gaps** - instances flagged on a company
- firm_id, engagement_id, gap_definition_id, opened_by_assessment_id, status (open|in_remediation|resolved), resolved_by_assessment_id nullable

**tasks**
- firm_id, engagement_id, gap_id nullable, playbook_id nullable, title, description, owner_role, assigned_to_name, status (todo|doing|done|blocked), due_date, sequence
- **engagement_plan_id nullable** (fk engagement_plans) — provenance annotation: a task can be gap-derived (gap_id set) or plan-applied (engagement_plan_id set), living in the same table (see Plans below).
- **completed_at nullable** — stamped when status → done; powers Applied-Plan progress and stalled-task detection.

**generated_documents**
- firm_id, engagement_id, assessment_id, doc_type (owner_report|advisor_brief|delta_report|cim|engagement_summary), content_md, prompt_version, model, created_at
- finalized_at timestamptz null — AI output is a labeled draft until the advisor edits and finalizes (S8). The **CIM** owner-read is gated on finalized_at (migration 20260721000600) so the buyer-facing draft stays firm-private until sign-off.
- The document suite (which doc types exist, their title/filename/audience/owner-visibility) is declared once in `shared/documents/catalog.ts` and rendered by the **Deliverables studio** (docs/17 §5); the server render path is `render-document-pdf` (`server/documents/catalog.ts`).

## Plans (prescription bundles — docs/37)

A **Plan** is a curated, versioned, reusable bundle of references to existing
primitives (playbooks, education/advisory items, inline milestones/manual tasks) —
prescription authored **top-down**, alongside the gap-driven roadmap's **bottom-up**
prescription. Plans write **only** to prescription tables (`tasks`,
`roadmap_milestones`); they never touch scoring (rule 1) and need no `rubric_version`.
Full design + as-built reference: **docs/37**. Shipped in
`20260721000100_plans.sql` (+ `…000200_plan_lineage.sql`, `…000300_task_completed_at.sql`).

**plan_templates** — the reusable Plan header (template)
- firm_id **nullable** (null = system/seed methodology Plan; set = firm-authored), source (system|advisor), code (system idempotency), name, summary, plan_version (rule 6), status (draft|active|retired), created_by
- RLS mirrors `advisory_library_items`: everyone reads system rows (firm_id null, service-role writes only); a firm has full CRUD on its own.

**plan_template_items** — the ordered contents of a Plan template
- firm_id (mirrors parent), plan_template_id, item_kind (playbook|education|advisory|milestone|manual_task), the matching reference column per kind (playbook_id / content_module_id / advisory_library_item_id) or inline copy (title/description/owner_role/track/target_offset_days), sort_order
- A check constraint enforces the right reference column per item_kind.

**engagement_plans** — the **immutable** applied-plan instance (mirrors assessments→rubric_version, rule 4)
- firm_id, engagement_id, plan_template_id, applied_plan_version (the version pinned at apply time), name (snapshot), anchor_date, applied_by, applied_at, status (active|completed|removed)
- Owner-readable (Q3): owner-read RLS mirrors `roadmap_milestones.owner_engagement_read`.

**engagement_plan_items** — immutable snapshot of what was applied, with pointers to the concrete rows produced (task_id / milestone_id / content/advisory ids), source_plan_template_item_id for lineage, snapshotted item_kind.

Applying a Plan (`apply-plan`, engine `workflow`) reuses the shared playbook→tasks
instantiation with the **once-per-engagement `(playbook_id, sequence)` idempotency**
(`server/roadmap.ts`), tags the rows with `engagement_plan_id`, and never duplicates a
playbook a gap already instantiated. Progress is **computed**, not stored. Removing a
Plan is a soft `status='removed'`.

## Outcome capture (schema only in v1 — no UI, no API)

Outcome data is the training substrate for future rubric calibration: it ties
readiness scores to what actually happened in market. It is only ever recorded
from advisor-reported facts and must never be backfilled speculatively.

**engagement_outcomes** — one row per engagement, created lazily; everything nullable
- firm_id, engagement_id (fk, unique), updated_at
- process_status (not_in_market|preparing|in_market|under_loi|closed|withdrawn|broken)
- outcome_recorded_at

**outcome_events** — append-only event log per engagement
- firm_id, engagement_id, event_type (loi_received|loi_expired|ioi_received|qoe_started|qoe_findings_recorded|retrade|price_change|deal_closed|deal_broken|withdrawn_from_market)
- event_date, recorded_by (fk profiles), numeric_value numeric null (e.g. multiple achieved, retrade %, QoE findings count), detail jsonb null, notes
- Append-only for non-admin roles (no UPDATE/DELETE policy or grant). A
  correction is a new correcting event, mirroring assessment immutability.

## Rules

1. A completed assessment is immutable. Corrections = supersede: create a new assessment with corrected answers (sequence_number increments), score it, mark the old row record_status = superseded with superseded_by_assessment_id + supersede_reason (server function supersedeAssessment). The old row's content is never touched; superseded rows are excluded from score history, deltas, and every longitudinal query via the active_assessments view.
2. DRS = weighted sum of business_readiness dimension scores only. ORI = weighted sum of ORI sub-scores. Never mix the two groups.
3. Gaps close only when a later assessment no longer triggers them (set resolved_by_assessment_id) or an advisor manually resolves with a note.
4. Score deltas are computed, not stored: compare assessments by sequence_number within an engagement.
5. RLS: advisors scoped to firm_id; owners scoped to their company's engagements, tables: completed assessments, dimension_scores, sub_score_results, gaps, tasks, owner_report documents, content assignments.

## Seed data

/seed/drs-rubric-dimensions.csv, drs-rubric-questions.csv, drs-rubric-subscores.csv -> rubric tables
/seed/gap-definitions.csv, gap-playbook-map.csv, gap-content-map.csv -> gap tables
/seed/playbooks/*.md -> playbooks + task templates (parse frontmatter + task table)
/seed/content-modules.csv -> content_modules
Seed script must be idempotent (upsert on code fields) and validate referential integrity.
