// Phase 1 financial verification. Requires a migrated + seeded database
// (DATABASE_URL); skipped otherwise. Proves the summary counts financial inputs,
// reflects recorded provenance, and moves the tier as inputs are verified.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { acceptAgreement } from './helpers';
import { verificationSummary, tierFor } from '../server/verification';

const url = process.env.DATABASE_URL;

describe('tierFor', () => {
  it('maps percentages to tiers at the default thresholds', () => {
    expect(tierFor(0)).toBe('self_reported');
    expect(tierFor(33)).toBe('self_reported');
    expect(tierFor(34)).toBe('partly_verified');
    expect(tierFor(66)).toBe('partly_verified');
    expect(tierFor(67)).toBe('document_verified');
    expect(tierFor(100)).toBe('document_verified');
  });
});

describe.skipIf(!url)('verificationSummary', () => {
  let db: pg.Client;
  let firmId: string;
  let assessmentId: string;

  beforeAll(async () => {
    db = new pg.Client({ connectionString: url });
    await db.connect();
    const rubricVersionId = (
      await db.query(`select id from rubric_versions where status = 'active' order by created_at desc limit 1`)
    ).rows[0].id;
    firmId = (await db.query(`insert into firms (name) values ('Verif Test Firm') returning id`)).rows[0].id;
    const companyId = (
      await db.query(`insert into companies (firm_id, name) values ($1, 'Verif Co') returning id`, [firmId])
    ).rows[0].id;
    const engagementId = (
      await db.query(`insert into engagements (firm_id, company_id) values ($1, $2) returning id`, [firmId, companyId])
    ).rows[0].id;
    await acceptAgreement(db, engagementId);
    assessmentId = (
      await db.query(
        `insert into assessments (firm_id, engagement_id, rubric_version_id, sequence_number, status, completed_at)
         values ($1, $2, $3, 1, 'completed', now()) returning id`,
        [firmId, engagementId, rubricVersionId],
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    if (!db) return;
    await db.query(`delete from answer_provenance where firm_id = $1`, [firmId]);
    await db.query(`delete from assessments where firm_id = $1`, [firmId]);
    await db.query(`delete from engagement_agreements where firm_id = $1`, [firmId]);
    await db.query(`delete from engagements where firm_id = $1`, [firmId]);
    await db.query(`delete from companies where firm_id = $1`, [firmId]);
    await db.query(`delete from agreement_versions where firm_id = $1`, [firmId]);
    await db.query(`delete from firms where id = $1`, [firmId]);
    await db.end();
  });

  it('starts fully self-reported with a non-empty financial input set', async () => {
    const s = await verificationSummary(db, assessmentId);
    expect(s.total_inputs).toBeGreaterThan(0);
    expect(s.verified_inputs).toBe(0);
    expect(s.pct).toBe(0);
    expect(s.tier).toBe('self_reported');
    // every input is a scored FIN or REV question
    expect(s.inputs.every((i) => i.dimension_code === 'FIN' || i.dimension_code === 'REV')).toBe(true);
  });

  it('counts document/ledger provenance as verified and lifts the tier', async () => {
    const before = await verificationSummary(db, assessmentId);
    // Verify enough inputs to clear the document-verified threshold.
    const toVerify = before.inputs.slice(0, Math.ceil(before.total_inputs * 0.7));
    for (const [i, inp] of toVerify.entries()) {
      await db.query(
        `insert into answer_provenance (firm_id, assessment_id, question_id, source, verified_at)
         values ($1, $2, $3, $4, now())
         on conflict (assessment_id, question_id) do update set source = excluded.source`,
        [firmId, assessmentId, inp.question_id, i % 2 === 0 ? 'document' : 'connected_ledger'],
      );
    }
    const after = await verificationSummary(db, assessmentId);
    expect(after.verified_inputs).toBe(toVerify.length);
    expect(after.pct).toBeGreaterThanOrEqual(67);
    expect(after.tier).toBe('document_verified');

    // self_reported provenance does NOT count as verified.
    await db.query(
      `update answer_provenance set source = 'self_reported'
       where assessment_id = $1 and question_id = $2`,
      [assessmentId, toVerify[0].question_id],
    );
    const reset = await verificationSummary(db, assessmentId);
    expect(reset.verified_inputs).toBe(toVerify.length - 1);
  });
});
