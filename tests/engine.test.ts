// The engine is correct when it reproduces the reference scorer's fixture
// outputs exactly (docs/03): every sub-score, dimension score, DRS, tier,
// ORI, gap set, flags, and computed intermediates.
import { describe, expect, it } from 'vitest';
import { explainFromAnswers, scoreFromAnswers } from '../shared/scoring/engine';
import type { Answers } from '../shared/scoring/types';
import { FIXTURE_NAMES, loadFixture, loadSeedRubric } from './helpers';

const rubric = loadSeedRubric();

describe.each(FIXTURE_NAMES)('fixture %s', (name) => {
  const fixture = loadFixture(name);
  const result = scoreFromAnswers(rubric, fixture.answers);

  it('reproduces every business sub-score exactly', () => {
    // The fixture's sub_scores map covers business dimensions; the reference
    // tracks ORI sub-scores separately (they're asserted via the ORI total).
    const businessDims = new Set(
      rubric.dimensions.filter((d) => d.scoreGroup === 'business_readiness').map((d) => d.code),
    );
    const businessCodes = new Set(
      rubric.subScores.filter((s) => businessDims.has(s.dimensionCode)).map((s) => s.code),
    );
    const actual = Object.fromEntries(
      result.subScores.filter((s) => businessCodes.has(s.code)).map((s) => [s.code, s.points]),
    );
    expect(actual).toEqual(fixture.expected.sub_scores);
  });

  it('reproduces dimension scores exactly', () => {
    const actual = Object.fromEntries(result.dimensionScores.map((d) => [d.code, d.score]));
    expect(actual).toEqual(fixture.expected.dimension_scores);
  });

  it('reproduces DRS, tier, and ORI exactly', () => {
    expect(result.drsScore).toBe(fixture.expected.drs);
    expect(result.drsTier).toBe(fixture.expected.tier);
    expect(result.oriScore).toBe(fixture.expected.owner_readiness_index);
  });

  it('reproduces the gap set and flags exactly', () => {
    expect(result.gapCodes).toEqual(fixture.expected.gaps);
    expect(result.flags).toEqual(fixture.expected.flags);
  });

  it('reproduces computed intermediates (explain trace)', () => {
    const computed = Object.fromEntries(
      result.subScores.flatMap((s) => Object.entries(s.computedInputs)),
    );
    const e = fixture.expected.computed;
    expect(computed.hhi_est).toBe(e.hhi_est);
    expect(computed.top1_pct).toBe(e.top1_pct);
    expect(computed.top5_pct).toBe(e.top5_pct);
    expect(computed.cagr_pct).toBe(e.cagr_pct);
    expect(computed.down_years).toBe(e.down_years);
    expect(computed.pipeline_coverage).toBe(e.pipeline_coverage);
  });
});

describe('determinism', () => {
  it('scoring the same answers twice produces identical output', () => {
    const fixture = loadFixture(FIXTURE_NAMES[0]);
    expect(scoreFromAnswers(rubric, fixture.answers)).toEqual(
      scoreFromAnswers(rubric, fixture.answers),
    );
  });
});

describe('band boundaries (docs/03 conventions)', () => {
  const base = loadFixture(FIXTURE_NAMES[0]).answers;
  const points = (answers: typeof base, code: string) =>
    scoreFromAnswers(rubric, answers).subScores.find((s) => s.code === code)!.points;

  it('recurring exactly 60 scores 75 (band_gte lower bound inclusive)', () => {
    expect(points({ ...base, 'REV-RECUR-PCT': 60 }, 'REV-RECUR')).toBe(75);
  });

  it('owner hours exactly 10 scores 75 (bands_lt: 10 is not < 10)', () => {
    expect(points({ ...base, 'OPS-OWNER-HOURS': 10 }, 'OPS-HOURS')).toBe(75);
  });

  it('top-1 share exactly 30 scores 20 (bands_lt: 30 falls to the next band)', () => {
    expect(points({ ...base, 'REV-TOP5-SHARES': [30, 9, 7, 5, 4] }, 'CUS-TOP1')).toBe(20);
  });
});

