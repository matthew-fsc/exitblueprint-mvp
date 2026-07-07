-- Outcome capture (S4.5 A1): deal-process outcomes per engagement.
-- Schema + RLS only — no UI or API in v1. This data is the training substrate
-- for future rubric calibration; it is only ever recorded from advisor-reported
-- facts, never backfilled speculatively (docs/02).

create type process_status as enum
  ('not_in_market', 'preparing', 'in_market', 'under_loi', 'closed', 'withdrawn', 'broken');

create type outcome_event_type as enum
  ('loi_received', 'loi_expired', 'ioi_received', 'qoe_started', 'qoe_findings_recorded',
   'retrade', 'price_change', 'deal_closed', 'deal_broken', 'withdrawn_from_market');

-- One row per engagement, created lazily; everything nullable.
create table engagement_outcomes (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),
  engagement_id uuid not null unique references engagements (id),
  process_status process_status,
  outcome_recorded_at timestamptz
);

-- Append-only event log per engagement. Corrections happen by appending a
-- correcting event, mirroring assessment immutability.
create table outcome_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),
  engagement_id uuid not null references engagements (id),
  event_type outcome_event_type not null,
  event_date date,
  recorded_by uuid references profiles (id),
  numeric_value numeric, -- e.g. multiple achieved, retrade %, QoE findings count
  detail jsonb,
  notes text
);

create index on engagement_outcomes (firm_id);
create index on outcome_events (firm_id);
create index on outcome_events (engagement_id);

create or replace function app.touch_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger engagement_outcomes_touch
  before update on engagement_outcomes
  for each row execute function app.touch_updated_at();

-- Grants (the blanket grant in the RLS migration predates these tables).
-- outcome_events deliberately gets no UPDATE/DELETE privilege for
-- authenticated: append-only for non-admin roles (service_role bypasses).
grant select, insert, update, delete on engagement_outcomes to authenticated;
grant select, insert on outcome_events to authenticated;
grant all on engagement_outcomes, outcome_events to service_role;

alter table engagement_outcomes enable row level security;
alter table outcome_events enable row level security;

create policy advisor_firm_all on engagement_outcomes for all to authenticated
  using (app.user_role() = 'advisor' and firm_id = app.user_firm_id())
  with check (app.user_role() = 'advisor' and firm_id = app.user_firm_id());

-- Append-only: select + insert policies only; no update/delete policy exists,
-- so both are denied for authenticated even beyond the missing grant.
create policy advisor_firm_read on outcome_events for select to authenticated
  using (app.user_role() = 'advisor' and firm_id = app.user_firm_id());

create policy advisor_firm_insert on outcome_events for insert to authenticated
  with check (app.user_role() = 'advisor' and firm_id = app.user_firm_id());
