// Interpretation layer: descriptions and the consensus synthesis. These do not
// touch scores (the engine fixtures cover those); they lock the plain-language
// output so a wrong reading can't ship silently.
import { describe, expect, it } from 'vitest';
import {
  consensus,
  interpretSubScore,
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
