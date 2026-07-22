// R&D PROTOTYPE — NOT PRODUCTION. See dev/frontier/README.md.
//
// Local, self-contained mirror of the fields this prototype reasons about. In
// production these come from real tables (server/outcomes.ts, docs/09 moat 1):
//   - PairedOutcome mirrors a `deal_outcomes` row: the frozen PREDICTION
//     (predicted_drs, predicted_ev_low/base/high) paired with REALITY
//     (final_ev, final_multiple, ebitda_at_close, days_on_market, retrade).
//   - CurrentRubric mirrors the versioned valuation rule this prototype would
//     propose superseding: the readiness multiple table by DRS band that
//     server/valuation.ts multiplies EBITDA by (valuation-multiples.csv +
//     readiness_factor).
//
// Nothing here imports from the app; the prototype is intentionally decoupled so
// it runs with `node --experimental-strip-types` (or tsx) on synthetic data.

// One closed engagement: what we predicted at go-to-market vs. what the market did.
export interface PairedOutcome {
  engagement_id: string;
  industry: string;
  size_band: string; // e.g. 'ebitda_1_3m'
  // --- Prediction snapshot (frozen when the outcome was recorded) ---
  predicted_drs: number; // 0..100, deterministic DRS at prediction time
  predicted_ev_low: number;
  predicted_ev_base: number;
  predicted_ev_high: number;
  // --- Reality (advisor-reported fact at close) ---
  final_ev: number;
  final_multiple: number;
  ebitda_at_close: number;
  days_on_market: number;
  retrade: boolean;
}

// A DRS band the calibration table is bucketed into. Bands are rubric data, not
// code — here they are fixed for the demo.
export interface DrsBand {
  key: string; // e.g. 'sale_ready'
  label: string;
  min: number; // inclusive
  max: number; // exclusive (last band is inclusive of 100 via a +epsilon)
}

// The current (versioned) valuation rule the prototype reads read-only and would
// propose superseding — never edit. `readiness_multiple` is the multiple the
// deterministic engine applies to defensible EBITDA for a company whose DRS
// falls in this band.
export interface RubricBandRule {
  band_key: string;
  readiness_multiple: number;
}

export interface CurrentRubric {
  valuation_rules_version: string; // e.g. 'val_2026_02'
  bands: RubricBandRule[];
}
