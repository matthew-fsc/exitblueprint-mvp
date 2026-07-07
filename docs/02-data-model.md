# 02 - Data Model

All tables have id uuid pk default gen_random_uuid(), created_at timestamptz default now(). All domain tables carry firm_id for RLS unless noted. Enums shown inline; implement as Postgres enums.

## Tenancy and people

**firms** - advisor firms (tenants)
- name, status (active|suspended)

**profiles** - extends Supabase auth.users
- user_id (fk auth.users), firm_id nullable, role (admin|advisor|owner), full_name, email
- owners also get company_id (fk companies) for portal scoping

## Clients and engagements

**companies**
- firm_id, name, industry, revenue_band, ebitda_band, state, notes
- owner_contact_name, owner_contact_email

**engagements** - the unit of work; a company's readiness journey
- firm_id, company_id, advisor_id (fk profiles), status (active|paused|exited|churned)
- target_exit_window (text), started_at

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

## Rules

1. A completed assessment is immutable. Corrections = new assessment (sequence_number increments).
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
