// In-app "Needs attention" surface (docs/archive/35 Phase 9). Requires a migrated +
// seeded database (DATABASE_URL); skipped otherwise. Proves the firm-scoped
// aggregator surfaces the three signals and is isolated to the caller's firm.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { firmAttention } from '../server/attention';
import { acceptAgreement } from './helpers';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('firmAttention', () => {
  let db: pg.Client;
  let rv: string;
  let firmA: string;
  let firmB: string;
  let engA: string; // firm A: old assessment + overdue task → all three signals
  let engB: string; // firm B: fresh assessment, no tasks → nothing due

  beforeAll(async () => {
    db = new pg.Client({ connectionString: url });
    await db.connect();
    rv = (await db.query(`select id from rubric_versions where status = 'active' limit 1`)).rows[0].id;

    firmA = (await db.query(`insert into firms (name) values ('Attention Firm A') returning id`)).rows[0].id;
    firmB = (await db.query(`insert into firms (name) values ('Attention Firm B') returning id`)).rows[0].id;

    const coA = (await db.query(`insert into companies (firm_id, name) values ($1, 'Alpha Co') returning id`, [firmA])).rows[0].id;
    const coB = (await db.query(`insert into companies (firm_id, name) values ($1, 'Bravo Co') returning id`, [firmB])).rows[0].id;

    // Firm A: engagement started long ago; its only completed assessment is 120
    // days old → reassessment due AND gone quiet (stale).
    engA = (
      await db.query(`insert into engagements (firm_id, company_id, started_at) values ($1, $2, now() - interval '200 days') returning id`, [firmA, coA])
    ).rows[0].id;
    await acceptAgreement(db, engA);
    await db.query(
      `insert into assessments (firm_id, engagement_id, rubric_version_id, sequence_number, status, completed_at, created_at, drs_score, drs_tier)
       values ($1, $2, $3, 1, 'completed', now() - interval '120 days', now() - interval '120 days', 61, 'Needs Work')`,
      [firmA, engA, rv],
    );
    // An open, overdue task → stalled.
    await db.query(
      `insert into tasks (firm_id, engagement_id, title, owner_role, status, due_date, created_at)
       values ($1, $2, 'Document add-backs', 'owner', 'todo', current_date - 10, now() - interval '30 days')`,
      [firmA, engA],
    );

    // Firm B: a fresh completed assessment, recent activity, no tasks → clean.
    engB = (
      await db.query(`insert into engagements (firm_id, company_id) values ($1, $2) returning id`, [firmB, coB])
    ).rows[0].id;
    await acceptAgreement(db, engB);
    await db.query(
      `insert into assessments (firm_id, engagement_id, rubric_version_id, sequence_number, status, completed_at, created_at, drs_score, drs_tier)
       values ($1, $2, $3, 1, 'completed', now(), now(), 80, 'Sale Ready')`,
      [firmB, engB, rv],
    );
  });

  afterAll(async () => {
    if (!db) return;
    for (const f of [firmA, firmB]) {
      await db.query(`delete from tasks where firm_id = $1`, [f]);
      await db.query(`delete from assessments where firm_id = $1`, [f]);
      await db.query(`delete from engagement_agreements where firm_id = $1`, [f]);
      await db.query(`delete from agreement_versions where firm_id = $1`, [f]);
      await db.query(`delete from engagements where firm_id = $1`, [f]);
      await db.query(`delete from companies where firm_id = $1`, [f]);
      await db.query(`delete from firms where id = $1`, [f]);
    }
    await db.end();
  });

  it('surfaces reassessment-due, stalled tasks, and stale engagements for the firm', async () => {
    const a = await firmAttention(db, firmA);
    expect(a.counts.reassessmentDue).toBeGreaterThanOrEqual(1);
    expect(a.counts.stalledTasks).toBeGreaterThanOrEqual(1);
    expect(a.counts.staleEngagements).toBeGreaterThanOrEqual(1);
    expect(a.counts.total).toBe(a.counts.reassessmentDue + a.counts.stalledTasks + a.counts.staleEngagements);

    expect(a.reassessmentDue.map((r) => r.engagementId)).toContain(engA);
    expect(a.reassessmentDue[0].daysSinceLastAssessment).toBeGreaterThanOrEqual(90);
    const task = a.stalledTasks.find((t) => t.engagementId === engA);
    expect(task?.pastDue).toBe(true);
    expect(task?.daysOverdue).toBeGreaterThanOrEqual(10);
    expect(a.staleEngagements.map((s) => s.engagementId)).toContain(engA);
  });

  it('is firm-isolated — firm A signals never leak into firm B', async () => {
    const b = await firmAttention(db, firmB);
    expect(b.reassessmentDue.map((r) => r.engagementId)).not.toContain(engA);
    expect(b.stalledTasks.map((t) => t.engagementId)).not.toContain(engA);
    expect(b.staleEngagements.map((s) => s.engagementId)).not.toContain(engA);
    // Firm B's own engagement is fresh, so nothing is due for it.
    expect(b.counts.total).toBe(0);
  });
});
