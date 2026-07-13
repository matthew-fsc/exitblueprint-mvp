// Deal-outcome capture + per-firm calibration (docs/09-moats.md).
//
// recordDealOutcome writes the advisor-reported result of an engagement and, in
// the same call, freezes the prediction snapshot (DRS / ORI / verified % from the
// latest completed assessment, and the predicted EV range from the valuation
// engine) so predicted-vs-actual is locked against what we said at the time.
//
// firmCalibration reads those frozen rows back into a simple readout: how close
// our predictions ran to reality across the firm's closed deals. It only reads —
// a recalibration of the rubric ships as a new version, never an edit here.
import type pg from 'pg';
import { verificationSummary } from './verification';
import { computeValuation } from './valuation';

export type DealOutcomeKind = 'closed' | 'broken' | 'withdrawn';
export type BuyerType = 'strategic' | 'financial' | 'individual' | 'management' | 'other';
export type DealStructure = 'all_cash' | 'cash_and_note' | 'earnout' | 'equity_rollover' | 'other';

export interface DealOutcomeInput {
  outcome: DealOutcomeKind;
  close_date?: string | null;
  days_on_market?: number | null;
  final_ev?: number | null;
  final_multiple?: number | null;
  ebitda_at_close?: number | null;
  buyer_type?: BuyerType | null;
  structure?: DealStructure | null;
  retrade?: boolean;
  retrade_pct?: number | null;
  buyer_flagged_risks?: unknown[];
  notes?: string | null;
  recorded_by?: string | null;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Record (or update) the outcome for an engagement, snapshotting the prediction
// we already hold. Idempotent per engagement (unique engagement_id → upsert).
export async function recordDealOutcome(
  db: pg.ClientBase,
  engagementId: string,
  input: DealOutcomeInput,
): Promise<{ id: string; engagement_id: string }> {
  const eng = (
    await db.query(`select firm_id from engagements where id = $1`, [engagementId])
  ).rows[0];
  if (!eng) throw new Error('engagement not found');
  if (!input || !input.outcome) throw new Error('outcome is required');

  // Prediction snapshot from the latest completed assessment + the valuation.
  const assessment = (
    await db.query(
      `select id, drs_score, ori_score from assessments
       where engagement_id = $1 and status = 'completed'
       order by sequence_number desc limit 1`,
      [engagementId],
    )
  ).rows[0];

  let verifiedPct: number | null = null;
  if (assessment) {
    verifiedPct = (await verificationSummary(db, assessment.id)).pct;
  }
  const val = await computeValuation(db, engagementId);
  const evLow = val.has_recast ? val.ev_low : null;
  const evBase = val.has_recast ? val.ev_base : null;
  const evHigh = val.has_recast ? val.ev_high : null;

  const row = (
    await db.query(
      `insert into deal_outcomes (
         firm_id, engagement_id, recorded_by, outcome, close_date, days_on_market,
         predicted_from_assessment_id, predicted_drs, predicted_ori, predicted_verified_pct,
         predicted_ev_low, predicted_ev_base, predicted_ev_high,
         final_ev, final_multiple, ebitda_at_close, buyer_type, structure,
         retrade, retrade_pct, buyer_flagged_risks, notes
       ) values (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10,
         $11, $12, $13,
         $14, $15, $16, $17, $18,
         $19, $20, $21, $22
       )
       on conflict (engagement_id) do update set
         recorded_by = excluded.recorded_by, outcome = excluded.outcome,
         close_date = excluded.close_date, days_on_market = excluded.days_on_market,
         predicted_from_assessment_id = excluded.predicted_from_assessment_id,
         predicted_drs = excluded.predicted_drs, predicted_ori = excluded.predicted_ori,
         predicted_verified_pct = excluded.predicted_verified_pct,
         predicted_ev_low = excluded.predicted_ev_low, predicted_ev_base = excluded.predicted_ev_base,
         predicted_ev_high = excluded.predicted_ev_high,
         final_ev = excluded.final_ev, final_multiple = excluded.final_multiple,
         ebitda_at_close = excluded.ebitda_at_close, buyer_type = excluded.buyer_type,
         structure = excluded.structure, retrade = excluded.retrade,
         retrade_pct = excluded.retrade_pct, buyer_flagged_risks = excluded.buyer_flagged_risks,
         notes = excluded.notes, updated_at = now()
       returning id, engagement_id`,
      [
        eng.firm_id,
        engagementId,
        input.recorded_by ?? null,
        input.outcome,
        input.close_date || null,
        input.days_on_market ?? null,
        assessment?.id ?? null,
        assessment ? num(assessment.drs_score) : null,
        assessment ? num(assessment.ori_score) : null,
        verifiedPct,
        evLow,
        evBase,
        evHigh,
        num(input.final_ev),
        num(input.final_multiple),
        num(input.ebitda_at_close),
        input.buyer_type ?? null,
        input.structure ?? null,
        input.retrade ?? false,
        num(input.retrade_pct),
        JSON.stringify(Array.isArray(input.buyer_flagged_risks) ? input.buyer_flagged_risks : []),
        input.notes ?? null,
      ],
    )
  ).rows[0];
  return row;
}

export interface DealCalibrationRow {
  engagement_id: string;
  company_name: string;
  outcome: DealOutcomeKind;
  close_date: string | null;
  predicted_drs: number | null;
  predicted_ev_base: number | null;
  final_ev: number | null;
  final_multiple: number | null;
  within_range: boolean | null;
}

export interface DealCalibration {
  deals_recorded: number;
  closed: number;
  broken: number;
  withdrawn: number;
  with_prediction: number; // closed deals that have both a predicted base and a final EV
  avg_ev_variance_pct: number | null; // mean (final − predicted) / predicted, %
  within_range_pct: number | null; // share of closed deals whose final EV fell inside the predicted range
  avg_final_multiple: number | null;
  avg_days_on_market: number | null;
  retrade_rate_pct: number | null;
  deals: DealCalibrationRow[];
}

function avg(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

// Predicted-vs-actual across a firm's recorded deals. Read-only.
export async function firmCalibration(db: pg.ClientBase, firmId: string): Promise<DealCalibration> {
  const rows = (
    await db.query(
      `select d.engagement_id, c.name as company_name, d.outcome, d.close_date,
              d.predicted_drs, d.predicted_ev_low, d.predicted_ev_base, d.predicted_ev_high,
              d.final_ev, d.final_multiple, d.days_on_market, d.retrade
       from deal_outcomes d
       join engagements e on e.id = d.engagement_id
       join companies c on c.id = e.company_id
       where d.firm_id = $1
       order by d.close_date desc nulls last, d.created_at desc`,
      [firmId],
    )
  ).rows;

  const closed = rows.filter((r) => r.outcome === 'closed');
  const withPrediction = closed.filter((r) => r.predicted_ev_base != null && r.final_ev != null);

  const variances = withPrediction.map(
    (r) => ((Number(r.final_ev) - Number(r.predicted_ev_base)) / Number(r.predicted_ev_base)) * 100,
  );
  const inRange = closed
    .filter((r) => r.predicted_ev_low != null && r.predicted_ev_high != null && r.final_ev != null)
    .map((r) =>
      Number(r.final_ev) >= Number(r.predicted_ev_low) && Number(r.final_ev) <= Number(r.predicted_ev_high)
        ? 1
        : 0,
    );
  const multiples = closed.filter((r) => r.final_multiple != null).map((r) => Number(r.final_multiple));
  const days = closed.filter((r) => r.days_on_market != null).map((r) => Number(r.days_on_market));
  const retrades = closed.map((r) => (r.retrade ? 1 : 0));

  const round1 = (v: number | null) => (v == null ? null : Math.round(v * 10) / 10);

  return {
    deals_recorded: rows.length,
    closed: closed.length,
    broken: rows.filter((r) => r.outcome === 'broken').length,
    withdrawn: rows.filter((r) => r.outcome === 'withdrawn').length,
    with_prediction: withPrediction.length,
    avg_ev_variance_pct: round1(avg(variances)),
    within_range_pct: inRange.length ? Math.round((avg(inRange) as number) * 100) : null,
    avg_final_multiple: round1(avg(multiples)),
    avg_days_on_market: days.length ? Math.round(avg(days) as number) : null,
    retrade_rate_pct: retrades.length ? Math.round((avg(retrades) as number) * 100) : null,
    deals: rows.map((r) => ({
      engagement_id: r.engagement_id,
      company_name: r.company_name,
      outcome: r.outcome,
      close_date: r.close_date,
      predicted_drs: r.predicted_drs != null ? Number(r.predicted_drs) : null,
      predicted_ev_base: r.predicted_ev_base != null ? Number(r.predicted_ev_base) : null,
      final_ev: r.final_ev != null ? Number(r.final_ev) : null,
      final_multiple: r.final_multiple != null ? Number(r.final_multiple) : null,
      within_range:
        r.predicted_ev_low != null && r.predicted_ev_high != null && r.final_ev != null
          ? Number(r.final_ev) >= Number(r.predicted_ev_low) && Number(r.final_ev) <= Number(r.predicted_ev_high)
          : null,
    })),
  };
}
