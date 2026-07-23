-- Buyer matching (buyer-matching design doc), 2026-07-23.
--
-- The reframe that makes buyer matching tractable: the CFP / M&A advisor already
-- HAS buyers. We do not discover the market (a losing fight with the data
-- vendors, and stale on arrival); we CODIFY the advisor's own book of
-- relationships into structured mandates and match assessed companies against
-- them DETERMINISTICALLY. It is the firm's proprietary relationship data and no
-- vendor can replicate it.
--
-- Three firm-scoped tables, each one concern:
--   buyers          — the advisor's own book (a contact record; NOT a login),
--                     modeled on firm_professionals: a firm-level org asset the
--                     admin curates once and matches against any engagement.
--   buyer_mandates  — the versioned acquisition thesis (one buyer → many
--                     mandates: a PE platform can carry several add-on theses).
--   buyer_matches   — the COMPUTED, ranked snapshot tying an engagement to the
--                     firm's buyers. Written by the deterministic engine, never
--                     hand-authored (CLAUDE.md rule 1: no LLM ranks a match; the
--                     rank is rule-based, versioned code, exactly like the DRS).
--
-- Non-negotiables this migration honors:
--   * firm_id on every table; RLS firm-isolated — a firm NEVER sees another
--     firm's buyers or mandates (CLAUDE.md rule 5). The buyer book is the firm's
--     crown jewels; this is verified by npm run test:rls, not by inspection.
--   * Buyers/mandates are staff-curated (advisor/reviewer/admin read AND write) —
--     the current self-serve firm_professionals pattern (20260721001300): the
--     advisor owns the relationship, so the book isn't routed through an admin.
--   * Matches are firm-staff intelligence, never owner-facing: no owner policy
--     (mirrors the engagement-comparables boundary — a firm's buyer book must not
--     be enumerable by an owner or a scoped collaborator).
--   * The cross-firm anonymized buyer-activity pool is the benchmarking layer,
--     explicitly OUT OF SCOPE here — nothing in this migration reads across firms.

-- The buyer taxonomy spans both channels in one object (the ratified Q1 call):
-- the M&A advisor's strategic acquirers AND the CFP's succession paths
-- (family office, ESOP/internal). Distinct from the coarser deal_buyer_type on
-- deal_outcomes (which records what closed); this is the finer book taxonomy.
create type buyer_kind as enum (
  'strategic', 'financial_sponsor', 'family_office', 'search_fund',
  'individual', 'strategic_competitor', 'esop_internal'
);

create type buyer_status as enum ('active', 'dormant', 'acquired_recently', 'do_not_contact');

-- The book entry. Firm-scoped; archived (not deleted) so historical matches keep
-- a resolvable name.
create table buyers (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),
  name text not null,
  organization text,                                    -- the acquirer's own entity name
  buyer_kind buyer_kind not null default 'strategic',
  relationship_strength text not null default 'unknown' -- the advisor's own read
    check (relationship_strength in ('strong', 'moderate', 'weak', 'unknown')),
  status buyer_status not null default 'active',
  contact_name text,
  contact_email text,
  notes text,                                           -- internal (specialty, history)
  archived boolean not null default false,
  created_by uuid references profiles (id)
);
create index on buyers (firm_id);

create trigger buyers_touch
  before update on buyers
  for each row execute function app.touch_updated_at();

