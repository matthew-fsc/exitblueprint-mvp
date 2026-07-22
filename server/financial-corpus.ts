// Verified financial corpus assembler (docs/09-moats.md, moat 2) — assemble the
// internal cross-firm calibration snapshot from the service-role-only `analytics`
// schema (supabase/migrations/20260721001000_financial_corpus.sql). This is the
// substrate that lets us refine valuation multiples "from our own book of verified
// deals": de-identified distributions of document-/ledger-backed financials and
// realized deal multiples, aggregated by industry × size band.
//
// ISOLATION (CLAUDE.md §5, docs/38 §0): every query is a SELECT over an `analytics`
// rollup view granted to `service_role` ONLY — `authenticated`/`anon` cannot read
// the schema, so cross-firm aggregation can never reach a tenant. This runs on the
// service-role connection behind the superadmin gate, mirroring platform-metrics;
// it never executes on a tenant JWT path. Every view emits COUNTS and aggregate
// statistics only — no firm/company id, no raw client financials, no PII.
//
// READ-ONLY (CLAUDE.md §1-2, §4): views only. Nothing here writes a score, mutates
// an assessment, or touches client data. Calibration informs a future
// rubric_version / valuation_rules_version; it never edits a score directly. This
// is internal calibration substrate, NOT a client-facing benchmark (out of scope).
import type pg from 'pg';

// Either a pooled client or the Pool itself — both expose `.query`. The route
// passes the service-role Pool directly (a read-only cross-tenant snapshot needs no
// per-request transaction); the test passes a fake client.
type Queryable = Pick<pg.ClientBase, 'query'> | Pick<pg.Pool, 'query'>;

export interface FinancialCorpus {
  generated_at: string;
  // Depth of the verified pool: verified data-point counts per industry × band.
  verified_coverage: Record<string, unknown>[];
  // De-identified distributions of the verified numeric financial inputs, keyed by
  // the dimension + question (metric) that captured them.
  verified_metrics: Record<string, unknown>[];
  // Realized multiples from closed deal_outcomes, per industry × band — the
  // own-book calibration signal.
  own_book_multiples: Record<string, unknown>[];
  // The same realized multiples keyed by the VALUATION industry_key (not raw
  // industry) — the recalibration signal in valuation's own key-space
  // (20260722215029_own_book_valuation_multiples.sql).
  own_book_valuation_multiples: Record<string, unknown>[];
  // Connected-ledger (QuickBooks/Xero) breadth per industry × band — the
  // ground-truth layer.
  ledger_coverage: Record<string, unknown>[];
  note: string;
}

const CORPUS_NOTE =
  'Internal calibration substrate (docs/09 moat 2): de-identified, cross-firm ' +
  'aggregates readable by service_role only. Cells expose counts and distribution ' +
  'statistics, never a firm’s raw financials or PII; a cell with ' +
  'contributing_firms = 1 is a single firm and should be treated as low-confidence. ' +
  'This is NOT a client-facing benchmark (that surface stays out of scope).';

export async function financialCorpus(db: Queryable): Promise<FinancialCorpus> {
  const verifiedCoverage = (
    await db.query(
      `select industry, size_band, verified_data_points, document_verified,
              ledger_verified, contributing_firms, companies, assessments
         from analytics.verified_corpus_coverage
        order by verified_data_points desc, industry, size_band`,
    )
  ).rows;

  const verifiedMetrics = (
    await db.query(
      `select industry, size_band, dimension_code, metric_code, verified_data_points,
              contributing_firms, avg_value, median_value, min_value, max_value,
              p25_value, p75_value
         from analytics.verified_financial_metrics
        order by dimension_code, metric_code, industry, size_band`,
    )
  ).rows;

  const ownBookMultiples = (
    await db.query(
      `select industry, size_band, closed_deals, contributing_firms, avg_multiple,
              median_multiple, min_multiple, max_multiple, avg_final_ev,
              avg_ebitda_at_close, avg_days_on_market, retrade_deals
         from analytics.own_book_multiples
        order by closed_deals desc, industry, size_band`,
    )
  ).rows;

  const ownBookValuationMultiples = (
    await db.query(
      `select industry_key, size_band, closed_deals, contributing_firms, avg_multiple,
              median_multiple, p25_multiple, p75_multiple, min_multiple, max_multiple
         from analytics.own_book_valuation_multiples
        order by closed_deals desc, industry_key, size_band`,
    )
  ).rows;

  const ledgerCoverage = (
    await db.query(
      `select industry, size_band, ledger_connected_companies, contributing_firms,
              quickbooks_connections, xero_connections
         from analytics.ledger_verified_coverage
        order by ledger_connected_companies desc, industry, size_band`,
    )
  ).rows;

  return {
    generated_at: new Date().toISOString(),
    verified_coverage: verifiedCoverage,
    verified_metrics: verifiedMetrics,
    own_book_multiples: ownBookMultiples,
    own_book_valuation_multiples: ownBookValuationMultiples,
    ledger_coverage: ledgerCoverage,
    note: CORPUS_NOTE,
  };
}
