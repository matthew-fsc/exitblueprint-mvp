// R&D PROTOTYPE — NOT PRODUCTION. See dev/frontier/README.md.
//
// The DRS Calibration Engine (docs/09 moat 1 "outcome calibration"; docs/40 §3
// "the single highest-value direction is closing the outcome-calibration loop").
//
// Every DRS is a PREDICTION ("Sale Ready ~5x"). This engine turns a corpus of
// paired prediction/reality records (`deal_outcomes`) into three things no
// competitor can retrofit:
//   1. an EMPIRICAL calibration table  — "DRS 70-79 closed at 4.6-5.4x, 82% of
//      the time" (the FICO readout), with an explicit confidence gate on n;
//   2. calibration DIAGNOSTICS         — how far the current rubric's implied
//      multiple ran from reality, per band and overall (a reliability metric);
//   3. a PROPOSED recalibration        — a diff against the current valuation
//      rule, expressed as a NEW version proposal that a human must review and
//      apply. It is NEVER applied here.
//
// GUARDRAILS THIS PROTOTYPE HONORS (the productionization contract):
//   - Deterministic (CLAUDE.md rule 1): pure arithmetic over recorded facts. No
//     LLM computes, adjusts, or influences any number. Same input -> same output.
//   - AI is narrative-only (rule 2): this module produces STRUCTURED numbers; a
//     narrative layer may describe them, never generate them.
//   - "Calibration informs the rubric; it never edits a score directly" (docs/09):
//     the output is a *proposal for a new valuation_rules_version*, flagged
//     applied=false / requires_human_review=true. Immutable history holds
//     (rule 4): a recalibration ships as a new version, superseding — never a
//     live edit of a past score or assessment.
//   - Read-only over aggregates (rule 5): operates on de-identified paired
//     records; no per-firm raw leak. In prod it runs on the service-role
//     `analytics` path behind the superadmin gate, like server/moat-metrics.ts.

import type {
  PairedOutcome,
  DrsBand,
  CurrentRubric,
  RubricBandRule,
} from './types.ts';

// Minimum paired outcomes before a band's stats are treated as decision-grade.
// Below this, we still report the numbers but flag them low-confidence and never
// let them drive a recalibration proposal.
export const MIN_CONFIDENT_N = 8;

// -- small deterministic stat helpers -----------------------------------------

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

// Linear-interpolated percentile (0..1) over a copy-sorted array.
function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const idx = p * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

const round1 = (v: number | null): number | null => (v == null ? null : Math.round(v * 10) / 10);
const round2 = (v: number | null): number | null => (v == null ? null : Math.round(v * 100) / 100);

// -- band assignment -----------------------------------------------------------

export function bandFor(bands: DrsBand[], drs: number): DrsBand | null {
  for (const b of bands) {
    // Last band is inclusive of its max so DRS 100 lands somewhere.
    const isLast = b === bands[bands.length - 1];
    if (drs >= b.min && (drs < b.max || (isLast && drs <= b.max))) return b;
  }
  return null;
}

// -- 1. empirical calibration table -------------------------------------------

export interface CalibrationCell {
  band_key: string;
  band_label: string;
  drs_range: string;
  n: number; // paired closed outcomes in this band
  confident: boolean; // n >= MIN_CONFIDENT_N
  // Realized multiple distribution — the "closed at 4.6-5.4x" spread.
  multiple_p25: number | null;
  multiple_median: number | null;
  multiple_p75: number | null;
  // Reliability: mean signed EV variance (final - predicted_base)/predicted_base,
  // as a % — positive means the rubric UNDER-predicted value in this band.
  mean_ev_variance_pct: number | null;
  // Share of deals whose realized EV landed inside the predicted [low, high]
  // range — the "82% of the time" hit rate.
  within_range_pct: number | null;
  retrade_rate_pct: number | null;
  median_days_on_market: number | null;
}

