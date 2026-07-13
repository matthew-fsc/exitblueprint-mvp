// Deal-outcome capture + firm calibration (the outcome-calibration moat).
// Requires a migrated + seeded database (DATABASE_URL); skipped otherwise. Proves
// recording an outcome freezes the prediction snapshot we already hold and that
// the calibration readout computes predicted-vs-actual correctly.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { recordDealOutcome, firmCalibration } from '../server/outcomes';
import { computeValuation } from '../server/valuation';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('deal outcomes + calibration', () => {
  let db: pg.Client;
  let firmId: string;
  let engagementId: string;
  let evBase: number;
  let evLow: number;
  let evHigh: number;
  let finalEv: number; // +4% over the predicted base, still inside the range

  beforeAll(async () => {
    db = new pg.Client({ connectionString: url });
    await db.connect();
    const rv = (await db.query(`select id from rubric_versions where status = 'active' limit 1`)).rows[0].id;
    firmId = (await db.query(`insert into firms (name) values ('Outcome Test Firm') returning id`)).rows[0].id;
    const companyId = (
      await db.query(
        `insert into companies (firm_id, name, industry) values ($1, 'Outcome Co', 'Precision Manufacturing') returning id`,
        [firmId],
      )
    ).rows[0].id;
    engagementId = (
      await db.query(`insert into engagements (firm_id, company_id) values ($1, $2) returning id`, [firmId, companyId])
    ).rows[0].id;
    // Sale-Ready completed assessment → readiness 1.0; self-reported → width 0.30.
    await db.query(
      `insert into assessments (firm_id, engagement_id, rubric_version_id, sequence_number, status, completed_at, drs_score, drs_tier, ori_score)
       values ($1, $2, $3, 1, 'completed', now(), 72, 'Sale Ready', 60)`,
      [firmId, engagementId, rv],
    );
    // Recast with no add-backs → the valuation engine produces the predicted EV
    // range we expect to see snapshotted onto the outcome.
    await db.query(
      `insert into ebitda_recasts (firm_id, engagement_id, reported_ebitda) values ($1, $2, 1000000)`,
      [firmId, engagementId],
    );
    const v = await computeValuation(db, engagementId);
    evBase = v.ev_base;
    evLow = v.ev_low;
    evHigh = v.ev_high;
    finalEv = Math.round(evBase * 1.04); // +4%, comfortably inside the ±30% range
  });

  afterAll(async () => {
    if (!db) return;
    await db.query(`delete from deal_outcomes where firm_id = $1`, [firmId]);
    await db.query(`delete from ebitda_recasts where firm_id = $1`, [firmId]);
    await db.query(`delete from assessments where firm_id = $1`, [firmId]);
    await db.query(`delete from engagements where firm_id = $1`, [firmId]);
    await db.query(`delete from companies where firm_id = $1`, [firmId]);
    await db.query(`delete from firms where id = $1`, [firmId]);
    await db.end();
  });

  it('records an outcome and freezes the prediction snapshot', async () => {
    await recordDealOutcome(db, engagementId, {
      outcome: 'closed',
      close_date: '2026-06-01',
      final_ev: finalEv,
      final_multiple: 5.2,
      ebitda_at_close: 1_000_000,
      buyer_type: 'strategic',
      structure: 'all_cash',
      days_on_market: 210,
      retrade: false,
      buyer_flagged_risks: ['customer concentration'],
    });
    const row = (
      await db.query(`select * from deal_outcomes where engagement_id = $1`, [engagementId])
    ).rows[0];
    expect(Number(row.predicted_drs)).toBe(72);
    expect(Number(row.predicted_ori)).toBe(60);
    // Prediction snapshot equals what the valuation engine produced at record time.
    expect(Number(row.predicted_ev_base)).toBe(evBase);
    expect(Number(row.predicted_ev_low)).toBe(evLow);
    expect(Number(row.predicted_ev_high)).toBe(evHigh);
    expect(Number(row.final_ev)).toBe(finalEv);
    expect(row.buyer_type).toBe('strategic');
    expect(row.buyer_flagged_risks).toEqual(['customer concentration']);
  });

  it('is idempotent per engagement (re-record updates, no duplicate)', async () => {
    await recordDealOutcome(db, engagementId, { outcome: 'closed', final_ev: finalEv + 100_000, final_multiple: 5.3 });
    const count = (
      await db.query(`select count(*)::int c from deal_outcomes where engagement_id = $1`, [engagementId])
    ).rows[0].c;
    expect(count).toBe(1);
    const ev = (await db.query(`select final_ev from deal_outcomes where engagement_id = $1`, [engagementId])).rows[0].final_ev;
    expect(Number(ev)).toBe(finalEv + 100_000);
    // Restore the canonical value for the calibration assertions below.
    await recordDealOutcome(db, engagementId, { outcome: 'closed', final_ev: finalEv, final_multiple: 5.2 });
  });

  it('computes firm calibration: within-range hit rate and EV variance', async () => {
    const c = await firmCalibration(db, firmId);
    expect(c.deals_recorded).toBe(1);
    expect(c.closed).toBe(1);
    expect(c.with_prediction).toBe(1);
    // final = base × 1.04 → +4.0% variance; inside the ±30% range → 100% in range.
    expect(c.avg_ev_variance_pct).toBe(4);
    expect(c.within_range_pct).toBe(100);
    expect(c.avg_final_multiple).toBe(5.2);
    expect(c.deals[0].company_name).toBe('Outcome Co');
    expect(c.deals[0].within_range).toBe(true);
  });
});
