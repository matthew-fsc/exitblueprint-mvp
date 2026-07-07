// Server-side entry points for the scoring engine (docs/03 contract):
//   scoreAssessment(db, assessment_id)   -> scores + persists in one transaction
//   explainAssessment(db, assessment_id) -> full explain trace, no writes
//   supersedeAssessment(db, old_id, ...) -> correction via new assessment (docs/02)
//   compareAssessments(db, a, b)         -> delta, same-rubric-version only (docs/03)
// Reads answers + rubric for the assessment's rubric_version; writes
// sub_score_results, dimension_scores, the assessment scores, and gap rows.
// Deterministic: no network calls except the database. No LLM involvement.
import type pg from 'pg';
import {
  explainFromAnswers,
  pyRound,
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
  record_status: 'active' | 'superseded';
  sequence_number: number;
}

async function loadAssessment(db: pg.ClientBase, assessmentId: string): Promise<LoadedAssessment> {
  const res = await db.query(
    `select id, firm_id, engagement_id, rubric_version_id, status, record_status, sequence_number
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

// Computes and persists the score for an in_progress assessment. Assumes the
// caller manages the transaction (scoreAssessment and supersedeAssessment wrap
// this in begin/commit).
async function scoreAndPersist(
  db: pg.ClientBase,
  assessment: LoadedAssessment,
): Promise<ScoreAssessmentResult> {
  const rubric = await loadRubric(db, assessment.rubric_version_id);
  const answers = await loadAnswers(db, assessment.id);

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

  for (const s of result.subScores) {
    await db.query(
      `insert into sub_score_results (assessment_id, sub_score_id, points, computed_inputs)
       values ($1, $2, $3, $4)`,
      [assessment.id, subScoreIds.get(s.code), s.points, JSON.stringify(s.computedInputs)],
    );
  }
  for (const d of result.dimensionScores) {
    await db.query(
      `insert into dimension_scores (assessment_id, dimension_id, score)
       values ($1, $2, $3)`,
      [assessment.id, dimensionIds.get(d.code), d.score],
    );
  }
  await db.query(
    `update assessments
     set status = 'completed', completed_at = now(),
         drs_score = $2, drs_tier = $3, ori_score = $4
     where id = $1`,
    [assessment.id, result.drsScore, result.drsTier, result.oriScore],
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
        [assessment.firm_id, assessment.engagement_id, gapDefIds.get(code), assessment.id],
      );
      gapsOpened.push(code);
    }
  }
  const gapsResolved: string[] = [];
  for (const [code, gapId] of openByCode) {
    if (!triggered.has(code)) {
      await db.query(
        `update gaps set status = 'resolved', resolved_by_assessment_id = $2 where id = $1`,
        [gapId, assessment.id],
      );
      gapsResolved.push(code);
    }
  }

  return { ...result, assessmentId: assessment.id, gapsOpened, gapsResolved };
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
  await db.query('begin');
  try {
    const result = await scoreAndPersist(db, assessment);
    await db.query('commit');
    return result;
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

// --- Correction workflow (docs/02: supersede, never edit) ---------------------

export interface SupersedeResult {
  oldAssessmentId: string;
  newAssessmentId: string;
  result: ScoreAssessmentResult;
}

// A correction = a new assessment with corrected answers, scored, with the old
// row marked superseded and linked. The old row's content is never touched.
// One transaction: either the whole correction lands or none of it.
export async function supersedeAssessment(
  db: pg.ClientBase,
  oldAssessmentId: string,
  newAnswers: Answers,
  reason: string,
): Promise<SupersedeResult> {
  const old = await loadAssessment(db, oldAssessmentId);
  if (old.status !== 'completed') {
    throw new Error(`assessment ${oldAssessmentId} is not completed; edit it directly instead`);
  }
  if (old.record_status === 'superseded') {
    throw new Error(`assessment ${oldAssessmentId} is already superseded`);
  }

  const questionIds = new Map<string, string>(
    (
      await db.query(
        `select q.id, q.code from questions q
         join dimensions d on d.id = q.dimension_id
         where d.rubric_version_id = $1`,
        [old.rubric_version_id],
      )
    ).rows.map((r) => [r.code, r.id]),
  );

  await db.query('begin');
  try {
    const nextSequence = (
      await db.query(
        `select coalesce(max(sequence_number), 0) + 1 as next
         from assessments where engagement_id = $1`,
        [old.engagement_id],
      )
    ).rows[0].next;
    const newId = (
      await db.query(
        `insert into assessments (firm_id, engagement_id, rubric_version_id, sequence_number)
         values ($1, $2, $3, $4) returning id`,
        [old.firm_id, old.engagement_id, old.rubric_version_id, nextSequence],
      )
    ).rows[0].id;
    for (const [code, value] of Object.entries(newAnswers)) {
      const questionId = questionIds.get(code);
      if (!questionId) continue; // context codes not in this rubric version
      await db.query(
        `insert into answers (assessment_id, question_id, value) values ($1, $2, $3)`,
        [newId, questionId, JSON.stringify(value)],
      );
    }
    const newAssessment = await loadAssessment(db, newId);
    const result = await scoreAndPersist(db, newAssessment);
    await db.query(
      `update assessments
       set record_status = 'superseded', superseded_by_assessment_id = $2, supersede_reason = $3
       where id = $1`,
      [oldAssessmentId, newId, reason],
    );
    await db.query('commit');
    return { oldAssessmentId, newAssessmentId: newId, result };
  } catch (err) {
    await db.query('rollback');
    throw err;
  }
}

// --- Deltas (docs/03: same rubric_version only) --------------------------------

interface ComparisonSnapshot {
  assessmentId: string;
  drsScore: number;
  drsTier: string;
  oriScore: number;
}

export type AssessmentComparison =
  | {
      comparable: false;
      reason: 'rubric_version_mismatch';
      prior_version: string;
      current_version: string;
    }
  | {
      comparable: true;
      prior: ComparisonSnapshot;
      current: ComparisonSnapshot;
      drsDelta: number;
      oriDelta: number;
      dimensions: { code: string; prior: number; current: number; delta: number }[];
      subScores: { code: string; prior: number; current: number; delta: number }[];
      gapsOpened: string[]; // fired in current but not prior
      gapsResolved: string[]; // fired in prior but not current
    };

// Delta between two completed assessments, prior -> current. Cross-version
// comparison never yields a number: rubrics differ, so the delta is returned
// as an explicit incomparable marker (docs/03 "Deltas and rubric versioning").
export async function compareAssessments(
  db: pg.ClientBase,
  priorAssessmentId: string,
  currentAssessmentId: string,
): Promise<AssessmentComparison> {
  const prior = await loadAssessment(db, priorAssessmentId);
  const current = await loadAssessment(db, currentAssessmentId);
  for (const a of [prior, current]) {
    if (a.status !== 'completed') {
      throw new Error(`assessment ${a.id} is not completed; deltas compare completed snapshots`);
    }
  }

  if (prior.rubric_version_id !== current.rubric_version_id) {
    const labels = new Map<string, string>(
      (
        await db.query(`select id, version_label from rubric_versions where id = any($1)`, [
          [prior.rubric_version_id, current.rubric_version_id],
        ])
      ).rows.map((r) => [r.id, r.version_label]),
    );
    return {
      comparable: false,
      reason: 'rubric_version_mismatch',
      prior_version: labels.get(prior.rubric_version_id)!,
      current_version: labels.get(current.rubric_version_id)!,
    };
  }

  // Recompute from stored answers (deterministic, identical to stored results)
  // so the comparison carries full sub-score and gap detail.
  const rubric = await loadRubric(db, prior.rubric_version_id);
  const priorResult = scoreFromAnswers(rubric, await loadAnswers(db, prior.id));
  const currentResult = scoreFromAnswers(rubric, await loadAnswers(db, current.id));

  const priorSubs = new Map(priorResult.subScores.map((s) => [s.code, s.points]));
  const priorDims = new Map(priorResult.dimensionScores.map((d) => [d.code, d.score]));
  const priorGaps = new Set(priorResult.gapCodes);
  const currentGaps = new Set(currentResult.gapCodes);

  return {
    comparable: true,
    prior: {
      assessmentId: prior.id,
      drsScore: priorResult.drsScore,
      drsTier: priorResult.drsTier,
      oriScore: priorResult.oriScore,
    },
    current: {
      assessmentId: current.id,
      drsScore: currentResult.drsScore,
      drsTier: currentResult.drsTier,
      oriScore: currentResult.oriScore,
    },
    drsDelta: pyRound(currentResult.drsScore - priorResult.drsScore, 1),
    oriDelta: pyRound(currentResult.oriScore - priorResult.oriScore, 1),
    dimensions: currentResult.dimensionScores.map((d) => ({
      code: d.code,
      prior: priorDims.get(d.code)!,
      current: d.score,
      delta: pyRound(d.score - priorDims.get(d.code)!, 2),
    })),
    subScores: currentResult.subScores.map((s) => ({
      code: s.code,
      prior: priorSubs.get(s.code)!,
      current: s.points,
      delta: pyRound(s.points - priorSubs.get(s.code)!, 2),
    })),
    gapsOpened: currentResult.gapCodes.filter((c) => !priorGaps.has(c)),
    gapsResolved: priorResult.gapCodes.filter((c) => !currentGaps.has(c)),
  };
}
