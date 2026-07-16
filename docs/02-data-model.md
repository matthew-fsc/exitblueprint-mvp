# 02 - Data Model

All tables have id uuid pk default gen_random_uuid(), created_at timestamptz default now(). All domain tables carry firm_id for RLS unless noted. Enums shown inline; implement as Postgres enums.

## Tenancy and people

**firms** - advisor firms (tenants)
- name, status (active|suspended)

**profiles** - extends Supabase auth.users
- user_id (fk auth.users), firm_id nullable, role (admin|advisor|reviewer|owner), full_name, email
- owners also get company_id (fk companies) for portal scoping
- reviewer role exists for the beta document-review queue (Requirement 3); its
  table policies land with that slice.

## Clients and engagements

**companies**
- firm_id, name, industry, revenue_band, ebitda_band, state, notes
- owner_contact_name, owner_contact_email

**engagements** - the unit of work; a company's readiness journey
- firm_id, company_id, advisor_id (fk profiles), status (active|paused|exited|churned)
- target_exit_window (text), started_at

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
never write to scoring tables.

**documents**
- firm_id, engagement_id, category, original_filename, mime_type, byte_size
- status (uploaded|scanning|scanned|classified|extracting|in_review|verified|rejected)
- scan_status (pending|clean|infected|skipped), classification, parser_name, storage_key
- uploaded_by, reviewed_by, reviewed_at

**document_blobs** — beta byte store (document_id fk unique, firm_id, bytes bytea).
R5 moves bytes to Supabase Storage (encryption + signed URLs) behind the same
StorageAdapter seam; schema-swappable.

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

**playbooks**
- code, name, version int, summary, dimension_code, phase, ev_impact, body_md

**playbook_task_templates**
- playbook_id, title, description, default_owner_role (owner|advisor|cpa|attorney|ops), sequence int, target_offset_days int

**gap_playbook_map** - gap_definition_id, playbook_id, priority int
**content_modules** - code, title, dimension_code, body_md
**gap_content_map** - gap_definition_id, content_module_id, drip_order int

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

**generated_documents**
- firm_id, engagement_id, assessment_id, doc_type (owner_report|advisor_brief|engagement_summary), content_md, prompt_version, model, created_at
- finalized_at timestamptz null — AI output is a labeled draft until the advisor edits and finalizes (S8)

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
