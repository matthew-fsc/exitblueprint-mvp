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
  | { type: 'answer_lte'; question_code: string; value: number }
  | { type: 'composite_below'; score_group: ScoreGroup; threshold: number }
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
