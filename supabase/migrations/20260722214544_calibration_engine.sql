-- Outcome Calibration Engine — the "FICO moat" (docs/09-moats.md §1, docs/40 §3).
-- The paired prediction↔reality corpus in `deal_outcomes` is the substrate; this
-- migration adds the store for a VERSIONED calibration artifact computed from it:
-- for each DRS (and, where sample allows, ORI) score band — sample size, close
-- rate, median/interquartile realized multiple, median time-to-close, within-range
-- hit rate, EV variance, and retrade rate. i.e. "companies at DRS 70–75 close at
-- ~4.8× within ~14 months, 82% of the time."
--
-- WHY A SNAPSHOT (not just a view): a calibration is a VERSIONED artifact
-- (CLAUDE.md rule #6). Each recompute inserts a new `calibration_version` row +
-- its band rows, frozen. The bands are computed deterministically by rule-based
-- code (server/calibration.ts → shared/calibration/compute.ts); no LLM touches
-- them (rule #1). Calibration NEVER edits a score — it informs the rubric only via
-- a future rubric_version (rules #1, #3, #4). Assessments stay immutable.
--
-- ISOLATION GUARANTEE (CLAUDE.md rule #5): this is CROSS-FIRM aggregate
-- intelligence, so — exactly like platform_analytics / financial_corpus / moat_kpis
-- — it lives in the dedicated `analytics` schema granted to `service_role` ONLY.
-- `authenticated`/`anon` get no usage on the schema and no select on these tables,
-- so a tenant role can never read them (scripts/rls-test.ts asserts the denial).
-- The single reader is the superadmin-gated GET /internal/metrics route
-- (server/http.ts) on the service-role, RLS-bypass connection. Every row is a
-- de-identified score-band aggregate — no firm_id, no company id, no PII; a band's
-- `contributing_firms` count powers the `low_confidence` guard for thin cells.
--
-- The `analytics` schema, its lockdown, and its service-role default privileges
-- already exist (20260721000700_platform_analytics.sql). We only add objects here.

-- ── Snapshot header: one row per computed calibration version ────────── business
create table analytics.calibration_versions (
  calibration_version bigint generated always as identity primary key,
  computed_at timestamptz not null default now(),
  band_width int not null, -- score points per band (5 → "70–75")
  min_sample int not null, -- bands below this are flagged low_confidence
  total_outcomes int not null, -- size of the corpus this version was computed from
  total_closed int not null,
  contributing_firms int not null,
  notes text
);

-- ── Per-band calibration rows, tied to a version ──────────────────────── business
-- group_key: 'drs' (rolls into the DRS) or 'ori' (Owner Readiness Index) — the two
-- score groups are never mixed (CLAUDE.md rule #3a). One row per (version, group,
-- band). All numeric cells are aggregate statistics over the band's outcomes.
create table analytics.calibration_bands (
  calibration_version bigint not null
    references analytics.calibration_versions (calibration_version) on delete cascade,
  group_key text not null check (group_key in ('drs', 'ori')),
  band_low int not null,
  band_high int not null,
  band_label text not null, -- "70–75"
  sample_n int not null, -- outcomes of any kind whose predicted score lands in this band
  closed_n int not null, -- of those, the ones that closed
  contributing_firms int not null, -- distinct firms (de-identification guard)
  close_rate_pct numeric, -- closed / sample_n, %
  median_multiple numeric, -- realized EV/EBITDA multiple over closed deals
  p25_multiple numeric,
  p75_multiple numeric,
  median_days_to_close numeric,
  within_range_hit_rate_pct numeric, -- closed deals whose final EV landed in the predicted band
  ev_variance_pct numeric, -- median (final − predicted_base) / predicted_base, %
  retrade_rate_pct numeric,
  low_confidence boolean not null default false,
  primary key (calibration_version, group_key, band_low)
);

create index on analytics.calibration_bands (calibration_version);

-- Convenience read: the bands of the most recent version (what the operator rail
-- reads). service_role-only like everything in this schema.
create view analytics.calibration_latest as
select v.calibration_version, v.computed_at, v.band_width, v.min_sample,
       v.total_outcomes, v.total_closed, v.contributing_firms,
       b.group_key, b.band_low, b.band_high, b.band_label, b.sample_n, b.closed_n,
       b.contributing_firms as band_contributing_firms, b.close_rate_pct,
       b.median_multiple, b.p25_multiple, b.p75_multiple, b.median_days_to_close,
       b.within_range_hit_rate_pct, b.ev_variance_pct, b.retrade_rate_pct,
       b.low_confidence
from analytics.calibration_bands b
join analytics.calibration_versions v on v.calibration_version = b.calibration_version
where b.calibration_version = (select max(calibration_version) from analytics.calibration_versions);

-- Grants. The schema default privileges (20260721000700) already extend SELECT on
-- future tables/views to service_role; the compute path also needs INSERT (and the
-- identity sequence), so grant those explicitly. service_role ONLY — never
-- authenticated/anon (the schema has no usage grant to them, so this is
-- belt-and-suspenders).
grant select, insert on analytics.calibration_versions to service_role;
grant select, insert on analytics.calibration_bands to service_role;
grant usage, select on sequence analytics.calibration_versions_calibration_version_seq to service_role;
grant select on analytics.calibration_latest to service_role;
