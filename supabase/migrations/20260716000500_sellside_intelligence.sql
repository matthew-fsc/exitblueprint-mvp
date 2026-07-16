-- Sell-side intelligence substrate: the document-verified knowledge layer that
-- sits between the existing document intake (20260716000200_documents.sql) and
-- the deterministic scoring engine (shared/scoring). Net-new tables only; the
-- existing engagements/documents/document_fields/field_corrections tables are
-- reused, not duplicated. document_fields is the extracted-facts substrate and
-- is extended here with graph + extraction provenance columns.
--
-- Provenance rule (CLAUDE.md): every derived value traces back to a document or
-- a fact. graph nodes/edges carry the facts that built them, assessment_values
-- carry the evidence fact id, findings carry graph evidence, scores carry the
-- assessment snapshot they were computed from. No orphan values.
--
-- Scoring rule (CLAUDE.md rule 2): nothing in this layer computes or writes a
-- DRS. scores rows are produced by the deterministic engine from reconciled
-- values; findings narrative is AI-drafted and always labeled draft.

create type value_source as enum ('self_reported', 'document_verified', 'conflicting');
create type finding_severity as enum ('low', 'medium', 'high', 'critical');
create type finding_status as enum ('pending', 'approved', 'rejected');
create type sellside_score_type as enum ('raw', 'verified');
create type job_status as enum ('pending', 'running', 'waiting_review', 'completed', 'failed');
create type review_item_type as enum
  ('low_confidence_extraction', 'conflict', 'finding_approval', 'report_signoff');
create type review_item_status as enum ('pending', 'in_review', 'resolved', 'escalated');

-- Knowledge graph, modeled relationally (no separate graph DB). node_type and
-- edge_type reference the ontology registry (server/ontology); attributes hold
-- the typed payload as JSONB. valid_from/valid_to give temporal versioning so a
-- longitudinal engagement can keep prior snapshots without mutating history.
create table graph_nodes (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),
  engagement_id uuid not null references engagements (id),
  node_type text not null,
  attributes jsonb not null default '{}'::jsonb,
  valid_from timestamptz not null default now(),
  valid_to timestamptz
);
create index on graph_nodes (firm_id);
create index on graph_nodes (engagement_id);
create index on graph_nodes (engagement_id, node_type);

create table graph_edges (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),
  engagement_id uuid not null references engagements (id),
  edge_type text not null,
  from_node uuid not null references graph_nodes (id) on delete cascade,
  to_node uuid not null references graph_nodes (id) on delete cascade,
  attributes jsonb not null default '{}'::jsonb,
  valid_from timestamptz not null default now(),
  valid_to timestamptz
);
create index on graph_edges (firm_id);
create index on graph_edges (engagement_id);
create index on graph_edges (engagement_id, edge_type);
create index on graph_edges (from_node);
create index on graph_edges (to_node);

-- Extend document_fields into the "extracted_facts" substrate the pipeline needs:
-- a nullable link to the graph node a fact populated, and extraction provenance
-- (source page/span, the extraction run that produced it). Additive + nullable so
-- the existing document intake path is untouched.
alter table document_fields
  add column node_id uuid references graph_nodes (id) on delete set null,
  add column source_page int,
  add column source_span text,
  add column extraction_run_id uuid;
create index on document_fields (node_id);
create index on document_fields (extraction_run_id);

-- Reconciliation of self-reported (questionnaire) vs document-verified values.
-- source records how the field resolved; evidence_fact_id points at the
-- document_fields row that verified it (provenance); resolved_by is the reviewer
-- who resolved a conflict, null when auto-resolved by confidence.
create table assessment_values (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),
  engagement_id uuid not null references engagements (id),
  field_key text not null,
  self_reported_value jsonb,
  verified_value jsonb,
  source value_source not null,
  evidence_fact_id uuid references document_fields (id) on delete set null,
  confidence numeric,
  resolved_by uuid references profiles (id),
  unique (engagement_id, field_key)
);
create index on assessment_values (firm_id);
create index on assessment_values (engagement_id);

-- Findings: buy-side diligence patterns run in reverse against the graph.
-- graph_evidence lists the node/edge ids that matched (provenance). narrative is
-- AI-drafted and gated: narrative_approved flips only after human sign-off.
create table findings (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),
  engagement_id uuid not null references engagements (id),
  pattern_key text not null,
  severity finding_severity not null,
  graph_evidence jsonb not null default '{}'::jsonb,
  narrative_draft text,
  narrative_approved boolean not null default false,
  status finding_status not null default 'pending'
);
create index on findings (firm_id);
create index on findings (engagement_id);
create index on findings (engagement_id, pattern_key);

-- Deterministic scores, computed by the engine (never here). raw = from
-- self-reported answers, verified = from reconciled values; both are persisted so
-- the raw-vs-verified gap is first-class. snapshot_id ties a score to the
-- immutable assessment it was computed from (provenance), null for ad-hoc runs.
create table scores (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),
  engagement_id uuid not null references engagements (id),
  score_type sellside_score_type not null,
  category_scores jsonb not null default '{}'::jsonb,
  composite numeric,
  snapshot_id uuid references assessments (id),
  computed_at timestamptz not null default now()
);
create index on scores (firm_id);
create index on scores (engagement_id);
create index on scores (engagement_id, score_type);

