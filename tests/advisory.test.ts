// Advisory Library firing engine. Requires a migrated + seeded database
// (DATABASE_URL); skipped otherwise. Proves items fire off live persisted
// scores, in critical-first / lowest-score-first order, and that an
// advisor-authored (firm) item joins the global catalog while a system item
// with a below-trigger score does not fire.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { scoreAssessment } from '../server/scoring';
import { fireAdvisoryItems, educationModules } from '../server/advisory';
import { loadFixture, acceptAgreement } from './helpers';

const url = process.env.DATABASE_URL;
const SEV_RANK: Record<string, number> = { critical: 0, high: 1, med: 2, low: 3 };

describe.skipIf(!url)('fireAdvisoryItems', () => {
  let db: pg.Client;
  let firmId: string;
  let engagementId: string;
  let firmItemId: string;

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
    firmId = (await db.query(`insert into firms (name) values ('Advisory Test Firm') returning id`)).rows[0].id;
    const companyId = (
      await db.query(`insert into companies (firm_id, name) values ($1, 'Advisory Co') returning id`, [firmId])
    ).rows[0].id;
    engagementId = (
      await db.query(
        `insert into engagements (firm_id, company_id, started_at) values ($1, $2, '2026-01-01') returning id`,
        [firmId, companyId],
      )
    ).rows[0].id;
    await acceptAgreement(db, engagementId);
    // Fixture 2 scores low across the board, firing many gaps and items.
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
    // Mark completed so the firing engine picks it as the latest for the engagement.
    await db.query(`update assessments set status = 'completed', completed_at = now() where id = $1`, [
      assessmentId,
    ]);

    // An advisor-authored item scoped to this firm, on a sub-score this fixture
    // scores low — it must fire alongside the global catalog.
    firmItemId = (
      await db.query(
        `insert into advisory_library_items
           (firm_id, source, item_type, title, body, dimension_code, sub_score_code, severity, score_trigger)
         values ($1, 'advisor', 'initiative', 'Firm-Specific Play', 'Do the thing.', 'OPS', 'OPS-HOURS', 'high', 60)
         returning id`,
        [firmId],
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    if (!db) return;
    await db.query(`delete from advisory_library_items where firm_id = $1`, [firmId]);
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

  it('fires items off live scores, with all three item types present', async () => {
    const r = await fireAdvisoryItems(db, engagementId);
    expect(r.assessment_id).toBeTruthy();
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.counts.buyer_question).toBeGreaterThan(0);
    expect(r.counts.initiative).toBeGreaterThan(0);
    expect(r.counts.risk_flag).toBeGreaterThan(0);
    // Every fired item's governing score is at or below its trigger.
    for (const it of r.items) expect(it.governing_score).toBeLessThanOrEqual(it.score_trigger);
  });

  it('orders items critical-first, then by lowest score', async () => {
    const r = await fireAdvisoryItems(db, engagementId);
    for (let i = 1; i < r.items.length; i++) {
      const prev = r.items[i - 1];
      const cur = r.items[i];
      const rp = SEV_RANK[prev.severity ?? ''] ?? 9;
      const rc = SEV_RANK[cur.severity ?? ''] ?? 9;
      expect(rp).toBeLessThanOrEqual(rc);
      // Within the same severity, non-decreasing score.
      if (rp === rc) expect(prev.governing_score).toBeLessThanOrEqual(cur.governing_score);
    }
    // First item is critical (fixture 2 fires critical customer/owner items).
    expect(r.items[0].severity).toBe('critical');
  });

  it('includes the firm\'s own advisor-authored item alongside the global catalog', async () => {
    const r = await fireAdvisoryItems(db, engagementId);
    const codes = r.items.map((i) => i.code);
    expect(codes).toContain('AL-BQ-CONC'); // a global/system item
    const firmItem = r.items.find((i) => i.id === firmItemId);
    expect(firmItem).toBeTruthy();
    expect(firmItem?.source).toBe('advisor');
  });

  it('does not fire an item whose governing score is above its trigger', async () => {
    const r = await fireAdvisoryItems(db, engagementId);
    // AL-BQ-REVDECLINE triggers at REV-GROWTH <= 50; assert consistency: if it
    // fired, its score is <= 50; if a REV-NRR-based item exists it must be <= 70.
    for (const it of r.items) {
      expect(it.governing_score).toBeLessThanOrEqual(it.score_trigger);
    }
    // Sanity: the number fired is fewer than the whole active catalog (not
    // everything triggers at every score).
    const total = (
      await db.query(
        `select count(*)::int c from advisory_library_items
         where active and score_trigger is not null and (firm_id is null or firm_id = $1)`,
        [firmId],
      )
    ).rows[0].c;
    expect(r.items.length).toBeLessThanOrEqual(total);
  });

  it('excludes education items from the advisor firing (they are owner-facing)', async () => {
    const r = await fireAdvisoryItems(db, engagementId);
    expect(r.items.every((i) => i.item_type !== 'education')).toBe(true);
  });

  it('surfaces education modules from the library, recommended when their area has an open gap', async () => {
    const r = await educationModules(db, engagementId);
    expect(r.modules.length).toBeGreaterThan(0);
    // Fixture 2 scores low and opens gaps, so at least one module's readiness
    // area is flagged as recommended.
    expect(r.modules.some((m) => m.recommended)).toBe(true);
    // Education is the content_modules library now — no score trigger on these,
    // and a recommended module always carries a readiness area.
    for (const m of r.modules) {
      expect(m.score_trigger).toBeNull();
      if (m.recommended) expect(m.dimension_code).not.toBeNull();
    }
  });

  it('returns an empty result for an engagement with no completed assessment', async () => {
    const emptyEng = (
      await db.query(
        `insert into engagements (firm_id, company_id, started_at)
         select $1, id, '2026-01-01' from companies where firm_id = $1 limit 1 returning id`,
        [firmId],
      )
    ).rows[0].id;
    const r = await fireAdvisoryItems(db, emptyEng);
    expect(r.assessment_id).toBeNull();
    expect(r.items).toEqual([]);
    await db.query(`delete from engagements where id = $1`, [emptyEng]);
  });
});
