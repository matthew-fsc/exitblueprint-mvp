// S4.5: correction workflow (supersede) and delta semantics (compareAssessments).
// Requires a migrated + seeded database (DATABASE_URL); skipped otherwise.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { compareAssessments, scoreAssessment, supersedeAssessment } from '../server/scoring';
import type { Answers } from '../shared/scoring/types';
import { loadFixture, acceptAgreement } from './helpers';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('supersedeAssessment and compareAssessments', () => {
  let db: pg.Client;
  let firmId: string;
  let engagementId: string;
  let rubricVersionId: string;
  let questionIds: Map<string, string>;
  let sequence = 0;

  const createScoredAssessment = async (answers: Answers): Promise<string> => {
    sequence++;
    const assessmentId = (
      await db.query(
        `insert into assessments (firm_id, engagement_id, rubric_version_id, sequence_number)
         values ($1, $2, $3, $4) returning id`,
        [firmId, engagementId, rubricVersionId, sequence],
      )
    ).rows[0].id;
    for (const [code, value] of Object.entries(answers)) {
      const questionId = questionIds.get(code);
      if (!questionId) continue;
      await db.query(
        `insert into answers (assessment_id, question_id, value) values ($1, $2, $3)`,
        [assessmentId, questionId, JSON.stringify(value)],
      );
    }
    await scoreAssessment(db, assessmentId);
    return assessmentId;
  };

  beforeAll(async () => {
    db = new pg.Client({ connectionString: url });
    await db.connect();
    rubricVersionId = (
      await db.query(
        `select id from rubric_versions where status = 'active' order by created_at desc limit 1`,
      )
    ).rows[0].id;
    questionIds = new Map(
      (
        await db.query(
          `select q.id, q.code from questions q
           join dimensions d on d.id = q.dimension_id
           where d.rubric_version_id = $1`,
          [rubricVersionId],
        )
      ).rows.map((r) => [r.code, r.id]),
    );
    firmId = (
      await db.query(`insert into firms (name) values ('Supersede Test Firm') returning id`)
    ).rows[0].id;
    const companyId = (
      await db.query(
        `insert into companies (firm_id, name) values ($1, 'Supersede Test Co') returning id`,
        [firmId],
      )
    ).rows[0].id;
    engagementId = (
      await db.query(
        `insert into engagements (firm_id, company_id) values ($1, $2) returning id`,
        [firmId, companyId],
      )
    ).rows[0].id;
    await acceptAgreement(db, engagementId);
  });

  afterAll(async () => {
    if (!db) return;
    for (const table of ['sub_score_results', 'dimension_scores', 'answers']) {
      await db.query(
        `delete from ${table} where assessment_id in (select id from assessments where firm_id = $1)`,
        [firmId],
      );
    }
    await db.query(`delete from gaps where firm_id = $1`, [firmId]);
    await db.query(`update assessments set superseded_by_assessment_id = null where firm_id = $1`, [firmId]);
    await db.query(`delete from assessments where firm_id = $1`, [firmId]);
    await db.query(
      `delete from assessments where rubric_version_id in
         (select id from rubric_versions where version_label = 'DRS-TEST-NEXT')`,
    );
    await db.query(`delete from rubric_versions where version_label = 'DRS-TEST-NEXT'`);
    await db.query(`delete from engagement_agreements where firm_id = $1`, [firmId]);
    await db.query(`delete from engagements where firm_id = $1`, [firmId]);
    await db.query(`delete from companies where firm_id = $1`, [firmId]);
    await db.query(`delete from agreement_versions where firm_id = $1`, [firmId]);
    await db.query(`delete from firms where id = $1`, [firmId]);
    await db.end();
  });

  it('supersedes a completed assessment without touching its content', async () => {
    const fixture3 = loadFixture('company-3-harborview-staffing');
    const fixture1 = loadFixture('company-1-meridian-managed-it');
    const oldId = await createScoredAssessment(fixture3.answers);
    const oldBefore = (
      await db.query(
        `select drs_score, drs_tier, ori_score, completed_at,
                (select count(*)::int from answers where assessment_id = $1) as answer_count
         from assessments where id = $1`,
        [oldId],
      )
    ).rows[0];

    const { newAssessmentId, result } = await supersedeAssessment(
      db,
      oldId,
      fixture1.answers,
      'data entry error: wrong company financials',
    );
    sequence++; // supersede consumed the next sequence number

    // new assessment scores correctly
    expect(result.drsScore).toBe(fixture1.expected.drs);
    expect(result.drsTier).toBe(fixture1.expected.tier);

    // old row: content unchanged, marked superseded, linked
    const oldAfter = (
      await db.query(
        `select record_status, superseded_by_assessment_id, supersede_reason,
                drs_score, drs_tier, ori_score, completed_at,
                (select count(*)::int from answers where assessment_id = $1) as answer_count
         from assessments where id = $1`,
        [oldId],
      )
    ).rows[0];
    expect(oldAfter.record_status).toBe('superseded');
    expect(oldAfter.superseded_by_assessment_id).toBe(newAssessmentId);
    expect(oldAfter.supersede_reason).toMatch(/data entry error/);
    expect(Number(oldAfter.drs_score)).toBe(fixture3.expected.drs);
    expect(oldAfter.drs_tier).toBe(oldBefore.drs_tier);
    expect(oldAfter.ori_score).toBe(oldBefore.ori_score);
    expect(oldAfter.completed_at).toEqual(oldBefore.completed_at);
    expect(oldAfter.answer_count).toBe(oldBefore.answer_count);

    // longitudinal read path excludes the superseded row
    const active = await db.query(
      `select id from active_assessments where engagement_id = $1`,
      [engagementId],
    );
    const activeIds = active.rows.map((r) => r.id);
    expect(activeIds).toContain(newAssessmentId);
    expect(activeIds).not.toContain(oldId);

    // a superseded assessment cannot be superseded again
    await expect(supersedeAssessment(db, oldId, fixture1.answers, 'x')).rejects.toThrow(
      /already superseded/,
    );
  });

  it('computes a same-version delta between two assessments', async () => {
    const fixture2 = loadFixture('company-2-apex-fabrication');
    const fixture1 = loadFixture('company-1-meridian-managed-it');
    const priorId = await createScoredAssessment(fixture2.answers);
    const currentId = await createScoredAssessment(fixture1.answers);

    const cmp = await compareAssessments(db, priorId, currentId);
    if (!cmp.comparable) throw new Error('expected comparable delta');
    expect(cmp.prior.drsScore).toBe(fixture2.expected.drs);
    expect(cmp.current.drsScore).toBe(fixture1.expected.drs);
    expect(cmp.drsDelta).toBe(
      Number((fixture1.expected.drs - fixture2.expected.drs).toFixed(1)),
    );
    expect(cmp.dimensions).toHaveLength(6);
    for (const d of cmp.dimensions) {
      expect(d.delta).toBe(Number((d.current - d.prior).toFixed(2)));
      expect(d.prior).toBe(fixture2.expected.dimension_scores[d.code]);
      expect(d.current).toBe(fixture1.expected.dimension_scores[d.code]);
    }
    // fixture 2 fires every gap fixture 1 doesn't: all resolved, none opened
    expect(cmp.gapsResolved.sort()).toEqual(fixture2.expected.gaps);
    expect(cmp.gapsOpened).toEqual([]);
  });

  it('returns an incomparable marker across rubric versions, never a number', async () => {
    const fixture1 = loadFixture('company-1-meridian-managed-it');
    const currentId = await createScoredAssessment(fixture1.answers);
    const otherVersionId = (
      await db.query(
        `insert into rubric_versions (version_label, status) values ('DRS-TEST-NEXT', 'draft')
         returning id`,
      )
    ).rows[0].id;
    sequence++;
    const otherAssessmentId = (
      await db.query(
        `insert into assessments (firm_id, engagement_id, rubric_version_id, sequence_number,
                                  status, completed_at, drs_score, drs_tier, ori_score)
         values ($1, $2, $3, $4, 'completed', now(), 50, 'High Risk', 50) returning id`,
        [firmId, engagementId, otherVersionId, sequence],
      )
    ).rows[0].id;

    const cmp = await compareAssessments(db, otherAssessmentId, currentId);
    expect(cmp.comparable).toBe(false);
    if (cmp.comparable) throw new Error('unreachable');
    expect(cmp.reason).toBe('rubric_version_mismatch');
    expect(cmp.prior_version).toBe('DRS-TEST-NEXT');
    expect(cmp.current_version).toBe('DRS-2.0');
    expect(cmp).not.toHaveProperty('drsDelta');
  });
});