describe('validation and unknowns', () => {
  it('rejects an incomplete assessment naming the missing questions', () => {
    const { 'REV-NRR': _omitted, ...incomplete } = loadFixture(FIXTURE_NAMES[0]).answers;
    expect(() => scoreFromAnswers(rubric, incomplete)).toThrow(/REV-NRR/);
  });

  it("NRR 'unknown' scores 25 and raises the not-tracked flag", () => {
    const answers = { ...loadFixture(FIXTURE_NAMES[0]).answers, 'REV-NRR': 'unknown' };
    const result = scoreFromAnswers(rubric, answers);
    expect(result.subScores.find((s) => s.code === 'REV-NRR')!.points).toBe(25);
    expect(result.flags).toContain('NRR not tracked');
  });
});

describe('input validation guards (crash / silent-corruption backstop)', () => {
  // Before these guards the engine did not crash on these inputs — it silently
  // produced meaningless scores (e.g. a $0 opening-revenue year scored
  // "Institutional Grade", a solo operator got a perfect management-depth ratio,
  // an out-of-range scale pushed the ORI past 100). Each must now be rejected
  // with a clear, field-level message. None of these change a well-formed score.
  const base = loadFixture(FIXTURE_NAMES[0]).answers;
  const cases: [string, Answers, RegExp][] = [
    ['single fiscal year', { 'REV-ANNUAL': [4_000_000] }, /two fiscal years/],
    ['zero opening-revenue year', { 'REV-ANNUAL': [0, 1_000_000] }, /greater than 0/],
    ['zero most-recent-revenue year', { 'REV-ANNUAL': [500_000, 0] }, /greater than 0/],
    ['negative revenue', { 'REV-ANNUAL': [-100_000, 200_000, 300_000] }, /greater than 0/],
    ['zero core-function count', { 'OPS-FUNC-COUNT': 0 }, /at least 1/],
    ['empty customer-share list', { 'REV-TOP5-SHARES': [] }, /at least one customer share/],
    ['too many customer shares', { 'REV-TOP5-SHARES': [20, 20, 20, 20, 10, 10] }, /at most five/],
    ['customer shares over 100%', { 'REV-TOP5-SHARES': [100, 100, 100, 100, 100] }, /exceeds 100%/],
    ['a single share above 100', { 'REV-TOP5-SHARES': [150] }, /between 0 and 100/],
    ['out-of-range 1–5 scale', { 'PFN-DEPEND': 10 }, /1–5 scale/],
    ['negative churn percentage', { 'CUS-CHURN': -5 }, /must not be negative/],
    ['unknown select value', { 'FIN-RECON': 'sometimes' }, /must be one of/],
  ];
  it.each(cases)('rejects %s', (_label, override, pattern) => {
    expect(() => scoreFromAnswers(rubric, { ...base, ...override })).toThrow(pattern);
  });

  it('still scores a well-formed assessment unchanged', () => {
    expect(scoreFromAnswers(rubric, base).drsScore).toBe(loadFixture(FIXTURE_NAMES[0]).expected.drs);
  });
});

