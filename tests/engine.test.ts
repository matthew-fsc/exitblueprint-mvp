// The engine is correct when it reproduces the reference scorer's fixture
// outputs exactly (docs/03): every sub-score, dimension score, DRS, tier,
// ORI, gap set, flags, and computed intermediates.
import { describe, expect, it } from 'vitest';
import { explainFromAnswers, pyRound, scoreFromAnswers } from '../shared/scoring/engine';
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

  it('top-1 share exactly 30 scores 25 (bands_lt: 30 falls to the next band, DRS-2.0)', () => {
    expect(points({ ...base, 'REV-TOP5-SHARES': [30, 9, 7, 5, 4] }, 'CUS-TOP1')).toBe(25);
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

  it('revenue-model branch: a transactional business N/As the recurring-revenue sub-scores', () => {
    const txn = loadFixture('company-5-cascade-precision-machining');
    const result = scoreFromAnswers(rubric, txn.answers);
    const na = result.subScores.filter((s) => !s.applicable).map((s) => s.code).sort();
    expect(na).toEqual(['REV-DURABILITY', 'REV-NRR', 'REV-RECUR']);
    // Revenue Quality is judged on the applicable sub-scores, not floored to zero
    expect(result.gapCodes).not.toContain('RECURRING_LOW');
    expect(result.gapCodes).not.toContain('CONTRACT_GAP');
    expect(result.gapCodes).not.toContain('CHURN_HIGH');
  });
});

describe('D8 pipeline: trend denominator + graded sub-1x + model-aware gap', () => {
  const base = loadFixture(FIXTURE_NAMES[0]).answers;
  const pipe = (answers: typeof base) =>
    scoreFromAnswers(rubric, answers).subScores.find((s) => s.code === 'GRW-PIPE')!.points;

  it('a revenue collapse no longer inflates coverage (avg denominator, not latest year)', () => {
    // $6M pipeline against a collapsed last year: latest-year math would read 2.0x
    // (-> 70); against the ~$8.25M average it is 0.73x -> graded 15.
    const collapsed = {
      ...base,
      'REV-ANNUAL': [10_000_000, 10_000_000, 10_000_000, 3_000_000],
      'GRW-PIPELINE': 6_000_000,
    };
    expect(pipe(collapsed)).toBe(15);
  });

  it('sub-1x coverage gets graded credit instead of a hard zero', () => {
    const thin = { ...base, 'REV-ANNUAL': [4_000_000, 4_000_000], 'GRW-PIPELINE': 2_400_000, 'BIZ-AGE-YEARS': 8 };
    expect(pipe(thin)).toBe(15); // 2.4 / 4.0 = 0.6x -> 15
  });

  it('PIPELINE_BLIND is suppressed for a recurring model (no new-business pipeline motion)', () => {
    const recurringThin = { ...base, 'GRW-PIPELINE': 100_000, 'REV-MODEL': 'recurring' };
    const result = scoreFromAnswers(rubric, recurringThin);
    expect(result.subScores.find((s) => s.code === 'GRW-PIPE')!.points).toBeLessThan(70);
    expect(result.gapCodes).not.toContain('PIPELINE_BLIND');
  });

  it('PIPELINE_BLIND still fires for a transactional/project model with thin pipeline', () => {
    const projectThin = { ...base, 'GRW-PIPELINE': 100_000, 'REV-MODEL': 'transactional_project' };
    expect(scoreFromAnswers(rubric, projectThin).gapCodes).toContain('PIPELINE_BLIND');
  });
});

describe('D2 concentration gradient + anchor offset', () => {
  const base = loadFixture(FIXTURE_NAMES[0]).answers;
  const top1 = (answers: typeof base) =>
    scoreFromAnswers(rubric, answers).subScores.find((s) => s.code === 'CUS-TOP1')!.points;

  it('a single-customer business cannot reach Sale Ready', () => {
    const captive = { ...base, 'REV-TOP5-SHARES': [100] };
    expect(scoreFromAnswers(rubric, captive).drsScore).toBeLessThan(70);
  });

  it('the severe range is graded, not collapsed to a single 0', () => {
    // 41% and 60% single customers now score differently (were both 0 in DRS-1.0)
    expect(top1({ ...base, 'REV-TOP5-SHARES': [41, 20, 15, 14, 10] })).toBe(15);
    expect(top1({ ...base, 'REV-TOP5-SHARES': [60, 15, 12, 8, 5] })).toBe(7);
    expect(top1({ ...base, 'REV-TOP5-SHARES': [80, 20] })).toBe(0);
  });

  it('a contractually locked-in anchor floors at 45 (no CoC clause, long term)', () => {
    const anchored = {
      ...base,
      'REV-TOP5-SHARES': [55, 15, 12, 10, 8],
      'CUS-COC-CTX': 'none',
      'REV-CONTRACT-AVG-MO': 60,
    };
    expect(top1(anchored)).toBe(45); // base band would be 7
  });

  it('the anchor offset does NOT apply to a fragile whale (CoC clause or short term)', () => {
    const shares = { 'REV-TOP5-SHARES': [55, 15, 12, 10, 8] };
    // change-of-control clause present -> no offset
    expect(top1({ ...base, ...shares, 'CUS-COC-CTX': 'yes_material', 'REV-CONTRACT-AVG-MO': 60 })).toBe(7);
    // short remaining term -> no offset
    expect(top1({ ...base, ...shares, 'CUS-COC-CTX': 'none', 'REV-CONTRACT-AVG-MO': 6 })).toBe(7);
  });
});

