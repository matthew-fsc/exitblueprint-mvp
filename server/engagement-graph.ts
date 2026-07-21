// Engagement-graph analytics — playbook / gap-remediation EFFECTIVENESS across a
// firm's engagements (docs/09-moats.md, moat 3 "the engagement graph").
//
// We hold the longitudinal path initial gaps -> remediation -> score movement ->
// outcome. This module reads that path back into the descriptive readout docs/09
// names directly: "clearing OWNER_DEP added ~0.4x on average". For each named gap
// that was flagged and later RESOLVED (its `gaps` row moved to status='resolved'
// with a `resolved_by_assessment_id`), it associates the DRS movement and the
// movement on that gap's own dimension between the resolving assessment and the
// immediately-preceding completed assessment in the same engagement, and — where a
// `deal_outcomes` row exists — the deal's final multiple.
//
// GUARANTEES (CLAUDE.md rules 1, 2, 3a, 4, 5):
//   - READ-ONLY. Every statement is a SELECT. Nothing here writes a score, mutates
//     an assessment (they are immutable), or touches any scoring table.
//   - NO LLM. This is deterministic descriptive analytics over existing rows; no
//     model computes, adjusts, or influences any number.
//   - SAME-RUBRIC ONLY. A delta is only computed when the resolving assessment and
//     its prior share a `rubric_version_id`. Cross-version clears are incomparable
//     (rubrics are on different scales), mirroring compareAssessments' guard
//     (server/scoring.ts, docs/03); they are counted but never averaged.
//   - FIRM-SCOPED. Filtered by the caller's trusted firmId (resolved upstream from
//     the profile, never from a body); RLS keeps the raw rows firm-isolated.
//
// Calibration informs the rubric; it never edits a score directly (docs/09). This
// is a reporting surface, not a scoring input.
import type pg from 'pg';

