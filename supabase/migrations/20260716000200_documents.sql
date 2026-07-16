-- Beta Requirement 3: document intake pipeline. Advisors (or clients) upload
-- source documents per assessment category; each moves through upload → virus
-- scan → classification → extraction (ParserAdapter) → human review → verified
-- fact. Extraction accuracy is not a beta blocker: the MANUAL review path is
-- complete (a reviewer confirms/corrects values against the source), the
-- automated path may be partial. Documents/fields NEVER write to scoring tables
-- (rule 2) — verified facts are a separate, auditable substrate.

create type document_status as enum
  ('uploaded', 'scanning', 'scanned', 'classified', 'extracting', 'in_review', 'verified', 'rejected');
create type doc_scan_status as enum ('pending', 'clean', 'infected', 'skipped');
-- Per-datapoint verification: unverified (questionnaire answer), extracted
-- (parser output, unreviewed), verified (human-confirmed against the source).
create type field_verification as enum ('unverified', 'extracted', 'verified');

create table documents (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),
  engagement_id uuid not null references engagements (id),
  category text,                       -- dimension code or free-form category
  original_filename text not null,
  mime_type text not null,
  byte_size int not null default 0,
  status document_status not null default 'uploaded',
  scan_status doc_scan_status not null default 'pending',
  classification text,                 -- label from classify step / advisor
  parser_name text,                    -- which ParserAdapter ran ('manual' = none)
  storage_key text,                    -- StorageAdapter key (beta: = documents.id)
  uploaded_by uuid references profiles (id),
  reviewed_by uuid references profiles (id),
  reviewed_at timestamptz
);
create index on documents (firm_id);
create index on documents (engagement_id);
create index on documents (status);

-- Beta byte store. R5 (security hardening) moves bytes to Supabase Storage with
-- encryption at rest + short-expiry signed URLs; the StorageAdapter seam
-- (server/documents/storage.ts) lets that swap without touching callers.
create table document_blobs (
  document_id uuid primary key references documents (id) on delete cascade,
  firm_id uuid not null references firms (id),
  bytes bytea not null
);
create index on document_blobs (firm_id);

-- Extracted or manually-entered data points tied to a document. field_key labels
-- the datapoint; question_id optionally links it to a scored question (a later
-- slice may sync a VERIFIED field into an answer — never automatically here).
create table document_fields (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),
  document_id uuid not null references documents (id) on delete cascade,
  question_id uuid references questions (id),
  field_key text not null,
  value text,
  verification_status field_verification not null default 'extracted',
  confidence numeric,                  -- parser confidence; null = manual entry
  verified_by uuid references profiles (id),
  verified_at timestamptz
);
create index on document_fields (firm_id);
create index on document_fields (document_id);

-- Parser-accuracy log: every reviewer correction of an extracted value, so we
-- can measure and improve the automated path over time.
create table field_corrections (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),
  document_field_id uuid not null references document_fields (id) on delete cascade,
  original_value text,
  corrected_value text,
  corrected_by uuid references profiles (id)
);
create index on field_corrections (firm_id);

-- Grants + RLS ----------------------------------------------------------------

grant select, insert, update, delete on documents to authenticated;
grant select, insert, update, delete on document_blobs to authenticated;
grant select, insert, update, delete on document_fields to authenticated;
grant select, insert, update, delete on field_corrections to authenticated;
grant all on documents, document_blobs, document_fields, field_corrections to service_role;

alter table documents enable row level security;
alter table document_blobs enable row level security;
alter table document_fields enable row level security;
alter table field_corrections enable row level security;

-- Staff (advisor + reviewer) get full CRUD within their firm; this is where the
-- reviewer role (added in the R1 migration) gets its first policies.
create policy staff_firm_all on documents for all to authenticated
  using (app.user_role() in ('advisor', 'reviewer') and firm_id = app.user_firm_id())
  with check (app.user_role() in ('advisor', 'reviewer') and firm_id = app.user_firm_id());
create policy staff_firm_all on document_blobs for all to authenticated
  using (app.user_role() in ('advisor', 'reviewer') and firm_id = app.user_firm_id())
  with check (app.user_role() in ('advisor', 'reviewer') and firm_id = app.user_firm_id());
create policy staff_firm_all on document_fields for all to authenticated
  using (app.user_role() in ('advisor', 'reviewer') and firm_id = app.user_firm_id())
  with check (app.user_role() in ('advisor', 'reviewer') and firm_id = app.user_firm_id());
create policy staff_firm_all on field_corrections for all to authenticated
  using (app.user_role() in ('advisor', 'reviewer') and firm_id = app.user_firm_id())
  with check (app.user_role() in ('advisor', 'reviewer') and firm_id = app.user_firm_id());

-- Owners (clients) may upload and read documents/fields for their own company's
-- engagements — "advisor or client uploads documents" — but not the QA log.
create policy owner_own_company on documents for all to authenticated
  using (app.user_role() = 'owner' and engagement_id in (
    select e.id from engagements e where e.company_id = app.user_company_id()))
  with check (app.user_role() = 'owner' and engagement_id in (
    select e.id from engagements e where e.company_id = app.user_company_id()));
create policy owner_own_company on document_blobs for all to authenticated
  using (app.user_role() = 'owner' and document_id in (
    select d.id from documents d join engagements e on e.id = d.engagement_id
    where e.company_id = app.user_company_id()))
  with check (app.user_role() = 'owner' and document_id in (
    select d.id from documents d join engagements e on e.id = d.engagement_id
    where e.company_id = app.user_company_id()));
create policy owner_own_company on document_fields for all to authenticated
  using (app.user_role() = 'owner' and document_id in (
    select d.id from documents d join engagements e on e.id = d.engagement_id
    where e.company_id = app.user_company_id()))
  with check (app.user_role() = 'owner' and document_id in (
    select d.id from documents d join engagements e on e.id = d.engagement_id
    where e.company_id = app.user_company_id()));
