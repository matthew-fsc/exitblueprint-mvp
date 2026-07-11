// One shared formatter for every number the UI shows — scores, deltas,
// currency, dates (spec §7). Consistent rounding and tabular presentation are a
// professionalism requirement: advisors compare columns of figures.

// Scores are 0–100, one decimal only when needed (DRS is rounded to 1dp by the
// engine; dimension scores to 2dp). We display DRS/ORI as given.
export function fmtScore(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  // trim a trailing .0 but keep genuine decimals
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

// Signed delta with an arrow, for DeltaChip and prose. Zero renders as an
// explicit no-change marker rather than "+0".
export function fmtDelta(n: number | null | undefined, digits = 1): {
  text: string;
  sign: 'up' | 'down' | 'flat';
} {
  if (n === null || n === undefined || Number.isNaN(n)) return { text: '—', sign: 'flat' };
  const rounded = Math.round(n * 10 ** digits) / 10 ** digits;
  if (rounded === 0) return { text: 'no change', sign: 'flat' };
  const sign = rounded > 0 ? 'up' : 'down';
  const arrow = rounded > 0 ? '▲' : '▼';
  const body = Math.abs(rounded).toFixed(digits).replace(/\.0+$/, '');
  return { text: `${arrow} ${rounded > 0 ? '+' : '−'}${body}`, sign };
}

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

export function fmtCurrency(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return USD.format(n);
}

// Compact currency for dense tiles ($4.6M, $920K).
export function fmtCurrencyCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return USD.format(n);
}

const DATE = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
const DATE_SHORT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });

export function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return '—';
  return DATE.format(date);
}

export function fmtDateShort(d: string | Date | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return '—';
  return DATE_SHORT.format(date);
}

// Whole-number count of days between a past date and now (never negative).
export function daysSince(d: string | Date | null | undefined): number | null {
  if (!d) return null;
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / 86_400_000));
}
