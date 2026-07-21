-- Firm professional directory, 2026-07-21.
--
-- A bigger advisory practice works with the same outside professionals — the
-- clients' CPAs, attorneys, M&A advisors, bankers — across many engagements.
-- Until now the only record of them was per-engagement (engagement_collaborators,
-- a VIEW-ONLY portal login re-typed one engagement at a time). This adds a
-- firm-level ADDRESS BOOK of those professionals: a reusable contact record the
-- firm curates once and attaches to any engagement's deal team.
--
-- Two tables, one concern each:
--   firm_professionals    — the directory entry (contact record; NOT a login)
--   engagement_professionals — which directory entry is on which engagement
--
-- This is deliberately distinct from engagement_collaborators: a directory entry
-- is firm knowledge (who we work with), a collaborator is an actual scoped portal
-- login. A directory entry can later seed a collaborator invite, but the two are
-- not the same row and are not coupled here.
--
-- Enforcement (org controls for a practice of 5): the DIRECTORY is a firm-level
-- org asset, so only admins write it; all firm staff read it. The per-engagement
-- LINK is client work, so any firm staff (advisor/reviewer/admin) manage it. That
-- is exactly the admin-administers / advisor-does-the-work split this slice draws.

-- Descriptive kinds for the outside professionals a firm works with. Superset of
-- collaborator_kind (adds m&a advisor, banker, wealth manager, insurance) since
-- the directory is broader than the view-only-portal roster.
create type professional_kind as enum (
  'cpa', 'attorney', 'ma_advisor', 'banker', 'wealth_manager', 'insurance', 'other'
);

-- The directory entry. Firm-scoped; archived (not deleted) so historical
-- engagement links keep a resolvable name.
create table firm_professionals (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),
  full_name text not null,
  organization text,                              -- their own firm / practice name
  kind professional_kind not null default 'other',
  email text,
  phone text,
  notes text,                                     -- internal notes (relationship, specialty)
  archived boolean not null default false,
  created_by uuid references profiles (id)
);
create index on firm_professionals (firm_id);

create trigger firm_professionals_touch
  before update on firm_professionals
  for each row execute function app.touch_updated_at();

-- The per-engagement link: this directory professional is engaged on this deal,
-- in a role specific to the deal (free text — "buy-side QoE", "deal counsel").
create table engagement_professionals (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),
  engagement_id uuid not null references engagements (id) on delete cascade,
  professional_id uuid not null references firm_professionals (id) on delete cascade,
  engagement_role text,
  added_by uuid references profiles (id),
  unique (engagement_id, professional_id)         -- one link per (engagement, professional)
);
create index on engagement_professionals (firm_id);
create index on engagement_professionals (engagement_id);
create index on engagement_professionals (professional_id);

-- ── RLS ────────────────────────────────────────────────────────────────────────
-- Directory: staff read, ADMIN write (org asset). The staff read policy and the
-- admin write policy are separate permissive policies; Postgres ORs them, so an
-- admin both reads (via either policy) and writes, while advisors/reviewers can
-- only read. This is the firm-scoped equivalent of firm_branding's read/write
-- split, tightened so writes are admin-only.
grant select, insert, update, delete on firm_professionals to authenticated;
grant all on firm_professionals to service_role;
alter table firm_professionals enable row level security;

create policy firm_professionals_staff_read on firm_professionals for select to authenticated
  using (app.user_role() = any (array['advisor','reviewer','admin']::app_role[])
         and firm_id = app.user_firm_id());

create policy firm_professionals_admin_write on firm_professionals for all to authenticated
  using (app.user_role() = 'admin' and firm_id = app.user_firm_id())
  with check (app.user_role() = 'admin' and firm_id = app.user_firm_id());

-- Links: any firm staff manage them (attaching a professional to an engagement is
-- client work, not org administration).
grant select, insert, update, delete on engagement_professionals to authenticated;
grant all on engagement_professionals to service_role;
alter table engagement_professionals enable row level security;

create policy engagement_professionals_staff_all on engagement_professionals for all to authenticated
  using (app.user_role() = any (array['advisor','reviewer','admin']::app_role[])
         and firm_id = app.user_firm_id())
  with check (app.user_role() = any (array['advisor','reviewer','admin']::app_role[])
         and firm_id = app.user_firm_id());
