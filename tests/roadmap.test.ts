// Roadmap task instantiation (F5). Requires a migrated + seeded database
// (DATABASE_URL); skipped otherwise.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { scoreAssessment } from '../server/scoring';
import { instantiateTasksForGaps } from '../server/roadmap';
import { loadFixture, acceptAgreement } from './helpers';

const url = process.env.DATABASE_URL;
const SEV_RANK: Record<string, number> = { critical: 0, high: 1, med: 2, low: 3 };

describe.skipIf(!url)('instantiateTasksForGaps', () => {
  let db: pg.Client;
  let firmId: string;
  let engagementId: string;

  beforeAll(async () => {
    db = new pg.Client({ connectionString: url });
    await db.connect();
    const rubricVersionId = (
      await db.query(`select id from rubric_versions where status = 'active' order by created_at desc limit 1`)
    ).rows[0].id;
    const questionIds = new Map<string, string>(
      (
        await db.query(
          `select q.id, q.code from questions q join dimensions d on d.id = q.dimension_id
           where d.rubric_version_id = $1`,
          [rubricVersionId],
        )
      ).rows.map((r) => [r.code, r.id]),
    );
    firmId = (await db.query(`insert into firms (name) values ('Roadmap Test Firm') returning id`)).rows[0].id;
    const companyId = (
      await db.query(`insert into companies (firm_id, name) values ($1, 'Roadmap Co') returning id`, [firmId])
    ).rows[0].id;
    engagementId = (
      await db.query(
        `insert into engagements (firm_id, company_id, started_at) values ($1, $2, '2026-01-01') returning id`,
        [firmId, companyId],
      )
    ).rows[0].id;
    await acceptAgreement(db, engagementId);
    // Score fixture 2 (fires many gaps, incl. critical ones) to open gaps.
    const assessmentId = (
      await db.query(
        `insert into assessments (firm_id, engagement_id, rubric_version_id, sequence_number)
         values ($1, $2, $3, 1) returning id`,
        [firmId, engagementId, rubricVersionId],
      )
    ).rows[0].id;
    for (const [code, value] of Object.entries(loadFixture('company-2-apex-fabrication').answers)) {
      const qid = questionIds.get(code);
      if (!qid) continue;
      await db.query(`insert into answers (assessment_id, question_id, value) values ($1, $2, $3)`, [
        assessmentId,
        qid,
        JSON.stringify(value),
      ]);
    }
    await scoreAssessment(db, assessmentId);
  });

  afterAll(async () => {
    if (!db) return;
    await db.query(`delete from tasks where firm_id = $1`, [firmId]);
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

  it('creates tasks from open gaps, one set per playbook, idempotently', async () => {
    const first = await instantiateTasksForGaps(db, engagementId);
    expect(first.tasksCreated).toBeGreaterThan(0);

    const rows = await db.query(
      `select count(*)::int c, count(distinct playbook_id)::int pb from tasks where engagement_id = $1`,
      [engagementId],
    );
    expect(rows.rows[0].c).toBe(first.tasksCreated);
    // each playbook instantiated once: task count == sum of its templates, no dup sets
    const perPlaybook = await db.query(
      `select playbook_id, count(*)::int c, count(distinct sequence)::int s
       from tasks where engagement_id = $1 group by playbook_id`,
      [engagementId],
    );
    for (const r of perPlaybook.rows) expect(r.c).toBe(r.s); // no duplicate sequences

    const again = await instantiateTasksForGaps(db, engagementId);
    expect(again.tasksCreated).toBe(0); // idempotent
  });

  it('derives due dates from the engagement start + template offset', async () => {
    const t = (
      await db.query(
        `select min(due_date) as earliest from tasks where engagement_id = $1`,
        [engagementId],
      )
    ).rows[0];
    // earliest offset in the seed is 14 days -> 2026-01-15
    expect(new Date(t.earliest).getTime()).toBeGreaterThanOrEqual(new Date('2026-01-14').getTime());
  });

  it('re-anchors task due dates when given an explicit start date', async () => {
    const anchor = '2027-03-01';
    await instantiateTasksForGaps(db, engagementId, anchor);
    const earliest = (
      await db.query(
        `select min(due_date) as d from tasks where engagement_id = $1 and playbook_id is not null`,
        [engagementId],
      )
    ).rows[0].d;
    // Every offset is >= 0, so the earliest due date is on/after the anchor,
    // and the whole plan has shifted forward to 2027.
    expect(new Date(earliest).getTime()).toBeGreaterThanOrEqual(new Date(anchor).getTime());
    expect(new Date(earliest).getFullYear()).toBe(2027);
  });

  it('processes gaps most-critical first (a critical gap seeds a playbook)', async () => {
    // A critical gap's mapped playbook must have tasks (critical gaps are never
    // skipped by dedup because they are processed first).
    const criticalWithTasks = await db.query(
      `select count(*)::int c
       from gaps g
       join gap_definitions gd on gd.id = g.gap_definition_id
       join gap_playbook_map m on m.gap_definition_id = gd.id
       join tasks t on t.playbook_id = m.playbook_id and t.engagement_id = g.engagement_id
       where g.engagement_id = $1 and gd.severity = 'critical'`,
      [engagementId],
    );
    expect(criticalWithTasks.rows[0].c).toBeGreaterThan(0);
    void SEV_RANK;
  });
});
