// Market key normalization (docs/sellside-ai/01) — proves marketIndustryKey lands in
// the SAME buckets as the valuation engine's industryKeyFor, so a licensed market
// multiple lines up with the seeded table multiple. Pure, fixture-style.
import { describe, expect, it } from 'vitest';
import { marketIndustryKey, marketSizeBand } from '../shared/market-keys';

describe('marketIndustryKey', () => {
  it('maps representative industries to the valuation buckets', () => {
    expect(marketIndustryKey('HVAC & Refrigeration')).toBe('field_services');
    expect(marketIndustryKey('Commercial Landscaping')).toBe('field_services');
    expect(marketIndustryKey('CNC Machining')).toBe('manufacturing');
    expect(marketIndustryKey('Metal Fabrication')).toBe('manufacturing');
    expect(marketIndustryKey('Precision Manufacturing')).toBe('manufacturing');
    expect(marketIndustryKey('Wholesale Distribution')).toBe('distribution');
    expect(marketIndustryKey('Behavioral Health')).toBe('healthcare');
    expect(marketIndustryKey('B2B SaaS')).toBe('software');
  });

  it('falls back to default for unknown or missing industries', () => {
    expect(marketIndustryKey('Artisanal Widgets')).toBe('default');
    expect(marketIndustryKey('')).toBe('default');
    expect(marketIndustryKey(null)).toBe('default');
  });

  it('matches the valuation industryKeyFor buckets exactly (parity contract)', () => {
    // Mirror of server/valuation.ts industryKeyFor — the two MUST agree.
    const industryKeyFor = (industry: string | null): string => {
      const s = (industry ?? '').toLowerCase();
      if (/facilit|field|clean|hvac|landscap|electric|security|maintenance|roofing|services/.test(s)) return 'field_services';
      if (/manufactur|fabricat|machin|plastic|industrial|coating|precision/.test(s)) return 'manufacturing';
      if (/distribut|logistic|transport|supply|wholesale|marine/.test(s)) return 'distribution';
      if (/health|dental|medical|care|behavioral/.test(s)) return 'healthcare';
      if (/software|saas|tech|data|lattice|it\b/.test(s)) return 'software';
      return 'default';
    };
    for (const industry of [
      'HVAC', 'field services', 'CNC fabrication', 'plastic injection', 'logistics',
      'transport', 'dental care', 'SaaS platform', 'data analytics', 'unknown thing', null, '',
    ]) {
      expect(marketIndustryKey(industry)).toBe(industryKeyFor(industry));
    }
  });
});

describe('marketSizeBand', () => {
  it('passes through the valuation size-band keys', () => {
    expect(marketSizeBand('lt_1m')).toBe('lt_1m');
    expect(marketSizeBand('1_3m')).toBe('1_3m');
    expect(marketSizeBand('3_5m')).toBe('3_5m');
    expect(marketSizeBand('gt_5m')).toBe('gt_5m');
    expect(marketSizeBand(' 1_3M ')).toBe('1_3m');
  });

  it('falls back to the widest band for unknown or missing values', () => {
    expect(marketSizeBand('mega')).toBe('gt_5m');
    expect(marketSizeBand(null)).toBe('gt_5m');
    expect(marketSizeBand('')).toBe('gt_5m');
  });
});