describe('D1 graded negative growth bands', () => {
  const base = loadFixture(FIXTURE_NAMES[0]).answers; // 4 fiscal years -> growth applies
  const cagr = (answers: typeof base, code: string) =>
    scoreFromAnswers(rubric, answers).subScores.find((s) => s.code === code)!.points;

  it('eroding decline (~-10%/yr) scores GRW-CAGR 5, not 0', () => {
    const eroding = { ...base, 'REV-ANNUAL': [5_000_000, 4_500_000, 4_100_000, 3_700_000] };
    expect(cagr(eroding, 'GRW-CAGR')).toBe(5);
  });

  it('melting decline (<-15%/yr) still scores GRW-CAGR 0', () => {
    const melting = { ...base, 'REV-ANNUAL': [5_000_000, 3_500_000, 2_500_000, 1_800_000] };
    expect(cagr(melting, 'GRW-CAGR')).toBe(0);
  });

  it('a soft, mostly-steady decline earns REV-GROWTH 15 rather than a hard zero', () => {
    // company-2: -0.65% CAGR with a single down year -> graded credit
    const soft = loadFixture(FIXTURE_NAMES[1]);
    const result = scoreFromAnswers(rubric, soft.answers);
    expect(result.subScores.find((s) => s.code === 'REV-GROWTH')!.points).toBe(15);
    expect(result.subScores.find((s) => s.code === 'GRW-CAGR')!.points).toBe(15);
  });

  it('positive-growth fixtures are unchanged by the negative bands', () => {
    // company-1 grows ~14%/yr; its growth sub-scores match the stored fixture
    const f = loadFixture(FIXTURE_NAMES[0]);
    const result = scoreFromAnswers(rubric, f.answers);
    expect(result.subScores.find((s) => s.code === 'GRW-CAGR')!.points).toBe(
      f.expected.sub_scores['GRW-CAGR'],
    );
  });
});

describe('explainFromAnswers', () => {
  it('decomposes the DRS into per-dimension and per-sub-score contributions', () => {
    const fixture = loadFixture(FIXTURE_NAMES[1]);
    const explain = explainFromAnswers(rubric, fixture.answers);
    // applicable contributions re-sum (with re-normalization) to the reported scores
    for (const d of explain.dimensions) {
      const parts = explain.subScores.filter((s) => s.dimensionCode === d.code);
      const applic = parts.filter((s) => s.applicable);
      const wsum = applic.reduce((a, s) => a + s.weight, 0);
      const expected =
        applic.length === parts.length
          ? pyRound(parts.reduce((a, s) => a + s.weight * s.points, 0), 2)
          : pyRound(applic.reduce((a, s) => a + s.weight * s.points, 0) / wsum, 2);
      expect(expected).toBe(d.score);
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
    const applicable = new Map(explain.subScores.map((s) => [s.code, s.applicable]));
    const dims = rubric.dimensions
      .filter((d) => d.scoreGroup === 'business_readiness')
      .map((d) => {
        const parts = rubric.subScores.filter((s) => s.dimensionCode === d.code);
        const applic = parts.filter((s) => applicable.get(s.code) !== false);
        const wsum = applic.reduce((a, s) => a + s.weight, 0);
        const score =
          applic.length === parts.length
            ? pyRound(parts.reduce((a, s) => a + s.weight * (points.get(s.code) ?? 0), 0), 2)
            : pyRound(applic.reduce((a, s) => a + s.weight * (points.get(s.code) ?? 0), 0) / wsum, 2);
        return { d, score };
      });
    const expected = pyRound(dims.reduce((a, x) => a + x.score * x.d.drsWeight, 0), 1);
    expect(explain.projectedDrs).toBe(expected);
  });
});
