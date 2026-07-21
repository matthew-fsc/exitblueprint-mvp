// Unit tests for the reconciliation comparison primitives (server/pipeline/field-map.ts).
// These are pure, deterministic functions — the heart of the "is the self-reported
// figure actually backed by the document?" check. They run with no DB. The tolerance
// band is what stops rounding/extraction noise from being flagged as a conflict, and
// what still catches a genuine mismatch a human must reconcile. Rule 1: nothing here
// touches a score; this only classifies self-reported vs document-verified values.
import { describe, it, expect } from 'vitest';
import {
  compareValues,
  normalizeNumeric,
  selectSelfValue,
  RECONCILE_ABS_EPSILON,
} from '../server/pipeline/field-map';

describe('normalizeNumeric', () => {
  it('parses plain and formatted numbers', () => {
    expect(normalizeNumeric(1000)).toBe(1000);
    expect(normalizeNumeric('1000')).toBe(1000);
    expect(normalizeNumeric('$1,000,000')).toBe(1_000_000);
    expect(normalizeNumeric('12.5%')).toBe(12.5);
    expect(normalizeNumeric('  42 ')).toBe(42);
  });

  it('treats parenthesized values as negative', () => {
    expect(normalizeNumeric('(1,234)')).toBe(-1234);
  });

  it('returns null for non-numeric / blank / unknown', () => {
    expect(normalizeNumeric('unknown')).toBeNull();
    expect(normalizeNumeric('')).toBeNull();
    expect(normalizeNumeric('-')).toBeNull();
    expect(normalizeNumeric(null)).toBeNull();
    expect(normalizeNumeric(undefined)).toBeNull();
    expect(normalizeNumeric(['a'])).toBeNull();
    expect(normalizeNumeric(Number.NaN)).toBeNull();
  });
});

describe('compareValues (numeric)', () => {
  it('exact equality is a match, regardless of formatting', () => {
    expect(compareValues(1_000_000, 1_000_000, 'number')).toBe('match');
    expect(compareValues('$1,000,000', '1000000', 'number')).toBe('match');
    expect(compareValues('1000000.0', 1_000_000, 'number')).toBe('match');
  });

  it('differences inside the tolerance band are within_tolerance, not conflict', () => {
    // 1% relative band on a large figure absorbs extraction/rounding noise.
    expect(compareValues(1_000_000, 1_005_000, 'number')).toBe('within_tolerance');
    // Sub-dollar rounding on a small figure is absorbed by the absolute floor.
    expect(compareValues(100, 100 + RECONCILE_ABS_EPSILON, 'number')).toBe('within_tolerance');
  });

  it('differences beyond the band are a genuine conflict', () => {
    expect(compareValues(1_000_000, 1_200_000, 'number')).toBe('conflict');
    expect(compareValues(100, 250, 'number')).toBe('conflict');
  });

  it('the relative band scales with magnitude', () => {
    const base = 10_000_000;
    // Well inside 1% (0.5% over) → reconciled; clearly beyond 1% (3% over) → conflict.
    expect(compareValues(base, base * 1.005, 'number')).not.toBe('conflict');
    expect(compareValues(base, base * 1.03, 'number')).toBe('conflict');
  });

  it('falls back to string compare when one side is not a clean number', () => {
    // "unknown" vs "unknown" must match rather than spuriously conflict.
    expect(compareValues('unknown', 'unknown', 'number')).toBe('match');
    // A real value vs "unknown" cannot be numerically reconciled → conflict.
    expect(compareValues(1_000_000, 'unknown', 'number')).toBe('conflict');
  });
});

describe('compareValues (string)', () => {
  it('is case- and whitespace-insensitive', () => {
    expect(compareValues('SaaS', 'saas', 'string')).toBe('match');
    expect(compareValues('  Health  Care ', 'health care', 'string')).toBe('match');
  });

  it('flags a genuine difference as a conflict', () => {
    expect(compareValues('Manufacturing', 'Logistics', 'string')).toBe('conflict');
  });
});

describe('selectSelfValue', () => {
  it('passes scalars through unchanged', () => {
    expect(selectSelfValue(1234)).toBe(1234);
    expect(selectSelfValue('x')).toBe('x');
  });

  it('reduces a numeric_list per listSelect (default last = most recent year)', () => {
    const series = [800, 900, 1000, 1200]; // oldest → newest
    expect(selectSelfValue(series)).toBe(1200);
    expect(selectSelfValue(series, 'last')).toBe(1200);
    expect(selectSelfValue(series, 'first')).toBe(800);
    expect(selectSelfValue(series, 'max')).toBe(1200);
  });

  it('handles an empty list', () => {
    expect(selectSelfValue([])).toBeUndefined();
  });
});