export interface CalibrationTable {
  cells: CalibrationCell[];
  total_paired: number;
}

export function calibrationTable(corpus: PairedOutcome[], bands: DrsBand[]): CalibrationTable {
  const cells: CalibrationCell[] = bands.map((b) => {
    const inBand = corpus.filter((r) => bandFor(bands, r.predicted_drs)?.key === b.key);
    const multiples = inBand.map((r) => r.final_multiple);
    const variances = inBand
      .filter((r) => r.predicted_ev_base > 0)
      .map((r) => ((r.final_ev - r.predicted_ev_base) / r.predicted_ev_base) * 100);
    const within = inBand.map((r) =>
      r.final_ev >= r.predicted_ev_low && r.final_ev <= r.predicted_ev_high ? 1 : 0,
    );
    const retrades = inBand.map((r) => (r.retrade ? 1 : 0));
    const days = inBand.map((r) => r.days_on_market);
    const n = inBand.length;
    return {
      band_key: b.key,
      band_label: b.label,
      drs_range: `${b.min}-${b === bands[bands.length - 1] ? b.max : b.max - 1}`,
      n,
      confident: n >= MIN_CONFIDENT_N,
      multiple_p25: round2(percentile(multiples, 0.25)),
      multiple_median: round2(percentile(multiples, 0.5)),
      multiple_p75: round2(percentile(multiples, 0.75)),
      mean_ev_variance_pct: round1(mean(variances)),
      within_range_pct: within.length ? Math.round((mean(within) as number) * 100) : null,
      retrade_rate_pct: retrades.length ? Math.round((mean(retrades) as number) * 100) : null,
      median_days_on_market: days.length ? Math.round(percentile(days, 0.5) as number) : null,
    };
  });
  return { cells, total_paired: corpus.length };
}

// -- 2. calibration diagnostics (reliability) ---------------------------------

export interface CalibrationDiagnostics {
  paired_outcomes: number;
  confident_bands: number;
  // Overall reliability: mean absolute EV variance across all paired deals. Lower
  // is a better-calibrated rubric. This is the headline "how good is the DRS as a
  // predictor" number that anchors the fundraising thesis (docs/40 §4a).
  overall_mean_abs_ev_variance_pct: number | null;
  // Overall share of deals that landed inside the predicted range.
  overall_within_range_pct: number | null;
  // Directional bias per confident band: does the rubric systematically under-
  // or over-predict there? This is what a recalibration would correct.
  band_bias: { band_key: string; mean_ev_variance_pct: number; direction: 'under' | 'over' | 'calibrated' }[];
}

export function calibrationDiagnostics(
  corpus: PairedOutcome[],
  table: CalibrationTable,
): CalibrationDiagnostics {
  const absVars = corpus
    .filter((r) => r.predicted_ev_base > 0)
    .map((r) => Math.abs((r.final_ev - r.predicted_ev_base) / r.predicted_ev_base) * 100);
  const within = corpus.map((r) =>
    r.final_ev >= r.predicted_ev_low && r.final_ev <= r.predicted_ev_high ? 1 : 0,
  );
  const bias = table.cells
    .filter((c) => c.confident && c.mean_ev_variance_pct != null)
    .map((c) => {
      const v = c.mean_ev_variance_pct as number;
      const direction: 'under' | 'over' | 'calibrated' =
        v > 3 ? 'under' : v < -3 ? 'over' : 'calibrated';
      return { band_key: c.band_key, mean_ev_variance_pct: v, direction };
    });
  return {
    paired_outcomes: corpus.length,
    confident_bands: table.cells.filter((c) => c.confident).length,
    overall_mean_abs_ev_variance_pct: round1(mean(absVars)),
    overall_within_range_pct: within.length ? Math.round((mean(within) as number) * 100) : null,
    band_bias: bias,
  };
}

// -- 3. proposed recalibration (a NEW version, never applied) ------------------

