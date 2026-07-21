// Evidence binder — the two pieces of substance behind the unified Evidence
// surface (docs/17 §3):
//   • the single "diligence binder" coverage metric (computeEvidenceCoverage), and
//   • the rule that a verified document auto-advances its linked data-room item to
//     'ready' without overriding an advisor's 'gap' / 'not_applicable' judgement.
//
// The pure-logic blocks run everywhere. The router block proves the auto-ready
// rule end-to-end and needs a migrated + seeded DB (DATABASE_URL); skipped otherwise.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { computeEvidenceCoverage } from '../server/data-room';
import { dataRoomAutoReadyEligible, AUTO_READY_PROTECTED_STATES } from '../server/documents/pipeline';
import { handleFunctionCall, type FunctionContext, type FunctionResult } from '../server/functions';

describe('computeEvidenceCoverage (binder-coverage metric)', () => {
  it('counts proven = Ready AND a verified document; pct is verified/total', () => {
    const c = computeEvidenceCoverage([
      { readiness_state: 'ready', document_status: 'verified' }, // proven
      { readiness_state: 'ready', document_status: 'in_review' }, // Ready but not proven
      { readiness_state: 'ready', document_status: null }, // Ready, no doc → not proven
      { readiness_state: 'in_progress', document_status: null },
      { readiness_state: 'not_started', document_status: null },
    ]);
    expect(c.total).toBe(5);
    expect(c.ready).toBe(3);
    expect(c.verified).toBe(1);
    // pct is the PROVEN share (verified/total), not the ready share: 1/5 → 20.
    expect(c.pct).toBe(20);
  });

  it('excludes not_applicable items from the denominator', () => {
    const c = computeEvidenceCoverage([
      { readiness_state: 'ready', document_status: 'verified' },
      { readiness_state: 'not_applicable', document_status: 'verified' }, // out of scope
      { readiness_state: 'not_started', document_status: null },
    ]);
    expect(c.total).toBe(2); // the not_applicable item is not counted
    expect(c.verified).toBe(1);
    expect(c.pct).toBe(50);
  });

  it('is 0% (not NaN) when there are no applicable items', () => {
    expect(computeEvidenceCoverage([]).pct).toBe(0);
    expect(
      computeEvidenceCoverage([{ readiness_state: 'not_applicable', document_status: null }]).pct,
    ).toBe(0);
  });
});

describe('dataRoomAutoReadyEligible (auto-ready rule)', () => {
  it('advances self-reported / in-progress states', () => {
    expect(dataRoomAutoReadyEligible('not_started')).toBe(true);
    expect(dataRoomAutoReadyEligible('in_progress')).toBe(true);
    expect(dataRoomAutoReadyEligible('ready')).toBe(true);
  });
  it('never overrides an advisor-set gap or not_applicable', () => {
    expect(dataRoomAutoReadyEligible('gap')).toBe(false);
    expect(dataRoomAutoReadyEligible('not_applicable')).toBe(false);
    expect(AUTO_READY_PROTECTED_STATES).toEqual(['gap', 'not_applicable']);
  });
});

// ── End-to-end: verifying a linked document advances its data-room item ────────
const url = process.env.DATABASE_URL;
const body = (r: FunctionResult) => r as { kind: 'json'; status: number; body: any };

describe.skipIf(!url)('auto-derive item ready from document verification (router)', () => {
  let pool: pg.Pool;
  let service: pg.Client;
  let firmId: string;
  let advisorUserId: string;
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

  // Attach a document to an item and verify it through the review path.
  const attachAndVerify = async (itemCode: string) => {
    const att = body(
      await handleFunctionCall(
        'attach-data-room-document',
        {
          engagement_id: engagementId,
          item_code: itemCode,
          filename: `${itemCode}.pdf`,
          mime_type: 'application/pdf',
          content_base64: Buffer.from(`evidence for ${itemCode}`).toString('base64'),
        },
        ctxFor(advisorUserId),
      ),
    );
    expect(att.status).toBe(200);
    const documentId = att.body.document_id as string;
    const rev = body(
      await handleFunctionCall(
        'submit-document-review',
        { document_id: documentId, verify: true, fields: [] },
        ctxFor(advisorUserId),
      ),
    );
    expect(rev.status).toBe(200);
    return documentId;
  };

  const itemState = async (itemCode: string) => {
    const list = body(
      await handleFunctionCall('list-data-room', { engagement_id: engagementId }, ctxFor(advisorUserId)),
    );
    return list.body.items.find((i: any) => i.item_code === itemCode);
  };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    service = new pg.Client({ connectionString: url });
    await service.connect();
    firmId = (await service.query(`insert into firms (name) values ('Auto-Ready Firm') returning id`)).rows[0].id;
    advisorUserId = await mkUser('ar.adv@test.co');
    await service.query(
      `insert into profiles (user_id, firm_id, role, full_name) values ($1, $2, 'advisor', 'AR Advisor')`,
      [advisorUserId, firmId],
    );
    const companyId = (
      await service.query(`insert into companies (firm_id, name) values ($1, 'AR Co') returning id`, [firmId])
    ).rows[0].id;
    engagementId = (
      await service.query(`insert into engagements (firm_id, company_id) values ($1, $2) returning id`, [firmId, companyId])
    ).rows[0].id;
  });

  afterAll(async () => {
    await service?.end();
    await pool?.end();
  });

  it('verifying a linked document advances an untouched item to Ready and counts it as proven', async () => {
    await attachAndVerify('FIN-STMTS');
    const item = await itemState('FIN-STMTS');
    expect(item.readiness_state).toBe('ready');
    expect(item.document_status).toBe('verified');

    // The binder-coverage function counts it as proven (verified).
    const cov = body(
      await handleFunctionCall('evidence-coverage', { engagement_id: engagementId }, ctxFor(advisorUserId)),
    );
    expect(cov.status).toBe(200);
    expect(cov.body.verified).toBeGreaterThanOrEqual(1);
    expect(cov.body.total).toBeGreaterThan(0);
  });

  it('does NOT override an item the advisor set to Gap', async () => {
    await handleFunctionCall(
      'set-data-room-item',
      { engagement_id: engagementId, item_code: 'CUS-CONC', readiness_state: 'gap' },
      ctxFor(advisorUserId),
    );
    await attachAndVerify('CUS-CONC');
    const item = await itemState('CUS-CONC');
    expect(item.readiness_state).toBe('gap'); // protected — verification must not flip it
    expect(item.document_status).toBe('verified'); // the doc is still verified
  });

  it('does NOT override an item marked Not applicable', async () => {
    await handleFunctionCall(
      'set-data-room-item',
      { engagement_id: engagementId, item_code: 'PIP-CERT', readiness_state: 'not_applicable' },
      ctxFor(advisorUserId),
    );
    await attachAndVerify('PIP-CERT');
    const item = await itemState('PIP-CERT');
    expect(item.readiness_state).toBe('not_applicable'); // protected
  });
});
