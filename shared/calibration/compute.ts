// Outcome-calibration math — the deterministic core of the "FICO moat"
// (docs/09-moats.md §1, docs/40 §3). Turns the paired prediction↔reality corpus
// in `deal_outcomes` into a calibrated read of the DRS: for each score band,
// "companies at DRS 70–75 close at ~4.8× within ~14 months, 82% of the time."
//
// This module is PURE and rule-based (CLAUDE.md rule #1): it takes plain outcome
// rows the caller assembled from the DB and returns a versionable artifact. No
// LLM, no I/O, no randomness — the same corpus always yields the same bands, so
// it is trivially unit-tested (tests/calibration.test.ts), exactly like the
// scoring engine. It NEVER edits a score: a recalibration ships as a new
// calibration_version snapshot (persisted by server/calibration.ts), which in
// turn informs the rubric only via a new rubric_version — never an in-place edit
// (CLAUDE.md rules #1, #3, #4).
//
// Mirrors the within-range / EV-variance / retrade definitions already used by
// server/outcomes.ts firmCalibration and the analytics.calibration_corpus view,
// but bucketed by score band rather than rolled into one number. Score-group
// aware (rule #3a): DRS bands and ORI bands are computed separately, never mixed.

export type CalibrationGroup = 'drs' | 'ori';

// One deal outcome, de-identified down to just the fields the math needs. firm_id
// is used ONLY to count distinct contributing firms per band (the de-identification
// / low-confidence guard); it is never emitted into a band row.
export interface OutcomeRecord {
  firm_id: string;
  outcome: 'closed' | 'broken' | 'withdrawn';
  predicted_drs: number | null;
  predicted_ori: number | null;
  predicted_ev_low: number | null;
  predicted_ev_base: number | null;
  predicted_ev_high: number | null;
  final_ev: number | null;
  final_multiple: number | null;
  days_on_market: number | null;
  retrade: boolean;
}

export interface CalibrationConfig {
  band_width: number; // score points per band (default 5 → "70–75")
  min_sample: number; // a band with fewer outcomes is flagged low_confidence (default 5)
  floor: number; // lowest score (0)
  ceil: number; // highest score (100)
}

export const DEFAULT_CONFIG: CalibrationConfig = {
  band_width: 5,
  min_sample: 5,
  floor: 0,
  ceil: 100,
};

export interface CalibrationBand {
  group_key: CalibrationGroup;
  band_low: number;
  band_high: number;
  band_label: string; // "70–75"
  sample_n: number; // outcomes of any kind whose predicted score falls in this band
  closed_n: number; // of those, the ones that closed
  contributing_firms: number; // distinct firms in the band (de-identification guard)
  close_rate_pct: number | null; // closed / sample_n, %
  median_multiple: number | null; // over closed deals with a final multiple
  p25_multiple: number | null; // interquartile band of realized multiple
  p75_multiple: number | null;
  median_days_to_close: number | null; // over closed deals with days_on_market
  within_range_hit_rate_pct: number | null; // closed deals whose final EV landed in the predicted band
  ev_variance_pct: number | null; // median (final − base) / base, %
  retrade_rate_pct: number | null; // closed deals that retraded, %
  low_confidence: boolean; // sample_n < min_sample OR only one contributing firm
}

export interface CalibrationArtifact {
  band_width: number;
  min_sample: number;
  total_outcomes: number;
  total_closed: number;
  contributing_firms: number;
  bands: CalibrationBand[]; // DRS bands then ORI bands, each ascending by band_low
}

