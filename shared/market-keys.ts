// Market-intelligence key normalization (docs/sellside-ai/01-market-intelligence-rag.md,
// "Sector/size key mapping") — the pure, unit-tested module that maps a raw licensed
// market row (an industry string + a size band) into the SAME valuation key-space
// the engine already uses, so a `market` multiple lines up with the seeded table
// multiple and the firm's own-book multiple.
//
// Determinism & no I/O (CLAUDE.md §1): plain string normalization, no LLM, no DB.
// The caller hands in the raw fields; this returns the canonical keys. It exists so
// the fiddly industry→bucket mapping lives in one trivially testable place, mirroring
// shared/own-book.ts.
//
// CRITICAL — key parity: `marketIndustryKey` MUST produce the exact same buckets as
// server/valuation.ts `industryKeyFor()` (field_services / manufacturing /
// distribution / healthcare / software / default). The regex below is kept identical
// to that function on purpose; if one changes, change both together (a market
// multiple keyed differently than the table multiple would never line up).

/**
 * Normalize a raw industry string to the valuation industry_key bucket. Identical
 * mapping to server/valuation.ts `industryKeyFor()` — keep the two in lockstep.
 */
export function marketIndustryKey(industry: string | null): string {
  const s = (industry ?? '').toLowerCase();
  if (/facilit|field|clean|hvac|landscap|electric|security|maintenance|roofing|services/.test(s)) return 'field_services';
  if (/manufactur|fabricat|machin|plastic|industrial|coating|precision/.test(s)) return 'manufacturing';
  if (/distribut|logistic|transport|supply|wholesale|marine/.test(s)) return 'distribution';
  if (/health|dental|medical|care|behavioral/.test(s)) return 'healthcare';
  if (/software|saas|tech|data|lattice|it\b/.test(s)) return 'software';
  return 'default';
}

// The valuation size-band key-space (server/valuation.ts derives these from the
// active valuation_rules_version's size_bands + the defensible EBITDA).
export type MarketSizeBand = 'lt_1m' | '1_3m' | '3_5m' | 'gt_5m';
const SIZE_BANDS: readonly string[] = ['lt_1m', '1_3m', '3_5m', 'gt_5m'];

/**
 * Normalize a raw size band to the valuation size-band key-space. A value already in
 * the key-space passes through; anything else falls back to the widest band so a
 * mislabeled licensed row can never silently match a narrower band. Pure and total.
 */
export function marketSizeBand(sizeBand: string | null): MarketSizeBand {
  const s = (sizeBand ?? '').trim().toLowerCase();
  return (SIZE_BANDS.includes(s) ? s : 'gt_5m') as MarketSizeBand;
}
