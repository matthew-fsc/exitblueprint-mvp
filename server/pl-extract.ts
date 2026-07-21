// Deterministic financial-document extractor: turn an uploaded P&L (or a
// revenue-by-customer report) into proposed answers for the derivable financial
// questions. This is DATA ENTRY ASSISTANCE, not scoring — it never computes,
// adjusts, or influences a score, and NO LLM is involved. It parses a structured
// file with plain string/number rules and returns proposals for a human to
// review and apply through enterManualFinancials (which stamps `document`
// provenance = attested to real statements). Whatever it can't recognize is left
// for manual entry, and it only ever proposes codes in LEDGER_DERIVABLE_CODES.
import { parse as parseCsv } from 'csv-parse/sync';
import { LEDGER_DERIVABLE_CODES, type ManualFinancialEntry } from './ledger';

// Codes this extractor knows how to source from a financial document. A strict
// subset of LEDGER_DERIVABLE_CODES — a P&L evidences the revenue trend and the
// recurring share; a revenue-by-customer report evidences concentration.
export const EXTRACTABLE_CODES = ['REV-ANNUAL', 'REV-RECUR-PCT', 'REV-TOP5-SHARES'] as const;

export interface RecognizedFigure {
  code: string; // a LEDGER_DERIVABLE_CODES entry
  label: string; // human label for the review UI
  value: unknown; // the value to write (number | number[])
  detail: string; // how it was derived, shown to the reviewer
}

export interface ExtractResult {
  format: 'pl_csv' | 'customer_csv' | 'json' | 'unrecognized';
  entries: ManualFinancialEntry[]; // ready for enterManualFinancials
  recognized: RecognizedFigure[]; // same data, human-labeled
  notes: string[]; // what was skipped / could not be recognized
  warnings: string[]; // deterministic plausibility problems (see validate* below)
  // False when a validation check flagged a plausibility problem. The caller must
  // NOT treat flagged figures as document-verified — they should be applied as
  // self_reported (or corrected first). Never means we adjusted a number.
  verifiable: boolean;
}

export interface ExtractInput {
  bytes: Buffer;
  filename: string;
  mimeType?: string | null;
}

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB — a P&L export is small; refuse anything large

// --- number parsing --------------------------------------------------------

// Parse a spreadsheet money/percent cell: strips $, commas, spaces and a
// trailing %, treats (1,234) as -1234. Returns null when the cell is not a
// number (a label, a blank, a dash placeholder).
export function parseNumber(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (s === '' || s === '-' || s === '—' || s === 'n/a' || s.toLowerCase() === 'na') return null;
  let negative = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[$,%\s]/g, '');
  if (s === '' || !/^-?\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  if (Number.isNaN(n)) return null;
  return negative ? -n : n;
}

// A cell contains a percent sign (used to read a pre-computed "% recurring" row).
function isPercentCell(raw: string | null | undefined): boolean {
  return raw != null && String(raw).includes('%');
}

// --- deterministic validation ----------------------------------------------
// These NEVER change a parsed number. They flag plausibility problems so a
// caller can refuse to treat a figure as verified (downgrade to self_reported)
// or show a warning. Pure functions — unit-tested directly.

const MIN_PLAUSIBLE_REVENUE = 1_000; // under this a "revenue" line is likely in $000s
const MAX_PLAUSIBLE_REVENUE = 1_000_000_000_000; // $1T ceiling — above this smells like a units error
const MAX_PERIOD_JUMP = 10; // >10x swing between consecutive periods = units/order problem

// Revenue series (oldest first). Checks sign/plausibility, units/magnitude, and
// period-over-period jump (a proxy for a units mismatch or wrong period order).
export function validateRevenueSeries(series: number[]): string[] {
  const warnings: string[] = [];
  if (series.length === 0) return warnings;
  if (series.some((v) => v <= 0)) {
    warnings.push('One or more revenue periods are zero or negative — check the statement.');
  }
  const positives = series.filter((v) => v > 0);
  if (positives.some((v) => v < MIN_PLAUSIBLE_REVENUE)) {
    warnings.push(
      'Revenue values look unusually small (under $1,000) — check whether the statement is stated in thousands.',
    );
  }
  if (positives.some((v) => v > MAX_PLAUSIBLE_REVENUE)) {
    warnings.push('Revenue values exceed $1T — check the units/magnitude.');
  }
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1];
    const cur = series[i];
    if (prev > 0 && cur > 0) {
      const ratio = cur / prev;
      if (ratio > MAX_PERIOD_JUMP || ratio < 1 / MAX_PERIOD_JUMP) {
        warnings.push(
          'Revenue changes more than 10x between consecutive periods — check the units or period order.',
        );
        break;
      }
    }
  }
  return warnings;
}

