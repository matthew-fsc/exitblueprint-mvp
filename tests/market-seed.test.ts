import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadSeedBundle, parseMarketMultiples, resolveSeedDir } from '../server/seed-methodology';

// Hermetic (no DB): parse the shipped seed/market-multiples.csv straight off disk
// and assert the placeholder market-reference dataset is well-formed and normalized
// to the SAME industry_key × size_band key-space as the deterministic valuation
// table (docs/sellside-ai/01). This guards the seed pipeline (the market lane feeds
// market.datasets / market.multiples) before a licensed dataset is swapped in.
const seedDir = resolveSeedDir();
const csv = readFileSync(join(seedDir, 'market-multiples.csv'), 'utf8');
const marketMultiples = parseMarketMultiples(csv);

// The valuation-multiples set is authoritative for which (industry_key, size_band)
// combinations the engine knows about; the market lane must cover exactly the same
// combos so a market multiple always lines up with the table multiple.
const bundle = loadSeedBundle(seedDir);
const keyOf = (m: { industryKey: string; sizeBand: string }) => `${m.industryKey}::${m.sizeBand}`;
const valuationKeys = new Set(bundle.valuationMultiples.map(keyOf));
const validIndustries = new Set(bundle.valuationMultiples.map((m) => m.industryKey));
const validBands = new Set(bundle.valuationMultiples.map((m) => m.sizeBand));

describe('parseMarketMultiples', () => {
  it('parses every seeded row (one per valuation industry × size band)', () => {
    expect(marketMultiples.length).toBe(bundle.valuationMultiples.length);
    expect(marketMultiples.length).toBeGreaterThan(0);
  });

  it('covers exactly the valuation industry_key × size_band combinations', () => {
    const marketKeys = new Set(marketMultiples.map(keyOf));
    expect(marketKeys).toEqual(valuationKeys);
    // No duplicate combos in the file (each maps to one market row).
    expect(marketMultiples.length).toBe(marketKeys.size);
  });

  it('has a valid, well-ordered distribution on every row', () => {
    for (const m of marketMultiples) {
      expect(validIndustries.has(m.industryKey)).toBe(true);
      expect(validBands.has(m.sizeBand)).toBe(true);
      // All multiples are finite positive numbers.
      for (const v of [m.medianMultiple, m.p25Multiple, m.p75Multiple]) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThan(0);
      }
      // Spread is ordered: p25 <= median <= p75.
      expect(m.p25Multiple).toBeLessThanOrEqual(m.medianMultiple);
      expect(m.medianMultiple).toBeLessThanOrEqual(m.p75Multiple);
      // Sample size is a positive integer.
      expect(Number.isInteger(m.sampleSize)).toBe(true);
      expect(m.sampleSize).toBeGreaterThan(0);
      // as_of is a parseable date.
      expect(Number.isNaN(Date.parse(m.asOf))).toBe(false);
    }
  });
});
