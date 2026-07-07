-- Full schema per docs/02-data-model.md.
-- Conventions: id uuid pk, created_at timestamptz default now();
-- domain tables carry firm_id for RLS unless noted in docs/02.

-- Enums ----------------------------------------------------------------------

create type firm_status as enum ('active', 'suspended');
create type app_role as enum ('admin', 'advisor', 'owner');
create type engagement_status as enum ('active', 'paused', 'exited', 'churned');
create type rubric_status as enum ('draft', 'active', 'retired');
create type score_group as enum ('business_readiness', 'owner_readiness');
create type answer_type as enum
  ('numeric', 'numeric_list', 'numeric_or_unknown', 'select', 'scale_1_5', 'rank', 'text');
create type formula_type as enum
  ('band_gte', 'band_ascending', 'select_map', 'scale_map', 'hhi_from_top5', 'durability',
   'growth_consistency', 'depth_ratio', 'cagr_band', 'pipeline_ratio', 'top1_band', 'top5_band');
create type gap_severity as enum ('low', 'med', 'high', 'critical');
create type assessment_status as enum ('in_progress', 'completed');
create type gap_status as enum ('open', 'in_remediation', 'resolved');
create type task_status as enum ('todo', 'doing', 'done', 'blocked');
create type task_owner_role as enum ('owner', 'advisor', 'cpa', 'attorney', 'ops');
create type doc_type as enum ('owner_report', 'advisor_brief', 'engagement_summary');

-- Tenancy and people ----------------------------------------------------------

create table firms (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null,
  status firm_status not null default 'active'
);

create table companies (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),
  name text not null,
  industry text,
  revenue_band text,
  ebitda_band text,
  state text,
  notes text,
  owner_contact_name text,
  owner_contact_email text
);

create table profiles (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid not null unique references auth.users (id),
  firm_id uuid references firms (id),
  role app_role not null,
  full_name text,
  email text,
  -- owners get company_id for portal scoping
  company_id uuid references companies (id)
);

create table engagements (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),
  company_id uuid not null references companies (id),
  advisor_id uuid references profiles (id),
  status engagement_status not null default 'active',
  target_exit_window text,
  started_at timestamptz not null default now()
);

-- Methodology (rubric lives in data; seeded from /seed) -----------------------

create table rubric_versions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  version_label text not null unique,
  status rubric_status not null default 'draft',
  effective_date date,
  notes text
);

create table dimensions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  rubric_version_id uuid not null references rubric_versions (id),
  code text not null,
  name text not null,
  description text,
  score_group score_group not null,
  drs_weight numeric not null default 0, -- 0 for owner_readiness dimensions
  sort_order int not null default 0,
  unique (rubric_version_id, code)
);

create table questions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  dimension_id uuid not null references dimensions (id),
  code text not null,
  prompt text not null,
  help_text text,
  answer_type answer_type not null,
  options text, -- pipe-delimited for select/rank
  scored boolean not null default true, -- false = context-only, never scored
  sort_order int not null default 0,
  unique (dimension_id, code)
);

create table sub_scores (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  dimension_id uuid not null references dimensions (id),
  code text not null,
  name text not null,
  weight numeric not null,
  formula_type formula_type not null,
  input_question_codes text not null, -- comma-separated question codes
  logic jsonb not null default '{}', -- bands, maps, formulas per docs/03
  notes text,
  unique (dimension_id, code)
);

create table gap_definitions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  rubric_version_id uuid not null references rubric_versions (id),
  code text not null,
  name text not null,
  severity gap_severity not null,
  dimension_id uuid not null references dimensions (id),
  trigger jsonb not null, -- trigger types per docs/03
  unique (rubric_version_id, code)
);

create table playbooks (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  code text not null,
  name text not null,
  version int not null default 1,
  summary text,
  dimension_code text,
  phase text,
  ev_impact text,
  body_md text,
  unique (code, version)
);

create table playbook_task_templates (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  playbook_id uuid not null references playbooks (id),
  title text not null,
  description text,
  default_owner_role task_owner_role not null,
  sequence int not null,
  target_offset_days int,
  unique (playbook_id, sequence)
);

create table gap_playbook_map (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  gap_definition_id uuid not null references gap_definitions (id),
  playbook_id uuid not null references playbooks (id),
  priority int not null default 1,
  unique (gap_definition_id, playbook_id)
);

create table content_modules (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  code text not null unique,
  title text not null,
  dimension_code text,
  body_md text
);

create table gap_content_map (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  gap_definition_id uuid not null references gap_definitions (id),
  content_module_id uuid not null references content_modules (id),
  drip_order int not null default 1,
  unique (gap_definition_id, content_module_id)
);

-- Assessment lifecycle (immutable snapshots) -----------------------------------

create table assessments (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),
  engagement_id uuid not null references engagements (id),
  rubric_version_id uuid not null references rubric_versions (id),
  status assessment_status not null default 'in_progress',
  completed_at timestamptz,
  sequence_number int not null default 1, -- 1 = baseline
  drs_score numeric,
  drs_tier text,
  ori_score numeric,
  unique (engagement_id, sequence_number)
);

create table answers (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  assessment_id uuid not null references assessments (id),
  question_id uuid not null references questions (id),
  value jsonb not null,
  answered_by uuid references profiles (id),
  unique (assessment_id, question_id)
);

create table sub_score_results (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  assessment_id uuid not null references assessments (id),
  sub_score_id uuid not null references sub_scores (id),
  points numeric not null,
  computed_inputs jsonb not null default '{}', -- explain trace
  unique (assessment_id, sub_score_id)
);

create table dimension_scores (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  assessment_id uuid not null references assessments (id),
  dimension_id uuid not null references dimensions (id),
  score numeric not null,
  unique (assessment_id, dimension_id)
);

create table gaps (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),
  engagement_id uuid not null references engagements (id),
  gap_definition_id uuid not null references gap_definitions (id),
  opened_by_assessment_id uuid not null references assessments (id),
  status gap_status not null default 'open',
  resolved_by_assessment_id uuid references assessments (id)
);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),
  engagement_id uuid not null references engagements (id),
  gap_id uuid references gaps (id),
  playbook_id uuid references playbooks (id),
  title text not null,
  description text,
  owner_role task_owner_role not null default 'owner',
  assigned_to_name text,
  status task_status not null default 'todo',
  due_date date,
  sequence int
);

create table generated_documents (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),
  engagement_id uuid not null references engagements (id),
  assessment_id uuid references assessments (id),
  doc_type doc_type not null,
  content_md text not null,
  prompt_version text not null,
  model text not null
);

-- Indexes for common access paths ----------------------------------------------

create index on companies (firm_id);
create index on profiles (firm_id);
create index on engagements (firm_id);
create index on engagements (company_id);
create index on assessments (firm_id);
create index on assessments (engagement_id);
create index on answers (assessment_id);
create index on sub_score_results (assessment_id);
create index on dimension_scores (assessment_id);
create index on gaps (firm_id);
create index on gaps (engagement_id);
create index on tasks (firm_id);
create index on tasks (engagement_id);
create index on generated_documents (firm_id);
create index on generated_documents (engagement_id);
create index on dimensions (rubric_version_id);
create index on questions (dimension_id);
create index on sub_scores (dimension_id);
create index on gap_definitions (rubric_version_id);
