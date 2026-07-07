// Server-side entry points for the scoring engine (docs/03 contract):
//   scoreAssessment(db, assessment_id)  -> scores + persists in one transaction
//   explainAssessment(db, assessment_id) -> full explain trace, no writes
// Reads answers + rubric for the assessment's rubric_version; writes
// sub_score_results, dimension_scores, the assessment scores, and gap rows.
// Deterministic: no network calls except the database. No LLM involvement.
import type pg from 'pg';
import {
  explainFromAnswers,
  scoreFromAnswers,
  validateCompleteness,
  type ExplainResult,
} from '../shared/scoring/engine';
import type { Answers, GapTrigger, Rubric, ScoreResult } from '../shared/scoring/types';

export interface ScoreAssessmentResult extends ScoreResult {
  assessmentId: string;
  gapsOpened: string[]; // gap_definition codes newly opened by this assessment
  gapsResolved: string[]; // gap_definition codes resolved by this assessment
}

interface LoadedAssessment {
  id: string;
  firm_id: string;
  engagement_id: string;
  rubric_version_id: string;
  status: 'in_progress' | 'completed';
}

async function loadAssessment(db: pg.ClientBase, assessmentId: string): Promise<LoadedAssessment> {
  const res = await db.query(
    `select id, firm_id, engagement_id, rubric_version_id, status
     from assessments where id = $1`,
    [assessmentId],
  );
  if (res.rowCount === 0) throw new Error(`assessment ${assessmentId} not found`);
  return res.rows[0];
}

async function loadRubric(db: pg.ClientBase, rubricVersionId: string): Promise<Rubric> {
  // sequential on purpose: a single pg client must not run concurrent queries
  const dims = await db.query(
    `select code, name, score_group, drs_weight, sort_order
     from dimensions where rubric_version_id = $1`,
    [rubricVersionId],
  );
  const questions = await db.query(
    `select q.code, d.code as dimension_code, q.prompt, q.answer_type, q.options, q.scored, q.sort_order
     from questions q join dimensions d on d.id = q.dimension_id
     where d.rubric_version_id = $1`,
    [rubricVersionId],
  );
  const subScores = await db.query(
    `select s.code, d.code as dimension_code, s.name, s.weight, s.formula_type,
            s.input_question_codes, s.logic
     from sub_scores s join dimensions d on d.id = s.dimension_id
     where d.rubric_version_id = $1`,
    [rubricVersionId],
  );
  const gapDefs = await db.query(
    `select g.code, g.name, g.severity, d.code as dimension_code, g.trigger
     from gap_definitions g join dimensions d on d.id = g.dimension_id
     where g.rubric_version_id = $1`,
    [rubricVersionId],
  );
  return {
    dimensions: dims.rows.map((r) => ({
      code: r.code,
      name: r.name,
      scoreGroup: r.score_group,
      drsWeight: Number(r.drs_weight),
      sortOrder: r.sort_order,
    })),
    questions: questions.rows.map((r) => ({
      code: r.code,
      dimensionCode: r.dimension_code,
      prompt: r.prompt,
      answerType: r.answer_type,
      options: r.options,
      scored: r.scored,
      sortOrder: r.sort_order,
    })),
    subScores: subScores.rows.map((r) => ({
      code: r.code,
      dimensionCode: r.dimension_code,
      name: r.name,
      weight: Number(r.weight),
      formulaType: r.formula_type,
      inputQuestionCodes: (r.input_question_codes as string).split(',').map((s) => s.trim()),
      logic: r.logic,
      notes: null,
    })),
    gapDefinitions: gapDefs.rows.map((r) => ({
      code: r.code,
      name: r.name,
      severity: r.severity,
      dimensionCode: r.dimension_code,
      trigger: r.trigger as GapTrigger,
    })),
  };
}

async function loadAnswers(db: pg.ClientBase, assessmentId: string): Promise<Answers> {
  const res = await db.query(
    `select q.code, a.value
     from answers a join questions q on q.id = a.question_id
     where a.assessment_id = $1`,
    [assessmentId],
  );
  return Object.fromEntries(res.rows.map((r) => [r.code, r.value]));
}

