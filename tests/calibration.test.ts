// Unit tests for the outcome-calibration math + the server read shape (docs/09
// moat 1). The math is pure and deterministic — no DB — so the same corpus always
// yields the same bands, exactly like the scoring-engine fixtures. Covers
// bucketing, every per-band statistic, the two score groups (rule #3a), the
// top-band fold, and the low-confidence / de-identification guard. The read shape
// is exercised with a fake pg client (the service-role isolation of the analytics
// schema itself is proven live in scripts/rls-test.ts).
import { describe, it, expect } from 'vitest';
import type pg from 'pg';
import { computeCalibrationArtifact, type OutcomeRecord } from '../shared/calibration/compute';
import { readCalibration } from '../server/calibration';
import { calibrationBands } from '../src/lib/platformConsole';

// A closed outcome with sensible defaults; override per case. Distinct firm_ids by
// default so bands are not flagged low-confidence purely for single-firm-ness.
let seq = 0;
function outcome(over: Partial<OutcomeRecord> = {}): OutcomeRecord {
  seq += 1;
  return {
    firm_id: `firm-${seq}`,
    outcome: 'closed',
    predicted_drs: 72,
    predicted_ori: null,
    predicted_ev_low: 4_000_000,
    predicted_ev_base: 5_000_000,
    predicted_ev_high: 6_000_000,
    final_ev: 5_000_000,
    final_multiple: 5.0,
    days_on_market: 200,
    retrade: false,
    ...over,
  };
}

describe('computeCalibrationArtifact', () => {
  it('buckets DRS predictions into fixed-width bands with a readable label', () => {
    const art = computeCalibrationArtifact(
      [outcome({ predicted_drs: 70 }), outcome({ predicted_drs: 74 }), outcome({ predicted_drs: 66 })],
      { band_width: 5, min_sample: 1 },
    );
    const drs = art.bands.filter((b) => b.group_key === 'drs');
    expect(drs.map((b) => b.band_label)).toEqual(['65–70', '70–75']);
    const b70 = drs.find((b) => b.band_low === 70)!;
    expect(b70.sample_n).toBe(2); // 70 and 74 both fall in [70,75)
    expect(b70.band_high).toBe(75);
  });

  it('folds a perfect 100 into the top band rather than orphaning it', () => {
    const art = computeCalibrationArtifact([outcome({ predicted_drs: 100 })], { band_width: 5, min_sample: 1 });
    const band = art.bands.find((b) => b.group_key === 'drs')!;
    expect(band.band_low).toBe(95);
    expect(band.band_high).toBe(100);
    expect(band.band_label).toBe('95–100');
  });

  it('computes close rate over ALL outcomes in the band (closed / sample_n)', () => {
    const art = computeCalibrationArtifact(
      [
        outcome({ predicted_drs: 71, outcome: 'closed' }),
        outcome({ predicted_drs: 72, outcome: 'closed' }),
        outcome({ predicted_drs: 73, outcome: 'closed' }),
        outcome({ predicted_drs: 74, outcome: 'broken' }),
      ],
      { band_width: 5, min_sample: 1 },
    );
    const band = art.bands.find((b) => b.band_low === 70)!;
    expect(band.sample_n).toBe(4);
    expect(band.closed_n).toBe(3);
    expect(band.close_rate_pct).toBe(75);
  });

  it('reports median and interquartile realized multiple over closed deals only', () => {
    const art = computeCalibrationArtifact(
      [
        outcome({ predicted_drs: 71, final_multiple: 4.0 }),
        outcome({ predicted_drs: 72, final_multiple: 5.0 }),
        outcome({ predicted_drs: 73, final_multiple: 6.0 }),
        // a broken deal in the same band must NOT contribute a multiple
        outcome({ predicted_drs: 74, outcome: 'broken', final_multiple: 99 }),
      ],
      { band_width: 5, min_sample: 1 },
    );
    const band = art.bands.find((b) => b.band_low === 70)!;
    expect(band.median_multiple).toBe(5.0);
    expect(band.p25_multiple).toBe(4.5); // linear interpolation of [4,5,6] at p25
    expect(band.p75_multiple).toBe(5.5);
  });

  it('computes within-range hit rate and median EV variance', () => {
    const art = computeCalibrationArtifact(
      [
        // inside the 4M–6M band, +0% variance
        outcome({ predicted_drs: 71, final_ev: 5_000_000 }),
        // above the high edge (7M), variance +40%, out of range
        outcome({ predicted_drs: 72, final_ev: 7_000_000 }),
      ],
      { band_width: 5, min_sample: 1 },
    );
    const band = art.bands.find((b) => b.band_low === 70)!;
    expect(band.within_range_hit_rate_pct).toBe(50); // 1 of 2 inside [low,high]
    expect(band.ev_variance_pct).toBe(20); // median of {0, +40}
  });

  it('computes median time-to-close and retrade rate over closed deals', () => {
    const art = computeCalibrationArtifact(
      [
        outcome({ predicted_drs: 71, days_on_market: 180, retrade: true }),
        outcome({ predicted_drs: 72, days_on_market: 220, retrade: false }),
      ],
      { band_width: 5, min_sample: 1 },
    );
    const band = art.bands.find((b) => b.band_low === 70)!;
    expect(band.median_days_to_close).toBe(200); // (180+220)/2
    expect(band.retrade_rate_pct).toBe(50);
  });

  it('keeps DRS and ORI bands separate (rule #3a) and never mixes them', () => {
    const art = computeCalibrationArtifact(
      [outcome({ predicted_drs: 72, predicted_ori: 40 }), outcome({ predicted_drs: 73, predicted_ori: 42 })],
      { band_width: 5, min_sample: 1 },
    );
    const groups = new Set(art.bands.map((b) => b.group_key));
    expect(groups).toEqual(new Set(['drs', 'ori']));
    expect(art.bands.find((b) => b.group_key === 'ori')!.band_low).toBe(40);
    // DRS bands come first, then ORI (each ascending).
    expect(art.bands[0].group_key).toBe('drs');
    expect(art.bands[art.bands.length - 1].group_key).toBe('ori');
  });

  it('flags low_confidence for a thin sample OR a single contributing firm', () => {
    // Below min_sample → low confidence.
    const thin = computeCalibrationArtifact(
      [outcome({ predicted_drs: 71 }), outcome({ predicted_drs: 72 })],
      { band_width: 5, min_sample: 5 },
    );
    expect(thin.bands.find((b) => b.band_low === 70)!.low_confidence).toBe(true);

    // Enough deals but all from ONE firm → still low confidence (de-identification).
    const oneFirm = computeCalibrationArtifact(
      [1, 2, 3, 4, 5].map((d) => outcome({ predicted_drs: 70 + (d % 5), firm_id: 'solo-firm' })),
      { band_width: 5, min_sample: 3 },
    );
    expect(oneFirm.bands.find((b) => b.band_low === 70)!.low_confidence).toBe(true);
    expect(oneFirm.bands.find((b) => b.band_low === 70)!.contributing_firms).toBe(1);

    // Enough deals across ≥2 firms → calibrated.
    const solid = computeCalibrationArtifact(
      [
        outcome({ predicted_drs: 71, firm_id: 'a' }),
        outcome({ predicted_drs: 72, firm_id: 'b' }),
        outcome({ predicted_drs: 73, firm_id: 'c' }),
      ],
      { band_width: 5, min_sample: 3 },
    );
    expect(solid.bands.find((b) => b.band_low === 70)!.low_confidence).toBe(false);
    expect(solid.contributing_firms).toBe(3);
  });

  it('ignores outcomes with no predicted score for the group', () => {
    const art = computeCalibrationArtifact([outcome({ predicted_drs: null, predicted_ori: null })], {
      band_width: 5,
      min_sample: 1,
    });
    expect(art.bands).toEqual([]);
    expect(art.total_outcomes).toBe(1);
  });

  it('is deterministic and returns an empty artifact for an empty corpus', () => {
    const corpus = [outcome({ predicted_drs: 71 }), outcome({ predicted_drs: 88 })];
    expect(computeCalibrationArtifact(corpus)).toEqual(computeCalibrationArtifact(corpus));
    const empty = computeCalibrationArtifact([]);
    expect(empty.bands).toEqual([]);
    expect(empty.total_outcomes).toBe(0);
    expect(empty.contributing_firms).toBe(0);
  });
});

