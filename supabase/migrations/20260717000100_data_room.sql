-- Work stream B (docs/15): Data Room Readiness. The buyer's diligence request
-- list — the ammunition from a real deal — turned into the CLIENT's pre-built
-- checklist, assembled across the 12–36-month pre-deal window instead of
-- scrambled during a live deal. Deterministic, no LLM: nothing here computes or
-- writes a score (rule 2 untouched); readiness is advisor/owner-entered fact.
--
-- The template (sections + items) is GLOBAL methodology, like the rubric —
-- readable by every authenticated user, written only by the seed. Per-engagement
-- readiness is firm-scoped tenant data under RLS. An item that maps to a scored
-- gap carries that gap's code (docs/15 decision 4: the data room and the gap
-- taxonomy are one taxonomy, never two parallel lists) — a soft reference so the
-- template stays independent of any single rubric_version.

create type data_room_state as enum
  ('not_started', 'in_progress', 'ready', 'gap', 'not_applicable');

-- Global template: the seven buyer diligence sections.
create table data_room_sections (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  code text not null unique,
  name text not null,
  description text,
  sort_order int not null default 0
);

-- Global template: the individual diligence requests within a section.
create table data_room_items (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  section_code text not null references data_room_sections (code),
  code text not null unique,
  label text not null,
  description text,
  buyer_rationale text,                       -- why a buyer asks (client education)
  applies_to text not null default 'all',     -- 'all' | 'product' | 'services' | …
  gap_code text,                              -- soft ref to gap_definitions.code
  sort_order int not null default 0
);
create index on data_room_items (section_code);

-- Per-engagement readiness: one row per (engagement, item), lazily created the
-- first time a state is set. Optionally links to an uploaded source document
-- (the R3 documents pipeline) as the evidence that an item is "ready".
create table engagement_data_room_items (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),
  engagement_id uuid not null references engagements (id),
  item_code text not null references data_room_items (code),
  readiness_state data_room_state not null default 'not_started',
  note text,
  document_id uuid references documents (id) on delete set null,
  updated_by uuid references profiles (id),
  unique (engagement_id, item_code)
);
create index on engagement_data_room_items (firm_id);
create index on engagement_data_room_items (engagement_id);

-- Grants + RLS ---------------------------------------------------------------

grant select on data_room_sections to authenticated;
grant select on data_room_items to authenticated;
grant select, insert, update, delete on engagement_data_room_items to authenticated;
grant all on data_room_sections, data_room_items, engagement_data_room_items to service_role;

alter table data_room_sections enable row level security;
alter table data_room_items enable row level security;
alter table engagement_data_room_items enable row level security;

-- Template is global methodology: readable by every authenticated user (the seed
-- writes it via service_role, which bypasses RLS).
create policy methodology_read on data_room_sections for select to authenticated using (true);
create policy methodology_read on data_room_items for select to authenticated using (true);

-- Staff (advisor + reviewer) get full CRUD within their firm.
create policy staff_firm_all on engagement_data_room_items for all to authenticated
  using (app.user_role() in ('advisor', 'reviewer') and firm_id = app.user_firm_id())
  with check (app.user_role() in ('advisor', 'reviewer') and firm_id = app.user_firm_id());

-- Owners maintain their own company's data room — they are the ones assembling
-- the binder — mirroring the documents pipeline's owner policy.
create policy owner_own_company on engagement_data_room_items for all to authenticated
  using (app.user_role() = 'owner' and engagement_id in (
    select e.id from engagements e where e.company_id = app.user_company_id()))
  with check (app.user_role() = 'owner' and engagement_id in (
    select e.id from engagements e where e.company_id = app.user_company_id()));
