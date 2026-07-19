// Plain-language interpretation layer over the deterministic explain output.
// This is the single source of truth that turns scores, inputs, and fired
// triggers into user-facing sentences — used by both the advisor results page
// and the deterministic owner-report composer, so the two never drift.
//
// It adds NO new numbers and makes NO scoring decisions: every figure it
// surfaces already came out of the engine (server/scoring.ts, shared/scoring).
// It only reads the explain trace and phrases it. That keeps the output
// defensible (traceable to the same numbers) and readable (no formula names,
// no matrices).

export interface SubScoreExplainLike {
  code: string;
  name: string;
  dimensionCode: string;
  formulaType: string;
  inputs: Record<string, unknown>;
  computed: Record<string, unknown>;
  points: number;
  weight: number;
  contribution: number;
}

export type QualityStatus = 'good' | 'ok' | 'warning' | 'critical';

export interface QualityBand {
  label: string;
  status: QualityStatus;
}

// Points are 0-100 for every sub-score. Four readable bands, aligned loosely
// with the DRS tiers, so a reader never sees a bare number without a word.
export function qualityBand(points: number): QualityBand {
  if (points >= 75) return { label: 'Strong', status: 'good' };
  if (points >= 50) return { label: 'Adequate', status: 'ok' };
  if (points >= 25) return { label: 'Needs work', status: 'warning' };
  return { label: 'At risk', status: 'critical' };
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && !Number.isNaN(v) ? v : null;

// Humanize a select answer value into a phrase a business owner would read.
const SELECT_LABELS: Record<string, string> = {
  monthly: 'reconciled every month',
  quarterly: 'reconciled every quarter',
  annual: 'reconciled once a year',
  none: 'not reconciled against the bank',
  fully_documented: 'fully documented',
  mostly_documented: 'mostly documented',
  partially_documented: 'only partially documented',
  undocumented: 'undocumented',
  accrual_consistent: 'accrual basis, applied consistently',
  cash_with_bridge: 'cash basis with an accrual bridge',
  cash_mixed: 'cash basis, mixed',
  unreconcilable: 'not reconcilable',
  all_three: 'all three statements (P&L, balance sheet, cash flow)',
  pl_and_bs: 'a P&L and balance sheet, no cash-flow statement',
  pl_only: 'a P&L only',
  spreadsheet_only: 'spreadsheets only',
  two_plus_layers: 'two or more management layers below the owner',
  one_clear_layer: 'one clear management layer below the owner',
  informal_partial: 'an informal, partial structure',
  none_all_report_to_owner: 'everyone reporting directly to the owner',
  within_15pct: 'within 15% of the market rate',
  below_15_25pct: '15-25% below the market rate',
  below_25pct_plus: 'more than 25% below the market rate',
  above_25pct_plus: 'more than 25% above the market rate',
  strong_defined: 'strong and clearly defined',
  moderate: 'moderate',
  undifferentiated_unclear: 'undifferentiated and unclear',
  yes: 'yes',
  mostly: 'mostly',
  partially: 'partially',
  no: 'no',
  minor_issues: 'with minor issues',
  significant_issues: 'with significant issues',
  within_12mo: 'valued within the last 12 months',
  one_3yr: 'valued 1-3 years ago',
  over_3yr: 'last valued over 3 years ago',
  never: 'never formally valued',
  fully: 'fully separated',
};

function selectLabel(v: unknown): string {
  const key = typeof v === 'string' ? v : '';
  return SELECT_LABELS[key] ?? key.replace(/_/g, ' ');
}

interface Meta {
  // What this measure checks, in one plain phrase.
  measures: string;
  // What earns full marks — the target the owner is working toward.
  benchmark: string;
  // A plain statement of what this company's data actually shows.
  reading: (s: SubScoreExplainLike) => string;
}

const scaleWords = ['very low', 'low', 'moderate', 'high', 'very high'];

// One entry per sub-score code. Keyed reading builders read from the same
// `computed`/`inputs` the engine already produced (see shared/scoring/engine.ts).
const META: Record<string, Meta> = {
  'REV-RECUR': {
    measures: 'how much revenue renews on its own instead of being re-won each period',
    benchmark: '80% or more of revenue under recurring contracts',
    reading: (s) => `${num(s.computed.value) ?? '—'}% of revenue is contractually recurring.`,
  },
  'REV-HHI': {
    measures: 'how spread out the customer base is',
    benchmark: 'no single customer over 10%, revenue spread across many accounts',
    reading: (s) =>
      `The largest customer is ${num(s.computed.top1_pct) ?? '—'}% of revenue; the wider the spread, the safer the base.`,
  },
  'REV-DURABILITY': {
    measures: 'how locked-in recurring revenue is through signed contracts',
    benchmark: '75% of customers under contract with 18+ months remaining',
    reading: (s) =>
      `${num(s.computed.coverage_pct) ?? '—'}% of customers are under contract, averaging ${num(s.computed.avg_months) ?? '—'} months remaining.`,
  },
  'REV-GROWTH': {
    measures: 'whether revenue grows steadily or bounces around',
    benchmark: '15%+ annual growth with no down years',
    reading: (s) =>
      `Revenue grew about ${num(s.computed.cagr_pct) ?? '—'}% a year, with ${num(s.computed.down_years) ?? 0} down year(s) along the way.`,
  },
  'REV-NRR': {
    measures: 'whether existing customers grow or shrink year over year',
    benchmark: '110%+ net revenue retention',
    reading: (s) =>
      s.computed.value === 'unknown'
        ? 'Net revenue retention is not tracked today, so this scores conservatively until it is measured.'
        : `Net revenue retention is ${num(s.computed.value) ?? '—'}%.`,
  },
  'FIN-RECON': {
    measures: 'how often the books are checked against the bank',
    benchmark: 'monthly reconciliation',
    reading: (s) => `The books are ${selectLabel(s.computed.value)}.`,
  },
  'FIN-ADDBACK': {
    measures: 'how well EBITDA add-backs are supported with evidence',
    benchmark: 'every add-back fully documented',
    reading: (s) => `EBITDA add-backs are ${selectLabel(s.computed.value)}.`,
  },
  'FIN-GAAP': {
    measures: 'how close the accounting is to what a buyer underwrites',
    benchmark: 'accrual basis, applied consistently',
    reading: (s) => `The company keeps its books on ${selectLabel(s.computed.value)}.`,
  },
  'FIN-STATEMENTS': {
    measures: 'whether a complete set of financial statements exists',
    benchmark: 'all three statements produced and internally consistent',
    reading: (s) => `The company produces ${selectLabel(s.computed.value)}.`,
  },
  'OPS-HOURS': {
    measures: 'how much the business still depends on the owner day to day',
    benchmark: 'under 10 owner hours per week in operations',
    reading: (s) =>
      `The owner spends ${num(s.computed.value) ?? '—'} hours a week in day-to-day operations; fewer is better here.`,
  },
  'OPS-SOP': {
    measures: 'how much of the business runs on written processes',
    benchmark: '80%+ of core processes documented',
    reading: (s) => `${num(s.computed.value) ?? '—'}% of core processes have written procedures.`,
  },
  'OPS-DEPTH': {
    measures: 'whether each core function has a manager who could run it without the owner',
    benchmark: 'a qualified manager for every core function',
    reading: (s) =>
      `Managers cover about ${Math.round((num(s.computed.depth_ratio) ?? 0) * 100)}% of the core functions.`,
  },
  'OPS-AUTO': {
    measures: 'how much routine work runs on systems rather than people',
    benchmark: '70%+ of repetitive tasks automated',
    reading: (s) => `${num(s.computed.value) ?? '—'}% of repetitive tasks are handled by systems.`,
  },
  'CUS-TOP1': {
    measures: 'exposure to losing the single largest customer',
    benchmark: 'largest customer under 10% of revenue',
    reading: (s) => `The single largest customer is ${num(s.computed.top1_pct) ?? '—'}% of revenue.`,
  },
  'CUS-TOP5': {
    measures: 'exposure to the top handful of customers',
    benchmark: 'top five customers under 30% of revenue combined',
    reading: (s) => `The top five customers are ${num(s.computed.top5_pct) ?? '—'}% of revenue combined.`,
  },
  'CUS-TENURE': {
    measures: 'how long customers typically stay',
    benchmark: 'average relationship of 5+ years',
    reading: (s) => `Customers stay an average of ${num(s.computed.value) ?? '—'} years.`,
  },
  'CUS-COVERAGE': {
    measures: 'how much revenue sits under a formal contract',
    benchmark: '80%+ of revenue contracted',
    reading: (s) => `${num(s.computed.value) ?? '—'}% of revenue is covered by formal contracts.`,
  },
  'CUS-CHURN': {
    measures: 'how much revenue is lost to customer departures each year',
    benchmark: 'under 5% annual revenue churn',
    reading: (s) => `About ${num(s.computed.value) ?? '—'}% of revenue is lost to churn each year; lower is better.`,
  },
  'MGT-LAYERS': {
    measures: 'how much management sits between the owner and the work',
    benchmark: 'two or more management layers below the owner',
    reading: (s) => `The company has ${selectLabel(s.computed.value)}.`,
  },
  'MGT-NC': {
    measures: 'how many key people are held by non-compete or non-solicit agreements',
    benchmark: 'all key employees under signed agreements',
    reading: (s) => `${num(s.computed.value) ?? '—'}% of key employees have signed non-compete agreements.`,
  },
  'MGT-COMP': {
    measures: 'whether key-role pay is close to the market rate',
    benchmark: 'key roles paid within 15% of market',
    reading: (s) => `Key-role compensation is ${selectLabel(s.computed.value)}.`,
  },
  'MGT-RETENTION': {
    measures: 'how stable the team has been',
    benchmark: 'voluntary turnover under 10% a year',
    reading: (s) => `Voluntary turnover runs about ${num(s.computed.value) ?? '—'}% a year; lower is better.`,
  },
  'GRW-CAGR': {
    measures: 'the underlying growth rate of the business',
    benchmark: '20%+ compound annual growth',
    reading: (s) => `Revenue is compounding at about ${num(s.computed.cagr_pct) ?? '—'}% a year.`,
  },
  'GRW-PIPE': {
    measures: 'how much qualified future work is lined up',
    benchmark: 'a pipeline worth 3x annual revenue',
    reading: (s) =>
      `Qualified pipeline covers about ${num(s.computed.pipeline_coverage) ?? 0}x of annual revenue.`,
  },
  'GRW-POS': {
    measures: 'how clear and defensible the market position is',
    benchmark: 'a strong, clearly defined position (caps at a high mark by design)',
    reading: (s) => `Market positioning is ${selectLabel(s.computed.value)}.`,
  },
  'GRW-REPEAT': {
    measures: 'how much revenue comes from repeatable offerings versus one-off custom work',
    benchmark: '70%+ of revenue from standardized offerings',
    reading: (s) => `${num(s.computed.value) ?? '—'}% of revenue comes from repeatable, standardized offerings.`,
  },
  // Owner Readiness Index sub-scores.
  'ORI-DEPEND': {
    measures: 'how much the owner’s future depends on hitting one specific price',
    benchmark: 'lifestyle not dependent on a single sale price',
    // PFN-DEPEND is 1 = fully dependent … 5 = not dependent, so the dependence
    // level runs OPPOSITE to the raw value: value 1 = "very high" dependence.
    reading: (s) => `The owner’s lifestyle dependence on the sale price is ${scaleWords[5 - (num(s.computed.value) ?? 5)] ?? '—'}.`,
  },
  'ORI-OUTSIDE': {
    measures: 'whether the owner has assets outside the business to retire on',
    benchmark: 'sufficient outside assets to retire',
    reading: (s) => `Outside assets sufficient to retire: ${selectLabel(s.computed.value)}.`,
  },
  'ORI-DEBT': {
    measures: 'whether personal obligations line up with the exit timeline',
    benchmark: 'personal debt and guarantees aligned with the timeline',
    reading: (s) => `Personal obligations align with the timeline: ${selectLabel(s.computed.value)}.`,
  },
  'ORI-LASTVAL': {
    measures: 'how current the owner’s sense of value is',
    benchmark: 'a professional valuation within the last 12 months',
    reading: (s) => `The business was ${selectLabel(s.computed.value)}.`,
  },
  'ORI-CONF': {
    measures: 'how confident the owner is that value meets their goals',
    benchmark: 'high confidence value supports the owner’s goals',
    reading: (s) => `The owner’s confidence that value meets their goals is ${scaleWords[(num(s.computed.value) ?? 1) - 1] ?? '—'}.`,
  },
  'ORI-SEP': {
    measures: 'how cleanly personal and business finances are separated',
    benchmark: 'personal and business finances fully separated',
    reading: (s) => `Personal and business finances are ${selectLabel(s.computed.value)}.`,
  },
};

export interface SubScoreReading {
  code: string;
  name: string;
  points: number;
  band: QualityBand;
  measures: string;
  reading: string;
  benchmark: string;
  // How many points this measure adds to its dimension's 0-100 score.
  contribution: number;
  weightPct: number;
}

const GENERIC: Meta = {
  measures: 'a component of this dimension',
  benchmark: 'a full-marks result',
  reading: (s) => {
    const v = s.computed.value;
    if (typeof v === 'string') return `Recorded as ${selectLabel(v)}.`;
    if (typeof v === 'number') return `Recorded value: ${v}.`;
    return 'See the underlying assessment answers.';
  },
};

export function interpretSubScore(s: SubScoreExplainLike): SubScoreReading {
  const meta = META[s.code] ?? GENERIC;
  return {
    code: s.code,
    name: s.name,
    points: s.points,
    band: qualityBand(s.points),
    measures: meta.measures,
    reading: meta.reading(s),
    benchmark: meta.benchmark,
    contribution: s.contribution,
    weightPct: Math.round(s.weight * 100),
  };
}

// Plain-language reason a gap fired, built from the same trigger the engine
// evaluated — never a raw code like "sub_score CUS-TOP1 below 70".
export function gapReason(
  trigger: unknown,
  subScoreNames: Map<string, string>,
): string {
  const t = trigger as Record<string, unknown>;
  switch (t?.type) {
    case 'sub_score_below':
      return `${subScoreNames.get(t.code as string) ?? (t.code as string)} scored below the safe threshold for a smooth sale.`;
    case 'answer_in':
      return `The assessment answer for this area falls in a range buyers treat as a risk.`;
    case 'answer_lte':
      return `The owner rated this area at or below the level that signals a concern.`;
    case 'composite_below':
      return `Overall business readiness is still below the level buyers expect.`;
    case 'all':
      return (t.conditions as unknown[])
        .map((c) => gapReason(c, subScoreNames))
        .join(' Together with: ');
    default:
      return 'A measured threshold in the methodology was crossed.';
  }
}

// --- Consensus synthesis ------------------------------------------------------
// A deterministic "bottom line" built only from the explain trace: the tier
// verdict, the two strongest and two weakest business dimensions, the gap
// pressure, and the business/owner divergence. No new numbers, no LLM — the
// same defensibility rule as everything else in this file. Shared by the
// results page, the owner report, and the PDF so they never disagree.
export interface ConsensusInput {
  drsScore: number;
  drsTier: string;
  oriScore: number;
  dimensions: { code: string; name: string; score: number }[];
  firedGaps: { severity: string }[];
}

export interface Consensus {
  headline: string; // one-sentence verdict
  strengths: { name: string; score: number }[]; // up to 2, highest
  risks: { name: string; score: number }[]; // up to 2, lowest
  criticalCount: number;
  highCount: number;
  divergent: boolean;
  bottomLine: string; // a short synthesized paragraph
}

export function consensus(input: ConsensusInput): Consensus {
  const ranked = [...input.dimensions].sort((a, b) => b.score - a.score);
  const strengths = ranked.slice(0, 2).map((d) => ({ name: d.name, score: d.score }));
  const risks = ranked
    .slice(-2)
    .reverse()
    .map((d) => ({ name: d.name, score: d.score }));
  const criticalCount = input.firedGaps.filter((g) => g.severity === 'critical').length;
  const highCount = input.firedGaps.filter((g) => g.severity === 'high').length;
  const divergent = Math.abs(input.drsScore - input.oriScore) >= 15;

  const headline = `At a Diligence Readiness Score of ${input.drsScore}, ${input.drsTier === 'Not Saleable (Yet)' ? 'the business is not ready to go to market' : `the business is in the ${input.drsTier} tier`} — ${tierMeaning(input.drsTier)}.`;

  const strengthPhrase =
    strengths.length && strengths[0].score >= 55
      ? ` Its strongest ground is ${strengths.map((d) => d.name).join(' and ')}.`
      : ' No dimension yet stands out as a clear strength.';

  const riskPhrase = risks.length
    ? ` The work to sequence first is ${risks.map((d) => d.name).join(' and ')}.`
    : '';

  const gapPhrase =
    criticalCount > 0
      ? ` ${criticalCount} critical gap${criticalCount > 1 ? 's' : ''} would stall diligence and must lead the plan.`
      : highCount > 0
        ? ` ${highCount} high-priority gap${highCount > 1 ? 's' : ''} would weigh on price if left unaddressed.`
        : ' No critical gaps are open — the focus shifts to holding the score and preparing materials.';

  const dividePhrase = divergent
    ? ` Business and owner readiness are far apart (${input.drsScore} vs ${input.oriScore}), so the plan has to move both.`
    : '';

  return {
    headline,
    strengths,
    risks,
    criticalCount,
    highCount,
    divergent,
    bottomLine: `${headline}${strengthPhrase}${riskPhrase}${gapPhrase}${dividePhrase}`,
  };
}

// --- Path to 100: gap decomposition ------------------------------------------
// The distance from the current DRS to a perfect 100, decomposed across the six
// business dimensions and — within a dimension — across its sub-scores. Every
// figure is derived from the same weights and points the engine already
// produced (drsWeight, dimension score, sub-score weight/points): this adds NO
// new numbers and makes NO scoring decisions. It exists so an advisor can see
// exactly where the missing points sit, ranked by how many DRS points each is
// worth, and move straight from the gap to the remediation plan.
//
// The identity that makes this defensible: a dimension currently contributes
// `drsWeight * score` DRS points and could contribute at most `drsWeight * 100`,
// so its recoverable points are `drsWeight * (100 - score)`. Summed across the
// six business dimensions these equal exactly `100 - drsScore`.

const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface DimensionGap {
  code: string;
  name: string;
  score: number; // current dimension score, 0-100
  drsWeight: number;
  contributionToDrs: number; // DRS points this dimension currently adds
  maxContributionToDrs: number; // most it could add: drsWeight * 100
  recoverablePoints: number; // DRS points still on the table: drsWeight * (100 - score)
  shareOfGap: number; // this dimension's share of the whole gap, 0-1
}

export interface GapToTarget {
  target: number; // always 100 — a perfect score
  current: number; // the current DRS
  totalGap: number; // target - current
  dimensions: DimensionGap[]; // sorted by recoverablePoints, largest opportunity first
}

export function gapToTarget(
  drsScore: number,
  dimensions: {
    code: string;
    name: string;
    score: number;
    drsWeight: number;
    contributionToDrs: number;
  }[],
): GapToTarget {
  const target = 100;
  const totalGap = round1(Math.max(0, target - drsScore));
  const dims: DimensionGap[] = dimensions
    .map((d) => {
      const maxContributionToDrs = round2(d.drsWeight * target);
      const recoverablePoints = round2(Math.max(0, d.drsWeight * (target - d.score)));
      return {
        code: d.code,
        name: d.name,
        score: d.score,
        drsWeight: d.drsWeight,
        contributionToDrs: d.contributionToDrs,
        maxContributionToDrs,
        recoverablePoints,
        shareOfGap: totalGap > 0 ? recoverablePoints / totalGap : 0,
      };
    })
    .sort((a, b) => b.recoverablePoints - a.recoverablePoints);
  return { target, current: drsScore, totalGap, dimensions: dims };
}

export interface SubScoreGap extends SubScoreReading {
  // Points this measure would add to its own dimension at full marks:
  // weight * (100 - points).
  recoverableDimPoints: number;
  // DRS points recovering it to full marks would add, through its dimension:
  // drsWeight * weight * (100 - points).
  recoverableDrsPoints: number;
}

// The sub-scores inside one dimension, ranked by how many DRS points bringing
// each to full marks would recover — the specific fixes behind a dimension gap.
export function subScoreGaps(
  subScores: SubScoreExplainLike[],
  drsWeight: number,
): SubScoreGap[] {
  return subScores
    .map((s) => {
      const reading = interpretSubScore(s);
      const recoverableDimPoints = round2(s.weight * (100 - s.points));
      return {
        ...reading,
        recoverableDimPoints,
        recoverableDrsPoints: round2(drsWeight * s.weight * (100 - s.points)),
      };
    })
    .sort((a, b) => b.recoverableDrsPoints - a.recoverableDrsPoints);
}

export function tierMeaning(tier: string): string {
  switch (tier) {
    case 'Institutional Grade':
      return 'the business would stand up to institutional buyers and a competitive process';
    case 'Sale Ready':
      return 'the business could go to market and through diligence with a short, known list of fixes';
    case 'Needs Work':
      return 'the fundamentals are there, but several gaps would slow a sale or pull down the price';
    case 'High Risk':
      return 'a sale today would face real friction and a discounted price until key risks are resolved';
    case 'Not Saleable (Yet)':
      return 'the business is not ready to sell yet; the priority is removing the biggest risks first';
    default:
      return 'this is where the business sits on the readiness scale';
  }
}