describe('age-aware applicability (N/A + re-normalization, docs/07)', () => {
  const young = loadFixture('company-4-northwind-vertical-saas');

  it('marks the age-gated sub-scores Not Applicable for a young business', () => {
    const result = scoreFromAnswers(rubric, young.answers);
    const na = result.subScores.filter((s) => !s.applicable).map((s) => s.code).sort();
    expect(na).toEqual(['CUS-TENURE', 'GRW-CAGR', 'MGT-RETENTION', 'ORI-LASTVAL', 'REV-GROWTH']);
  });

  it('re-normalizes a dimension over its remaining sub-scores when one is N/A', () => {
    const result = scoreFromAnswers(rubric, young.answers);
    // CUS excludes CUS-TENURE and re-normalizes over the other four (weights 0.80)
    const cus = result.dimensionScores.find((d) => d.code === 'CUS')!.score;
    const parts = rubric.subScores.filter((s) => s.dimensionCode === 'CUS' && s.code !== 'CUS-TENURE');
    const points = new Map(result.subScores.map((s) => [s.code, s.points]));
    const wsum = parts.reduce((a, s) => a + s.weight, 0);
    const expected = Number(
      (parts.reduce((a, s) => a + s.weight * points.get(s.code)!, 0) / wsum).toFixed(2),
    );
    expect(cus).toBe(expected);
    expect(cus).toBe(young.expected.dimension_scores.CUS);
  });

  it('does not fire a gap keyed on an N/A sub-score, and suppresses STALE_VALUATION when young', () => {
    const result = scoreFromAnswers(rubric, young.answers);
    // REV-GROWTH is N/A -> REV_VOLATILITY cannot fire; age < 3 -> STALE_VALUATION suppressed
    expect(result.gapCodes).not.toContain('REV_VOLATILITY');
    expect(result.gapCodes).not.toContain('STALE_VALUATION');
  });

  it('business_age_gte gates STALE_VALUATION: an older company with real history fires it', () => {
    // 12 years old with four fiscal years: the age-gated (tenure, retention,
    // valuation) AND history-gated (growth) sub-scores all apply again.
    const asOld = {
      ...young.answers,
      'BIZ-AGE-YEARS': 12,
      'REV-ANNUAL': [1_500_000, 1_900_000, 2_200_000, 2_600_000],
    };
    const result = scoreFromAnswers(rubric, asOld);
    expect(result.subScores.every((s) => s.applicable)).toBe(true);
    expect(result.gapCodes).toContain('STALE_VALUATION'); // VAL-LASTVAL 'never' + old enough
  });

  it('history gate is independent of age: an old company with only 2 fiscal years still N/As growth', () => {
    const oldFewStatements = { ...young.answers, 'BIZ-AGE-YEARS': 20 };
    const result = scoreFromAnswers(rubric, oldFewStatements);
    const na = result.subScores.filter((s) => !s.applicable).map((s) => s.code).sort();
    // age gates clear at 20yrs; the 2-year history still N/As the growth sub-scores
    expect(na).toEqual(['GRW-CAGR', 'REV-GROWTH']);
  });

  it('a mature fixture has every sub-score applicable (no behavior change)', () => {
    const result = scoreFromAnswers(rubric, loadFixture(FIXTURE_NAMES[0]).answers);
    expect(result.subScores.every((s) => s.applicable)).toBe(true);
  });
});

describe('explainFromAnswers', () => {
  it('decomposes the DRS into per-dimension and per-sub-score contributions', () => {
    const fixture = loadFixture(FIXTURE_NAMES[1]);
    const explain = explainFromAnswers(rubric, fixture.answers);
    // contributions re-sum to the reported scores
    for (const d of explain.dimensions) {
      const parts = explain.subScores.filter((s) => s.dimensionCode === d.code);
      expect(
        Number(parts.reduce((acc, s) => acc + s.weight * s.points, 0).toFixed(2)),
      ).toBe(d.score);
    }
    expect(
      Number(
        explain.dimensions.reduce((acc, d) => acc + d.score * d.drsWeight, 0).toFixed(1),
      ),
    ).toBe(fixture.expected.drs);
    // every fired gap is explained with its trigger
    expect(explain.firedGaps.map((g) => g.code).sort()).toEqual(fixture.expected.gaps);
    expect(explain.firedGaps.every((g) => g.trigger)).toBe(true);
  });

  it('projects the DRS upward if sub-score gaps are remediated to threshold', () => {
    // Fixture 2 scores low and fires many sub_score_below gaps, so the projected
    // DRS must exceed the current DRS and never exceed the target ceiling.
    const fixture = loadFixture(FIXTURE_NAMES[1]);
    const explain = explainFromAnswers(rubric, fixture.answers);
    expect(explain.projectedDrs).toBeGreaterThan(explain.drsScore);
    expect(explain.projectedDrs).toBeLessThanOrEqual(100);

    // Recompute the projection by hand from the same thresholds and aggregation.
    const floors = new Map<string, number>();
    for (const g of explain.firedGaps) {
      const t = g.trigger as { type: string; code?: string; threshold?: number };
      if (t.type === 'sub_score_below' && t.code) {
        floors.set(t.code, Math.max(floors.get(t.code) ?? 0, t.threshold ?? 0));
      }
    }
    const points = new Map(explain.subScores.map((s) => [s.code, s.points]));
    for (const [code, floor] of floors) points.set(code, Math.max(points.get(code) ?? 0, floor));
    const dims = rubric.dimensions
      .filter((d) => d.scoreGroup === 'business_readiness')
      .map((d) => {
        const parts = rubric.subScores.filter((s) => s.dimensionCode === d.code);
        return { d, score: Number(parts.reduce((a, s) => a + s.weight * (points.get(s.code) ?? 0), 0).toFixed(2)) };
      });
    const expected = Number(dims.reduce((a, x) => a + x.score * x.d.drsWeight, 0).toFixed(1));
    expect(explain.projectedDrs).toBe(expected);
  });
});
