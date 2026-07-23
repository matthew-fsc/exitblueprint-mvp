// Deterministic financial-document extractor (server/pl-extract.ts). Pure, no
// DB, no LLM: proves a P&L / revenue export is parsed into PROPOSED answers for
// the derivable financial questions, that only allowed codes are emitted, and
// that unusable inputs fail loudly. The demo fixtures are parsed here too, so a
// change that breaks the demo story fails a test rather than the sales demo.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractFinancials, parseNumber, EXTRACTABLE_CODES } from '../server/pl-extract';
import { LEDGER_DERIVABLE_CODES } from '../server/ledger';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const buf = (s: string) => Buffer.from(s, 'utf8');
const entryFor = (r: { entries: { code: string; value: unknown }[] }, code: string) =>
  r.entries.find((e) => e.code === code)?.value;

describe('parseNumber', () => {
  it('strips currency, commas, percent and whitespace', () => {
    expect(parseNumber('$1,234,000')).toBe(1234000);
    expect(parseNumber('  6,900,000 ')).toBe(6900000);
    expect(parseNumber('42%')).toBe(42);
    expect(parseNumber('0.32')).toBe(0.32);
  });
  it('reads parenthesised numbers as negative', () => {
    expect(parseNumber('(50,000)')).toBe(-50000);
  });
  it('returns null for labels and blanks', () => {
    expect(parseNumber('Total revenue')).toBeNull();
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('-')).toBeNull();
    expect(parseNumber(null)).toBeNull();
  });
});

describe('extractFinancials — P&L CSV', () => {
  const pl = [
    'Line item,FY2022,FY2023,FY2024,FY2025',
    'Total revenue,"1,000,000","1,200,000","1,400,000","1,500,000"',
    'Recurring revenue,"400,000","510,000","560,000","600,000"',
    'Operating expenses,"300,000","320,000","350,000","360,000"',
  ].join('\n');

  it('reads the revenue series oldest-first and the recurring share', () => {
    const r = extractFinancials({ bytes: buf(pl), filename: 'pl.csv' });
    expect(r.format).toBe('pl_csv');
    expect(entryFor(r, 'REV-ANNUAL')).toEqual([1_000_000, 1_200_000, 1_400_000, 1_500_000]);
    // 600,000 / 1,500,000 = 40%
    expect(entryFor(r, 'REV-RECUR-PCT')).toBe(40);
  });

  it('keeps only the most recent four years when more are present', () => {
    const wide = [
      'Line item,2020,2021,2022,2023,2024',
      'Total revenue,100,200,300,400,500',
    ].join('\n');
    const r = extractFinancials({ bytes: buf(wide), filename: 'pl.csv' });
    expect(entryFor(r, 'REV-ANNUAL')).toEqual([200, 300, 400, 500]);
  });

  it('orders by the year in the header, not column position', () => {
    const shuffled = ['Item,FY2024,FY2022,FY2023', 'Total revenue,300,100,200'].join('\n');
    const r = extractFinancials({ bytes: buf(shuffled), filename: 'pl.csv' });
    expect(entryFor(r, 'REV-ANNUAL')).toEqual([100, 200, 300]);
  });

  it('reads a pre-computed "% recurring" cell directly', () => {
    const csv = [
      'Item,2024',
      'Total revenue,"2,000,000"',
      'Recurring revenue %,55%',
    ].join('\n');
    const r = extractFinancials({ bytes: buf(csv), filename: 'pl.csv' });
    expect(entryFor(r, 'REV-RECUR-PCT')).toBe(55);
  });

  it('prefers a Total revenue line over a bare Revenue / unrelated income line', () => {
    const csv = [
      'Item,2024',
      'Other income,"90,000"',
      'Revenue,"999,000"',
      'Total revenue,"1,000,000"',
    ].join('\n');
    const r = extractFinancials({ bytes: buf(csv), filename: 'pl.csv' });
    expect(entryFor(r, 'REV-ANNUAL')).toEqual([1_000_000]);
  });

  it('notes when no recurring line is present but still fills revenue', () => {
    const csv = ['Item,2024', 'Total revenue,"1,000,000"'].join('\n');
    const r = extractFinancials({ bytes: buf(csv), filename: 'pl.csv' });
    expect(entryFor(r, 'REV-ANNUAL')).toEqual([1_000_000]);
    expect(entryFor(r, 'REV-RECUR-PCT')).toBeUndefined();
    expect(r.notes.join(' ')).toMatch(/recurring/i);
  });
});

