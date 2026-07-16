-- Beta Requirement 1: data-rights capture. Before any assessment data is
-- collected for a client engagement, the advisor records acceptance of a
-- specific, immutable engagement-agreement version plus the client's data-use
-- consents. The agreement version in force is stamped onto every assessment as
-- provenance. The DRS is never touched — this only GATES and ANNOTATES inputs
-- (non-negotiable rule 2: AI/consent layers never write to scoring).

-- Beta roles are admin | advisor | reviewer (+ owner for the portal). The
-- reviewer role is added now; the document-review queue that uses it lands with
-- Requirement 3. Additive — PG12+ permits ADD VALUE inside the per-migration
-- transaction scripts/migrate.ts uses; the value is not referenced in this file.
alter type app_role add value if not exists 'reviewer';

create type agreement_status as enum ('draft', 'active', 'retired');

-- Immutable, full-text agreement versions, scoped per firm. A new version is a
-- new row; rows are never edited (UPDATE/DELETE grants are withheld from
-- authenticated). Acceptances reference the exact version accepted.
create table agreement_versions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),
  version_label text not null,
  title text not null,
  body_md text not null,
  status agreement_status not null default 'active',
  effective_date date not null default current_date,
  created_by uuid references profiles (id),
  unique (firm_id, version_label)
);
create index on agreement_versions (firm_id);

-- Per-engagement acceptance: which version was accepted, by whom, and the three
-- data-use consents. One acceptance per engagement (re-acceptance on a new
-- version is a later slice). This row is the gate: no assessment may be created
-- for an engagement that lacks it (trigger below).
create table engagement_agreements (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),
  engagement_id uuid not null unique references engagements (id),
  agreement_version_id uuid not null references agreement_versions (id),
  accepted_by uuid references profiles (id),   -- advisor who recorded acceptance
  accepted_signer_name text,                   -- client signatory captured
  accepted_at timestamptz not null default now(),
  consent_benchmarking boolean not null default false,
  consent_anonymized_aggregation boolean not null default false,
  consent_outcome_tracking boolean not null default false
);
create index on engagement_agreements (firm_id);
create index on engagement_agreements (agreement_version_id);

-- The agreement version in force when an assessment's data was collected
-- (provenance). Populated automatically by the gate trigger, never by callers.
alter table assessments add column agreement_version_id uuid references agreement_versions (id);

-- Gate + stamp. Blocks any assessment for an engagement with no accepted
-- agreement and records the accepted version on the row. security definer so it
-- reads the acceptance regardless of the writer's RLS; fires for every writer,
-- RLS-bypassing service_role included. This is the DB-hard guarantee behind
-- acceptance criterion 1 ("no assessment data before acceptance").
create or replace function app.require_agreement_before_assessment()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_version uuid;
begin
  select agreement_version_id into v_version
  from engagement_agreements where engagement_id = new.engagement_id;
  if v_version is null then
    raise exception
      'engagement % has no accepted agreement; record acceptance before collecting assessment data',
      new.engagement_id using errcode = 'check_violation';
  end if;
  new.agreement_version_id := v_version;
  return new;
end $$;

create trigger require_agreement_before_assessment
  before insert on assessments
  for each row execute function app.require_agreement_before_assessment();

-- Grants + RLS ----------------------------------------------------------------

grant select, insert on agreement_versions to authenticated;  -- immutable: no update/delete
grant all on agreement_versions to service_role;
grant select, insert, update, delete on engagement_agreements to authenticated;
grant all on engagement_agreements to service_role;

alter table agreement_versions enable row level security;
alter table engagement_agreements enable row level security;

-- agreement_versions: anyone in the firm may read; advisors may add versions.
create policy firm_read on agreement_versions for select to authenticated
  using (firm_id = app.user_firm_id());
create policy advisor_insert on agreement_versions for insert to authenticated
  with check (app.user_role() = 'advisor' and firm_id = app.user_firm_id());

-- engagement_agreements: advisor full CRUD within firm; owner reads own company.
create policy advisor_firm_all on engagement_agreements for all to authenticated
  using (app.user_role() = 'advisor' and firm_id = app.user_firm_id())
  with check (app.user_role() = 'advisor' and firm_id = app.user_firm_id());
create policy owner_engagement_read on engagement_agreements for select to authenticated
  using (app.user_role() = 'owner' and engagement_id in (
    select e.id from engagements e where e.company_id = app.user_company_id()));

-- Backfill --------------------------------------------------------------------
-- Existing engagements predate this gate. Give each firm a retired placeholder
-- version and a backfilled acceptance (no explicit consent — flags stay false,
-- honestly recording that none was captured) so historical engagements remain
-- writable, then stamp existing assessments with the version now in force.
insert into agreement_versions (firm_id, version_label, title, body_md, status, effective_date)
select distinct e.firm_id, 'MIGRATED-0', 'Migrated engagement agreement (backfill)',
  'Placeholder created during the data-rights migration. No agreement text or consent was captured for engagements that predate consent capture.',
  'retired'::agreement_status, current_date
from engagements e
where not exists (select 1 from agreement_versions av where av.firm_id = e.firm_id)
on conflict (firm_id, version_label) do nothing;

insert into engagement_agreements
  (firm_id, engagement_id, agreement_version_id, accepted_signer_name)
select e.firm_id, e.id, av.id, 'backfilled — no explicit consent captured'
from engagements e
join agreement_versions av on av.firm_id = e.firm_id and av.version_label = 'MIGRATED-0'
where not exists (select 1 from engagement_agreements ea where ea.engagement_id = e.id)
on conflict (engagement_id) do nothing;

update assessments a
set agreement_version_id = ea.agreement_version_id
from engagement_agreements ea
where ea.engagement_id = a.engagement_id and a.agreement_version_id is null;
