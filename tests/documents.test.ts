// Beta Requirement 3: document intake + manual review. Requires a migrated DB
// (DATABASE_URL); skipped otherwise. Proves the acceptance criterion — a document
// goes from upload to verified fact through the MANUAL review path — plus reviewer
// access, correction logging, the binary source fetch, and firm isolation.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { acceptAgreement } from './helpers';
import { handleFunctionCall, type FunctionContext } from '../server/functions';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('document intake + review (portable router)', () => {
  let pool: pg.Pool;
  let service: pg.Client;
  let firmId: string;
  let otherFirmId: string;
  let advisorUserId: string;
  let reviewerUserId: string;
  let otherAdvisorUserId: string;
  let engagementId: string;

  const asUserWith =
    (claims: Record<string, unknown>) =>
    async <T>(fn: (db: pg.ClientBase) => Promise<T>): Promise<T> => {
      const c = await pool.connect();
      try {
        await c.query('begin');
        await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
        await c.query('set local role authenticated');
        const out = await fn(c);
        await c.query('commit');
        return out;
      } catch (e) {
        await c.query('rollback').catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    };
  const ctxFor = (userId: string): FunctionContext => ({
    userId,
    asUser: (fn) => asUserWith({ sub: userId, role: 'authenticated' })(fn),
    service,
  });

  const mkUser = async (email: string) =>
    (await service.query(`insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`, [email]))
      .rows[0].id as string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    service = new pg.Client({ connectionString: url });
    await service.connect();

    firmId = (await service.query(`insert into firms (name) values ('Docs Firm') returning id`)).rows[0].id;
    otherFirmId = (await service.query(`insert into firms (name) values ('Other Firm') returning id`)).rows[0].id;
    advisorUserId = await mkUser('docs.adv@test.co');
    reviewerUserId = await mkUser('docs.rev@test.co');
    otherAdvisorUserId = await mkUser('other.adv@test.co');
    await service.query(
      `insert into profiles (user_id, firm_id, role, full_name) values
         ($1, $2, 'advisor', 'Docs Advisor'),
         ($3, $2, 'reviewer', 'Docs Reviewer'),
         ($4, $5, 'advisor', 'Other Advisor')`,
      [advisorUserId, firmId, reviewerUserId, otherAdvisorUserId, otherFirmId],
    );
    const companyId = (
      await service.query(`insert into companies (firm_id, name) values ($1, 'Docs Co') returning id`, [firmId])
    ).rows[0].id;
    engagementId = (
      await service.query(`insert into engagements (firm_id, company_id) values ($1, $2) returning id`, [firmId, companyId])
    ).rows[0].id;
    await acceptAgreement(service, engagementId);
  });

  afterAll(async () => {
    if (service) {
      await service.query(`delete from data_access_log where firm_id = any($1)`, [[firmId, otherFirmId]]);
      await service.query(`delete from field_corrections where firm_id = any($1)`, [[firmId, otherFirmId]]);
      await service.query(`delete from document_fields where firm_id = any($1)`, [[firmId, otherFirmId]]);
      await service.query(`delete from document_blobs where firm_id = any($1)`, [[firmId, otherFirmId]]);
      await service.query(`delete from documents where firm_id = any($1)`, [[firmId, otherFirmId]]);
      await service.query(`delete from engagement_agreements where firm_id = $1`, [firmId]);
      await service.query(`delete from engagements where firm_id = $1`, [firmId]);
      await service.query(`delete from agreement_versions where firm_id = $1`, [firmId]);
      await service.query(`delete from companies where firm_id = $1`, [firmId]);
      await service.query(`delete from profiles where firm_id = any($1)`, [[firmId, otherFirmId]]);
      await service.query(`delete from auth.users where id = any($1)`, [
        [advisorUserId, reviewerUserId, otherAdvisorUserId],
      ]);
      await service.query(`delete from firms where id = any($1)`, [[firmId, otherFirmId]]);
      await service.end();
    }
    if (pool) await pool.end();
  });

  const uploadDoc = async (userId: string, category = 'Financials') => {
    const content_base64 = Buffer.from('%PDF-1.4 fake financials\n').toString('base64');
    return handleFunctionCall(
      'upload-document',
      {
        engagement_id: engagementId,
        category,
        filename: 'financials.pdf',
        mime_type: 'application/pdf',
        content_base64,
      },
      ctxFor(userId),
    );
  };

  it('advisor uploads → document lands in the review queue (manual adapter extracts nothing)', async () => {
    const r = await uploadDoc(advisorUserId);
    expect(r.kind).toBe('json');
    if (r.kind !== 'json') return;
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'in_review', fields_extracted: 0 });
  });

  it('reviewer sees the queue and can fetch the source bytes', async () => {
    const q = await handleFunctionCall('list-review-queue', {}, ctxFor(reviewerUserId));
    expect(q.kind).toBe('json');
    if (q.kind !== 'json') return;
    const items = (q.body as { items: { document_id: string }[] }).items;
    expect(items.length).toBeGreaterThanOrEqual(1);

    const bin = await handleFunctionCall('get-document', { document_id: items[0].document_id }, ctxFor(reviewerUserId));
    expect(bin.kind).toBe('binary');
    if (bin.kind === 'binary') {
      expect(bin.mime).toBe('application/pdf');
      expect(bin.buffer.length).toBeGreaterThan(0);
    }
  });

  it('manual path: reviewer adds a fact and verifies → document becomes a verified fact', async () => {
    const up = await uploadDoc(advisorUserId, 'Operations');
    const documentId = (up.kind === 'json' && (up.body as { document_id: string }).document_id) as string;

    const r = await handleFunctionCall(
      'submit-document-review',
      { document_id: documentId, verify: true, fields: [{ field_key: 'Revenue FY24', value: '4200000' }] },
      ctxFor(reviewerUserId),
    );
    expect(r).toMatchObject({ kind: 'json', status: 200 });

    const doc = (await service.query(`select status from documents where id = $1`, [documentId])).rows[0];
    expect(doc.status).toBe('verified');
    const field = (
      await service.query(`select value, verification_status from document_fields where document_id = $1`, [documentId])
    ).rows[0];
    expect(field).toMatchObject({ value: '4200000', verification_status: 'verified' });
  });

  it('correcting an extracted value logs a field_correction for parser accuracy', async () => {
    const up = await uploadDoc(advisorUserId, 'Financials');
    const documentId = (up.kind === 'json' && (up.body as { document_id: string }).document_id) as string;
    // Simulate a parser having extracted a (wrong) value to be corrected.
    const fieldId = (
      await service.query(
        `insert into document_fields (firm_id, document_id, field_key, value, verification_status, confidence)
         values ($1, $2, 'EBITDA FY24', '900000', 'extracted', 0.6) returning id`,
        [firmId, documentId],
      )
    ).rows[0].id;

    await handleFunctionCall(
      'submit-document-review',
      { document_id: documentId, verify: true, fields: [{ id: fieldId, field_key: 'EBITDA FY24', value: '1000000' }] },
      ctxFor(reviewerUserId),
    );

    const corr = (
      await service.query(`select original_value, corrected_value from field_corrections where document_field_id = $1`, [
        fieldId,
      ])
    ).rows[0];
    expect(corr).toMatchObject({ original_value: '900000', corrected_value: '1000000' });
    const field = (await service.query(`select verification_status from document_fields where id = $1`, [fieldId])).rows[0];
    expect(field.verification_status).toBe('verified');
  });

  it('firm isolation: another firm’s advisor cannot open the document (404)', async () => {
    const q = await handleFunctionCall('list-review-queue', {}, ctxFor(reviewerUserId));
    const anyDocId = q.kind === 'json' ? (q.body as { items: { document_id: string }[] }).items[0].document_id : '';
    const r = await handleFunctionCall('get-document-detail', { document_id: anyDocId }, ctxFor(otherAdvisorUserId));
    expect(r).toMatchObject({ kind: 'json', status: 404 });
  });

  it('rejects a non-staff (owner) caller (403)', async () => {
    const ownerUserId = await mkUser('docs.owner@test.co');
    const companyId = (await service.query(`select company_id from engagements where id = $1`, [engagementId])).rows[0].company_id;
    await service.query(
      `insert into profiles (user_id, firm_id, role, company_id, full_name) values ($1, $2, 'owner', $3, 'Docs Owner')`,
      [ownerUserId, firmId, companyId],
    );
    const r = await handleFunctionCall('list-review-queue', {}, ctxFor(ownerUserId));
    expect(r).toMatchObject({ kind: 'json', status: 403 });
    await service.query(`delete from profiles where user_id = $1`, [ownerUserId]);
    await service.query(`delete from auth.users where id = $1`, [ownerUserId]);
  });
});