-- Resumable pipeline jobs (no Temporal). A job owns one pipeline run for an
-- engagement; step is the current step, checkpoint is the step's resumable state,
-- attempts drives retry/backoff. waiting_review parks a job until a review_item
-- unblocks it.
create table jobs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),
  engagement_id uuid not null references engagements (id),
  pipeline text not null,
  step text not null,
  status job_status not null default 'pending',
  attempts int not null default 0,
  checkpoint jsonb not null default '{}'::jsonb,
  last_error text,
  started_at timestamptz,
  finished_at timestamptz
);
create index on jobs (firm_id);
create index on jobs (engagement_id);
create index on jobs (status);

-- Generalized review queue spanning the whole pipeline (extraction confidence,
-- reconciliation conflicts, finding approval, report sign-off). Distinct from
-- field_corrections, which is the per-datapoint parser-accuracy log. payload
-- carries the item's context; resolution carries the human decision.
create table review_items (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),
  engagement_id uuid not null references engagements (id),
  type review_item_type not null,
  payload jsonb not null default '{}'::jsonb,
  status review_item_status not null default 'pending',
  assigned_to uuid references profiles (id),
  resolution jsonb,
  resolved_at timestamptz,
  resolved_by uuid references profiles (id)
);
create index on review_items (firm_id);
create index on review_items (engagement_id);
create index on review_items (engagement_id, status);
create index on review_items (type);

-- Per-call LLM cost ledger. Written server-side (service_role) by the Claude
-- client wrapper. firm_id/engagement_id are nullable for system-level calls;
-- when present, staff can read their firm's spend for the metrics endpoint.
create table llm_calls (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  firm_id uuid references firms (id),
  engagement_id uuid references engagements (id),
  prompt_key text not null,
  model text not null,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cost_usd numeric not null default 0,
  latency_ms int
);
create index on llm_calls (firm_id);
create index on llm_calls (engagement_id);
create index on llm_calls (prompt_key);

-- Grants + RLS ----------------------------------------------------------------

grant select, insert, update, delete on
  graph_nodes, graph_edges, assessment_values, findings, scores, jobs, review_items, llm_calls
  to authenticated;
grant all on
  graph_nodes, graph_edges, assessment_values, findings, scores, jobs, review_items, llm_calls
  to service_role;

alter table graph_nodes enable row level security;
alter table graph_edges enable row level security;
alter table assessment_values enable row level security;
alter table findings enable row level security;
alter table scores enable row level security;
alter table jobs enable row level security;
alter table review_items enable row level security;
alter table llm_calls enable row level security;

-- Staff (advisor + reviewer) get full CRUD within their firm, matching the
-- documents layer. No owner policies: this substrate is advisor-facing only.
create policy staff_firm_all on graph_nodes for all to authenticated
  using (app.user_role() in ('advisor', 'reviewer') and firm_id = app.user_firm_id())
  with check (app.user_role() in ('advisor', 'reviewer') and firm_id = app.user_firm_id());
create policy staff_firm_all on graph_edges for all to authenticated
  using (app.user_role() in ('advisor', 'reviewer') and firm_id = app.user_firm_id())
  with check (app.user_role() in ('advisor', 'reviewer') and firm_id = app.user_firm_id());
create policy staff_firm_all on assessment_values for all to authenticated
  using (app.user_role() in ('advisor', 'reviewer') and firm_id = app.user_firm_id())
  with check (app.user_role() in ('advisor', 'reviewer') and firm_id = app.user_firm_id());
create policy staff_firm_all on findings for all to authenticated
  using (app.user_role() in ('advisor', 'reviewer') and firm_id = app.user_firm_id())
  with check (app.user_role() in ('advisor', 'reviewer') and firm_id = app.user_firm_id());
create policy staff_firm_all on scores for all to authenticated
  using (app.user_role() in ('advisor', 'reviewer') and firm_id = app.user_firm_id())
  with check (app.user_role() in ('advisor', 'reviewer') and firm_id = app.user_firm_id());
create policy staff_firm_all on jobs for all to authenticated
  using (app.user_role() in ('advisor', 'reviewer') and firm_id = app.user_firm_id())
  with check (app.user_role() in ('advisor', 'reviewer') and firm_id = app.user_firm_id());
create policy staff_firm_all on review_items for all to authenticated
  using (app.user_role() in ('advisor', 'reviewer') and firm_id = app.user_firm_id())
  with check (app.user_role() in ('advisor', 'reviewer') and firm_id = app.user_firm_id());
-- llm_calls: staff may read their firm's spend; rows with a null firm_id are
-- system calls, visible only to service_role. Writes are service_role only.
create policy staff_firm_read on llm_calls for select to authenticated
  using (app.user_role() in ('advisor', 'reviewer') and firm_id = app.user_firm_id());
