// The readiness-alignment logic (src/lib/alignment.ts). Pure, no
// DB — mirrors the buildPortfolioRows unit-test pattern.
import { describe, expect, it } from 'vitest';
import { buildAlignment, fmtUsdShort, type AlignmentInput } from '../src/lib/alignment';

const base: AlignmentInput = {
  drs: 72,
  tier: 'Sale Ready',
  ori: 74,
  hasValuation: true,
  wealthGap: 0,
  netProceeds: 4_000_000,
  ownerWealthTarget: 4_000_000,
  openGapCodes: [],
};

const leg = (a: ReturnType<typeof buildAlignment>, key: string) => a.legs.find((l) => l.key === key)!;

describe('fmtUsdShort', () => {
  it('formats millions, thousands, and small values', () => {
    expect(fmtUsdShort(1_200_000)).toBe('$1.2M');
    expect(fmtUsdShort(12_000_000)).toBe('$12M');
    expect(fmtUsdShort(850_000)).toBe('$850K');
    expect(fmtUsdShort(-1_500_000)).toBe('-$1.5M');
  });
});

describe('buildAlignment', () => {
  it('all three legs strong → aligned, Decide gate', () => {
    const a = buildAlignment({ ...base, drs: 88, tier: 'Institutional Grade', ori: 82, wealthGap: -500_000 });
    expect(leg(a, 'business').band).toBe('strong');
    expect(leg(a, 'personal').band).toBe('strong');
    expect(leg(a, 'financial').band).toBe('strong');
    expect(a.balanced).toBe(true);
    expect(a.gate).toBe('Decide');
    expect(a.verdict).toMatch(/aligned and strong/i);
  });

  it('short financial leg (wealth gap) is called out even with a strong business', () => {
    const a = buildAlignment({
      ...base,
      drs: 84,
      tier: 'Sale Ready',
      ori: 76,
      wealthGap: 2_000_000,
      netProceeds: 3_000_000,
      ownerWealthTarget: 5_000_000,
    });
    expect(leg(a, 'business').band).toBe('strong');
    expect(leg(a, 'financial').band).toBe('attention');
    expect(a.shortest).toBe('financial');
    expect(a.balanced).toBe(false);
    expect(a.verdict).toMatch(/financial readiness is the constraint/i);
    expect(a.verdict).toMatch(/wealth gap|\$2/i);
    expect(a.gate).toBe('Prepare');
    expect(a.gateHint).toMatch(/financial readiness/i);
  });

  it('a small wealth gap relative to target is "building", not "attention"', () => {
    const a = buildAlignment({
      ...base,
      wealthGap: 400_000, // 10% of a 4M target
      netProceeds: 3_600_000,
      ownerWealthTarget: 4_000_000,
    });
    expect(leg(a, 'financial').band).toBe('building');
  });

  it('wealth goal covered → financial strong', () => {
    const a = buildAlignment({ ...base, wealthGap: -200_000, netProceeds: 4_200_000 });
    expect(leg(a, 'financial').band).toBe('strong');
    expect(leg(a, 'financial').headline).toMatch(/covered/i);
  });

  it('timeline mismatch pulls the personal leg down', () => {
    const a = buildAlignment({ ...base, ori: 78, openGapCodes: ['TIMELINE_MISMATCH'] });
    // ORI 78 would be strong, but exit-soon-while-not-ready drops it.
    expect(leg(a, 'personal').band).toBe('building');
    expect(leg(a, 'personal').headline).toMatch(/timeline risk/i);
  });

  it('no valuation → financial unknown and Discover gate', () => {
    const a = buildAlignment({
      ...base,
      hasValuation: false,
      wealthGap: null,
      netProceeds: null,
      ownerWealthTarget: null,
    });
    expect(leg(a, 'financial').band).toBe('unknown');
    expect(a.gate).toBe('Discover');
    expect(a.verdict).toMatch(/incomplete|finish the assessment/i);
  });

  it('VALUE_GAP flag makes financial "attention" even without valuation numbers', () => {
    const a = buildAlignment({
      ...base,
      hasValuation: false,
      wealthGap: null,
      netProceeds: null,
      ownerWealthTarget: null,
      openGapCodes: ['VALUE_GAP'],
    });
    expect(leg(a, 'financial').band).toBe('attention');
  });

  it('short business leg is named', () => {
    const a = buildAlignment({
      ...base,
      drs: 48,
      tier: 'High Risk',
      ori: 72,
      wealthGap: -100_000,
      netProceeds: 4_100_000,
    });
    expect(leg(a, 'business').band).toBe('attention');
    expect(a.shortest).toBe('business');
    expect(a.verdict).toMatch(/business readiness is the constraint/i);
  });

  it('all legs weak but moving together → balanced, Prepare', () => {
    const a = buildAlignment({
      ...base,
      drs: 58,
      tier: 'Needs Work',
      ori: 58,
      wealthGap: 600_000,
      netProceeds: 3_400_000,
      ownerWealthTarget: 4_000_000,
    });
    // business building, personal building, financial building (15% gap)
    expect(a.balanced).toBe(true);
    expect(a.verdict).toMatch(/move together|early in the arc/i);
    expect(a.gate).toBe('Prepare');
  });
});
