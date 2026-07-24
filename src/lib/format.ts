// One shared formatter for every number the UI shows — scores, deltas,
// currency, dates (spec §7). Consistent rounding and tabular presentation are a
// professionalism requirement: advisors compare columns of figures.

// Scores are 0–100, one decimal only when needed (DRS is rounded to 1dp by the
// engine; dimension scores to 2dp). We display DRS/ORI as given.
export function fmtScore(n: number | string | null | undefined): string {
  if (n === null || n === undefined || n === '') return '—';
  // Numeric DB columns arrive as strings; coerce here so callers don't wrap in
  // Number() — which turns a genuine null into 0 and defeats this "—" guard.
  const num = typeof n === 'number' ? n : Number(n);
  if (Number.isNaN(num)) return '—';
  // trim a trailing .0 but keep genuine decimals
  return Number.isInteger(num) ? String(num) : String(Math.round(num * 100) / 100);
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
  // Threshold at 999_500, not 1_000_000: a value like $999,600 rounds up to
  // 1000K in the K branch, which must render as "$1.0M", never "$1000K".
  if (abs >= 999_500) return `$${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return USD.format(n);
}

const DATE = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

export function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return '—';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return '—';
  return DATE.format(date);
}

// Turn an internal snake_case / UPPER_SNAKE key (field_key, pattern_key, item
// code) into a human label for display — machine identifiers must never reach an
// advisor's screen. Common finance acronyms are cased correctly.
const ACRONYMS: Record<string, string> = {
  ebitda: 'EBITDA', gaap: 'GAAP', sop: 'SOP', sops: 'SOPs', ar: 'AR', ap: 'AP',
  arr: 'ARR', mrr: 'MRR', crm: 'CRM', kpi: 'KPI', kpis: 'KPIs', pct: '%',
  hr: 'HR', it: 'IT', qoe: 'QoE', osha: 'OSHA', sla: 'SLA', ceo: 'CEO', p: 'P',
  cim: 'CIM', drs: 'DRS', ori: 'ORI', nda: 'NDA', loi: 'LOI',
};
export function humanizeKey(key: string | null | undefined): string {
  if (!key) return '—';
  return String(key)
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w, i) => {
      const a = ACRONYMS[w.toLowerCase()];
      if (a) return a;
      return i === 0 ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase();
    })
    .join(' ');
}

// Format a reconciliation / evidence value in the context of its field key:
// money fields render as currency, ratio/percent fields as a percentage, other
// numbers get thousands separators, and non-numeric values pass through. No raw
// integers like "10000000" ever reach the UI.
const MONEY_HINT = /(revenue|ebitda|income|cost|debt|value|proceeds|comp|salary|price|cash|arr|mrr|settlement|payroll|capital|ev|purchase)/i;
const PCT_HINT = /(pct|percent|ratio|rate|margin|concentration|share)/i;
export function formatFieldValue(key: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'number' && !Number.isNaN(v)) {
    if (PCT_HINT.test(key)) return `${Math.round(v <= 1 && v > 0 ? v * 100 : v)}%`;
    if (MONEY_HINT.test(key)) return fmtCurrency(v);
    return v.toLocaleString('en-US');
  }
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) {
    return formatFieldValue(key, Number(v));
  }
  if (typeof v === 'string') return v;
  return String(v);
}

// Whole-number count of days between a past date and now (never negative).
export function daysSince(d: string | Date | null | undefined): number | null {
  if (!d) return null;
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / 86_400_000));
}