// Top-customer shares (percentages). Checks range and total (concentration can
// never exceed 100% of revenue — a sum over 100% means double-counting or a
// units error).
export function validateShares(shares: number[]): string[] {
  const warnings: string[] = [];
  if (shares.length === 0) return warnings;
  if (shares.some((s) => s < 0 || s > 100)) {
    warnings.push('A customer share is outside 0–100% — check the report.');
  }
  const sum = shares.reduce((acc, s) => acc + s, 0);
  if (sum > 100.5) {
    warnings.push('Top-customer shares sum to over 100% — check the report for double-counting.');
  }
  return warnings;
}

// --- row-label recognizers -------------------------------------------------

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim();

// Revenue line, most-specific first so "total revenue" beats a bare "revenue"
// and neither matches an unrelated "other income" line.
const REVENUE_LABELS: RegExp[] = [
  /^total (net )?revenue$/,
  /^net revenue$/,
  /^total (net )?sales$/,
  /^net sales$/,
  /^(gross )?revenue$/,
  /^sales$/,
  /^total income$/,
];

const RECURRING_LABEL =
  /(recurring|subscription|retainer|contracted|contract) (revenue|income|sales)|^recurring$|\b(mrr|arr)\b/;

function revenuePriority(label: string): number {
  const n = norm(label);
  for (let i = 0; i < REVENUE_LABELS.length; i++) if (REVENUE_LABELS[i].test(n)) return i;
  return -1;
}

function isRecurringLabel(label: string): boolean {
  return RECURRING_LABEL.test(norm(label));
}

// --- CSV parsing -----------------------------------------------------------

interface Table {
  header: string[];
  rows: string[][];
}

function readTable(bytes: Buffer): Table {
  const text = bytes.toString('utf8');
  const delimiter = text.includes('\t') && !text.includes(',') ? '\t' : ',';
  const records = parseCsv(text, {
    delimiter,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  }) as string[][];
  if (records.length === 0) return { header: [], rows: [] };
  return { header: records[0], rows: records.slice(1) };
}

// Keep the most recent up-to-4 periods. When header cells carry a 4-digit year we
// sort by it; otherwise we trust left→right = oldest→newest and take the last 4.
function orderRevenueSeries(header: string[], values: (number | null)[]): number[] {
  const cols: { year: number | null; value: number }[] = [];
  for (let i = 1; i < values.length; i++) {
    const v = values[i];
    if (v == null) continue;
    const ym = (header[i] ?? '').match(/(19|20)\d{2}/);
    cols.push({ year: ym ? Number(ym[0]) : null, value: v });
  }
  const haveYears = cols.length > 0 && cols.every((c) => c.year != null);
  if (haveYears) cols.sort((a, b) => (a.year as number) - (b.year as number));
  return cols.slice(-4).map((c) => c.value);
}

