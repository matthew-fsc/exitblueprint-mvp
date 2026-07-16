// Integration tests for the db-backed scoreAssessment/explainAssessment.
// Requires a migrated + seeded database (DATABASE_URL); skipped otherwise.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { explainAssessment, scoreAssessment } from '../server/scoring';
import type { Answers } from '../shared/scoring/types';
import { loadFixture, acceptAgreement } from './helpers';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('scoreAssessment against the database', () => {
  let db: pg.Client;
  let firmId: string;
  let engagementId: string;
  let rubricVersionId: string;
  let questionIds: Map<string, string>;
  let sequence = 0;

  const createAssessment = async (answers: Answers): Promise<string> => {
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
      if (!questionId) continue; // context answer codes not in rubric
      await db.query(
        `insert into answers (assessment_id, question_id, value) values ($1, $2, $3)`,
        [assessmentId, questionId, JSON.stringify(value)],
      );
    }
    return assessmentId;
  };

  beforeAll(async () => {
    db = new pg.Client({ connectionString: url });
    await db.connect();
    rubricVersionId = (
      await db.query(`select id from rubric_versions where status = 'active' order by created_at desc limit 1`)
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
      await db.query(`insert into firms (name) values ('Engine Test Firm') returning id`)
    ).rows[0].id;
    const companyId = (
      await db.query(
        `insert into companies (firm_id, name) values ($1, 'Engine Test Co') returning id`,
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
    await db.query(`delete from assessments where firm_id = $1`, [firmId]);
    await db.query(`delete from engagement_agreements where firm_id = $1`, [firmId]);
    await db.query(`delete from engagements where firm_id = $1`, [firmId]);
    await db.query(`delete from companies where firm_id = $1`, [firmId]);
    await db.query(`delete from agreement_versions where firm_id = $1`, [firmId]);
    await db.query(`delete from firms where id = $1`, [firmId]);
    await db.end();
  });

  it('reproduces fixture 2 exactly and opens its gaps', async () => {
    const fixture = loadFixture('company-2-apex-fabrication');
    const assessmentId = await createAssessment(fixture.answers);
    const result = await scoreAssessment(db, assessmentId);

    expect(result.drsScore).toBe(fixture.expected.drs);
    expect(result.drsTier).toBe(fixture.expected.tier);
    expect(result.oriScore).toBe(fixture.expected.owner_readiness_index);
    expect(result.gapCodes).toEqual(fixture.expected.gaps);
    expect(result.gapsOpened).toEqual(fixture.expected.gaps);
    expect(result.flags).toEqual(fixture.expected.flags);

    const row = (
      await db.query(`select status, drs_score, drs_tier, ori_score from assessments where id = $1`, [assessmentId])
    ).rows[0];
    expect(row.status).toBe('completed');
    expect(Number(row.drs_score)).toBe(fixture.expected.drs);
    const counts = (
      await db.query(
        `select (select count(*)::int from sub_score_results where assessment_id = $1) as subs,
                (select count(*)::int from dimension_scores where assessment_id = $1) as dims`,
        [assessmentId],
      )
    ).rows[0];
    expect(counts.subs).toBe(Object.keys(fixture.expected.sub_scores).length + 6); // + ORI sub-scores
    expect(counts.dims).toBe(Object.keys(fixture.expected.dimension_scores).length);

    const openGaps = await db.query(
      `select gd.code from gaps g join gap_definitions gd on gd.id = g.gap_definition_id
       where g.engagement_id = $1 and g.status = 'open'`,
      [engagementId],
    );
    // sort in JS: db collation (e.g. en_US.utf8) orders '_' differently than
    // the byte-order sort the reference scorer and fixtures use
    expect(openGaps.rows.map((r) => r.code).sort()).toEqual(fixture.expected.gaps);

    // immutability: a completed assessment cannot be rescored
    await expect(scoreAssessment(db, assessmentId)).rejects.toThrow(/immutable/);

    // explain still works on the completed (immutable) assessment
    const explain = await explainAssessment(db, assessmentId);
    expect(explain.drsScore).toBe(fixture.expected.drs);
    expect(explain.firedGaps.map((g) => g.code).sort()).toEqual(fixture.expected.gaps);
  });

  it('is deterministic and resolves gaps when a re-assessment clears them', async () => {
    const fixture2 = loadFixture('company-2-apex-fabrication');
    const again = await scoreAssessment(db, await createAssessment(fixture2.answers));
    // identical inputs -> identical outputs (fresh assessment, same engagement)
    expect(again.drsScore).toBe(fixture2.expected.drs);
    expect(again.subScores).toEqual(
      (await scoreAssessment(db, await createAssessment(fixture2.answers))).subScores,
    );
    expect(again.gapsOpened).toEqual([]); // gaps already open, not duplicated

    // re-assess with healthy answers: previously open gaps resolve
    const fixture1 = loadFixture('company-1-meridian-managed-it');
    const healthy = await scoreAssessment(db, await createAssessment(fixture1.answers));
    expect(healthy.gapCodes).toEqual([]);
    expect(healthy.gapsResolved.sort()).toEqual(fixture2.expected.gaps);
    const stillOpen = await db.query(
      `select count(*)::int as c from gaps where engagement_id = $1 and status = 'open'`,
      [engagementId],
    );
    expect(stillOpen.rows[0].c).toBe(0);
  });

  it('rejects an incomplete assessment', async () => {
    const { 'REV-NRR': _omitted, ...incomplete } = loadFixture('company-1-meridian-managed-it').answers;
    const assessmentId = await createAssessment(incomplete);
    await expect(scoreAssessment(db, assessmentId)).rejects.toThrow(/REV-NRR/);
  });
});
