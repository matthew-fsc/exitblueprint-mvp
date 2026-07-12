-- Advisory Library: a single catalog that unifies the three things an advisor
-- reaches for when coaching an owner toward a sale — the questions a buyer will
-- ask (buyer_question), the value-creating actions to take (initiative), and the
-- red flags a buyer's diligence will surface (risk_flag). Each item can fire off
-- a live score: when the governing DRS sub-score (or dimension) is at or below
-- score_trigger, the item surfaces on the engagement, critical-first.
--
-- Global vs tenant (audit debt #8, decided): system-curated items are GLOBAL
-- (firm_id null, readable by everyone, methodology-like); advisor-authored items
-- are TENANT-scoped (firm_id set, firm-isolated by RLS). source records which.

create type advisory_item_type as enum ('buyer_question', 'initiative', 'risk_flag');
create type advisory_source as enum ('system', 'advisor');

create table advisory_library_items (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  firm_id uuid references firms (id),           -- null = global/system catalog
  source advisory_source not null default 'advisor',
  item_type advisory_item_type not null,
  code text,                                     -- stable code for system items
  title text not null,
  body text not null,                           -- the question / action / flag
  response_framework text,                      -- how to answer / mitigate
  data_needed text,                             -- documentation the item requires
  dimension_code text,                          -- DRS category that governs firing
  sub_score_code text,                          -- finer trigger (optional)
  severity gap_severity,
  buyer_type text,                              -- strategic / financial (buyer_qs)
  score_trigger int,                            -- fires when governing score <= this
  active boolean not null default true,
  sort_order int not null default 0,
  created_by uuid references profiles (id)
);

-- System rows are keyed by code for idempotent re-seeding; advisor rows have no code.
create unique index advisory_library_system_code
  on advisory_library_items (code) where firm_id is null;
create index on advisory_library_items (firm_id);
create index on advisory_library_items (item_type);
create index on advisory_library_items (dimension_code);

grant select, insert, update, delete on advisory_library_items to authenticated;
grant all on advisory_library_items to service_role;

alter table advisory_library_items enable row level security;

-- Global catalog: readable by any authenticated user; writes via service_role only.
create policy library_system_read on advisory_library_items for select to authenticated
  using (firm_id is null);

-- Advisor-authored items: full CRUD within the advisor's own firm.
create policy library_advisor_all on advisory_library_items for all to authenticated
  using (app.user_role() = 'advisor' and firm_id = app.user_firm_id())
  with check (app.user_role() = 'advisor' and firm_id = app.user_firm_id());