function extractPL(table: Table): ExtractResult | null {
  const notes: string[] = [];
  let revenueRow: { values: (number | null)[]; priority: number } | null = null;
  let recurringRow: string[] | null = null;

  for (const row of table.rows) {
    const label = row[0] ?? '';
    if (!label) continue;
    const pr = revenuePriority(label);
    if (pr >= 0) {
      // A better (lower-priority-index) revenue label supersedes a weaker one.
      if (!revenueRow || pr < revenueRow.priority) {
        revenueRow = { values: row.map((c) => parseNumber(c)), priority: pr };
      }
      continue;
    }
    if (isRecurringLabel(label) && !recurringRow) recurringRow = row;
  }

  if (!revenueRow) return null;
  const series = orderRevenueSeries(table.header, revenueRow.values);
  if (series.length === 0) return null;

  const recognized: RecognizedFigure[] = [];
  const entries: ManualFinancialEntry[] = [];
  const warnings: string[] = validateRevenueSeries(series);

  recognized.push({
    code: 'REV-ANNUAL',
    label: 'Annual revenue (last 4 fiscal years)',
    value: series,
    detail: `Total-revenue line across ${series.length} period${series.length > 1 ? 's' : ''}, oldest first.`,
  });
  entries.push({ code: 'REV-ANNUAL', value: series });

  const mostRecentRevenue = series[series.length - 1];
  if (recurringRow) {
    const recurringCells = recurringRow.map((c) => parseNumber(c));
    // A "% recurring" row is used directly; a dollar recurring row is divided by
    // the same period's total revenue.
    const lastIdx = recurringCells.map((v, i) => (v != null ? i : -1)).filter((i) => i >= 0).pop();
    if (lastIdx != null && lastIdx >= 0) {
      const recurringVal = recurringCells[lastIdx] as number;
      // A cell written with a % sign is the recurring share itself; a dollar
      // recurring line is divided by the same period's total revenue.
      let pct: number | null = null;
      let detail = '';
      if (isPercentCell(recurringRow[lastIdx])) {
        pct = Math.round(recurringVal);
        detail = 'Recurring-revenue percentage read directly from the statement.';
      } else if (mostRecentRevenue > 0) {
        // Cross-foot: a dollar recurring line can never exceed total revenue.
        if (recurringVal > mostRecentRevenue) {
          warnings.push('Recurring revenue exceeds total revenue for the period — check the statement.');
        }
        pct = Math.round((recurringVal / mostRecentRevenue) * 100);
        detail = 'Recurring revenue ÷ total revenue for the most recent period.';
      }
      if (pct != null && pct >= 0 && pct <= 100) {
        recognized.push({
          code: 'REV-RECUR-PCT',
          label: 'Recurring revenue (% of most recent year)',
          value: pct,
          detail,
        });
        entries.push({ code: 'REV-RECUR-PCT', value: pct });
      } else {
        notes.push('Found a recurring-revenue line but could not derive a 0–100% figure — enter it by hand.');
      }
    }
  } else {
    notes.push('No recurring-revenue line found — enter the recurring % by hand if it applies.');
  }

  return { format: 'pl_csv', entries, recognized, notes, warnings, verifiable: warnings.length === 0 };
}

// Revenue-by-customer report → REV-TOP5-SHARES. Detected when a percent/share
// column exists over named rows and there is no revenue line to read as a P&L.
function extractCustomerShares(table: Table): ExtractResult | null {
  const header = table.header.map((h) => norm(h));
  const shareCol = header.findIndex((h) => /%|percent|share|concentration/.test(h));
  if (shareCol <= 0) return null; // need a named first column + a share column

  // Aggregate rows ("All other customers", "Total", "Remaining") are not a
  // single customer — excluding them keeps concentration honest.
  const AGGREGATE = /^(all other|other|others|remaining|misc|miscellaneous|total|subtotal|grand total)\b/i;
  const shares: number[] = [];
  for (const row of table.rows) {
    const name = (row[0] ?? '').trim();
    if (!name || AGGREGATE.test(name)) continue;
    const pct = parseNumber(row[shareCol]);
    if (pct == null) continue;
    // Accept a fraction (0.32) or a percentage (32); normalize to a percentage.
    shares.push(pct > 0 && pct <= 1 ? Math.round(pct * 1000) / 10 : pct);
  }
  if (shares.length === 0) return null;

  const warnings = validateShares(shares);
  const top5 = shares.sort((a, b) => b - a).slice(0, 5);
  return {
    format: 'customer_csv',
    entries: [{ code: 'REV-TOP5-SHARES', value: top5 }],
    recognized: [
      {
        code: 'REV-TOP5-SHARES',
        label: 'Top-5 customer revenue shares (largest first)',
        value: top5,
        detail: `Top ${top5.length} of ${shares.length} customers by revenue share.`,
      },
    ],
    notes: [],
    warnings,
    verifiable: warnings.length === 0,
  };
}

// --- JSON shape ------------------------------------------------------------

// A flexible JSON financials export (also what the extractor tests and any
// integration can emit). All fields optional; unknown keys ignored.
interface JsonFinancials {
  revenue_by_year?: number[]; // oldest first
  recurring_pct?: number;
  recurring_revenue_recent?: number; // dollars, most recent year
  top_customer_shares?: number[]; // percentages, any order
}