describe('extractFinancials — revenue-by-customer CSV', () => {
  it('reads the top-5 shares largest-first', () => {
    const csv = [
      'Customer,% of revenue',
      'Acme,14%',
      'Beta,10%',
      'Gamma,7%',
      'Delta,5%',
      'Epsilon,4%',
      'All other,60%',
    ].join('\n');
    const r = extractFinancials({ bytes: buf(csv), filename: 'customers.csv' });
    expect(r.format).toBe('customer_csv');
    // "All other" is an aggregate, not a customer — excluded from concentration.
    expect(entryFor(r, 'REV-TOP5-SHARES')).toEqual([14, 10, 7, 5, 4]);
  });

  it('normalises fractional shares to percentages', () => {
    const csv = ['Customer,Share', 'Acme,0.32', 'Beta,0.12'].join('\n');
    const r = extractFinancials({ bytes: buf(csv), filename: 'customers.csv' });
    expect(entryFor(r, 'REV-TOP5-SHARES')).toEqual([32, 12]);
  });
});

describe('extractFinancials — JSON export', () => {
  it('maps revenue_by_year, recurring, and top customers', () => {
    const json = JSON.stringify({
      revenue_by_year: [3_000_000, 3_400_000, 3_800_000, 4_200_000],
      recurring_revenue_recent: 2_100_000,
      top_customer_shares: [0.2, 0.15, 0.1, 0.08, 0.05],
    });
    const r = extractFinancials({ bytes: buf(json), filename: 'financials.json' });
    expect(r.format).toBe('json');
    expect(entryFor(r, 'REV-ANNUAL')).toEqual([3_000_000, 3_400_000, 3_800_000, 4_200_000]);
    expect(entryFor(r, 'REV-RECUR-PCT')).toBe(50); // 2.1M / 4.2M
    expect(entryFor(r, 'REV-TOP5-SHARES')).toEqual([20, 15, 10, 8, 5]);
  });
});

describe('extractFinancials — guardrails', () => {
  it('only ever proposes codes inside the honest derivable set', () => {
    const csv = ['Item,2024', 'Total revenue,"1,000,000"', 'Recurring revenue,"500,000"'].join('\n');
    const r = extractFinancials({ bytes: buf(csv), filename: 'pl.csv' });
    for (const e of r.entries) expect(LEDGER_DERIVABLE_CODES).toContain(e.code);
    for (const e of r.entries) expect(EXTRACTABLE_CODES as readonly string[]).toContain(e.code);
  });

  it('returns an unrecognised result (not a throw) for a valid but unreadable file', () => {
    const r = extractFinancials({ bytes: buf('hello,world\nfoo,bar'), filename: 'notes.csv' });
    expect(r.format).toBe('unrecognized');
    expect(r.entries).toEqual([]);
    expect(r.notes.length).toBeGreaterThan(0);
  });

  it('throws on empty, oversize, or unsupported files', () => {
    expect(() => extractFinancials({ bytes: Buffer.alloc(0), filename: 'x.csv' })).toThrow(/empty/);
    expect(() => extractFinancials({ bytes: buf('x'), filename: 'scan.pdf' })).toThrow(/CSV or JSON/);
    expect(() =>
      extractFinancials({ bytes: Buffer.alloc(6 * 1024 * 1024, 1), filename: 'big.csv' }),
    ).toThrow(/limit/);
  });
});

