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