// Map a substring of the SQL to the rows that query should return.
function fakeDb(rows: Record<string, unknown>[]): pg.ClientBase {
  return {
    query: async (text: string) => (text.includes('analytics.calibration_latest') ? { rows } : { rows: [] }) as never,
  } as unknown as pg.ClientBase;
}

describe('readCalibration (server, fake db)', () => {
  it('assembles the latest snapshot shape and numifies band stats', async () => {
    const snap = await readCalibration(
      fakeDb([
        {
          calibration_version: '3',
          computed_at: '2026-07-01T00:00:00.000Z',
          band_width: '5',
          total_outcomes: '40',
          total_closed: '25',
          contributing_firms: '6',
          group_key: 'drs',
          band_low: '70',
          band_high: '75',
          band_label: '70–75',
          sample_n: '8',
          closed_n: '7',
          band_contributing_firms: '3',
          close_rate_pct: '88',
          median_multiple: '4.90',
          p25_multiple: '4.50',
          p75_multiple: '5.40',
          median_days_to_close: '410',
          within_range_hit_rate_pct: '82',
          ev_variance_pct: '-3.1',
          retrade_rate_pct: '14',
          low_confidence: false,
        },
      ]),
    );
    expect(snap.calibration_version).toBe(3);
    expect(snap.total_closed).toBe(25);
    expect(snap.bands).toHaveLength(1);
    expect(snap.bands[0]).toMatchObject({ band_label: '70–75', median_multiple: 4.9, within_range_hit_rate_pct: 82 });
    expect(snap.note).toMatch(/service_role|de-identified/i);
    expect(snap.note).not.toMatch(/firm_id/);
  });

  it('degrades to an empty snapshot before the first compute', async () => {
    const snap = await readCalibration(fakeDb([]));
    expect(snap.calibration_version).toBeNull();
    expect(snap.bands).toEqual([]);
  });
});

describe('calibrationBands helper', () => {
  it('splits bands by score group, ascending by band_low', () => {
    const rows = [
      { group_key: 'ori', band_low: 40 },
      { group_key: 'drs', band_low: 75 },
      { group_key: 'drs', band_low: 70 },
    ];
    expect(calibrationBands(rows, 'drs').map((r) => r.band_low)).toEqual([70, 75]);
    expect(calibrationBands(rows, 'ori').map((r) => r.band_low)).toEqual([40]);
  });
});
