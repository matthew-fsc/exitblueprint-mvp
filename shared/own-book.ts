// Own-book valuation multiples (docs/09-moats.md, moat 2) — the deterministic,
// pure core that lets valuation refine its multiple "from our own book of closed
// deals" ALONGSIDE the generic industry/size table.
//
// Scope & isolation (CLAUDE.md §5): this operates on a FIRM'S OWN realized
// deal_outcomes — the advisor's own closed deals, firm-scoped, exactly like
// shared/comparables.ts. It is NOT the cross-firm benchmarking pool (that stays
// service-role-only in the `analytics` schema, internal calibration, never a
// firm-facing read). No company/firm identity flows through here — just the
// realized multiples the caller already fetched under firm scope.
//
// Determinism & versioning (CLAUDE.md §1, §6): no LLM, no I/O — plain arithmetic
// on rows the caller assembles. WHETHER the own-book multiple actually drives the
// number is decided by `selectValuationMultiple` from the ACTIVE
// valuation_rules_version config; adopting it is a NEW version, never an in-place
// edit. With the corpus disabled (the default) the generic table multiple is
// returned unchanged.

// A single realized deal the caller fetched (firm-scoped, de-identified to just
// the number + which size band it fell in).
export interface OwnBookDeal {
  multiple: number;
  sizeBand: string | null;
}

export type OwnBookConfidence = 'low' | 'moderate' | 'high';

// The firm's own-book distribution for one industry, plus how many of those deals
// sat in the subject's size band (a tighter-comp signal).
export interface OwnBookMultiple {
  sample_size: number;
  same_band_count: number;
  median: number;
  mean: number;
  p25: number;
  p75: number;
  min: number;
  max: number;
  confidence: OwnBookConfidence;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Deterministic linear-interpolation quantile over an ascending-sorted array. */
export function quantile(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  if (n === 1) return sortedAsc[0];
  const idx = (n - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

/**
 * Confidence in an own-book multiple, from sample depth alone. Firm own-book
 * samples are small, so the thresholds are lower than the cross-firm corpus.
 */
export function ownBookConfidence(sampleSize: number): OwnBookConfidence {
  if (sampleSize >= 8) return 'high';
  if (sampleSize >= 4) return 'moderate';
  return 'low';
}

/**
 * Reduce a firm's realized deals (already filtered to the subject industry) to an
 * own-book multiple distribution. Returns null when there are no usable deals.
 * `subjectSizeBand` is used only to count same-band deals — the aggregate itself
 * spans the whole industry so the sample stays meaningful.
 */
export function aggregateOwnBook(
  deals: OwnBookDeal[],
  subjectSizeBand: string | null,
): OwnBookMultiple | null {
  const usable = deals.filter((d) => Number.isFinite(d.multiple) && d.multiple > 0);
  if (usable.length === 0) return null;

  const multiples = usable.map((d) => d.multiple).sort((a, b) => a - b);
  const sameBand =
    subjectSizeBand == null ? 0 : usable.filter((d) => d.sizeBand === subjectSizeBand).length;

  return {
    sample_size: usable.length,
    same_band_count: sameBand,
    median: round2(quantile(multiples, 0.5)),
    mean: round2(multiples.reduce((s, x) => s + x, 0) / multiples.length),
    p25: round2(quantile(multiples, 0.25)),
    p75: round2(quantile(multiples, 0.75)),
    min: round2(multiples[0]),
    max: round2(multiples[multiples.length - 1]),
    confidence: ownBookConfidence(usable.length),
  };
}

// ── Which multiple drives the valuation, and why ────────────────────────────────
export interface MultipleSelection {
  multiple: number;
  source: 'override' | 'table' | 'own_book';
  // The own-book context is attached whenever a distribution exists — even when it
  // is NOT driving the number — so the surface can always show own-book vs. table.
  own_book: (OwnBookMultiple & { driving: boolean }) | null;
}

/**
 * Choose the base multiple deterministically.
 *
 * Precedence: an explicit advisor override always wins; otherwise the firm's
 * own-book median is used ONLY when the versioned config enables it AND the sample
 * clears its floor; otherwise the generic versioned table multiple.
 *
 * `config.enabled` comes from the active valuation_rules_version (CLAUDE.md §6):
 * with the own-book corpus disabled (the default) this returns the table/override
 * multiple unchanged, so adopting own-book multiples is a NEW rules version, never
 * an in-place recalibration.
 */
export function selectValuationMultiple(args: {
  tableMultiple: number;
  override: number | null;
  ownBook: OwnBookMultiple | null;
  config: { enabled: boolean; minSampleSize: number };
}): MultipleSelection {
  const { tableMultiple, override, ownBook, config } = args;
  const usable =
    config.enabled && ownBook != null && ownBook.sample_size >= Math.max(1, config.minSampleSize);

  let source: MultipleSelection['source'];
  let multiple: number;
  if (override != null && Number.isFinite(override)) {
    source = 'override';
    multiple = override;
  } else if (usable && ownBook != null) {
    source = 'own_book';
    multiple = ownBook.median;
  } else {
    source = 'table';
    multiple = tableMultiple;
  }

  return {
    multiple,
    source,
    own_book: ownBook ? { ...ownBook, driving: source === 'own_book' } : null,
  };
}
