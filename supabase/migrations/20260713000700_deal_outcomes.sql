-- The outcome-calibration moat (docs/09-moats.md). We already log process
-- *events* (LOI, QoE, retrade) in outcome_events, but never the structured
-- *result* of a deal. deal_outcomes closes that: one record per closed / broken
-- engagement, tying the PREDICTION we made (the DRS, ORI, verified %, and
-- predicted EV range at go-to-market) to the REALITY at close (final EV,
-- multiple, EBITDA, buyer type, structure, retrade, days on market, and which
-- gaps the buyer actually flagged).
--
-- Two disciplines, straight from docs/09:
--   * The reality half is advisor-reported FACT — recorded, never inferred.
--   * The prediction half is a SNAPSHOT of scores/valuation we already hold,
--     copied at record time so the comparison is frozen against what we said
--     back then, even as later assessments move the score.
-- Calibration analytics read these rows; they never write back into a score.
-- Firm-scoped like every domain table — a firm's raw deals never leak.

create type deal_outcome_kind as enum ('closed', 'broken', 'withdrawn');
create type deal_buyer_type as enum ('strategic', 'financial', 'individual', 'management', 'other');
create type deal_structure as enum ('all_cash', 'cash_and_note', 'earnout', 'equity_rollover', 'other');

create table deal_outcomes (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  firm_id uuid not null references firms (id),
  engagement_id uuid not null references engagements (id) unique,
  recorded_by uuid references profiles (id),
  outcome deal_outcome_kind not null,
  close_date date,
  days_on_market int,

  -- Prediction snapshot (copied from the latest completed assessment + valuation
  -- when the outcome is recorded; null where we never scored / valued the deal).
  predicted_from_assessment_id uuid references assessments (id),
  predicted_drs numeric,
  predicted_ori numeric,
  predicted_verified_pct numeric,
  predicted_ev_low numeric,
  predicted_ev_base numeric,
  predicted_ev_high numeric,

  -- Reality (advisor-reported fact).
  final_ev numeric,
  final_multiple numeric,
  ebitda_at_close numeric,
  buyer_type deal_buyer_type,
  structure deal_structure,
  retrade boolean not null default false,
  retrade_pct numeric,
  buyer_flagged_risks jsonb not null default '[]',  -- dimension codes or free labels the buyer raised
  notes text
);

create index on deal_outcomes (firm_id);
create index on deal_outcomes (firm_id, outcome);

grant select, insert, update, delete on deal_outcomes to authenticated;
grant all on deal_outcomes to service_role;

alter table deal_outcomes enable row level security;

-- Advisor: full CRUD within their firm. No owner policy — outcome calibration is
-- the firm's internal asset, not owner-portal content.
create policy advisor_firm_all on deal_outcomes for all to authenticated
  using (app.user_role() = 'advisor' and firm_id = app.user_firm_id())
  with check (app.user_role() = 'advisor' and firm_id = app.user_firm_id());
