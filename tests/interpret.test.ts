// Interpretation layer: descriptions and the consensus synthesis. These do not
// touch scores (the engine fixtures cover those); they lock the plain-language
// output so a wrong reading can't ship silently.
import { describe, expect, it } from 'vitest';
import {
  consensus,
  gapToTarget,
  interpretSubScore,
  subScoreGaps,
  type SubScoreExplainLike,
} from '../shared/scoring/interpret';

function sub(code: string, points: number, value: unknown): SubScoreExplainLike {
  return {
    code,
    name: code,
    dimensionCode: 'PFN',
    formulaType: 'scale_map',
    inputs: {},
    computed: { value },
    points,
    weight: 0.25,
    contribution: 0,
  };
}

describe('ORI-DEPEND reading is not inverted', () => {
  it('a fully dependent owner (value 1, score 0) reads as HIGH dependence', () => {
    const r = interpretSubScore(sub('ORI-DEPEND', 0, 1));
    expect(r.reading).toContain('very high');
    expect(r.band.status).toBe('critical'); // 0 points -> At risk
  });

  it('a non-dependent owner (value 5, score 100) reads as LOW dependence', () => {
    const r = interpretSubScore(sub('ORI-DEPEND', 100, 5));
    expect(r.reading).toContain('very low');
    expect(r.band.status).toBe('good');
  });
});

describe('consensus synthesis', () => {
  const base = {
    drsScore: 72.3,
    drsTier: 'Sale Ready',
    oriScore: 63.2,
    dimensions: [
      { code: 'FIN', name: 'Financial Integrity', score: 91 },
      { code: 'REV', name: 'Revenue Quality', score: 82 },
      { code: 'OPS', name: 'Operational Independence', score: 46 },
      { code: 'GRW', name: 'Growth Drivers', score: 43 },
    ],
    firedGaps: [{ severity: 'critical' }, { severity: 'high' }, { severity: 'high' }],
  };

  it('names the tier, the top strengths, and the weakest areas', () => {
    const c = consensus(base);
    expect(c.headline).toContain('72.3');
    expect(c.headline).toContain('Sale Ready');
    expect(c.strengths.map((s) => s.name)).toEqual(['Financial Integrity', 'Revenue Quality']);
    expect(c.risks.map((r) => r.name)).toEqual(['Growth Drivers', 'Operational Independence']);
    expect(c.criticalCount).toBe(1);
    expect(c.bottomLine).toContain('critical gap');
  });

  it('flags a wide business/owner divergence', () => {
    const c = consensus({ ...base, oriScore: 30 });
    expect(c.divergent).toBe(true);
    expect(c.bottomLine).toContain('far apart');
  });
});

describe('gapToTarget — path to 100', () => {
  // Two dimensions whose weights sum to 1, so drs = weighted mean of scores.
  const dims = [
    { code: 'FIN', name: 'Financial Integrity', score: 90, drsWeight: 0.6, contributionToDrs: 54 },
    { code: 'GRW', name: 'Growth Drivers', score: 40, drsWeight: 0.4, contributionToDrs: 16 },
  ];
  const drs = 70; // 54 + 16

  it('total gap is the distance from the DRS to a perfect 100', () => {
    const g = gapToTarget(drs, dims);
    expect(g.target).toBe(100);
    expect(g.totalGap).toBe(30);
  });

  it('recoverable points per dimension sum to the total gap', () => {
    const g = gapToTarget(drs, dims);
    const sum = g.dimensions.reduce((a, d) => a + d.recoverablePoints, 0);
    expect(sum).toBeCloseTo(g.totalGap, 6);
  });

  it('ranks dimensions by recoverable points, largest first', () => {
    const g = gapToTarget(drs, dims);
    // GRW: 0.4*(100-40)=24 open; FIN: 0.6*(100-90)=6 open.
    expect(g.dimensions.map((d) => d.code)).toEqual(['GRW', 'FIN']);
    expect(g.dimensions[0].recoverablePoints).toBeCloseTo(24, 6);
    expect(g.dimensions[1].recoverablePoints).toBeCloseTo(6, 6);
    expect(g.dimensions[0].shareOfGap).toBeCloseTo(24 / 30, 6);
  });

  it('reports no gap when already at 100', () => {
    const g = gapToTarget(100, [
      { code: 'FIN', name: 'Financial Integrity', score: 100, drsWeight: 1, contributionToDrs: 100 },
    ]);
    expect(g.totalGap).toBe(0);
    expect(g.dimensions[0].recoverablePoints).toBe(0);
  });
});

describe('subScoreGaps — measures ranked by DRS points on the table', () => {
  const subs: SubScoreExplainLike[] = [
    { ...sub('A', 20, 'x'), weight: 0.5 }, // 0.5*(100-20)=40 dim pts
    { ...sub('B', 80, 'x'), weight: 0.5 }, // 0.5*(100-80)=10 dim pts
  ];

  it('weights each measure into DRS points via its dimension weight', () => {
    const gaps = subScoreGaps(subs, 0.3); // dimension is 30% of the DRS
    expect(gaps.map((g) => g.code)).toEqual(['A', 'B']);
    expect(gaps[0].recoverableDimPoints).toBeCloseTo(40, 6);
    expect(gaps[0].recoverableDrsPoints).toBeCloseTo(0.3 * 40, 6); // 12
    expect(gaps[1].recoverableDrsPoints).toBeCloseTo(0.3 * 10, 6); // 3
  });
});
