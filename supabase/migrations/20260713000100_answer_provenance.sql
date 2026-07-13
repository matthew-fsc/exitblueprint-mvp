-- Phase 1: provenance & verification. The DRS is computed from answers; this
-- records WHERE each financial answer came from — self-reported, backed by a
-- document, or pulled from a connected ledger (QuickBooks/Xero). From that we
-- derive a "document-verified %" that upgrades a self-reported score (Tier-0)
-- toward a verified one (Tier-1) — the durable moat. Provenance never touches
-- the score; it only annotates the inputs.
--
-- Verification-tier thresholds (what % → which badge) are a product decision;
-- the mechanism here is neutral and the current defaults live in server code.

create type provenance_source as enum ('self_reported', 'document', 'connected_ledger');

create table answer_provenance (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),
  assessment_id uuid not null references assessments (id),
  question_id uuid not null references questions (id),
  source provenance_source not null default 'self_reported',
  note text,
  verified_by uuid references profiles (id),
  verified_at timestamptz,
  unique (assessment_id, question_id)
);

create index on answer_provenance (firm_id);
create index on answer_provenance (assessment_id);

grant select, insert, update, delete on answer_provenance to authenticated;
grant all on answer_provenance to service_role;

alter table answer_provenance enable row level security;

-- Advisor: full CRUD within their firm.
create policy advisor_firm_all on answer_provenance for all to authenticated
  using (app.user_role() = 'advisor' and firm_id = app.user_firm_id())
  with check (app.user_role() = 'advisor' and firm_id = app.user_firm_id());

-- Owner: read provenance for their own company's assessments.
create policy owner_engagement_read on answer_provenance for select to authenticated
  using (app.user_role() = 'owner' and assessment_id in (
    select a.id from assessments a join engagements e on e.id = a.engagement_id
    where e.company_id = app.user_company_id()));
