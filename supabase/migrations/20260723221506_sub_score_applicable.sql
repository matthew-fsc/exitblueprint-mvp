-- DRS-2.0 age-aware scoring (docs/07): a sub-score can be Not Applicable for an
-- assessment (insufficient operating history, or inapplicable to the revenue
-- model). N/A sub-scores are excluded from their dimension, which re-normalizes
-- over the remaining weights. Persist the flag so the descriptive layers
-- (advisory library, explain trace) don't treat a non-counted sub-score's points
-- as a real signal. Default true keeps every existing row (all applicable) correct.
alter table sub_score_results
  add column if not exists applicable boolean not null default true;