function isNum(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

// Round half-up to `digits` decimals, deterministically.
function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

// Median of a numeric list (empty → null). Sorts a copy; even length averages
// the two middle values.
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Linear-interpolation percentile (type-7, the numpy/Excel default), so p25/p75
// are well-defined and deterministic for any sample size. p in [0,1].
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

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

// Which band a score falls in. Scores at or above the ceiling fold into the top
// band (95–100 for width 5), so DRS 100 is never orphaned into an empty 100–105.
function bandLowFor(score: number, cfg: CalibrationConfig): number | null {
  if (!isNum(score) || score < cfg.floor || score > cfg.ceil) return null;
  const span = cfg.ceil - cfg.floor;
  const lastIdx = Math.ceil(span / cfg.band_width) - 1;
  const idx = Math.min(Math.floor((score - cfg.floor) / cfg.band_width), lastIdx);
  return cfg.floor + idx * cfg.band_width;
}

function bandsForGroup(
  records: OutcomeRecord[],
  group: CalibrationGroup,
  cfg: CalibrationConfig,
): CalibrationBand[] {
  const pick = (r: OutcomeRecord) => (group === 'drs' ? r.predicted_drs : r.predicted_ori);

  // Bucket every outcome that carries a predicted score for this group.
  const buckets = new Map<number, OutcomeRecord[]>();
  for (const r of records) {
    const score = pick(r);
    if (!isNum(score)) continue;
    const low = bandLowFor(score, cfg);
    if (low === null) continue;
    const arr = buckets.get(low) ?? [];
    arr.push(r);
    buckets.set(low, arr);
  }

  const out: CalibrationBand[] = [];
  for (const low of [...buckets.keys()].sort((a, b) => a - b)) {
    const inBand = buckets.get(low)!;
    const high = Math.min(low + cfg.band_width, cfg.ceil);
    const closed = inBand.filter((r) => r.outcome === 'closed');
    const firms = new Set(inBand.map((r) => r.firm_id)).size;

    const multiples = closed.filter((r) => isNum(r.final_multiple)).map((r) => r.final_multiple as number);
    const days = closed.filter((r) => isNum(r.days_on_market)).map((r) => r.days_on_market as number);
    const variances = closed
      .filter((r) => isNum(r.predicted_ev_base) && (r.predicted_ev_base as number) !== 0 && isNum(r.final_ev))
      .map(
        (r) =>
          (((r.final_ev as number) - (r.predicted_ev_base as number)) / (r.predicted_ev_base as number)) * 100,
      );
    const inRange = closed
      .filter((r) => isNum(r.predicted_ev_low) && isNum(r.predicted_ev_high) && isNum(r.final_ev))
      .map((r) =>
        (r.final_ev as number) >= (r.predicted_ev_low as number) &&
        (r.final_ev as number) <= (r.predicted_ev_high as number)
          ? 1
          : 0,
      );

    const med = median(multiples);
    const p25 = percentile(multiples, 0.25);
    const p75 = percentile(multiples, 0.75);
    const medDays = median(days);
    const medVar = median(variances);
    const hitRate = mean(inRange);
    const retradeRate = closed.length
      ? closed.reduce((a, r) => a + (r.retrade ? 1 : 0), 0) / closed.length
      : null;

    out.push({
      group_key: group,
      band_low: low,
      band_high: high,
      band_label: `${low}–${high}`,
      sample_n: inBand.length,
      closed_n: closed.length,
      contributing_firms: firms,
      close_rate_pct: inBand.length ? Math.round((closed.length / inBand.length) * 100) : null,
      median_multiple: med === null ? null : round(med, 2),
      p25_multiple: p25 === null ? null : round(p25, 2),
      p75_multiple: p75 === null ? null : round(p75, 2),
      median_days_to_close: medDays === null ? null : Math.round(medDays),
      within_range_hit_rate_pct: hitRate === null ? null : Math.round(hitRate * 100),
      ev_variance_pct: medVar === null ? null : round(medVar, 1),
      retrade_rate_pct: retradeRate === null ? null : Math.round(retradeRate * 100),
      low_confidence: inBand.length < cfg.min_sample || firms < 2,
    });
  }
  return out;
}

// Compute a full, versionable calibration artifact from the outcome corpus.
// Deterministic and pure. DRS bands first, then ORI bands (ORI only where a
// predicted ORI exists), each ascending by band_low.
export function computeCalibrationArtifact(
  records: OutcomeRecord[],
  config: Partial<CalibrationConfig> = {},
): CalibrationArtifact {
  const cfg: CalibrationConfig = { ...DEFAULT_CONFIG, ...config };
  const bands = [...bandsForGroup(records, 'drs', cfg), ...bandsForGroup(records, 'ori', cfg)];
  return {
    band_width: cfg.band_width,
    min_sample: cfg.min_sample,
    total_outcomes: records.length,
    total_closed: records.filter((r) => r.outcome === 'closed').length,
    contributing_firms: new Set(records.map((r) => r.firm_id)).size,
    bands,
  };
}
