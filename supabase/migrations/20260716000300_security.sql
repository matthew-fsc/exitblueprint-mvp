-- Beta Requirement 5: security baseline. Two schema pieces support it:
--   (1) document bytes are encrypted at rest — document_blobs.enc_algo records
--       which envelope a row uses ('aes-256-gcm'; null = legacy plaintext), so
--       the StorageAdapter can read old and new rows during/after rollout.
--   (2) a firm-scoped audit log of access to client records (documents, reports).
-- MFA and short-expiry signed document URLs are enforced in code, not schema.

alter table document_blobs add column enc_algo text; -- null = plaintext (legacy)

-- Append-only access log. Written server-side (service_role) whenever a client
-- record is read; readable by the firm's advisors/reviewers for compliance.
create table data_access_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),
  actor_user_id uuid,               -- auth.users id of the accessor
  actor_profile_id uuid references profiles (id),
  action text not null,             -- e.g. 'document.read', 'report.download'
  resource_type text not null,      -- e.g. 'document', 'owner_report'
  resource_id uuid,
  engagement_id uuid references engagements (id),
  detail jsonb
);
create index on data_access_log (firm_id, created_at desc);
create index on data_access_log (resource_type, resource_id);

-- Only the server (service_role) writes; advisors/reviewers read their firm's log.
grant select on data_access_log to authenticated;
grant all on data_access_log to service_role;

alter table data_access_log enable row level security;
create policy staff_firm_read on data_access_log for select to authenticated
  using (app.user_role() in ('advisor', 'reviewer') and firm_id = app.user_firm_id());
