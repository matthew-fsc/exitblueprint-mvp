// Roadmap generation (F5). Playbooks are retired: generating the roadmap
// auto-applies every Plan whose content is majority-applicable to the
// engagement's open gaps (server/plans.ts). Applying a Plan is the sole path
// that lays tasks down; each task is tied to a library_task + an applied Plan.
// Requires a migrated + seeded database (DATABASE_URL); skipped otherwise.
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
    // FK order: plan items reference tasks/milestones/plans; tasks & milestones
    // reference plans — so items first, then tasks/milestones, then plans.
    await db.query(
      `delete from engagement_plan_items where engagement_plan_id in (select id from engagement_plans where firm_id = $1)`,
      [firmId],
    );
    await db.query(`delete from tasks where firm_id = $1`, [firmId]);
    await db.query(`delete from roadmap_milestones where firm_id = $1`, [firmId]);
    await db.query(`delete from engagement_plans where firm_id = $1`, [firmId]);
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

  it('creates tasks by auto-applying qualifying Plans, idempotently', async () => {
    const first = await instantiateTasksForGaps(db, engagementId);
    expect(first.tasksCreated).toBeGreaterThan(0);
    expect(first.plansApplied.length).toBeGreaterThan(0);

    const rows = await db.query(
      `select count(*)::int c,
              count(library_task_id)::int with_lt,
              count(distinct library_task_id)::int distinct_lt,
              count(*) filter (where engagement_plan_id is not null)::int planned
       from tasks where engagement_id = $1`,
      [engagementId],
    );
    // Every reported create is a real row; every task belongs to an applied Plan;
    // a library task appears at most once (once-per-engagement idempotency —
    // inline manual-task rows carry a null library_task_id, hence with_lt < c).
    expect(rows.rows[0].c).toBe(first.tasksCreated);
    expect(rows.rows[0].distinct_lt).toBe(rows.rows[0].with_lt);
    expect(rows.rows[0].planned).toBe(rows.rows[0].c);

    const again = await instantiateTasksForGaps(db, engagementId);
    expect(again.tasksCreated).toBe(0); // idempotent — the Plans are already applied
  });

  it('derives due dates from the engagement start + task offset', async () => {
    const t = (
      await db.query(
        `select min(due_date) as earliest from tasks where engagement_id = $1`,
        [engagementId],
      )
    ).rows[0];
    // Every offset is >= 0 (inline manual tasks with no offset land on the anchor),
    // so the earliest due date is on/after the engagement start.
    expect(new Date(t.earliest).getTime()).toBeGreaterThanOrEqual(new Date('2026-01-01').getTime());
  });

  it('auto-applies the remediation Plan a critical gap is linked to', async () => {
    // A critical gap's remediation Plan (gap_plan_map) is applied and its tasks
    // are on the roadmap, tagged with that applied Plan.
    const criticalWithTasks = await db.query(
      `select count(*)::int c
       from gaps g
       join gap_definitions gd on gd.id = g.gap_definition_id
       join gap_plan_map m on m.gap_definition_id = gd.id
       join engagement_plans ep on ep.plan_template_id = m.plan_template_id and ep.engagement_id = g.engagement_id
       join tasks t on t.engagement_plan_id = ep.id
       where g.engagement_id = $1 and gd.severity = 'critical'`,
      [engagementId],
    );
    expect(criticalWithTasks.rows[0].c).toBeGreaterThan(0);
    void SEV_RANK;
  });
});