export interface BandChange {
  band_key: string;
  current_readiness_multiple: number;
  proposed_readiness_multiple: number;
  delta: number;
  basis: string; // human-readable rationale grounded in the evidence
  evidence: { n: number; mean_ev_variance_pct: number; multiple_median: number | null };
}

// A DRAFT proposal to supersede the current valuation rule. Mirrors how a real
// recalibration would ship: a new valuation_rules_version, gated on human review.
export interface RecalibrationProposal {
  from_version: string;
  proposed_version: string; // NOT applied — a suggested successor id
  applied: false; // type-level guarantee this object never represents an applied change
  requires_human_review: true;
  generated_at: string;
  changes: BandChange[];
  unchanged_bands: string[]; // bands left alone (calibrated, or too little data)
  notes: string;
}

// Derive a corrected readiness multiple per band from the empirical evidence.
// Logic: if a CONFIDENT band's mean EV variance shows the rubric under/over-
// predicts by more than the dead-band, nudge the readiness multiple by that
// same proportion — but damped (half the observed bias) so calibration converges
// gradually rather than chasing noise, and clamped to a sane per-cycle move.
export function proposeRecalibration(
  table: CalibrationTable,
  current: CurrentRubric,
  opts: { deadBandPct?: number; damping?: number; maxMovePct?: number; proposedVersion: string } = {
    proposedVersion: 'val_PROPOSED',
  },
): RecalibrationProposal {
  const deadBand = opts.deadBandPct ?? 3; // ignore |variance| below this (%)
  const damping = opts.damping ?? 0.5; // apply half the observed bias
  const maxMove = opts.maxMovePct ?? 12; // never move a multiple > this % per cycle

  const currentByBand = new Map<string, RubricBandRule>(
    current.bands.map((b) => [b.band_key, b]),
  );

  const changes: BandChange[] = [];
  const unchanged: string[] = [];

  for (const cell of table.cells) {
    const rule = currentByBand.get(cell.band_key);
    if (!rule) continue;
    const v = cell.mean_ev_variance_pct;
    // Only confident, meaningfully-biased bands drive a change.
    if (!cell.confident || v == null || Math.abs(v) <= deadBand) {
      unchanged.push(cell.band_key);
      continue;
    }
    let movePct = (v / 100) * damping * 100; // damped bias, in %
    movePct = Math.max(-maxMove, Math.min(maxMove, movePct));
    const proposed = round2(rule.readiness_multiple * (1 + movePct / 100)) as number;
    if (proposed === rule.readiness_multiple) {
      unchanged.push(cell.band_key);
      continue;
    }
    changes.push({
      band_key: cell.band_key,
      current_readiness_multiple: rule.readiness_multiple,
      proposed_readiness_multiple: proposed,
      delta: round2(proposed - rule.readiness_multiple) as number,
      basis:
        `${cell.n} closed deals in this band realized EV ${v > 0 ? 'above' : 'below'} the ` +
        `rubric's prediction by ${Math.abs(v)}% on average (median realized ` +
        `${cell.multiple_median}x); nudging the readiness multiple ${movePct > 0 ? '+' : ''}` +
        `${round1(movePct)}% (half the observed bias).`,
      evidence: {
        n: cell.n,
        mean_ev_variance_pct: v,
        multiple_median: cell.multiple_median,
      },
    });
  }

  return {
    from_version: current.valuation_rules_version,
    proposed_version: opts.proposedVersion,
    applied: false,
    requires_human_review: true,
    generated_at: new Date().toISOString(),
    changes,
    unchanged_bands: unchanged,
    notes:
      'DRAFT recalibration proposal. This object never edits a score or an ' +
      'existing rubric. If accepted by a human reviewer it ships as a NEW ' +
      'valuation_rules_version; prior assessments keep their original version ' +
      '(CLAUDE.md rules 1 & 4; docs/09 "calibration informs the rubric, never ' +
      'edits a score directly").',
  };
}