function extractJson(bytes: Buffer): ExtractResult {
  let doc: JsonFinancials;
  try {
    doc = JSON.parse(bytes.toString('utf8'));
  } catch {
    return {
      format: 'unrecognized',
      entries: [],
      recognized: [],
      notes: ['File is not valid JSON.'],
      warnings: [],
      verifiable: true,
    };
  }
  const recognized: RecognizedFigure[] = [];
  const entries: ManualFinancialEntry[] = [];
  const notes: string[] = [];
  const warnings: string[] = [];

  const series = Array.isArray(doc.revenue_by_year)
    ? doc.revenue_by_year.filter((n) => typeof n === 'number').slice(-4)
    : [];
  if (series.length > 0) {
    recognized.push({ code: 'REV-ANNUAL', label: 'Annual revenue (last 4 fiscal years)', value: series, detail: 'From revenue_by_year.' });
    entries.push({ code: 'REV-ANNUAL', value: series });
    warnings.push(...validateRevenueSeries(series));
  }

  let recurringPct: number | null = null;
  if (typeof doc.recurring_pct === 'number') recurringPct = Math.round(doc.recurring_pct);
  else if (typeof doc.recurring_revenue_recent === 'number' && series.length > 0 && series[series.length - 1] > 0) {
    recurringPct = Math.round((doc.recurring_revenue_recent / series[series.length - 1]) * 100);
  }
  if (recurringPct != null && recurringPct >= 0 && recurringPct <= 100) {
    recognized.push({ code: 'REV-RECUR-PCT', label: 'Recurring revenue (%)', value: recurringPct, detail: 'From recurring share.' });
    entries.push({ code: 'REV-RECUR-PCT', value: recurringPct });
  }

  if (Array.isArray(doc.top_customer_shares)) {
    const top5 = doc.top_customer_shares
      .filter((n) => typeof n === 'number')
      .map((n) => (n > 0 && n <= 1 ? Math.round(n * 1000) / 10 : n))
      .sort((a, b) => b - a)
      .slice(0, 5);
    if (top5.length > 0) {
      recognized.push({ code: 'REV-TOP5-SHARES', label: 'Top-5 customer revenue shares', value: top5, detail: 'From top_customer_shares.' });
      entries.push({ code: 'REV-TOP5-SHARES', value: top5 });
      warnings.push(...validateShares(top5));
    }
  }

  if (recognized.length === 0) notes.push('No recognizable financial fields in the JSON.');
  return { format: 'json', entries, recognized, notes, warnings, verifiable: warnings.length === 0 };
}

// --- entry point -----------------------------------------------------------

const ALLOWED_EXT = new Set(['csv', 'tsv', 'txt', 'json']);

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

// Parse an uploaded financial document into proposed answers. Throws on an
// unusable input (empty, too large, wrong type); returns an empty-but-shaped
// result when the file is valid but nothing could be recognized.
export function extractFinancials(input: ExtractInput): ExtractResult {
  if (!input.bytes || input.bytes.length === 0) throw new Error('uploaded file is empty');
  if (input.bytes.length > MAX_BYTES) throw new Error(`file exceeds ${MAX_BYTES} byte limit`);
  const ext = extensionOf(input.filename);
  if (!ALLOWED_EXT.has(ext)) {
    throw new Error(
      `file type '${ext || 'unknown'}' can't be read for financials; upload a CSV or JSON export (accepted: ${[...ALLOWED_EXT].join(', ')})`,
    );
  }

  let result: ExtractResult;
  if (ext === 'json') {
    result = extractJson(input.bytes);
  } else {
    const table = readTable(input.bytes);
    result =
      extractPL(table) ??
      extractCustomerShares(table) ?? {
        format: 'unrecognized',
        entries: [],
        recognized: [],
        notes: ['Could not find a revenue line or a customer-share column. Check the file format.'],
        warnings: [],
        verifiable: true,
      };
  }

  // Defense in depth: never propose a code outside the honest derivable set.
  const allowed = new Set<string>(LEDGER_DERIVABLE_CODES);
  result.entries = result.entries.filter((e) => allowed.has(e.code));
  result.recognized = result.recognized.filter((r) => allowed.has(r.code));
  // A plausibility warning means the figures must NOT be auto-treated as
  // verified — the caller applies them self_reported (never silently trusted).
  result.verifiable = result.warnings.length === 0;
  return result;
}