-- The versioned acquisition thesis. Matched on the axes the company already
-- carries (industry, revenue_band, ebitda_band, state) — narrow-but-structured
-- (the ratified Q2 call) — plus the fields that make a match SHARP:
-- deal-structure appetite, must-haves, and dealbreakers. A revised thesis is a
-- new row (mandate_version bumps), never an edit — rule 6 versioning discipline.
create table buyer_mandates (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),
  buyer_id uuid not null references buyers (id) on delete cascade,
  mandate_version int not null default 1,
  label text,                                           -- e.g. "Southeast HVAC add-ons"
  target_industries text[] not null default '{}',       -- match on companies.industry
  target_revenue_bands text[] not null default '{}',    -- match on companies.revenue_band
  target_ebitda_bands text[] not null default '{}',     -- match on companies.ebitda_band
  target_states text[] not null default '{}',           -- match on companies.state
  deal_structures text[] not null default '{}',         -- appetite (context; not scored)
  must_haves text[] not null default '{}',              -- free-text thesis requirements
  dealbreaker_gap_codes text[] not null default '{}',   -- gap_definition codes that BLOCK a fit while open
  min_drs numeric,                                       -- readiness floor; null = no floor
  status text not null default 'active' check (status in ('active', 'retired')),
  notes text,
  created_by uuid references profiles (id)
);
create index on buyer_mandates (firm_id);
create index on buyer_mandates (buyer_id);

create trigger buyer_mandates_touch
  before update on buyer_mandates
  for each row execute function app.touch_updated_at();

-- The computed ranked snapshot. One row per (engagement, mandate) at the last
-- compute; the engine replaces an engagement's rows on each run (latest-snapshot
-- semantics). Per-assessment immutable match history is a later refinement (it
-- rides on the deal_outcomes → buyer_id linkage, docs/09 moat loop).
create table buyer_matches (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),
  engagement_id uuid not null references engagements (id) on delete cascade,
  assessment_id uuid references assessments (id),        -- the assessment whose DRS/gaps drove the match
  buyer_id uuid not null references buyers (id) on delete cascade,
  mandate_id uuid not null references buyer_mandates (id) on delete cascade,
  mandate_version int not null,
  match_score numeric not null,
  blocked boolean not null default false,               -- a dealbreaker gap is open, or min_drs unmet
  match_factors jsonb not null default '[]',            -- the explain trace (why it fits)
  blockers jsonb not null default '[]',                 -- what to clear to unblock (the dynamic view)
  computed_at timestamptz not null default now()
);
create index on buyer_matches (firm_id);
create index on buyer_matches (engagement_id);

-- ── RLS ────────────────────────────────────────────────────────────────────────
-- Buyers + mandates: any firm STAFF (advisor/reviewer/admin) reads AND writes
-- their own firm's rows — a single staff-all policy, mirroring the current
-- self-serve firm_professionals (20260721001300). The advisor is the person WITH
-- the buyer relationship; routing the book through an admin is exactly the
-- friction that migration removed for the rolodex, and the argument is stronger
-- for buyers. Firm isolation is unchanged: firm_id must be the caller's firm on
-- every row.
grant select, insert, update, delete on buyers to authenticated;
grant all on buyers to service_role;
alter table buyers enable row level security;

create policy buyers_staff_all on buyers for all to authenticated
  using (app.user_role() = any (array['advisor','reviewer','admin']::app_role[])
         and firm_id = app.user_firm_id())
  with check (app.user_role() = any (array['advisor','reviewer','admin']::app_role[])
         and firm_id = app.user_firm_id());

grant select, insert, update, delete on buyer_mandates to authenticated;
grant all on buyer_mandates to service_role;
alter table buyer_mandates enable row level security;

create policy buyer_mandates_staff_all on buyer_mandates for all to authenticated
  using (app.user_role() = any (array['advisor','reviewer','admin']::app_role[])
         and firm_id = app.user_firm_id())
  with check (app.user_role() = any (array['advisor','reviewer','admin']::app_role[])
         and firm_id = app.user_firm_id());

-- Matches: firm staff READ; the deterministic engine writes them under the
-- service role (grant all to service_role). NO owner policy — the firm's buyer
-- book must never be enumerable by an owner or a scoped collaborator, exactly
-- like engagement-comparables.
grant select on buyer_matches to authenticated;
grant all on buyer_matches to service_role;
alter table buyer_matches enable row level security;

create policy buyer_matches_staff_read on buyer_matches for select to authenticated
  using (app.user_role() = any (array['advisor','reviewer','admin']::app_role[])
         and firm_id = app.user_firm_id());
