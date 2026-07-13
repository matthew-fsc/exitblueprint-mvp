// Ledger sync + honest manual financial entry. Requires a migrated + seeded
// database (DATABASE_URL); skipped otherwise. Proves: a connected ledger no
// longer fabricates figures (the removed DEFAULTS), and the manual-entry path
// records real figures with honest provenance (document = verified when the user
// attests to statements, else self_reported).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { syncLedgerToAssessment, enterManualFinancials, LEDGER_DERIVABLE_CODES } from '../server/ledger';
import { verificationSummary } from '../server/verification';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('ledger sync + manual financials', () => {
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

  it('a connected ledger fabricates nothing until the live API is wired', async () => {
    await db.query(
      `insert into ledger_connections (firm_id, company_id, provider, status, external_org_name, connected_at)
       values ($1, $2, 'quickbooks', 'connected', 'Ledger Co Books', now())`,
      [firmId, companyId],
    );
    const r = await syncLedgerToAssessment(db, assessmentId);
    expect(r.filled).toBe(0); // no invented DEFAULTS
    const answers = (
      await db.query(`select count(*)::int c from answers where assessment_id = $1`, [assessmentId])
    ).rows[0].c;
    expect(answers).toBe(0);
  });

  it('manual entry with attestation records figures as document-verified', async () => {
    const entries = [
      { code: 'REV-ANNUAL', value: [3_000_000, 3_200_000, 3_500_000, 3_800_000] },
      { code: 'REV-TOP5-SHARES', value: [20, 15, 10, 8, 5] },
      { code: 'REV-RECUR-PCT', value: 40 },
      { code: 'FIN-RECON', value: 'monthly' },
      { code: 'FIN-BASIS', value: 'accrual_consistent' },
      { code: 'FIN-STATEMENTS', value: 'all_three' },
    ];
    const r = await enterManualFinancials(db, assessmentId, entries, true);
    expect(r.source).toBe('document');
    expect(r.filled).toBe(LEDGER_DERIVABLE_CODES.length);

    const prov = (
      await db.query(
        `select ap.source, ap.verified_at from answer_provenance ap
         join questions q on q.id = ap.question_id
         where ap.assessment_id = $1 and q.code = 'REV-ANNUAL'`,
        [assessmentId],
      )
    ).rows[0];
    expect(prov.source).toBe('document');
    expect(prov.verified_at).not.toBeNull();

    const v = await verificationSummary(db, assessmentId);
    expect(v.verified_inputs).toBeGreaterThanOrEqual(LEDGER_DERIVABLE_CODES.length);
    expect(v.pct).toBeGreaterThan(0);
  });

  it('manual entry without attestation is self_reported, not verified', async () => {
    const entries = [{ code: 'REV-RECUR-PCT', value: 55 }];
    const r = await enterManualFinancials(db, assessmentId, entries, false);
    expect(r.source).toBe('self_reported');
    const prov = (
      await db.query(
        `select ap.source, ap.verified_at from answer_provenance ap
         join questions q on q.id = ap.question_id
         where ap.assessment_id = $1 and q.code = 'REV-RECUR-PCT'`,
        [assessmentId],
      )
    ).rows[0];
    expect(prov.source).toBe('self_reported'); // downgraded from document by the re-entry
    expect(prov.verified_at).toBeNull();
  });

  it('ignores codes outside the derivable financial set', async () => {
    const r = await enterManualFinancials(db, assessmentId, [{ code: 'NOT-A-FIN-CODE', value: 1 }], true);
    expect(r.filled).toBe(0);
  });

  it('refuses to modify a completed assessment', async () => {
    await db.query(`update assessments set status = 'completed', completed_at = now() where id = $1`, [assessmentId]);
    await expect(enterManualFinancials(db, assessmentId, [{ code: 'REV-RECUR-PCT', value: 1 }], true)).rejects.toThrow(
      /immutable/,
    );
    await expect(syncLedgerToAssessment(db, assessmentId)).rejects.toThrow(/immutable/);
    await db.query(`update assessments set status = 'in_progress', completed_at = null where id = $1`, [assessmentId]);
  });
});