describe('extractFinancials — real QuickBooks P&L exports', () => {
  // A QuickBooks Online "Profit and Loss" CSV as actually exported: a UTF-8 BOM,
  // company/title/date-range preamble rows, an empty first header cell, indented
  // sub-accounts under "Income" with a "Total Income" roll-up, a trailing "Total"
  // summary column, and $ / .00 formatting.
  const qbo = [
    '﻿Cascade Water Solutions',
    'Profit and Loss',
    'January - December 2022 - January - December 2025',
    '',
    ',Jan - Dec 2022,Jan - Dec 2023,Jan - Dec 2024,Jan - Dec 2025,Total',
    'Income,,,,,',
    '   Product Sales,"3,000,000.00","3,400,000.00","3,900,000.00","4,300,000.00","14,600,000.00"',
    '   Service Revenue,"1,800,000.00","2,000,000.00","2,300,000.00","2,600,000.00","8,700,000.00"',
    'Total Income,"4,800,000.00","5,400,000.00","6,200,000.00","6,900,000.00","23,300,000.00"',
    'Recurring revenue,"2,976,000.00","3,510,000.00","4,092,000.00","4,554,000.00","15,132,000.00"',
    'Cost of Goods Sold,,,,,',
    'Total Cost of Goods Sold,"2,112,000.00","2,322,000.00","2,604,000.00","2,829,000.00","9,867,000.00"',
    'Gross Profit,"2,688,000.00","3,078,000.00","3,596,000.00","4,071,000.00","13,433,000.00"',
  ].join('\n');

  it('skips the preamble, reads Total Income (not a sub-account), and drops the Total column', () => {
    const r = extractFinancials({ bytes: buf(qbo), filename: 'ProfitAndLoss.csv' });
    expect(r.format).toBe('pl_csv');
    // The Total-column 23.3M is NOT read as a period; Product Sales sub-line is
    // NOT read as revenue — the "Total Income" roll-up wins.
    expect(entryFor(r, 'REV-ANNUAL')).toEqual([4_800_000, 5_400_000, 6_200_000, 6_900_000]);
    // 4,554,000 / 6,900,000 = 66%, read from the same (2025) period column.
    expect(entryFor(r, 'REV-RECUR-PCT')).toBe(66);
    expect(r.verifiable).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it('flags a monthly P&L (single fiscal year across the columns) as not verifiable', () => {
    const monthly = [
      ',Jan 2025,Feb 2025,Mar 2025,Total',
      'Total Income,"100,000","110,000","120,000","330,000"',
    ].join('\n');
    const r = extractFinancials({ bytes: buf(monthly), filename: 'pl.csv' });
    // The Total column is still dropped, so the figures themselves are the months.
    expect(entryFor(r, 'REV-ANNUAL')).toEqual([100_000, 110_000, 120_000]);
    expect(r.verifiable).toBe(false);
    expect(r.warnings.join(' ')).toMatch(/monthly or quarterly|single year/i);
  });

  it('strips a UTF-8 BOM on a JSON export', () => {
    const json = '﻿' + JSON.stringify({ revenue_by_year: [1_000_000, 1_200_000] });
    const r = extractFinancials({ bytes: buf(json), filename: 'financials.json' });
    expect(r.format).toBe('json');
    expect(entryFor(r, 'REV-ANNUAL')).toEqual([1_000_000, 1_200_000]);
  });

  it('hints at exporting as CSV when an .xlsx is uploaded', () => {
    expect(() => extractFinancials({ bytes: buf('x'), filename: 'ProfitAndLoss.xlsx' })).toThrow(
      /Export to CSV/i,
    );
  });
});

describe('extractFinancials — customer concentration from a dollar column', () => {
  it('computes shares from a QuickBooks Sales-by-Customer amount column', () => {
    // No percent column — a "Sales by Customer Summary" reports dollar totals.
    const csv = [
      'Cascade Water Solutions',
      'Sales by Customer Summary',
      '',
      ',Total',
      'Northgate Property Group,"966,000.00"',
      'Summit Health Systems,"690,000.00"',
      'Riverside School District,"483,000.00"',
      'Cedar Grove Retail,"345,000.00"',
      'Blue Harbor Logistics,"276,000.00"',
      'TOTAL,"2,760,000.00"',
    ].join('\n');
    const r = extractFinancials({ bytes: buf(csv), filename: 'SalesByCustomer.csv' });
    expect(r.format).toBe('customer_csv');
    // 966k / 2,760k = 35%, 690/2760 = 25%, 483 = 17.5%, 345 = 12.5%, 276 = 10%.
    // The "TOTAL" row is an aggregate and excluded from the population sum.
    expect(entryFor(r, 'REV-TOP5-SHARES')).toEqual([35, 25, 17.5, 12.5, 10]);
  });
});

describe('extractFinancials — demo fixtures tie out to the demo answers', () => {
  it("parses the demo P&L to the demo client's revenue trend and 66% recurring", () => {
    const bytes = readFileSync(join(root, 'seed', 'demo', 'files', 'cascade-pl-2022-2025.csv'));
    const r = extractFinancials({ bytes, filename: 'cascade-pl-2022-2025.csv' });
    expect(entryFor(r, 'REV-ANNUAL')).toEqual([4_800_000, 5_400_000, 6_200_000, 6_900_000]);
    expect(entryFor(r, 'REV-RECUR-PCT')).toBe(66);
  });

  it("parses the demo revenue-by-customer report to the demo client's top-5 shares", () => {
    const bytes = readFileSync(join(root, 'seed', 'demo', 'files', 'cascade-revenue-by-customer.csv'));
    const r = extractFinancials({ bytes, filename: 'cascade-revenue-by-customer.csv' });
    expect(entryFor(r, 'REV-TOP5-SHARES')).toEqual([14, 10, 7, 5, 4]);
  });
});
