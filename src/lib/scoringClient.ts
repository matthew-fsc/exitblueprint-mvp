// Browser-side scoring: loads the rubric in the shape the shared engine wants
// and re-exports the pure scoring functions so the workbench can re-score
// answers live, with zero server round-trip and byte-for-byte the same result
// the server produces (docs/03 — deterministic, no LLM). Reads are RLS-safe:
// every rubric table is world-readable to authenticated users (methodology_read).
import { supabase } from './supabase';
import type {
  Answers,
  FormulaType,
  GapTrigger,
  Rubric,
} from '../../shared/scoring/types';

export {
  drsTier,
  explainFromAnswers,
  scoreFromAnswers,
  validateCompleteness,
} from '../../shared/scoring/engine';
export type { ExplainResult, SubScoreExplain } from '../../shared/scoring/engine';
export type { Answers, Rubric } from '../../shared/scoring/types';

// Builds the engine Rubric via plain per-table reads joined in JS (no embedded
// selects — keeps parity with the dev emulator, which serves eq/in/order only).
export async function loadEngineRubric(rubricVersionId: string): Promise<Rubric> {
  const { data: dims, error: dErr } = await supabase
    .from('dimensions')
    .select('*')
    .eq('rubric_version_id', rubricVersionId)
    .order('sort_order');
  if (dErr) throw new Error(dErr.message);
  const dimensions = dims ?? [];
  const dimIds = dimensions.map((d) => d.id);
  const codeByDimId = new Map<string, string>(dimensions.map((d) => [d.id, d.code]));

  const [{ data: questions }, { data: subs }, { data: gaps }] = await Promise.all([
    supabase.from('questions').select('*').in('dimension_id', dimIds),
    supabase.from('sub_scores').select('*').in('dimension_id', dimIds),
    supabase.from('gap_definitions').select('*').in('dimension_id', dimIds),
  ]);

  return {
    dimensions: dimensions.map((d) => ({
      code: d.code,
      name: d.name,
      scoreGroup: d.score_group,
      drsWeight: Number(d.drs_weight),
      sortOrder: d.sort_order,
    })),
    questions: (questions ?? []).map((q) => ({
      code: q.code,
      dimensionCode: codeByDimId.get(q.dimension_id)!,
      prompt: q.prompt,
      answerType: q.answer_type,
      options: q.options,
      scored: q.scored,
      sortOrder: q.sort_order,
    })),
    subScores: (subs ?? []).map((s) => ({
      code: s.code,
      dimensionCode: codeByDimId.get(s.dimension_id)!,
      name: s.name,
      weight: Number(s.weight),
      formulaType: s.formula_type as FormulaType,
      inputQuestionCodes: (s.input_question_codes as string).split(',').map((x) => x.trim()),
      logic: s.logic,
      notes: null,
    })),
    gapDefinitions: (gaps ?? []).map((g) => ({
      code: g.code,
      name: g.name,
      severity: g.severity,
      dimensionCode: codeByDimId.get(g.dimension_id)!,
      trigger: g.trigger as GapTrigger,
    })),
  };
}

// Maps a draft-derived answer map keyed by question id to the code-keyed map the
// engine consumes. Values already in engine form (number | number[] | string).
export function answersByCode(
  idToCode: Map<string, string>,
  byId: Map<string, unknown>,
): Answers {
  const out: Answers = {};
  for (const [id, value] of byId) {
    const code = idToCode.get(id);
    if (code && value !== undefined) out[code] = value as Answers[string];
  }
  return out;
}
