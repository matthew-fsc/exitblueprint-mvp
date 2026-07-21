-- Financial-verification hardening: link a financial answer's provenance to the
-- STORED document (and, when known, the specific verified fact) it was attested
-- against, and keep an append-only audit trail of every provenance mutation.
--
-- Additive only (rule 4 / additive-migration discipline): two NULLABLE columns
-- on answer_provenance and one new history table. Deliberately NO hard CHECK that
-- source='document' implies a document — existing seed/rls-test/verification
-- inserts stamp 'document' with no evidence and that invariant is enforced in
-- APPLICATION CODE (server/ledger.ts), the only path that stamps 'document' in
-- production. Provenance never touches a score (rule 1); this is evidence/audit
-- overlay only.

-- The stored source a `document`/`connected_ledger` answer was attested against.
-- Nullable so historical rows and the direct test/seed inserts remain valid.
alter table answer_provenance
  add column if not exists evidence_document_id uuid references documents (id),
  add column if not exists evidence_fact_id uuid references document_fields (id);

create index if not exists answer_provenance_evidence_document_id_idx
  on answer_provenance (evidence_document_id);

-- Append-only history of every provenance mutation — who set a financial answer's
-- source to what, against which document, and when. Immutable: authenticated
-- callers get SELECT + INSERT only (no UPDATE/DELETE grant), so the trail cannot
-- be rewritten from a client session; the service_role writes it server-side.
create table answer_provenance_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),
  assessment_id uuid references assessments (id),
  question_id uuid references questions (id),
  source provenance_source,
  evidence_document_id uuid references documents (id),
  event text,
  actor_profile_id uuid references profiles (id),
  note text
);
create index on answer_provenance_events (firm_id);
create index on answer_provenance_events (assessment_id);

-- SELECT + INSERT only — omitting UPDATE/DELETE makes the log append-only even
-- for an advisor with a valid firm session.
grant select, insert on answer_provenance_events to authenticated;
grant all on answer_provenance_events to service_role;

alter table answer_provenance_events enable row level security;

-- Advisor: read + append their own firm's history (no full CRUD — immutable).
create policy advisor_firm_read on answer_provenance_events for select to authenticated
  using (app.user_role() = 'advisor' and firm_id = app.user_firm_id());
create policy advisor_firm_insert on answer_provenance_events for insert to authenticated
  with check (app.user_role() = 'advisor' and firm_id = app.user_firm_id());

-- Owner: read history for their own company's assessments (mirrors the
-- owner_engagement_read policy on answer_provenance in 20260713000100).
create policy owner_engagement_read on answer_provenance_events for select to authenticated
  using (app.user_role() = 'owner' and assessment_id in (
    select a.id from assessments a join engagements e on e.id = a.engagement_id
    where e.company_id = app.user_company_id()));
