// Ledger sync (QuickBooks/Xero → assessment answers). Requires a migrated +
// seeded database (DATABASE_URL); skipped otherwise. Proves connecting the books
// fills the ledger-derivable financial answers with connected_ledger provenance,
// is idempotent, and refuses when there's no connection or the assessment is done.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { syncLedgerToAssessment, LEDGER_DERIVABLE_CODES } from '../server/ledger';
import { verificationSummary } from '../server/verification';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('syncLedgerToAssessment', () => {
  let db: pg.Client;
  let firmId: string;
  let companyId: string;
  let assessmentId: string;

  beforeAll(async () => {
    db = new pg.Client({ connectionString: url });
    await db.connect();
    const rubricVersionId = (
      await db.query(`select id from rubric_versions where status = 'active' order by created_at desc limit 1`)
    ).rows[0].id;
    firmId = (await db.query(`insert into firms (name) values ('Ledger Test Firm') returning id`)).rows[0].id;
    companyId = (
      await db.query(`insert into companies (firm_id, name) values ($1, 'Ledger Co') returning id`, [firmId])
    ).rows[0].id;
    const engagementId = (
      await db.query(`insert into engagements (firm_id, company_id) values ($1, $2) returning id`, [firmId, companyId])
    ).rows[0].id;
    assessmentId = (
      await db.query(
        `insert into assessments (firm_id, engagement_id, rubric_version_id, sequence_number, status)
         values ($1, $2, $3, 1, 'in_progress') returning id`,
        [firmId, engagementId, rubricVersionId],
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    if (!db) return;
    await db.query(`delete from answer_provenance where firm_id = $1`, [firmId]);
    await db.query(`delete from answers where assessment_id = $1`, [assessmentId]);
    await db.query(`delete from ledger_connections where firm_id = $1`, [firmId]);
    await db.query(`delete from assessments where firm_id = $1`, [firmId]);
    await db.query(`delete from engagements where firm_id = $1`, [firmId]);
    await db.query(`delete from companies where firm_id = $1`, [firmId]);
    await db.query(`delete from firms where id = $1`, [firmId]);
    await db.end();
  });

  it('refuses to sync without a connected ledger', async () => {
    await expect(syncLedgerToAssessment(db, assessmentId)).rejects.toThrow(/no connected ledger/);
  });

  it('fills the derivable answers with connected_ledger provenance and lifts verification', async () => {
    await db.query(
      `insert into ledger_connections (firm_id, company_id, provider, status, external_org_name, connected_at)
       values ($1, $2, 'quickbooks', 'connected', 'Ledger Co Books', now())`,
      [firmId, companyId],
    );
    const r = await syncLedgerToAssessment(db, assessmentId);
    expect(r.filled).toBe(LEDGER_DERIVABLE_CODES.length);
    expect(r.provider).toBe('quickbooks');

    const answers = (
      await db.query(`select count(*)::int c from answers where assessment_id = $1`, [assessmentId])
    ).rows[0].c;
    expect(answers).toBe(LEDGER_DERIVABLE_CODES.length);

    const v = await verificationSummary(db, assessmentId);
    expect(v.verified_inputs).toBeGreaterThanOrEqual(LEDGER_DERIVABLE_CODES.length);
    expect(v.pct).toBeGreaterThan(0);
  });

  it('is idempotent', async () => {
    const r = await syncLedgerToAssessment(db, assessmentId);
    expect(r.filled).toBe(LEDGER_DERIVABLE_CODES.length);
    const answers = (
      await db.query(`select count(*)::int c from answers where assessment_id = $1`, [assessmentId])
    ).rows[0].c;
    expect(answers).toBe(LEDGER_DERIVABLE_CODES.length); // no duplicates
  });

  it('refuses to modify a completed assessment', async () => {
    await db.query(`update assessments set status = 'completed', completed_at = now() where id = $1`, [assessmentId]);
    await expect(syncLedgerToAssessment(db, assessmentId)).rejects.toThrow(/immutable/);
    await db.query(`update assessments set status = 'in_progress', completed_at = null where id = $1`, [assessmentId]);
  });
});
