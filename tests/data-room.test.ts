// Data Room Readiness (docs/15, work stream B) through the portable function
// router. Requires a migrated + seeded DB (DATABASE_URL); skipped otherwise.
// Proves: the seeded template loads, a state upsert flows through the router and
// updates the readiness summary, an invalid state and a foreign-engagement
// document are rejected, an owner can maintain their own company's data room,
// and a foreign advisor is blocked by RLS.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { handleFunctionCall, type FunctionContext, type FunctionResult } from '../server/functions';

const url = process.env.DATABASE_URL;
const body = (r: FunctionResult) => r as { kind: 'json'; status: number; body: any };

describe.skipIf(!url)('data room readiness (router)', () => {
  let pool: pg.Pool;
  let service: pg.Client;
  let firmId: string;
  let otherFirmId: string;
  let advisorUserId: string;
  let otherAdvisorUserId: string;
  let ownerUserId: string;
  let engagementId: string;
  let otherEngagementId: string;
  let foreignDocId: string;

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

    firmId = (await service.query(`insert into firms (name) values ('Data Room Firm') returning id`)).rows[0].id;
    otherFirmId = (await service.query(`insert into firms (name) values ('Other DR Firm') returning id`)).rows[0].id;
    advisorUserId = await mkUser('dr.adv@test.co');
    otherAdvisorUserId = await mkUser('dr.other@test.co');
    ownerUserId = await mkUser('dr.owner@test.co');

    const companyId = (
      await service.query(`insert into companies (firm_id, name) values ($1, 'DR Co') returning id`, [firmId])
    ).rows[0].id;
    engagementId = (
      await service.query(`insert into engagements (firm_id, company_id) values ($1, $2) returning id`, [firmId, companyId])
    ).rows[0].id;
    otherEngagementId = (
      await service.query(`insert into engagements (firm_id, company_id) values ($1, $2) returning id`, [firmId, companyId])
    ).rows[0].id;

    await service.query(
      `insert into profiles (user_id, firm_id, role, full_name) values
         ($1, $2, 'advisor', 'DR Advisor'), ($3, $4, 'advisor', 'Other Advisor')`,
      [advisorUserId, firmId, otherAdvisorUserId, otherFirmId],
    );
    await service.query(
      `insert into profiles (user_id, firm_id, role, company_id, full_name)
       values ($1, $2, 'owner', $3, 'DR Owner')`,
      [ownerUserId, firmId, companyId],
    );

    // A document that belongs to the OTHER engagement, for the cross-engagement
    // link-rejection check.
    foreignDocId = (
      await service.query(
        `insert into documents (firm_id, engagement_id, original_filename, mime_type, status)
         values ($1, $2, 'other.pdf', 'application/pdf', 'uploaded') returning id`,
        [firmId, otherEngagementId],
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    await service?.end();
    await pool?.end();
  });

  it('lists the seeded template with all items not_started', async () => {
    const r = body(await handleFunctionCall('list-data-room', { engagement_id: engagementId }, ctxFor(advisorUserId)));
    expect(r.status).toBe(200);
    expect(r.body.sections.length).toBe(7);
    expect(r.body.items.length).toBe(37);
    expect(r.body.items.every((i: any) => i.readiness_state === 'not_started')).toBe(true);
    expect(r.body.summary.total).toBe(37);
    expect(r.body.summary.readiness_pct).toBe(0);
    // Items that map to a scored gap carry that gap's code (shared taxonomy).
    const conc = r.body.items.find((i: any) => i.item_code === 'CUS-CONC');
    expect(conc.gap_code).toBe('CUST_CONC');
  });

  it('upserts a readiness state and reflects it in the summary', async () => {
    const set = body(
      await handleFunctionCall(
        'set-data-room-item',
        { engagement_id: engagementId, item_code: 'FIN-STMTS', readiness_state: 'ready', note: 'have 36 months' },
        ctxFor(advisorUserId),
      ),
    );
    expect(set.status).toBe(200);
    expect(set.body.readiness_state).toBe('ready');
    expect(set.body.note).toBe('have 36 months');

    const list = body(await handleFunctionCall('list-data-room', { engagement_id: engagementId }, ctxFor(advisorUserId)));
    expect(list.body.summary.ready).toBe(1);
    // 1 ready of 37 in-scope items → round(1/37*100) = 3.
    expect(list.body.summary.readiness_pct).toBe(3);
    const stmts = list.body.items.find((i: any) => i.item_code === 'FIN-STMTS');
    expect(stmts.readiness_state).toBe('ready');
    expect(stmts.note).toBe('have 36 months');
  });

  it('re-upserting the same item updates in place (not_applicable leaves scope)', async () => {
    await handleFunctionCall(
      'set-data-room-item',
      { engagement_id: engagementId, item_code: 'PIP-CERT', readiness_state: 'not_applicable' },
      ctxFor(advisorUserId),
    );
    const list = body(await handleFunctionCall('list-data-room', { engagement_id: engagementId }, ctxFor(advisorUserId)));
    expect(list.body.summary.not_applicable).toBe(1);
    // Ready share is of in-scope items only: 1 ready / 36 in scope → 3.
    expect(list.body.summary.readiness_pct).toBe(3);
  });

  it('rejects an invalid readiness state', async () => {
    const r = body(
      await handleFunctionCall(
        'set-data-room-item',
        { engagement_id: engagementId, item_code: 'FIN-STMTS', readiness_state: 'done' },
        ctxFor(advisorUserId),
      ),
    );
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/invalid readiness_state/);
  });

  it('rejects an unknown item code', async () => {
    const r = body(
      await handleFunctionCall(
        'set-data-room-item',
        { engagement_id: engagementId, item_code: 'NOPE', readiness_state: 'ready' },
        ctxFor(advisorUserId),
      ),
    );
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/unknown data room item/);
  });

  it('rejects linking a document from another engagement', async () => {
    const r = body(
      await handleFunctionCall(
        'set-data-room-item',
        { engagement_id: engagementId, item_code: 'FIN-STMTS', readiness_state: 'ready', document_id: foreignDocId },
        ctxFor(advisorUserId),
      ),
    );
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/document does not belong/);
  });

  it('lets an owner maintain their own company data room', async () => {
    const r = body(
      await handleFunctionCall(
        'set-data-room-item',
        { engagement_id: engagementId, item_code: 'LEG-IPREG', readiness_state: 'in_progress' },
        ctxFor(ownerUserId),
      ),
    );
    expect(r.status).toBe(200);
    expect(r.body.readiness_state).toBe('in_progress');
  });

  it('attaches an uploaded document to an item, tags it, and advances it', async () => {
    const r = body(
      await handleFunctionCall(
        'attach-data-room-document',
        {
          engagement_id: engagementId,
          item_code: 'FIN-RECON',
          filename: 'recs.pdf',
          mime_type: 'application/pdf',
          content_base64: Buffer.from('reconciliations').toString('base64'),
        },
        ctxFor(advisorUserId),
      ),
    );
    expect(r.status).toBe(200);
    expect(r.body.document_id).toBeTruthy();
    // an untouched item advances to in_progress and links the document.
    expect(r.body.item.readiness_state).toBe('in_progress');
    expect(r.body.item.document_filename).toBe('recs.pdf');
    // the document carries the data_room:<item> category so parse can key off it.
    const cat = (await service.query(`select category from documents where id = $1`, [r.body.document_id]))
      .rows[0].category;
    expect(cat).toBe('data_room:FIN-RECON');
    // reflected in the list view (joined document fields).
    const list = body(await handleFunctionCall('list-data-room', { engagement_id: engagementId }, ctxFor(advisorUserId)));
    const recon = list.body.items.find((i: any) => i.item_code === 'FIN-RECON');
    expect(recon.document_id).toBe(r.body.document_id);
    expect(recon.document_filename).toBe('recs.pdf');
  });

  it('lets an owner attach a document to their company data room', async () => {
    const r = body(
      await handleFunctionCall(
        'attach-data-room-document',
        {
          engagement_id: engagementId,
          item_code: 'HR-ORG',
          filename: 'roster.csv',
          mime_type: 'text/csv',
          content_base64: Buffer.from('name,title').toString('base64'),
        },
        ctxFor(ownerUserId),
      ),
    );
    expect(r.status).toBe(200);
    expect(r.body.item.document_filename).toBe('roster.csv');
  });

  it('blocks a foreign advisor from the engagement', async () => {
    const r = body(
      await handleFunctionCall('list-data-room', { engagement_id: engagementId }, ctxFor(otherAdvisorUserId)),
    );
    expect(r.status).toBe(404);
  });
});
