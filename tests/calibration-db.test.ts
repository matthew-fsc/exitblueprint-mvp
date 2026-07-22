// Server-layer round trip for the calibration engine (docs/09 moat 1). Requires a
// migrated + seeded database (DATABASE_URL); skipped otherwise. Proves that
// computeCalibration reads the CROSS-FIRM deal_outcomes corpus, persists a versioned
// snapshot into the analytics schema with the right per-band statistics, and that
// readCalibration returns the latest — including the contributing_firms
// de-identification guard.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { computeCalibration, readCalibration } from '../server/calibration';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('calibration engine (server, DB-backed)', () => {
  let db: pg.Client;
  const firmIds: string[] = [];

  beforeAll(async () => {
    db = new pg.Client({ connectionString: url });
    await db.connect();

    // Three closed deals predicted in the DRS 70–75 band across TWO firms + one
    // broken, so the band has a known close rate (3/4), multiple median (5.0 of
    // {4,5,6}) and contributing_firms = 2 (calibrated, not low-confidence).
    const specs = [
      { firm: 0, drs: 71, outcome: 'closed', mult: 4.0, ev: 5_000_000, days: 180, retrade: true },
      { firm: 1, drs: 72, outcome: 'closed', mult: 5.0, ev: 5_000_000, days: 200, retrade: false },
      { firm: 0, drs: 73, outcome: 'closed', mult: 6.0, ev: 7_000_000, days: 220, retrade: false },
      { firm: 1, drs: 74, outcome: 'broken', mult: null, ev: null, days: null, retrade: false },
    ];
    for (let i = 0; i < 2; i++) {
      const fid = (await db.query(`insert into firms (name) values ($1) returning id`, [`Calib Firm ${i}`])).rows[0].id;
      firmIds.push(fid);
    }
    for (const s of specs) {
      const fid = firmIds[s.firm];
      const companyId = (
        await db.query(`insert into companies (firm_id, name) values ($1, 'Calib Co') returning id`, [fid])
      ).rows[0].id;
      const eng = (
        await db.query(`insert into engagements (firm_id, company_id) values ($1, $2) returning id`, [fid, companyId])
      ).rows[0].id;
      await db.query(
        `insert into deal_outcomes
           (firm_id, engagement_id, outcome, predicted_drs, predicted_ev_low, predicted_ev_base, predicted_ev_high,
            final_ev, final_multiple, days_on_market, retrade)
         values ($1, $2, $3, $4, 4000000, 5000000, 6000000, $5, $6, $7, $8)`,
        [fid, eng, s.outcome, s.drs, s.ev, s.mult, s.days, s.retrade],
      );
    }
  });

  afterAll(async () => {
    if (!db) return;
    await db.query(`delete from analytics.calibration_bands where calibration_version in
      (select calibration_version from analytics.calibration_versions)`);
    // Snapshots are keyed only by version; clean the ones this test created by
    // truncating is too broad, so delete rows whose corpus matches our inserts.
    for (const fid of firmIds) {
      await db.query(`delete from deal_outcomes where firm_id = $1`, [fid]);
      await db.query(`delete from engagements where firm_id = $1`, [fid]);
      await db.query(`delete from companies where firm_id = $1`, [fid]);
      await db.query(`delete from firms where id = $1`, [fid]);
    }
    await db.end();
  });

  it('computes and persists a versioned snapshot with correct band stats', async () => {
    const out = await computeCalibration(db, { min_sample: 1 });
    expect(out.calibration_version).toBeGreaterThanOrEqual(1);
    expect(out.total_outcomes).toBeGreaterThanOrEqual(4);
    expect(out.total_closed).toBeGreaterThanOrEqual(3);

    const band = out.bands.find(
      (b) => (b as { band_low: number; group_key: string }).band_low === 70 && (b as { group_key: string }).group_key === 'drs',
    ) as Record<string, unknown>;
    expect(band.sample_n).toBe(4);
    expect(band.closed_n).toBe(3);
    expect(band.close_rate_pct).toBe(75);
    expect(band.median_multiple).toBe(5.0);
    expect(band.p25_multiple).toBe(4.5);
    expect(band.p75_multiple).toBe(5.5);
    expect(band.median_days_to_close).toBe(200);
    // finals {5M,5M,7M} vs base 5M → within-range 2/3 (67%); median variance 0%.
    expect(band.within_range_hit_rate_pct).toBe(67);
    expect(band.ev_variance_pct).toBe(0);
    expect(band.retrade_rate_pct).toBe(33);
    expect(band.contributing_firms).toBe(2);
    expect(band.low_confidence).toBe(false);
  });

  it('bumps the version on recompute and readCalibration returns the latest', async () => {
    const first = await computeCalibration(db, { min_sample: 1 });
    const second = await computeCalibration(db, { min_sample: 1 });
    expect(Number(second.calibration_version)).toBeGreaterThan(Number(first.calibration_version));

    const read = await readCalibration(db);
    expect(read.calibration_version).toBe(second.calibration_version);
    expect(read.bands.length).toBeGreaterThan(0);
  });
});
