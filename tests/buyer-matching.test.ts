import { describe, expect, it } from 'vitest';
import { rankBuyers, type MandateCandidate, type BuyerMatchSubject } from '../shared/buyer-matching';

const subject: BuyerMatchSubject = {
  industry: 'hvac',
  revenueBand: '3_5m',
  ebitdaBand: '1_3m',
  state: 'GA',
  drs: 68,
  openGapCodes: ['CUST_CONC', 'SOP_GAP'],
};

const mandate = (
  o: Partial<MandateCandidate> & { buyerId: string; buyerName: string; mandateId: string },
): MandateCandidate => ({
  buyerKind: 'strategic',
  relationshipStrength: 'unknown',
  mandateVersion: 1,
  targetIndustries: [],
  targetRevenueBands: [],
  targetEbitdaBands: [],
  targetStates: [],
  dealbreakerGapCodes: [],
  minDrs: null,
  ...o,
});

describe('rankBuyers', () => {
  it('scores firmographic + readiness fit and orders by score', () => {
    const r = rankBuyers(subject, [
      // industry(4)+revenue(2)+ebitda(2)+state(1)+drs floor(2)+clean(2) = 13
      mandate({
        buyerId: 'a', buyerName: 'Apex Strategic', mandateId: 'ma',
        targetIndustries: ['hvac'], targetRevenueBands: ['3_5m'], targetEbitdaBands: ['1_3m'],
        targetStates: ['GA', 'FL'], dealbreakerGapCodes: ['OWNER_DEP'], minDrs: 60,
      }),
      // industry(4) only (open sector box on the others) = 4
      mandate({ buyerId: 'b', buyerName: 'Broad Holdings', mandateId: 'mb', targetIndustries: ['hvac'] }),
    ]);
    expect(r.map((x) => x.buyerId)).toEqual(['a', 'b']);
    expect(r[0].score).toBe(13);
    expect(r[0].blocked).toBe(false);
    expect(r[0].factors).toContain('Industry match (hvac)');
    expect(r[0].factors).toContain('No dealbreakers open');
  });

  it('hard-gates a buyer whose sector box excludes the company', () => {
    const r = rankBuyers(subject, [
      mandate({ buyerId: 'x', buyerName: 'Bakery Buyer', mandateId: 'mx', targetIndustries: ['bakery'] }),
    ]);
    expect(r).toEqual([]);
  });

  it('keeps an open sector box (no target industries) as a soft match', () => {
    const r = rankBuyers(subject, [
      mandate({ buyerId: 'o', buyerName: 'Open Mandate', mandateId: 'mo', targetRevenueBands: ['3_5m'] }),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].score).toBe(2); // revenue only
  });

  it('blocks (not excludes) on an open dealbreaker gap and names the code to clear', () => {
    const r = rankBuyers(subject, [
      mandate({
        buyerId: 'd', buyerName: 'Picky PE', mandateId: 'md',
        targetIndustries: ['hvac'], dealbreakerGapCodes: ['CUST_CONC'],
      }),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0].blocked).toBe(true);
    expect(r[0].blockers).toContain('Open dealbreaker: CUST_CONC');
    expect(r[0].factors).not.toContain('No dealbreakers open');
  });

  it('blocks when the DRS floor is unmet, and when DRS is unknown', () => {
    const belowFloor = rankBuyers(subject, [
      mandate({ buyerId: 'f', buyerName: 'High Bar', mandateId: 'mf', targetIndustries: ['hvac'], minDrs: 75 }),
    ]);
    expect(belowFloor[0].blocked).toBe(true);
    expect(belowFloor[0].blockers[0]).toMatch(/Below DRS floor \(68 < 75\)/);

    const noScore = rankBuyers({ ...subject, drs: null }, [
      mandate({ buyerId: 'g', buyerName: 'Needs Score', mandateId: 'mg', targetIndustries: ['hvac'], minDrs: 60 }),
    ]);
    expect(noScore[0].blocked).toBe(true);
    expect(noScore[0].blockers[0]).toMatch(/Not yet assessed/);
  });

  it('orders unblocked ahead of blocked regardless of raw score', () => {
    const r = rankBuyers(subject, [
      // blocked but otherwise high-scoring
      mandate({
        buyerId: 'hi', buyerName: 'Blocked High', mandateId: 'mhi',
        targetIndustries: ['hvac'], targetRevenueBands: ['3_5m'], targetEbitdaBands: ['1_3m'],
        dealbreakerGapCodes: ['SOP_GAP'],
      }),
      // unblocked, lower score
      mandate({ buyerId: 'lo', buyerName: 'Clean Low', mandateId: 'mlo', targetIndustries: ['hvac'] }),
    ]);
    expect(r.map((x) => x.buyerId)).toEqual(['lo', 'hi']);
  });

  it('breaks score ties by relationship strength then name', () => {
    const r = rankBuyers(subject, [
      mandate({ buyerId: 'weak', buyerName: 'Zeta', mandateId: 'mw', targetIndustries: ['hvac'], relationshipStrength: 'weak' }),
      mandate({ buyerId: 'strong', buyerName: 'Yotta', mandateId: 'ms', targetIndustries: ['hvac'], relationshipStrength: 'strong' }),
    ]);
    expect(r.map((x) => x.buyerId)).toEqual(['strong', 'weak']);
  });

  it('respects an optional limit', () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      mandate({ buyerId: `e${i}`, buyerName: `Co ${i}`, mandateId: `me${i}`, targetIndustries: ['hvac'] }),
    );
    expect(rankBuyers(subject, many, 3)).toHaveLength(3);
  });
});
