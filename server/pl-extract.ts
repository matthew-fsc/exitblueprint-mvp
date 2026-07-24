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
import { xlsxToRows } from './xlsx';

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

// Revenue line, most-specific first. Every "total …" section-total variant
// outranks the bare account lines so that a QuickBooks income section — where
// "Total Income" is the roll-up and "Sales"/"Service Revenue" are indented
// sub-accounts under it — reads the roll-up, not a single sub-account (which
// would undercount revenue). Nothing here matches an unrelated "other income".
const REVENUE_LABELS: RegExp[] = [
  /^total (net )?revenue$/, // 0
  /^total (net )?sales$/, // 1
  /^total operating income$/, // 2 — QBO/GAAP operating-income roll-up
  /^total income$/, // 3 — QuickBooks default P&L revenue roll-up
  /^net revenue$/, // 4
  /^net sales$/, // 5
  /^(gross )?revenue$/, // 6
  /^sales$/, // 7 — bare account line (only used if it carries figures)
  /^income$/, // 8 — bare account line (a blank group header is skipped)
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

// A UTF-8 BOM survives `Buffer.toString('utf8')` as U+FEFF and would corrupt the
// first cell (or break JSON.parse). QuickBooks/Excel CSV exports routinely carry
// one, so strip it before anything else looks at the text.
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// Turn a raw record grid (from CSV or .xlsx) into a header + data rows. Real
// QuickBooks/accounting exports open with title/metadata rows (company name,
// "Profit and Loss", the reporting date range) before the actual column header.
// Those preamble lines are single-cell; the true header is the first multi-COLUMN
// row (e.g. `,Jan - Dec 2024,…,Total` or `,Total`) — note its first cell is often
// blank, so key on column count, not non-empty count, but still require one real
// cell so an all-empty `,,,,` spacer row is skipped.
function detectTable(records: string[][]): Table {
  if (records.length === 0) return { header: [], rows: [] };
  const headerIdx = records.findIndex(
    (r) => r.length >= 2 && r.some((c) => c && c.trim() !== ''),
  );
  if (headerIdx < 0) return { header: records[0], rows: records.slice(1) };
  return { header: records[headerIdx], rows: records.slice(headerIdx + 1) };
}

function readTable(bytes: Buffer): Table {
  const text = stripBom(bytes.toString('utf8'));
  const delimiter = text.includes('\t') && !text.includes(',') ? '\t' : ',';
  const records = parseCsv(text, {
    delimiter,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  }) as string[][];
  return detectTable(records);
}

// The .xlsx counterpart to readTable: unzip the workbook's first sheet into the
// same record grid, then apply the identical preamble/header detection so a P&L
// exported as Excel reads exactly like the CSV export of the same report.
function readXlsxTable(bytes: Buffer): Table {
  return detectTable(xlsxToRows(bytes).map((row) => row.map((c) => c.trim())));
}

const yearOf = (label: string | undefined): number | null => {
  const m = (label ?? '').match(/(19|20)\d{2}/);
  return m ? Number(m[0]) : null;
};

// The data-bearing period columns of a report: every column past the label
// column, EXCEPT a summary "Total" column. A QuickBooks comparison P&L appends a
// "Total" column that sums the periods; left in, it is read as the most-recent
// period and silently overstates current-year revenue. Its header normalizes to
// exactly "total", which no real fiscal-period column does.
function periodColumnIndices(header: string[], width: number): number[] {
  const idxs: number[] = [];
  for (let i = 1; i < width; i++) {
    if (norm(header[i] ?? '') === 'total') continue;
    idxs.push(i);
  }
  return idxs;
}

interface PeriodValue {
  idx: number; // source column index (to align the recurring row to the same period)
  year: number | null;
  value: number;
}

// Keep the most recent up-to-4 periods, dropping any Total summary column. When
// every period column carries a 4-digit year we sort by it; otherwise we trust
// left→right = oldest→newest and take the last 4.
function orderRevenuePeriods(
  header: string[],
  cells: (number | null)[],
  periods: number[],
): PeriodValue[] {
  const cols: PeriodValue[] = [];
  for (const i of periods) {
    const v = cells[i];
    if (v == null) continue;
    cols.push({ idx: i, year: yearOf(header[i]), value: v });
  }
  const haveYears = cols.length > 0 && cols.every((c) => c.year != null);
  if (haveYears) cols.sort((a, b) => (a.year as number) - (b.year as number));
  return cols.slice(-4);
}

function extractPL(table: Table): ExtractResult | null {
  const notes: string[] = [];
  let revenueRow: { cells: (number | null)[]; priority: number } | null = null;
  let recurringRow: string[] | null = null;

  for (const row of table.rows) {
    const label = row[0] ?? '';
    if (!label) continue;
    const pr = revenuePriority(label);
    if (pr >= 0) {
      const cells = row.map((c) => parseNumber(c));
      // Only a row that actually carries a figure is a revenue row: a QuickBooks
      // "Income" line is often just a blank section header sitting above the
      // "Total Income" roll-up. A better (lower-index) label supersedes a weaker
      // one, but never a blank header over a real total.
      const hasFigure = cells.some((v, i) => i >= 1 && v != null);
      if (hasFigure && (!revenueRow || pr < revenueRow.priority)) {
        revenueRow = { cells, priority: pr };
      }
      continue;
    }
    if (isRecurringLabel(label) && !recurringRow) recurringRow = row;
  }

  if (!revenueRow) return null;

  const width = Math.max(
    table.header.length,
    revenueRow.cells.length,
    ...table.rows.map((r) => r.length),
  );
  const periods = periodColumnIndices(table.header, width);
  const cols = orderRevenuePeriods(table.header, revenueRow.cells, periods);
  if (cols.length === 0) return null;

  const series = cols.map((c) => c.value);
  const recognized: RecognizedFigure[] = [];
  const entries: ManualFinancialEntry[] = [];
  const warnings: string[] = validateRevenueSeries(series);

  // Multiple period columns that all fall in ONE fiscal year are a monthly or
  // quarterly P&L, not a year-over-year trend — reading them as annual revenue
  // would be wrong. Flag it (so the figures record self-reported, not verified)
  // rather than silently mis-labeling months as fiscal years.
  const years = cols.map((c) => c.year).filter((y): y is number => y != null);
  if (cols.length >= 2 && years.length === cols.length && new Set(years).size === 1) {
    warnings.push(
      'The revenue columns look like periods within a single year (a monthly or quarterly P&L), not separate fiscal years — upload an annual P&L or confirm the figures.',
    );
  }

  recognized.push({
    code: 'REV-ANNUAL',
    label: 'Annual revenue (last 4 fiscal years)',
    value: series,
    detail: `Total-revenue line across ${series.length} period${series.length > 1 ? 's' : ''}, oldest first.`,
  });
  entries.push({ code: 'REV-ANNUAL', value: series });

  const mostRecent = cols[cols.length - 1];
  const mostRecentRevenue = mostRecent.value;
  if (recurringRow) {
    const recurringCells = recurringRow.map((c) => parseNumber(c));
    // Read the recurring figure from the SAME period column as the most-recent
    // revenue (so the cross-foot is apples-to-apples); if that specific cell is
    // blank, fall back to the last populated period column. Never the Total
    // column — periodColumnIndices already excluded it.
    let recIdx: number | null = recurringCells[mostRecent.idx] != null ? mostRecent.idx : null;
    if (recIdx == null) {
      for (let k = periods.length - 1; k >= 0; k--) {
        if (recurringCells[periods[k]] != null) {
          recIdx = periods[k];
          break;
        }
      }
    }
    if (recIdx != null) {
      const recurringVal = recurringCells[recIdx] as number;
      // A cell written with a % sign is the recurring share itself; a dollar
      // recurring line is divided by the same period's total revenue.
      let pct: number | null = null;
      let detail = '';
      if (isPercentCell(recurringRow[recIdx])) {
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

// Aggregate rows ("All other customers", "Total", "Remaining") are not a single
// customer — excluding them keeps concentration honest.
const AGGREGATE_CUSTOMER = /^(all other|other|others|remaining|misc|miscellaneous|total|subtotal|grand total)\b/i;

// Pick the amount column for a customer report that has no explicit share column:
// prefer a header naming a money total, else the right-most column that actually
// carries numbers (QuickBooks "Sales by Customer Summary" ends in a Total column).
function pickAmountColumn(table: Table): number {
  const header = table.header.map((h) => norm(h));
  const named = header.findIndex((h, i) => i > 0 && /\b(total|amount|revenue|sales|income)\b/.test(h));
  if (named > 0) return named;
  const width = Math.max(table.header.length, ...table.rows.map((r) => r.length), 0);
  for (let i = width - 1; i >= 1; i--) {
    if (table.rows.some((r) => parseNumber(r[i]) != null)) return i;
  }
  return -1;
}

function customerResult(shares: number[], population: number, basis: string): ExtractResult {
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
        detail: `Top ${top5.length} of ${population} customers by ${basis}.`,
      },
    ],
    notes: [],
    warnings,
    verifiable: warnings.length === 0,
  };
}

// Revenue-by-customer report → REV-TOP5-SHARES. Prefers an explicit percent/share
// column; failing that, computes shares from a dollar amount column (the common
// QuickBooks "Sales by Customer" export, which reports totals, not percentages).
function extractCustomerShares(table: Table): ExtractResult | null {
  const header = table.header.map((h) => norm(h));
  const shareCol = header.findIndex((h) => /%|percent|share|concentration/.test(h));
  if (shareCol > 0) {
    const shares: number[] = [];
    for (const row of table.rows) {
      const name = (row[0] ?? '').trim();
      if (!name || AGGREGATE_CUSTOMER.test(name)) continue;
      const pct = parseNumber(row[shareCol]);
      if (pct == null) continue;
      // Accept a fraction (0.32) or a percentage (32); normalize to a percentage.
      shares.push(pct > 0 && pct <= 1 ? Math.round(pct * 1000) / 10 : pct);
    }
    if (shares.length === 0) return null;
    return customerResult(shares, shares.length, 'revenue share');
  }

  // No share column — derive shares from a dollar amount column. Shares are of
  // the summed listed customers, so an export that hides customers under an
  // "All other" line would overstate them; we exclude that aggregate and let
  // validateShares flag anything implausible.
  const amountCol = pickAmountColumn(table);
  if (amountCol <= 0) return null;
  const amounts: number[] = [];
  for (const row of table.rows) {
    const name = (row[0] ?? '').trim();
    if (!name || AGGREGATE_CUSTOMER.test(name)) continue;
    const amt = parseNumber(row[amountCol]);
    if (amt == null || amt <= 0) continue;
    amounts.push(amt);
  }
  const total = amounts.reduce((a, v) => a + v, 0);
  if (amounts.length === 0 || total <= 0) return null;
  const shares = amounts.map((a) => Math.round((a / total) * 1000) / 10);
  return customerResult(shares, amounts.length, 'revenue (shares computed from the amount column)');
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
    doc = JSON.parse(stripBom(bytes.toString('utf8')));
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

const ALLOWED_EXT = new Set(['csv', 'tsv', 'txt', 'xlsx', 'json']);

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
    const hint =
      ext === 'xls'
        ? ' Re-save it as .xlsx (Excel’s "Save As"), or export the Profit and Loss report to CSV.'
        : ext === 'pdf'
          ? " In QuickBooks, open the Profit and Loss report and use Export → Export to CSV (or 'Save as CSV')."
          : '';
    throw new Error(
      `file type '${ext || 'unknown'}' can't be read for financials; upload an Excel (.xlsx), CSV, or JSON export (accepted: ${[...ALLOWED_EXT].join(', ')}).${hint}`,
    );
  }

  let result: ExtractResult;
  if (ext === 'json') {
    result = extractJson(input.bytes);
  } else {
    const table = ext === 'xlsx' ? readXlsxTable(input.bytes) : readTable(input.bytes);
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