// Postgres returns numeric columns as strings; coerce to a number or null.
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function avg(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

const round1 = (v: number | null): number | null => (v == null ? null : Math.round(v * 10) / 10);
const round2 = (v: number | null): number | null => (v == null ? null : Math.round(v * 100) / 100);

// One resolved-gap "clear" as loaded from the DB (prior -> resolving assessment).
interface ClearRow {
  engagement_id: string;
  gap_code: string;
  gap_name: string;
  severity: string;
  dimension_code: string;
  current_assessment_id: string;
  current_rubric: string;
  prior_assessment_id: string;
  prior_rubric: string;
  current_drs: unknown;
  prior_drs: unknown;
  current_dim: unknown;
  prior_dim: unknown;
  outcome: string | null;
  final_multiple: unknown;
}

// Per-gap effectiveness rollup. Deltas are averages over the comparable clears of
// this gap (same rubric_version, prior -> resolving assessment).
export interface GapEffectiveness {
  gap_code: string;
  gap_name: string;
  dimension_code: string;
  severity: string;
  clears: number; // comparable clears (same rubric_version) driving the averages
  incomparable_clears: number; // cross-rubric clears — counted, not averaged
  avg_drs_delta: number | null; // mean DRS movement across the comparable clears
  avg_dimension_delta: number | null; // mean movement on THIS gap's dimension
  deals_closed: number; // comparable clears whose engagement later closed with a multiple
  avg_final_multiple: number | null; // mean final multiple where a closed deal exists
}

export interface EngagementGraph {
  firm_id: string;
  gaps_cleared: number; // total comparable clears across all gaps
  incomparable_clears: number; // total cross-rubric clears (movement not computed)
  effectiveness: GapEffectiveness[]; // most DRS movement first
}

// Cross-engagement gap-remediation effectiveness for one firm. Read-only.
export async function engagementGraph(db: pg.ClientBase, firmId: string): Promise<EngagementGraph> {
  // One row per resolved gap: the resolving ("current") assessment, its immediately
  // preceding completed ("prior") assessment in the same engagement, the DRS and
  // gap-dimension score on each side, and the deal outcome if one was recorded.
  // The lateral join is an inner join, so a gap with no prior completed assessment
  // (nothing to move from) is naturally excluded.
  const rows = (
    await db.query(
      `select g.engagement_id,
              gd.code as gap_code, gd.name as gap_name, gd.severity,
              d.code as dimension_code,
              cur.id as current_assessment_id, cur.rubric_version_id as current_rubric,
              cur.drs_score as current_drs,
              prev.id as prior_assessment_id, prev.rubric_version_id as prior_rubric,
              prev.drs_score as prior_drs,
              cds.score as current_dim, pds.score as prior_dim,
              dlo.outcome as outcome, dlo.final_multiple as final_multiple
         from gaps g
         join gap_definitions gd on gd.id = g.gap_definition_id
         join dimensions d on d.id = gd.dimension_id
         join assessments cur on cur.id = g.resolved_by_assessment_id
         join lateral (
           select a.id, a.rubric_version_id, a.drs_score
             from assessments a
            where a.engagement_id = cur.engagement_id
              and a.status = 'completed'
              and a.sequence_number < cur.sequence_number
            order by a.sequence_number desc
            limit 1
         ) prev on true
         left join dimension_scores cds on cds.assessment_id = cur.id and cds.dimension_id = d.id
         left join dimension_scores pds on pds.assessment_id = prev.id and pds.dimension_id = d.id
         left join deal_outcomes dlo on dlo.engagement_id = g.engagement_id and dlo.outcome = 'closed'
        where g.firm_id = $1
          and g.status = 'resolved'
          and g.resolved_by_assessment_id is not null`,
      [firmId],
    )
  ).rows as ClearRow[];

  // Group by gap code, accumulating comparable vs. incomparable clears.
  interface Acc {
    gap_code: string;
    gap_name: string;
    dimension_code: string;
    severity: string;
    comparable: number; // same-rubric clears driving the averages
    drsDeltas: number[];
    dimDeltas: number[];
    incomparable: number;
    multiples: number[];
  }
  const byGap = new Map<string, Acc>();

  let gapsCleared = 0;
  let incomparableClears = 0;

  for (const r of rows) {
    let acc = byGap.get(r.gap_code);
    if (!acc) {
      acc = {
        gap_code: r.gap_code,
        gap_name: r.gap_name,
        dimension_code: r.dimension_code,
        severity: r.severity,
        comparable: 0,
        drsDeltas: [],
        dimDeltas: [],
        incomparable: 0,
        multiples: [],
      };
      byGap.set(r.gap_code, acc);
    }

    // Same-rubric guard — never subtract across rubric versions (docs/03).
    if (r.prior_rubric !== r.current_rubric) {
      acc.incomparable += 1;
      incomparableClears += 1;
      continue;
    }

    gapsCleared += 1;
    acc.comparable += 1;
    const priorDrs = num(r.prior_drs);
    const currentDrs = num(r.current_drs);
    if (priorDrs != null && currentDrs != null) acc.drsDeltas.push(currentDrs - priorDrs);

    const priorDim = num(r.prior_dim);
    const currentDim = num(r.current_dim);
    if (priorDim != null && currentDim != null) acc.dimDeltas.push(currentDim - priorDim);

    const mult = num(r.final_multiple);
    if (r.outcome === 'closed' && mult != null) acc.multiples.push(mult);
  }

  const effectiveness: GapEffectiveness[] = [...byGap.values()]
    .map((a) => ({
      gap_code: a.gap_code,
      gap_name: a.gap_name,
      dimension_code: a.dimension_code,
      severity: a.severity,
      clears: a.comparable,
      incomparable_clears: a.incomparable,
      avg_drs_delta: round1(avg(a.drsDeltas)),
      avg_dimension_delta: round2(avg(a.dimDeltas)),
      deals_closed: a.multiples.length,
      avg_final_multiple: round2(avg(a.multiples)),
    }))
    .sort(
      (x, y) =>
        (y.avg_drs_delta ?? -Infinity) - (x.avg_drs_delta ?? -Infinity) || y.clears - x.clears,
    );

  return {
    firm_id: firmId,
    gaps_cleared: gapsCleared,
    incomparable_clears: incomparableClears,
    effectiveness,
  };
}
