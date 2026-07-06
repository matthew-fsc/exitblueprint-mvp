# 03 - Scoring Engine Spec

## Contract

`scoreAssessment(assessment_id) -> { overall_score, dimension_scores[], gaps_opened[], gaps_resolved[] }`

Deterministic. No network calls except the database. No LLM involvement under any circumstances.

## Algorithm

1. Load the assessment, its rubric_version, all dimensions/questions/gap_definitions for that version, and all answers.
2. Validate completeness: every question answered, or explicitly marked skipped with reason. Incomplete -> return validation error, do not score.
3. Question points: map each answer through the question's scoring_map. Normalize to 0-100 per question.
4. Dimension raw_score: weighted average of its question scores (question weights).
5. Dimension weighted_score: raw_score * dimension weight.
6. overall_score: sum of weighted_scores / sum of dimension weights, rounded to integer 0-100.
7. Gap evaluation: run every gap_definition trigger against dimension scores and answers.
   - Trigger fires and no open gap of that definition exists on the engagement -> open a gap.
   - Trigger does not fire and an open gap of that definition exists -> mark it resolved_by this assessment.
8. Persist dimension_scores, overall_score, gap changes, set assessment completed_at, all in one transaction.

## Trigger types (v1)

- `dimension_below`: {threshold}
- `question_answer`: {question_code, in: [values]}
- `question_below`: {question_code, threshold}
- Compound AND of the above via `all: [...]`

Keep the trigger evaluator small and table-driven; new trigger types are added deliberately, not ad hoc.

## Testing (required before Phase 2 begins)

- Fixtures: 3 fictional companies with full answer sets and hand-computed expected scores/gaps (Matthew supplies expected values in /seed/fixtures/).
- Unit tests assert exact score match and exact gap set match.
- Determinism test: scoring the same assessment twice produces identical rows.
- Immutability test: attempting to rescore a completed assessment fails.

## Explainability requirement

The engine must be able to produce a trace for any score: per-question points, per-dimension math, and which trigger fired each gap. Expose as `explainAssessment(assessment_id)` returning structured JSON. The advisor UI "why is this score X" view and the narrative service both consume this.
