// Deterministic P&L validation (server/pl-extract.ts). Pure, no DB, no LLM:
// proves the plausibility checks flag bad figures and mark the extract result
// non-verifiable — WITHOUT ever changing a parsed number. These are the checks
// that stop a garbled statement from being auto-recorded as document-verified.
import { describe, expect, it } from 'vitest';
import { extractFinancials, validateRevenueSeries, validateShares } from '../server/pl-extract';

const buf = (s: string) => Buffer.from(s, 'utf8');

describe('validateRevenueSeries', () => {
  it('passes a clean, growing series', () => {
    expect(validateRevenueSeries([1_000_000, 1_200_000, 1_400_000, 1_600_000])).toEqual([]);
  });
  it('flags zero/negative revenue', () => {
    expect(validateRevenueSeries([1_000_000, 0, 1_400_000]).join(' ')).toMatch(/zero or negative/i);
    expect(validateRevenueSeries([-5, 10_000]).join(' ')).toMatch(/zero or negative/i);
  });
  it('flags a units/magnitude problem (values look like $000s)', () => {
    expect(validateRevenueSeries([120, 140, 160]).join(' ')).toMatch(/thousands/i);
  });
  it('flags an implausible >$1T magnitude', () => {
    expect(validateRevenueSeries([2_000_000_000_000]).join(' ')).toMatch(/1T/i);
  });
  it('flags a >10x period-over-period jump (units or order error)', () => {
    expect(validateRevenueSeries([1_000_000, 20_000_000]).join(' ')).toMatch(/10x/i);
  });
  it('never mutates the input array', () => {
    const s = [500, 1_000_000];
    const copy = [...s];
    validateRevenueSeries(s);
    expect(s).toEqual(copy);
  });
});

describe('validateShares', () => {
  it('passes shares that sum under 100%', () => {
    expect(validateShares([30, 20, 10, 5])).toEqual([]);
  });
  it('flags a share outside 0–100%', () => {
    expect(validateShares([120, 5]).join(' ')).toMatch(/0.?100/i);
  });
  it('flags shares that sum to over 100% (double-counting)', () => {
    expect(validateShares([60, 55]).join(' ')).toMatch(/over 100/i);
  });
});

describe('extractFinancials — verifiable flag', () => {
  it('a clean P&L is verifiable with no warnings', () => {
    const csv = [
      'Line item,FY2022,FY2023,FY2024,FY2025',
      'Total revenue,"1,000,000","1,200,000","1,400,000","1,600,000"',
      'Recurring revenue,"400,000","510,000","560,000","640,000"',
    ].join('\n');
    const r = extractFinancials({ bytes: buf(csv), filename: 'pl.csv' });
    expect(r.verifiable).toBe(true);
    expect(r.warnings).toEqual([]);
  });
  it('a P&L with a 10x jump is NOT verifiable but still returns the figures', () => {
    const csv = [
      'Line item,FY2023,FY2024',
      'Total revenue,"1,000,000","50,000,000"',
    ].join('\n');
    const r = extractFinancials({ bytes: buf(csv), filename: 'pl.csv' });
    expect(r.verifiable).toBe(false);
    expect(r.warnings.length).toBeGreaterThan(0);
    // Figures are still proposed — validation warns, it never drops/adjusts them.
    expect(r.entries.find((e) => e.code === 'REV-ANNUAL')?.value).toEqual([1_000_000, 50_000_000]);
  });
  it('recurring exceeding total revenue is flagged', () => {
    const csv = [
      'Line item,FY2024',
      'Total revenue,"1,000,000"',
      'Recurring revenue,"1,500,000"',
    ].join('\n');
    const r = extractFinancials({ bytes: buf(csv), filename: 'pl.csv' });
    expect(r.verifiable).toBe(false);
    expect(r.warnings.join(' ')).toMatch(/exceeds total revenue/i);
  });
});
