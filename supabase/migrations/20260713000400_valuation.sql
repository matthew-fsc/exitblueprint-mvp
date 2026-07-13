-- Phase 2: valuation — turning readiness into "the number". Deterministic, like
-- the DRS: versioned valuation rules (multiples + adjustments + tax defaults)
-- compute enterprise value from a recast EBITDA; no LLM ever computes a value.
--
--   recast EBITDA = reported EBITDA + defensible add-backs
--   EV (base)     = recast EBITDA × industry/size multiple × readiness factor
--   EV range      = base ± a width set by the verification tier
--   net to owner  = EV − debt − transaction costs − taxes
--
-- Multiples and assumptions are DATA (valuation_rules_versions), edited by adding
-- a new version — never by changing engine logic.

-- --- Versioned rules (methodology; readable by all, written via service_role) --
create table valuation_rules_versions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  version_label text not null unique,
  status rubric_status not null default 'active',
  effective_date date not null default current_date,
  config jsonb not null default '{}'  -- size bands, readiness/verification adj, tax + cost defaults, target DRS
);

create table valuation_multiples (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  rules_version_id uuid not null references valuation_rules_versions (id),
  industry_key text not null,
  size_band text not null,
  base_multiple numeric not null,
  unique (rules_version_id, industry_key, size_band)
);

-- --- Per-engagement recast + inputs (tenant data) ----------------------------
create type challenge_likelihood as enum ('low', 'medium', 'high', 'not_defensible');

create table ebitda_recasts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),
  engagement_id uuid not null references engagements (id) unique,
  fiscal_year int,
  reported_ebitda numeric not null default 0,
  notes text
);

create table ebitda_addbacks (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),
  recast_id uuid not null references ebitda_recasts (id) on delete cascade,
  label text not null,
  category text,
  amount numeric not null default 0,
  challenge_likelihood challenge_likelihood not null default 'medium',
  documented boolean not null default false,
  note text
);

create table valuation_inputs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),
  engagement_id uuid not null references engagements (id) unique,
  industry_key text,                    -- advisor-chosen valuation category
  multiple_override numeric,            -- optional manual multiple
  interest_bearing_debt numeric not null default 0,
  transaction_cost_pct numeric,         -- optional override of the rules default
  tax_rate numeric,                     -- optional override of the rules default
  owner_wealth_target numeric           -- the owner's "number" for the wealth gap
);

create index on ebitda_recasts (firm_id);
create index on ebitda_addbacks (recast_id);
create index on valuation_inputs (firm_id);
create index on valuation_multiples (rules_version_id);

grant select, insert, update, delete on valuation_rules_versions, valuation_multiples,
  ebitda_recasts, ebitda_addbacks, valuation_inputs to authenticated;
grant all on valuation_rules_versions, valuation_multiples,
  ebitda_recasts, ebitda_addbacks, valuation_inputs to service_role;

alter table valuation_rules_versions enable row level security;
alter table valuation_multiples enable row level security;
alter table ebitda_recasts enable row level security;
alter table ebitda_addbacks enable row level security;
alter table valuation_inputs enable row level security;

-- Rules are methodology: readable by any authenticated user, service_role writes.
create policy methodology_read on valuation_rules_versions for select to authenticated using (true);
create policy methodology_read on valuation_multiples for select to authenticated using (true);

-- Recast, add-backs, inputs: advisor firm CRUD; owner reads (to see their number).
create policy advisor_firm_all on ebitda_recasts for all to authenticated
  using (app.user_role() = 'advisor' and firm_id = app.user_firm_id())
  with check (app.user_role() = 'advisor' and firm_id = app.user_firm_id());
create policy owner_engagement_read on ebitda_recasts for select to authenticated
  using (app.user_role() = 'owner' and engagement_id in (
    select e.id from engagements e where e.company_id = app.user_company_id()));

create policy advisor_firm_all on ebitda_addbacks for all to authenticated
  using (app.user_role() = 'advisor' and firm_id = app.user_firm_id())
  with check (app.user_role() = 'advisor' and firm_id = app.user_firm_id());
create policy owner_engagement_read on ebitda_addbacks for select to authenticated
  using (app.user_role() = 'owner' and recast_id in (
    select r.id from ebitda_recasts r join engagements e on e.id = r.engagement_id
    where e.company_id = app.user_company_id()));

create policy advisor_firm_all on valuation_inputs for all to authenticated
  using (app.user_role() = 'advisor' and firm_id = app.user_firm_id())
  with check (app.user_role() = 'advisor' and firm_id = app.user_firm_id());
create policy owner_engagement_read on valuation_inputs for select to authenticated
  using (app.user_role() = 'owner' and engagement_id in (
    select e.id from engagements e where e.company_id = app.user_company_id()));
