// Deterministic scoring engine — a pure function of (rubric, answers).
// Ported from seed/fixtures/reference_scorer.py, which is the executable
// reference: where prose and reference disagree, the reference wins.
// No I/O, no LLM involvement under any circumstances (CLAUDE.md rule 1).
import type {
  AnswerValue,
  Answers,
  GapTrigger,
  Rubric,
  ScoreResult,
  SubScoreDef,
  SubScoreResult,
} from './types';

// Matches Python's round(): round-half-even applied to the EXACT binary value
// of the double (e.g. 40.25 -> 40.2, while 61.05 -> 61.0 because the double is
// 61.04999…). The reference scorer used Python round, so fixture outputs are
// only reproducible with the same convention. Exact via BigInt: the double is
// decomposed as m * 2^e and rounded as an exact rational.
export function pyRound(x: number, ndigits: number): number {
  if (!Number.isFinite(x)) return x;
  const negative = x < 0;
  const abs = Math.abs(x);
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, abs);
  const bits = view.getBigUint64(0);
  const exponentBits = Number((bits >> 52n) & 0x7ffn);
  const fractionBits = bits & 0xfffffffffffffn;
  const mantissa = exponentBits === 0 ? fractionBits : fractionBits | (1n << 52n);
  const exponent = (exponentBits === 0 ? -1074 : exponentBits - 1075);
  // abs = mantissa * 2^exponent, exactly. Compute abs * 10^ndigits as N / D.
  const scale = 10n ** BigInt(ndigits);
  let numerator = mantissa * scale;
  let denominator = 1n;
  if (exponent >= 0) numerator <<= BigInt(exponent);
  else denominator = 1n << BigInt(-exponent);
  let quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const twice = remainder * 2n;
  if (twice > denominator || (twice === denominator && quotient % 2n === 1n)) quotient += 1n;
  const rounded = Number(quotient) / Number(scale);
  return negative ? -rounded : rounded;
}

function num(v: AnswerValue | undefined, code: string): number {
  if (typeof v !== 'number' || Number.isNaN(v)) {
    throw new Error(`answer ${code}: expected a number, got ${JSON.stringify(v)}`);
  }
  return v;
}

function numList(v: AnswerValue | undefined, code: string): number[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'number')) {
    throw new Error(`answer ${code}: expected a numeric list, got ${JSON.stringify(v)}`);
  }
  return v;
}

function str(v: AnswerValue | undefined, code: string): string {
  if (typeof v !== 'string') {
    throw new Error(`answer ${code}: expected a string, got ${JSON.stringify(v)}`);
  }
  return v;
}

// Higher is better: bands sorted descending, first threshold where v >= wins.
function bandGte(v: number, bands: [number, number][], elsePoints?: number): number {
  for (const [threshold, points] of bands) {
    if (v >= threshold) return points;
  }
  return elsePoints ?? bands[bands.length - 1][1];
}

// Lower is better: strict less-than, ascending; else-value if none match.
function bandLt(v: number, bandsLt: [number, number][], elsePoints: number): number {
  for (const [threshold, points] of bandsLt) {
    if (v < threshold) return points;
  }
  return elsePoints;
}

function selectMap(v: string, map: Record<string, number>, code: string): number {
  const points = map[v];
  if (points === undefined) throw new Error(`sub_score ${code}: no mapping for answer '${v}'`);
  return points;
}

interface GrowthInputs {
  cagrPct: number;
  downYears: number;
}

function growthInputs(annual: number[]): GrowthInputs {
  const n = annual.length;
  const cagr = Math.pow(annual[n - 1] / annual[0], 1 / (n - 1)) - 1;
  let down = 0;
  for (let i = 1; i < n; i++) if (annual[i] < annual[i - 1]) down++;
  return { cagrPct: cagr * 100, downYears: down };
}

