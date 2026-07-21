// Moat KPIs assembler — "the moats ARE the business plan" (docs/40 §4a-§4b,
// docs/09-moats.md). Assembles the calibration-corpus snapshot the operator
// dashboard treats as the company's core KPI: the growth and predictive power of
// the paired prediction/reality records in deal_outcomes, read from the
// service-role-only `analytics` schema
// (supabase/migrations/20260721001200_moat_kpis.sql). The numbers use the same
// within-range / EV-variance / retrade definitions as server/outcomes.ts
// firmCalibration, rolled up PLATFORM-WIDE across firms.
//
// Read-only (CLAUDE.md §1-2, §4): every query is a SELECT over a rollup view;
// nothing here writes a score, mutates an assessment, recalibrates a rubric, or
// touches client data. Cross-firm isolation (CLAUDE.md §5): the `analytics`
// schema is granted to service_role ONLY, so this runs exclusively on the
// service-role connection behind the superadmin-gated GET /internal/metrics route
// (server/http.ts) — never on a tenant JWT path. Counts + aggregate stats only,
// no PII.
//
// Operator/superadmin rail ONLY: this does NOT reintroduce the deliberately-
// removed firm-facing predicted-vs-actual UI.
import type pg from 'pg';

// Either a pooled client or the Pool itself — both expose `.query`. The route
// passes the service-role Pool directly (read-only cross-tenant snapshot); the
// test passes a fake client.
type Queryable = Pick<pg.ClientBase, 'query'> | Pick<pg.Pool, 'query'>;

export interface MoatMetrics {
  generated_at: string;
  // The calibration corpus as the business plan's core KPI (one-row rollup):
  // paired_outcomes, within_range_pct, avg_ev_variance_pct, avg_final_multiple,
  // retrade_rate_pct, ... — see analytics.calibration_corpus.
  corpus: Record<string, number>;
  // Corpus growth over time: paired outcomes (and closed deals) by month.
  corpus_monthly: Record<string, unknown>[];
}

// Postgres returns count()/numeric as strings; coerce a one-row scalar object to
// numbers so the JSON is charts-ready. Null aggregates (empty corpus) become NaN;
// keep them numeric-typed but drop the key so the snapshot stays clean.
function numify(row: Record<string, unknown> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(row ?? {})) {
    if (v === null || v === undefined) continue;
    out[k] = Number(v);
  }
  return out;
}

export async function moatMetrics(db: Queryable): Promise<MoatMetrics> {
  const corpus = (await db.query('select * from analytics.calibration_corpus')).rows[0];

  const corpusMonthly = (
    await db.query(
      `select month, closed_deals, paired_outcomes, avg_final_multiple
         from analytics.calibration_corpus_monthly
        order by month`,
    )
  ).rows;

  return {
    generated_at: new Date().toISOString(),
    corpus: numify(corpus),
    corpus_monthly: corpusMonthly,
  };
}
