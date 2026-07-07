# 03 - Scoring Engine Spec

## Contract

`scoreAssessment(assessment_id) -> { drs_score, drs_tier, ori_score, dimension_scores[], sub_score_results[], gaps_opened[], gaps_resolved[], flags[] }`

Deterministic. No network calls except the database. No LLM involvement under any circumstances.

**The executable reference implementation is /seed/fixtures/reference_scorer.py.**
The production engine is correct when it reproduces the fixture expected outputs exactly.
Where prose and reference implementation disagree, the reference implementation wins;
flag the discrepancy for Matthew.

## Computation pipeline

1. Load assessment, rubric (dimensions, questions, sub_scores, gap_definitions for its rubric_version), answers.
2. Validate completeness: every scored question answered (or explicitly skipped with reason -> validation error for v1).
3. Compute each sub-score via its formula_type (below). Persist points + computed_inputs (explain trace).
4. Dimension score = sum(sub_score.weight x points) within the dimension. Weights sum to 1.0 per dimension.
5. DRS = sum(dimension score x drs_weight) over business_readiness dimensions. Round to 1 decimal.
6. Tier: >=85 Institutional Grade; 70-84 Sale Ready; 55-69 Needs Work; 40-54 High Risk; <40 Not Saleable (Yet).
7. ORI = sum of ORI sub-score weights x points (owner_readiness group; never enters DRS).
8. Evaluate gap triggers; open/resolve gaps on the engagement.
9. Persist everything + completed_at in one transaction.

## Formula types

- **band_gte**: higher is better. Bands sorted descending; first band where value >= threshold wins (lower-bound inclusive).
- **band_ascending**: lower is better. Bands sorted ascending on strict less-than; else-value if none match.
- **select_map / scale_map**: direct mapping; scale_map formula (v-1)*25 for 1-5 scales.
- **hhi_from_top5**: HHI_est = sum(share_i^2) over top-5 shares in percent. Band via bands_lt. If top-1 share > 30, cap points at 60.
- **durability**: 100 x min(1, coverage/75) x min(1, months/18), rounded 2dp.
- **growth_consistency**: from annual revenue list: CAGR = (last/first)^(1/(n-1)) - 1; down = count of YoY declines. cagr>=15% and down==0 ->100; cagr>=10% and down<=1 ->75; cagr>=5% and down<=1 ->50; cagr<0 ->0; else 25.
- **cagr_band**: same CAGR input, banded (>=20 ->100, >=15 ->85, >=10 ->65, >=5 ->40, >=0 ->20, negative ->0).
- **depth_ratio**: managers/functions: >=1.0 ->100, >=0.75 ->75, >=0.5 ->40, else 10.
- **pipeline_ratio**: pipeline_dollars / most recent annual revenue: 0 or no pipeline ->0; >=3 ->100, >=2 ->70, >=1 ->35, else 0.
- **top1_band / top5_band**: derived from the top-5 shares list (first element / sum), banded via bands_lt.

## Unknown policy

numeric_or_unknown answered "unknown" scores the sub-score's declared unknown value (NRR: 25) and appends a not-tracked flag. Flags surface in the advisor UI and narrative payloads.

## Trigger types

- `sub_score_below`: {code, threshold} - fires when that sub-score's points < threshold
- `answer_in`: {question_code, values[]}
- `answer_lte`: {question_code, value} - for scales
- `composite_below`: {score_group, threshold} - business_readiness means the DRS
- `all`: {conditions[]} - logical AND of the above

## Testing (required before Phase 2 begins)

- Unit tests against the three /seed/fixtures companies: exact match on every sub-score, dimension score, DRS, tier, ORI, and gap set.
- Determinism test: scoring twice produces identical rows.
- Immutability test: rescoring a completed assessment fails.
- Band boundary tests: recurring exactly 60 -> 75 pts; owner hours exactly 10 -> 75 pts; top-1 exactly 30 -> 20 pts band check per bands_lt convention (30 is not < 30, falls to next band).

## Explainability

`explainAssessment(assessment_id)` returns per-sub-score: inputs used, computed intermediates (hhi_est, cagr_pct, down_years, ratios), band applied, points, weight, contribution; per-dimension math; DRS composition; and each fired gap trigger. The advisor UI "why is this score X" view and the narrative service consume this.
