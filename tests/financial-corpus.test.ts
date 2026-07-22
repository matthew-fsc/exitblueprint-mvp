// Unit test for the verified financial corpus assembler (docs/09 moat 2). No live
// DB: a fake pg client returns canned view rows so we exercise the SHAPE of the
// de-identified, cross-firm calibration snapshot. The service-role-only isolation
// of the `analytics` schema itself is proven live in scripts/rls-test.ts.
import { describe, it, expect } from 'vitest';
import { financialCorpus } from '../server/financial-corpus';
import type pg from 'pg';

// Map a substring of the SQL to the rows that query should return.
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

describe('financialCorpus', () => {
  it('assembles the four aggregate blocks from the analytics views', async () => {
    const db = fakeDb([
      [
        'analytics.verified_corpus_coverage',
        [
          {
            industry: 'field_services',
            size_band: '2m_5m',
            verified_data_points: '18',
            document_verified: '10',
            ledger_verified: '8',
            contributing_firms: '3',
            companies: '4',
            assessments: '5',
          },
        ],
      ],
      [
        'analytics.verified_financial_metrics',
        [
          {
            industry: 'field_services',
            size_band: '2m_5m',
            dimension_code: 'REV',
            metric_code: 'REV_TOP_CUST_PCT',
            verified_data_points: '4',
            contributing_firms: '2',
            avg_value: '22.5',
            median_value: '21.0',
          },
        ],
      ],
      [
        'analytics.own_book_multiples',
        [
          {
            industry: 'field_services',
            size_band: '2m_5m',
            closed_deals: '3',
            contributing_firms: '2',
            avg_multiple: '4.80',
            median_multiple: '4.75',
            retrade_deals: '1',
          },
        ],
      ],
      [
        'analytics.own_book_valuation_multiples',
        [
          {
            industry_key: 'field_services',
            size_band: '2m_5m',
            closed_deals: '3',
            contributing_firms: '2',
            avg_multiple: '4.90',
            median_multiple: '4.85',
            p25_multiple: '4.50',
            p75_multiple: '5.20',
          },
        ],
      ],
      [
        'analytics.ledger_verified_coverage',
        [
          {
            industry: 'manufacturing',
            size_band: 'gt_5m',
            ledger_connected_companies: '2',
            contributing_firms: '2',
            quickbooks_connections: '1',
            xero_connections: '1',
          },
        ],
      ],
    ]);

    const corpus = await financialCorpus(db);

    // Each block carries its view's rows, keyed by industry × band.
    expect(corpus.verified_coverage).toHaveLength(1);
    expect(corpus.verified_coverage[0]).toMatchObject({
      industry: 'field_services',
      size_band: '2m_5m',
      ledger_verified: '8',
    });
    expect(corpus.verified_metrics[0]).toMatchObject({ metric_code: 'REV_TOP_CUST_PCT' });
    expect(corpus.own_book_multiples[0]).toMatchObject({ avg_multiple: '4.80', closed_deals: '3' });
    expect(corpus.own_book_valuation_multiples[0]).toMatchObject({
      industry_key: 'field_services',
      median_multiple: '4.85',
    });
    expect(corpus.ledger_coverage[0]).toMatchObject({ industry: 'manufacturing', xero_connections: '1' });

    // De-identification note + stamped generation time.
    expect(corpus.note).toMatch(/service_role|de-identified/i);
    expect(corpus.note).not.toMatch(/firm_id/); // never expose a firm identifier
    expect(() => new Date(corpus.generated_at).toISOString()).not.toThrow();
  });

  it('degrades to empty blocks when the views return no rows', async () => {
    const corpus = await financialCorpus(fakeDb([]));
    expect(corpus.verified_coverage).toEqual([]);
    expect(corpus.verified_metrics).toEqual([]);
    expect(corpus.own_book_multiples).toEqual([]);
    expect(corpus.own_book_valuation_multiples).toEqual([]);
    expect(corpus.ledger_coverage).toEqual([]);
    expect(corpus.note).toContain('calibration');
  });
});
