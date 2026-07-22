// Outcome Calibration Engine — server layer (docs/09-moats.md §1, docs/40 §3).
// Reads the cross-firm `deal_outcomes` corpus, computes a VERSIONED calibration
// artifact with the pure, rule-based math in shared/calibration/compute.ts, and
// persists it as a new `calibration_version` snapshot in the service-role-only
// `analytics` schema (supabase/migrations/20260722214544_calibration_engine.sql).
//
// TRUST BOUNDARY (CLAUDE.md rule #5): calibration is CROSS-FIRM aggregate
// intelligence, so it runs ONLY on the service-role (RLS-bypass) connection behind
// the platform-superadmin gate — mirroring server/moat-metrics.ts and
// server/financial-corpus.ts. It reads raw deal_outcomes across firms (legitimate
// on service_role), but everything it WRITES is a de-identified score-band
// aggregate: no firm_id, no company id, no PII crosses into the artifact. Never
// call this on a tenant JWT path.
//
// DETERMINISTIC & READ-ONLY-TO-SCORES (CLAUDE.md rules #1, #3, #4): the bands come
// from rule-based code, never an LLM. Persisting a calibration NEVER mutates an
// assessment or a score; a recalibration informs the rubric only via a future
// rubric_version. Assessments stay immutable — we only append a new snapshot.
import type pg from 'pg';
import {
  computeCalibrationArtifact,
  type CalibrationArtifact,
  type CalibrationConfig,
  type OutcomeRecord,
} from '../shared/calibration/compute';

// Either a pooled client or the Pool itself — both expose `.query`. The read path
// (used by the metrics rail) accepts either; the test passes a fake client. The
// compute path needs a client that can run its multi-statement insert.
type Queryable = Pick<pg.ClientBase, 'query'> | Pick<pg.Pool, 'query'>;

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// One persisted calibration snapshot, ready for the operator rail.
export interface CalibrationSnapshot {
  generated_at: string;
  calibration_version: number | null; // null until the first compute has run
  computed_at: string | null;
  band_width: number | null;
  total_outcomes: number | null;
  total_closed: number | null;
  contributing_firms: number | null;
  bands: Record<string, unknown>[]; // one row per (group, band); de-identified aggregates
  note: string;
}

const CALIBRATION_NOTE =
  'Outcome-calibration artifact (docs/09 moat 1, the FICO moat): DRS/ORI score ' +
  'band → realized close rate, multiple, time-to-close, within-range hit rate, EV ' +
  'variance and retrade rate, computed deterministically across every firm’s closed ' +
  'deals and readable by service_role only. Rows are de-identified score-band ' +
  'aggregates — never a firm’s raw deal or PII; a band flagged low_confidence has too ' +
  'few outcomes or a single contributing firm and should not be read as calibrated. ' +
  'Calibration informs a future rubric_version; it never edits a score in place.';

// Pull the whole corpus (service-role → all firms) and shape it for the pure math.
async function loadCorpus(db: Queryable): Promise<OutcomeRecord[]> {
  const rows = (
    await db.query(
      `select firm_id, outcome, predicted_drs, predicted_ori,
              predicted_ev_low, predicted_ev_base, predicted_ev_high,
              final_ev, final_multiple, days_on_market, retrade
         from deal_outcomes`,
    )
  ).rows;
  return rows.map((r) => ({
    firm_id: String(r.firm_id),
    outcome: r.outcome as OutcomeRecord['outcome'],
    predicted_drs: num(r.predicted_drs),
    predicted_ori: num(r.predicted_ori),
    predicted_ev_low: num(r.predicted_ev_low),
    predicted_ev_base: num(r.predicted_ev_base),
    predicted_ev_high: num(r.predicted_ev_high),
    final_ev: num(r.final_ev),
    final_multiple: num(r.final_multiple),
    days_on_market: num(r.days_on_market),
    retrade: r.retrade === true,
  }));
}

