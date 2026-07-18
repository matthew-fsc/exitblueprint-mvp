import { describe, expect, it } from 'vitest';
import { rankComparables, type ComparableCandidate } from '../shared/comparables';

const subject = { industry: 'hvac', sizeBand: '3_5m', openGapCodes: ['CUST_CONC', 'OWNER_DEP', 'SOP_GAP'] };

const cand = (o: Partial<ComparableCandidate> & { engagementId: string; companyName: string }): ComparableCandidate => ({
  industry: null, sizeBand: null, drs: null, tier: null, outcomeStatus: null, openGapCodes: [], ...o,
});

describe('rankComparables', () => {
  it('weights industry > size > shared gaps and orders by score', () => {
    const r = rankComparables(subject, [
      cand({ engagementId: 'a', companyName: 'Alpha HVAC', industry: 'hvac', sizeBand: '3_5m', openGapCodes: ['CUST_CONC'] }), // 3+2+1=6
      cand({ engagementId: 'b', companyName: 'Beta Plumbing', industry: 'plumbing', sizeBand: '3_5m', openGapCodes: ['CUST_CONC', 'OWNER_DEP', 'SOP_GAP'] }), // 0+2+3=5
      cand({ engagementId: 'c', companyName: 'Gamma HVAC', industry: 'hvac', sizeBand: '1_3m', openGapCodes: [] }), // 3
    ]);
    expect(r.map((x) => x.engagementId)).toEqual(['a', 'b', 'c']);
    expect(r[0].score).toBe(6);
    expect(r[0].sharedGaps).toEqual(['CUST_CONC']);
    expect(r[0].reasons[0]).toMatch(/Same industry/);
  });

  it('excludes zero-match candidates', () => {
    const r = rankComparables(subject, [
      cand({ engagementId: 'x', companyName: 'Nothing Co', industry: 'retail', sizeBand: 'gt_5m', openGapCodes: ['XYZ'] }),
    ]);
    expect(r).toEqual([]);
  });

  it('breaks score ties by a closed outcome first', () => {
    const r = rankComparables(subject, [
      cand({ engagementId: 'open', companyName: 'Zeta', industry: 'hvac', outcomeStatus: 'in_market' }), // 3
      cand({ engagementId: 'closed', companyName: 'Yotta', industry: 'hvac', outcomeStatus: 'closed' }), // 3
    ]);
    expect(r.map((x) => x.engagementId)).toEqual(['closed', 'open']);
  });

  it('respects the limit', () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      cand({ engagementId: `e${i}`, companyName: `Co ${i}`, industry: 'hvac' }),
    );
    expect(rankComparables(subject, many, 3)).toHaveLength(3);
  });

  it('handles a subject with no attributes', () => {
    expect(rankComparables({ industry: null, sizeBand: null, openGapCodes: [] }, [
      cand({ engagementId: 'a', companyName: 'A', industry: 'hvac' }),
    ])).toEqual([]);
  });
});
