// Unit test for the moat-KPIs assembler (docs/40 §4a-§4b, docs/09). No live DB:
// a fake pg client returns canned view rows so we exercise the SHAPE and the
// numeric coercion of the calibration-corpus snapshot. The cross-firm isolation
// of the `analytics` schema itself is proven live in scripts/rls-test.ts.
import { describe, it, expect } from 'vitest';
import { moatMetrics } from '../server/moat-metrics';
import type pg from 'pg';

// Map a substring of the SQL to the rows that query should return. Routes are
// checked in order and the first substring match wins, so list the more specific
// `..._monthly` needle before the `calibration_corpus` prefix it contains.
function fakeDb(routes: Array<[string, Record<string, unknown>[]]>): pg.ClientBase {
  return {
    query: async (text: string) => {
      for (const [needle, rows] of routes) {
        if (text.includes(needle)) return { rows } as never;
      }
      return { rows: [] } as never;
    },
  } as unknown as pg.ClientBase;
}

describe('moatMetrics', () => {
  it('assembles the calibration-corpus snapshot and coerces scalar stats to numbers', async () => {
    const db = fakeDb([
      [
        'analytics.calibration_corpus_monthly',
        [
          { month: '2026-05-01', closed_deals: '2', paired_outcomes: '2', avg_final_multiple: '5.1' },
          { month: '2026-06-01', closed_deals: '3', paired_outcomes: '2', avg_final_multiple: '6.0' },
        ],
      ],
      [
        'analytics.calibration_corpus',
        [
          {
            deals_recorded: '12',
            closed_deals: '8',
            broken_deals: '3',
            withdrawn_deals: '1',
            paired_outcomes: '6',
            within_range_pct: '83',
            avg_ev_variance_pct: '-4.2',
            avg_final_multiple: '5.7',
            retrade_rate_pct: '25',
            avg_days_on_market: '190',
          },
        ],
      ],
    ]);

    const m = await moatMetrics(db);

    // Scalar corpus stats are numified — the business plan's core KPIs.
    expect(m.corpus.paired_outcomes).toBe(6);
    expect(m.corpus.within_range_pct).toBe(83);
    expect(m.corpus.avg_ev_variance_pct).toBe(-4.2);
    expect(m.corpus.avg_final_multiple).toBe(5.7);
    expect(m.corpus.retrade_rate_pct).toBe(25);
    expect(typeof m.corpus.closed_deals).toBe('number');

    // Corpus-growth rows pass through untouched.
    expect(m.corpus_monthly).toHaveLength(2);
    expect(m.corpus_monthly[0]).toMatchObject({ month: '2026-05-01', paired_outcomes: '2' });

    // Stamped generation time.
    expect(() => new Date(m.generated_at).toISOString()).not.toThrow();
  });

  it('drops null aggregates and degrades to an empty snapshot when the corpus is empty', async () => {
    // A brand-new platform: the corpus view returns all-null aggregate columns
    // and the monthly view has no rows yet.
    const db = fakeDb([
      ['analytics.calibration_corpus_monthly', []],
      [
        'analytics.calibration_corpus',
        [
          {
            deals_recorded: '0',
            closed_deals: '0',
            paired_outcomes: '0',
            within_range_pct: null,
            avg_ev_variance_pct: null,
            avg_final_multiple: null,
            retrade_rate_pct: null,
          },
        ],
      ],
    ]);

    const m = await moatMetrics(db);

    expect(m.corpus.deals_recorded).toBe(0);
    expect(m.corpus.paired_outcomes).toBe(0);
    // Null aggregates are dropped, not coerced to NaN.
    expect('within_range_pct' in m.corpus).toBe(false);
    expect('avg_final_multiple' in m.corpus).toBe(false);
    expect(m.corpus_monthly).toEqual([]);
  });

  it('degrades to an empty snapshot when the views return no rows', async () => {
    const m = await moatMetrics(fakeDb([]));
    expect(m.corpus).toEqual({});
    expect(m.corpus_monthly).toEqual([]);
  });
});