// Compute a new calibration version from the current corpus and persist it as an
// immutable snapshot. Returns the fresh snapshot. Superadmin/service-role only.
export async function computeCalibration(
  db: pg.ClientBase,
  config: Partial<CalibrationConfig> = {},
): Promise<CalibrationSnapshot> {
  const corpus = await loadCorpus(db);
  const artifact: CalibrationArtifact = computeCalibrationArtifact(corpus, config);

  const header = (
    await db.query(
      `insert into analytics.calibration_versions
         (band_width, min_sample, total_outcomes, total_closed, contributing_firms)
       values ($1, $2, $3, $4, $5)
       returning calibration_version, computed_at`,
      [
        artifact.band_width,
        artifact.min_sample,
        artifact.total_outcomes,
        artifact.total_closed,
        artifact.contributing_firms,
      ],
    )
  ).rows[0];
  const version = Number(header.calibration_version);

  for (const b of artifact.bands) {
    await db.query(
      `insert into analytics.calibration_bands (
         calibration_version, group_key, band_low, band_high, band_label,
         sample_n, closed_n, contributing_firms, close_rate_pct,
         median_multiple, p25_multiple, p75_multiple, median_days_to_close,
         within_range_hit_rate_pct, ev_variance_pct, retrade_rate_pct, low_confidence
       ) values (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
       )`,
      [
        version,
        b.group_key,
        b.band_low,
        b.band_high,
        b.band_label,
        b.sample_n,
        b.closed_n,
        b.contributing_firms,
        b.close_rate_pct,
        b.median_multiple,
        b.p25_multiple,
        b.p75_multiple,
        b.median_days_to_close,
        b.within_range_hit_rate_pct,
        b.ev_variance_pct,
        b.retrade_rate_pct,
        b.low_confidence,
      ] as unknown[],
    );
  }

  return {
    generated_at: new Date().toISOString(),
    calibration_version: version,
    computed_at: header.computed_at ? new Date(header.computed_at).toISOString() : null,
    band_width: artifact.band_width,
    total_outcomes: artifact.total_outcomes,
    total_closed: artifact.total_closed,
    contributing_firms: artifact.contributing_firms,
    bands: artifact.bands as unknown as Record<string, unknown>[],
    note: CALIBRATION_NOTE,
  };
}

// Read the latest persisted calibration snapshot (bands of the newest version).
// Read-only; used by the read-calibration function and the /internal/metrics
// operator rail. Empty (calibration_version null, no bands) until the first
// compute has run.
export async function readCalibration(db: Queryable): Promise<CalibrationSnapshot> {
  const rows = (
    await db.query(
      `select calibration_version, computed_at, band_width, total_outcomes, total_closed,
              contributing_firms, group_key, band_low, band_high, band_label, sample_n,
              closed_n, band_contributing_firms, close_rate_pct, median_multiple,
              p25_multiple, p75_multiple, median_days_to_close, within_range_hit_rate_pct,
              ev_variance_pct, retrade_rate_pct, low_confidence
         from analytics.calibration_latest
        order by group_key, band_low`,
    )
  ).rows;

  const head = rows[0];
  const bands: Record<string, unknown>[] = rows.map((r) => ({
    group_key: r.group_key,
    band_label: r.band_label,
    band_low: num(r.band_low),
    band_high: num(r.band_high),
    sample_n: num(r.sample_n),
    closed_n: num(r.closed_n),
    contributing_firms: num(r.band_contributing_firms),
    close_rate_pct: num(r.close_rate_pct),
    median_multiple: num(r.median_multiple),
    p25_multiple: num(r.p25_multiple),
    p75_multiple: num(r.p75_multiple),
    median_days_to_close: num(r.median_days_to_close),
    within_range_hit_rate_pct: num(r.within_range_hit_rate_pct),
    ev_variance_pct: num(r.ev_variance_pct),
    retrade_rate_pct: num(r.retrade_rate_pct),
    low_confidence: r.low_confidence === true,
  }));

  return {
    generated_at: new Date().toISOString(),
    calibration_version: head ? num(head.calibration_version) : null,
    computed_at: head?.computed_at ? new Date(head.computed_at).toISOString() : null,
    band_width: head ? num(head.band_width) : null,
    total_outcomes: head ? num(head.total_outcomes) : null,
    total_closed: head ? num(head.total_closed) : null,
    contributing_firms: head ? num(head.contributing_firms) : null,
    bands,
    note: CALIBRATION_NOTE,
  };
}