function computeSubScore(sub: SubScoreDef, answers: Answers, flags: string[]): SubScoreResult {
  const logic = sub.logic;
  const inputs = sub.inputQuestionCodes;
  const q0 = inputs[0];
  const computedInputs: SubScoreResult['computedInputs'] = {};
  let points: number;

  switch (sub.formulaType) {
    case 'band_gte': {
      const raw = answers[q0];
      if (raw === 'unknown') {
        if (logic.unknown === undefined) {
          throw new Error(`sub_score ${sub.code}: 'unknown' answer but no unknown value declared`);
        }
        points = logic.unknown;
        // e.g. REV-NRR -> "NRR not tracked" (v1 flag convention from the reference)
        flags.push(`${sub.code.split('-').slice(1).join('-')} not tracked`);
        computedInputs.value = 'unknown';
        break;
      }
      const v = num(raw, q0);
      points = bandGte(v, logic.bands!, logic.else);
      computedInputs.value = v;
      break;
    }
    case 'band_ascending': {
      const v = num(answers[q0], q0);
      points = bandLt(v, logic.bands_lt!, logic.else ?? 0);
      computedInputs.value = v;
      break;
    }
    case 'select_map': {
      const v = str(answers[q0], q0);
      points = selectMap(v, logic.map!, sub.code);
      computedInputs.value = v;
      break;
    }
    case 'scale_map': {
      const v = num(answers[q0], q0);
      points = (v - 1) * 25;
      computedInputs.value = v;
      break;
    }
    case 'hhi_from_top5': {
      const shares = numList(answers[q0], q0);
      const hhi = shares.reduce((acc, s) => acc + s * s, 0);
      points = bandLt(hhi, logic.bands_lt!, logic.else ?? 0);
      const [capThreshold, capPoints] = logic.cap_if_top1_gt ?? [Infinity, 0];
      if (shares[0] > capThreshold) points = Math.min(points, capPoints);
      computedInputs.hhi_est = hhi;
      computedInputs.top1_pct = shares[0];
      break;
    }
    case 'durability': {
      // 100 * min(1, coverage/75) * min(1, months/18), rounded 2dp (docs/03)
      const coverage = num(answers[inputs[0]], inputs[0]);
      const months = num(answers[inputs[1]], inputs[1]);
      points = pyRound(100 * Math.min(1, coverage / 75) * Math.min(1, months / 18), 2);
      computedInputs.coverage_pct = coverage;
      computedInputs.avg_months = months;
      break;
    }
    case 'growth_consistency': {
      const annual = numList(answers[q0], q0);
      const { cagrPct, downYears } = growthInputs(annual);
      if (cagrPct < 0) points = 0;
      else if (cagrPct >= 15 && downYears === 0) points = 100;
      else if (cagrPct >= 10 && downYears <= 1) points = 75;
      else if (cagrPct >= 5 && downYears <= 1) points = 50;
      else points = 25;
      computedInputs.cagr_pct = pyRound(cagrPct, 2);
      computedInputs.down_years = downYears;
      break;
    }
    case 'cagr_band': {
      const annual = numList(answers[q0], q0);
      const { cagrPct } = growthInputs(annual);
      points = cagrPct < 0 ? (logic.negative ?? 0) : bandGte(cagrPct, logic.bands!);
      computedInputs.cagr_pct = pyRound(cagrPct, 2);
      break;
    }
    case 'depth_ratio': {
      const managers = num(answers[inputs[0]], inputs[0]);
      const functions = num(answers[inputs[1]], inputs[1]);
      const ratio = managers / functions;
      points = bandGte(ratio, logic.bands!, logic.else);
      computedInputs.depth_ratio = ratio;
      break;
    }
    case 'pipeline_ratio': {
      const pipeline = num(answers[inputs[0]], inputs[0]);
      const annual = numList(answers[inputs[1]], inputs[1]);
      const ratio = pipeline > 0 ? pipeline / annual[annual.length - 1] : 0;
      points = pipeline <= 0 ? 0 : bandGte(ratio, logic.bands!, logic.else ?? 0);
      computedInputs.pipeline_coverage = pyRound(ratio, 2);
      break;
    }
    case 'top1_band': {
      const shares = numList(answers[q0], q0);
      points = bandLt(shares[0], logic.bands_lt!, logic.else ?? 0);
      computedInputs.top1_pct = shares[0];
      break;
    }
    case 'top5_band': {
      const shares = numList(answers[q0], q0);
      const total = shares.reduce((acc, s) => acc + s, 0);
      points = bandLt(total, logic.bands_lt!, logic.else ?? 0);
      computedInputs.top5_pct = total;
      break;
    }
    default:
      throw new Error(`sub_score ${sub.code}: unknown formula_type ${sub.formulaType}`);
  }

  return { code: sub.code, points, computedInputs };
}

export function drsTier(drs: number): string {
  if (drs >= 85) return 'Institutional Grade';
  if (drs >= 70) return 'Sale Ready';
  if (drs >= 55) return 'Needs Work';
  if (drs >= 40) return 'High Risk';
  return 'Not Saleable (Yet)';
}

function evaluateTrigger(
  trigger: GapTrigger,
  subScorePoints: Map<string, number>,
  answers: Answers,
  drs: number,
): boolean {
  switch (trigger.type) {
    case 'sub_score_below': {
      const points = subScorePoints.get(trigger.code);
      if (points === undefined) throw new Error(`gap trigger references unknown sub_score ${trigger.code}`);
      return points < trigger.threshold;
    }
    case 'answer_in':
      return trigger.values.includes(answers[trigger.question_code] as string);
    case 'answer_lte':
      return (answers[trigger.question_code] as number) <= trigger.value;
    case 'composite_below':
      // business_readiness composite is the DRS (docs/03)
      return drs < trigger.threshold;
    case 'all':
      return trigger.conditions.every((c) => evaluateTrigger(c, subScorePoints, answers, drs));
    default:
      return false;
  }
}

