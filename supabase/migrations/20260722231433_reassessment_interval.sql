-- Per-engagement re-assessment cadence. The platform re-scores an engagement on
-- a cadence (the "monitor" loop, docs/00) but that cadence lived only as a single
-- hardcoded 90-day constant in server/scheduled.ts, surfaced backward-looking on
-- the dashboard ("last assessed N days ago") and never as a forward due-date on
-- the engagement itself. This column lets an advisor vary the cadence per client;
-- null keeps the platform default (DEFAULT_REASSESS_INTERVAL_DAYS = 90), so
-- existing engagements are unchanged. The derived "re-assess by <date>" surface
-- and the dashboard "reassessment due" flag both read it, defaulting to 90.
alter table engagements
  add column if not exists reassessment_interval_days int;

-- Guard: a cadence must be a sane positive number of days when set (null = default).
alter table engagements
  add constraint engagements_reassessment_interval_days_check
  check (reassessment_interval_days is null or reassessment_interval_days between 7 and 3650);
