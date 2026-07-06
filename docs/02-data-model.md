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
- target_exit_window (text, e.g. "2027-H2"), started_at

## Methodology (rubric lives in data)

**rubric_versions**
- version_label (e.g. "DRS-1.0"), status (draft|active|retired), effective_date, notes

**dimensions**
- rubric_version_id, code (e.g. FIN, OPS, OWN, MKT, LEG), name, description, weight numeric, sort_order

**questions**
- dimension_id, prompt text, help_text, answer_type (scale_1_5|yes_no|numeric|select), options jsonb (for select), scoring_map jsonb (answer -> points), weight numeric, sort_order

**gap_definitions** - named gaps the methodology can flag
- rubric_version_id, dimension_id, code (e.g. CUST_CONC), name, description, severity (low|med|high|critical)
- trigger jsonb (rule, e.g. {"type":"dimension_below","threshold":60} or {"type":"question_answer","question_code":"FIN-03","in":["no"]})

**playbooks**
- code, name, version int, summary, dimension_code, body_md (full playbook text)

**playbook_task_templates**
- playbook_id, title, description, default_owner_role (owner|advisor|cpa|attorney|ops), sequence int, target_offset_days int

**gap_playbook_map**
- gap_definition_id, playbook_id, priority int

**content_modules**
- code, title, summary, body_md or asset_url, dimension_code, sort_order

**gap_content_map**
- gap_definition_id, content_module_id, drip_order int

## Assessment lifecycle (immutable snapshots)

**assessments**
- firm_id, engagement_id, rubric_version_id, status (in_progress|completed), completed_at, sequence_number int (1 = baseline)
- overall_score numeric null until scored

**answers**
- assessment_id, question_id, value jsonb, answered_by (fk profiles)

**dimension_scores**
- assessment_id, dimension_id, raw_score numeric, weighted_score numeric

**gaps** - instances flagged on a company
- firm_id, engagement_id, gap_definition_id, opened_by_assessment_id, status (open|in_remediation|resolved), resolved_by_assessment_id nullable

**tasks**
- firm_id, engagement_id, gap_id nullable, playbook_id nullable, title, description, owner_role, assigned_to_name, status (todo|doing|done|blocked), due_date, sequence

**generated_documents**
- firm_id, engagement_id, assessment_id, doc_type (owner_report|advisor_brief|engagement_summary), content_md, prompt_version, model, created_at

## Rules

1. A completed assessment is immutable: no updates to answers, dimension_scores, or overall_score after completed_at is set. Corrections = new assessment.
2. Gaps close only when a later assessment no longer triggers them (set resolved_by_assessment_id) or an advisor manually resolves with a note.
3. Score deltas are computed, not stored: compare assessments by sequence_number within an engagement.
4. RLS policy sketch: advisors see rows where firm_id = their firm; owners see rows where engagement -> company_id = their company_id and only tables: assessments (completed), dimension_scores, gaps, tasks, generated_documents (owner_report only), content assignments.

## Seed data

/seed/drs-rubric.csv -> rubric_versions, dimensions, questions
/seed/gap-definitions.csv -> gap_definitions
/seed/playbooks/*.md + playbook-tasks.csv -> playbooks, playbook_task_templates
/seed/gap-playbook-map.csv, /seed/gap-content-map.csv -> mapping tables
Seed script must be idempotent (upsert on code fields).