export function validateCompleteness(rubric: Rubric, answers: Answers): string[] {
  return rubric.questions
    .filter((q) => q.scored && answers[q.code] === undefined)
    .map((q) => q.code);
}

export function scoreFromAnswers(rubric: Rubric, answers: Answers): ScoreResult {
  const missing = validateCompleteness(rubric, answers);
  if (missing.length > 0) {
    throw new Error(`assessment incomplete: unanswered scored questions: ${missing.join(', ')}`);
  }

  const flags: string[] = [];
  const dimensionByCode = new Map(rubric.dimensions.map((d) => [d.code, d]));
  const subScores = rubric.subScores.map((s) => computeSubScore(s, answers, flags));
  const pointsByCode = new Map(subScores.map((s) => [s.code, s.points]));

  // Dimension score = sum(weight x points); computed for business dimensions.
  // ORI = sum(weight x points) across the owner_readiness group as a whole
  // (its weights sum to 1.0 across the group, per the reference scorer).
  const businessDims = rubric.dimensions
    .filter((d) => d.scoreGroup === 'business_readiness')
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const dimensionScores = businessDims.map((d) => {
    const parts = rubric.subScores.filter((s) => s.dimensionCode === d.code);
    const score = pyRound(
      parts.reduce((acc, s) => acc + s.weight * pointsByCode.get(s.code)!, 0),
      2,
    );
    return { code: d.code, score };
  });

  const drsScore = pyRound(
    dimensionScores.reduce(
      (acc, ds) => acc + ds.score * dimensionByCode.get(ds.code)!.drsWeight,
      0,
    ),
    1,
  );

  const oriScore = pyRound(
    rubric.subScores
      .filter((s) => dimensionByCode.get(s.dimensionCode)!.scoreGroup === 'owner_readiness')
      .reduce((acc, s) => acc + s.weight * pointsByCode.get(s.code)!, 0),
    1,
  );

  const gapCodes = rubric.gapDefinitions
    .filter((g) => evaluateTrigger(g.trigger, pointsByCode, answers, drsScore))
    .map((g) => g.code)
    .sort();

  return {
    subScores,
    dimensionScores,
    drsScore,
    drsTier: drsTier(drsScore),
    oriScore,
    gapCodes,
    flags,
  };
}

// --- Explainability (docs/03) -------------------------------------------------

export interface SubScoreExplain {
  code: string;
  name: string;
  dimensionCode: string;
  formulaType: string;
  inputs: Record<string, AnswerValue | null>;
  computed: SubScoreResult['computedInputs'];
  logic: SubScoreDef['logic'];
  points: number;
  weight: number;
  contribution: number;
}

export interface ExplainResult {
  subScores: SubScoreExplain[];
  dimensions: {
    code: string;
    name: string;
    score: number;
    drsWeight: number;
    contributionToDrs: number;
  }[];
  drsScore: number;
  drsTier: string;
  oriScore: number;
  firedGaps: { code: string; name: string; severity: string; trigger: GapTrigger }[];
  flags: string[];
}

export function explainFromAnswers(rubric: Rubric, answers: Answers): ExplainResult {
  const result = scoreFromAnswers(rubric, answers);
  const pointsByCode = new Map(result.subScores.map((s) => [s.code, s]));
  const scoreByDim = new Map(result.dimensionScores.map((d) => [d.code, d.score]));

  const subScores = rubric.subScores.map((s) => {
    const r = pointsByCode.get(s.code)!;
    return {
      code: s.code,
      name: s.name,
      dimensionCode: s.dimensionCode,
      formulaType: s.formulaType,
      inputs: Object.fromEntries(s.inputQuestionCodes.map((qc) => [qc, answers[qc] ?? null])),
      computed: r.computedInputs,
      logic: s.logic,
      points: r.points,
      weight: s.weight,
      contribution: pyRound(s.weight * r.points, 2),
    };
  });

  const dimensions = rubric.dimensions
    .filter((d) => d.scoreGroup === 'business_readiness')
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((d) => ({
      code: d.code,
      name: d.name,
      score: scoreByDim.get(d.code)!,
      drsWeight: d.drsWeight,
      contributionToDrs: pyRound(scoreByDim.get(d.code)! * d.drsWeight, 2),
    }));

  const firedGaps = rubric.gapDefinitions
    .filter((g) => result.gapCodes.includes(g.code))
    .map((g) => ({ code: g.code, name: g.name, severity: g.severity, trigger: g.trigger }));

  return {
    subScores,
    dimensions,
    drsScore: result.drsScore,
    drsTier: result.drsTier,
    oriScore: result.oriScore,
    firedGaps,
    flags: result.flags,
  };
}
