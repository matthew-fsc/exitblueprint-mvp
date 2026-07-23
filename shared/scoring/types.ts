// Rubric and scoring types. The rubric is data (seeded from /seed, stored in
// the database); the engine is a pure function of (rubric, answers).

export type ScoreGroup = 'business_readiness' | 'owner_readiness';

export type FormulaType =
  | 'band_gte'
  | 'band_ascending'
  | 'select_map'
  | 'scale_map'
  | 'hhi_from_top5'
  | 'durability'
  | 'growth_consistency'
  | 'depth_ratio'
  | 'cagr_band'
  | 'pipeline_ratio'
  | 'top1_band'
  | 'top5_band';

export interface DimensionDef {
  code: string;
  name: string;
  scoreGroup: ScoreGroup;
  drsWeight: number;
  sortOrder: number;
}

export interface QuestionDef {
  code: string;
  dimensionCode: string;
  prompt: string;
  answerType: string;
  options: string | null;
  scored: boolean;
  sortOrder: number;
}

// When present, marks a sub-score Not Applicable for an assessment that meets the
// condition. An N/A sub-score is excluded from its dimension, which re-normalizes
// over the remaining weights (docs/07). Data-driven so the methodology stays in
// the rubric, not the engine (CLAUDE.md rule 3).
export interface NaWhen {
  business_age_lt?: number; // years in business below this -> N/A
  history_years_lt?: number; // fewer than this many fiscal years of revenue -> N/A
  answer_unknown?: string; // the named question answered 'unknown' -> N/A
  answer_in?: { question_code: string; values: string[] }; // named answer in set -> N/A
}

export interface SubScoreLogic {
  bands?: [number, number][];
  bands_lt?: [number, number][];
  else?: number;
  map?: Record<string, number>;
  unknown?: number;
  cap_if_top1_gt?: [number, number];
  negative?: number;
  formula?: string;
  rules?: string;
  na_when?: NaWhen;
  // Softens the top-1 concentration penalty for a contractually locked-in anchor
  // customer (docs/07, D2): if the top customer is >= top1_gte% but under a
  // durable contract (no change-of-control clause, >= min_months avg term), the
  // sub-score floors at `floor` rather than the fragile-whale band.
  anchor_offset?: {
    top1_gte: number;
    coc_question: string;
    coc_ok: string;
    months_question: string;
    min_months: number;
    floor: number;
  };
}

export interface SubScoreDef {
  code: string;
  dimensionCode: string;
  name: string;
  weight: number;
  formulaType: FormulaType;
  inputQuestionCodes: string[];
  logic: SubScoreLogic;
  notes: string | null;
}

export type GapTrigger =
  | { type: 'sub_score_below'; code: string; threshold: number }
  | { type: 'answer_in'; question_code: string; values: string[] }
  | { type: 'answer_not_in'; question_code: string; values: string[] }
  | { type: 'answer_lte'; question_code: string; value: number }
  | { type: 'composite_below'; score_group: ScoreGroup; threshold: number }
  | { type: 'business_age_gte'; years: number }
  | { type: 'all'; conditions: GapTrigger[] };

export type GapSeverity = 'low' | 'med' | 'high' | 'critical';

export interface GapDef {
  code: string;
  name: string;
  severity: GapSeverity;
  dimensionCode: string;
  trigger: GapTrigger;
}

export interface Rubric {
  dimensions: DimensionDef[];
  questions: QuestionDef[];
  subScores: SubScoreDef[];
  gapDefinitions: GapDef[];
}

export type AnswerValue = number | number[] | string;
export type Answers = Record<string, AnswerValue>;

export interface SubScoreResult {
  code: string;
  points: number;
  // false when a na_when condition excludes this sub-score from its dimension for
  // this assessment. Points are still computed (for the explain trace) but not
  // counted, and gaps keyed on it do not fire.
  applicable: boolean;
  computedInputs: Record<string, number | string | number[] | null>;
}

export interface ScoreResult {
  subScores: SubScoreResult[];
  dimensionScores: { code: string; score: number }[];
  drsScore: number;
  drsTier: string;
  oriScore: number;
  gapCodes: string[]; // sorted
  flags: string[];
}