export async function scoreAssessment(
  db: pg.ClientBase,
  assessmentId: string,
): Promise<ScoreAssessmentResult> {
  const assessment = await loadAssessment(db, assessmentId);
  if (assessment.status === 'completed') {
    throw new Error(
      `assessment ${assessmentId} is completed and immutable; start a new assessment instead`,
    );
  }
  const rubric = await loadRubric(db, assessment.rubric_version_id);
  const answers = await loadAnswers(db, assessmentId);

  const missing = validateCompleteness(rubric, answers);
  if (missing.length > 0) {
    throw new Error(`assessment incomplete: unanswered scored questions: ${missing.join(', ')}`);
  }

  const result = scoreFromAnswers(rubric, answers);

  const subScoreIds = new Map<string, string>(
    (
      await db.query(
        `select s.id, s.code from sub_scores s
         join dimensions d on d.id = s.dimension_id
         where d.rubric_version_id = $1`,
        [assessment.rubric_version_id],
      )
    ).rows.map((r) => [r.code, r.id]),
  );
  const dimensionIds = new Map<string, string>(
    (
      await db.query(`select id, code from dimensions where rubric_version_id = $1`, [
        assessment.rubric_version_id,
      ])
    ).rows.map((r) => [r.code, r.id]),
  );
  const gapDefIds = new Map<string, string>(
    (
      await db.query(`select id, code from gap_definitions where rubric_version_id = $1`, [
        assessment.rubric_version_id,
      ])
    ).rows.map((r) => [r.code, r.id]),
  );

  await db.query('begin');
  try {
    for (const s of result.subScores) {
      await db.query(
        `insert into sub_score_results (assessment_id, sub_score_id, points, computed_inputs)
         values ($1, $2, $3, $4)`,
        [assessmentId, subScoreIds.get(s.code), s.points, JSON.stringify(s.computedInputs)],
      );
    }
    for (const d of result.dimensionScores) {
      await db.query(
        `insert into dimension_scores (assessment_id, dimension_id, score)
         values ($1, $2, $3)`,
        [assessmentId, dimensionIds.get(d.code), d.score],
      );
    }
    await db.query(
      `update assessments
       set status = 'completed', completed_at = now(),
           drs_score = $2, drs_tier = $3, ori_score = $4
       where id = $1`,
      [assessmentId, result.drsScore, result.drsTier, result.oriScore],
    );

    // Gap lifecycle (docs/02 rule 3): open new triggers; resolve open gaps the
    // new assessment no longer triggers.
    const openGaps = await db.query(
      `select g.id, gd.code
       from gaps g join gap_definitions gd on gd.id = g.gap_definition_id
       where g.engagement_id = $1 and g.status in ('open', 'in_remediation')`,
      [assessment.engagement_id],
    );
    const openByCode = new Map<string, string>(openGaps.rows.map((r) => [r.code, r.id]));
    const triggered = new Set(result.gapCodes);

    const gapsOpened: string[] = [];
    for (const code of result.gapCodes) {
      if (!openByCode.has(code)) {
        await db.query(
          `insert into gaps (firm_id, engagement_id, gap_definition_id, opened_by_assessment_id, status)
           values ($1, $2, $3, $4, 'open')`,
          [assessment.firm_id, assessment.engagement_id, gapDefIds.get(code), assessmentId],
        );
        gapsOpened.push(code);
      }
    }
    const gapsResolved: string[] = [];
    for (const [code, gapId] of openByCode) {
      if (!triggered.has(code)) {
        await db.query(
          `update gaps set status = 'resolved', resolved_by_assessment_id = $2 where id = $1`,
          [gapId, assessmentId],
        );
        gapsResolved.push(code);
      }
    }

    await db.query('commit');
    return { ...result, assessmentId, gapsOpened, gapsResolved };
  } catch (err) {
    await db.query('rollback');
    throw err;
  }
}

export async function explainAssessment(
  db: pg.ClientBase,
  assessmentId: string,
): Promise<ExplainResult> {
  const assessment = await loadAssessment(db, assessmentId);
  const rubric = await loadRubric(db, assessment.rubric_version_id);
  const answers = await loadAnswers(db, assessmentId);
  return explainFromAnswers(rubric, answers);
}
