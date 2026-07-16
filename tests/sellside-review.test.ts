// The verification + review-queue flow as the advisor drives it, through the
// portable function router. Requires a migrated DB (DATABASE_URL); skipped
// otherwise. Proves: run-verification reconciles + finds, the review queue
// exposes the resulting items, resolving a low-confidence item writes the
// verified value back with resolved_by, approving a finding flips its status,
// the metrics endpoint reports the automation ratio, and a foreign advisor is
// blocked.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { acceptAgreement } from './helpers';
import { handleFunctionCall, type FunctionContext, type FunctionResult } from '../server/functions';

const url = process.env.DATABASE_URL;
const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'sellside');

const body = (r: FunctionResult) => (r as { kind: 'json'; status: number; body: any });

describe.skipIf(!url)('verification + review queue (router)', () => {
  let pool: pg.Pool;
  let service: pg.Client;
  let firmId: string;
  let otherFirmId: string;
  let advisorUserId: string;
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
    process.env.EB_PARSER = 'fixture';
    pool = new pg.Pool({ connectionString: url });
    service = new pg.Client({ connectionString: url });
    await service.connect();

    firmId = (await service.query(`insert into firms (name) values ('Verify Firm') returning id`)).rows[0].id;
    otherFirmId = (await service.query(`insert into firms (name) values ('Other Verify Firm') returning id`)).rows[0].id;
    advisorUserId = await mkUser('verify.adv@test.co');
    otherAdvisorUserId = await mkUser('verify.other@test.co');
    await service.query(
      `insert into profiles (user_id, firm_id, role, full_name) values
         ($1, $2, 'advisor', 'Verify Advisor'), ($3, $4, 'advisor', 'Other Advisor')`,
      [advisorUserId, firmId, otherAdvisorUserId, otherFirmId],
    );
    const companyId = (
      await service.query(`insert into companies (firm_id, name) values ($1, 'Fixture Co') returning id`, [firmId])
    ).rows[0].id;
    engagementId = (
      await service.query(`insert into engagements (firm_id, company_id) values ($1, $2) returning id`, [firmId, companyId])
    ).rows[0].id;
    await acceptAgreement(service, engagementId);

    const bytes = readFileSync(join(fixtureDir, 'customer-financials.doc.json'));
    const documentId = (
      await service.query(
        `insert into documents (firm_id, engagement_id, category, original_filename, mime_type, byte_size, status)
         values ($1, $2, 'financial_statement', 'doc.json', 'application/json', $3, 'uploaded') returning id`,
        [firmId, engagementId, bytes.length],
      )
    ).rows[0].id;
    await service.query(`insert into document_blobs (document_id, firm_id, bytes) values ($1, $2, $3)`, [
      documentId,
      firmId,
      bytes,
    ]);
  });

  afterAll(async () => {
    if (service) {
      for (const t of [
        'graph_edges', 'graph_nodes', 'assessment_values', 'review_items', 'findings',
        'scores', 'jobs', 'document_fields', 'document_blobs', 'documents',
      ]) {
        await service.query(`delete from ${t} where firm_id = $1`, [firmId]);
      }
      await service.query(`delete from engagement_agreements where firm_id = $1`, [firmId]);
      await service.query(`delete from engagements where firm_id = $1`, [firmId]);
      await service.query(`delete from agreement_versions where firm_id = $1`, [firmId]);
      await service.query(`delete from companies where firm_id = $1`, [firmId]);
      await service.query(`delete from profiles where firm_id = any($1)`, [[firmId, otherFirmId]]);
      await service.query(`delete from auth.users where id = any($1)`, [[advisorUserId, otherAdvisorUserId]]);
      await service.query(`delete from firms where id = any($1)`, [[firmId, otherFirmId]]);
      await service.end();
    }
    if (pool) await pool.end();
  });

  it('run-verification reconciles values and produces a finding', async () => {
    const r = body(await handleFunctionCall('run-verification', { engagement_id: engagementId }, ctxFor(advisorUserId)));
    expect(r.status).toBe(200);
    expect(r.body.metrics.reconciled_total).toBe(2);
    expect(r.body.findings).toBe(1);
    // The pipeline parks at the first unimplemented step.
    expect(r.body.job.step).toBe('score');
  });

  it('surfaces the review items and metrics', async () => {
    const items = (
      await service.query(`select id, type, status from review_items where engagement_id = $1 order by type`, [engagementId])
    ).rows;
    // finding_approval (customer_concentration) + low_confidence_extraction (ebitda).
    expect(items.map((i) => i.type).sort()).toEqual(['finding_approval', 'low_confidence_extraction']);

    const metrics = body(
      await handleFunctionCall('verification-metrics', { engagement_id: engagementId }, ctxFor(advisorUserId)),
    );
    expect(metrics.body.reconciled_total).toBe(2);
    expect(metrics.body.human_required).toBe(1);
  });

  it('resolving a low-confidence item writes the verified value with resolved_by', async () => {
    const item = (
      await service.query(
        `select id from review_items where engagement_id = $1 and type = 'low_confidence_extraction'`,
        [engagementId],
      )
    ).rows[0];
    const r = body(
      await handleFunctionCall(
        'resolve-review-item',
        { review_item_id: item.id, resolution: { verified_value: '2000000' } },
        ctxFor(advisorUserId),
      ),
    );
    expect(r.status).toBe(200);

    const av = (
      await service.query(
        `select verified_value, source, resolved_by from assessment_values where engagement_id = $1 and field_key = 'ebitda'`,
        [engagementId],
      )
    ).rows[0];
    expect(av.verified_value).toBe('2000000');
    expect(av.source).toBe('document_verified');
    expect(av.resolved_by).not.toBeNull();

    const status = (await service.query(`select status from review_items where id = $1`, [item.id])).rows[0].status;
    expect(status).toBe('resolved');
  });

  it('human resolution does not inflate the automation ratio', async () => {
    // After a human resolved ebitda, it must count as human-resolved — not roll
    // into the automated share. annual_revenue stays the only auto-resolved field.
    const m = body(
      await handleFunctionCall('verification-metrics', { engagement_id: engagementId }, ctxFor(advisorUserId)),
    ).body;
    expect(m.reconciled_total).toBe(2);
    expect(m.human_resolved).toBe(1); // ebitda
    expect(m.human_required).toBe(0); // nothing left open
    expect(m.auto_resolved).toBe(1); // annual_revenue only — NOT 2
    expect(m.automation_ratio).toBeCloseTo(0.5, 5); // stays 0.5, does not jump to 1.0
  });

  it('approving a finding flips its status', async () => {
    const item = (
      await service.query(
        `select id from review_items where engagement_id = $1 and type = 'finding_approval'`,
        [engagementId],
      )
    ).rows[0];
    await handleFunctionCall(
      'resolve-review-item',
      { review_item_id: item.id, resolution: { approve: true } },
      ctxFor(advisorUserId),
    );
    const finding = (
      await service.query(
        `select status, narrative_approved from findings where engagement_id = $1 and pattern_key = 'customer_concentration'`,
        [engagementId],
      )
    ).rows[0];
    expect(finding.status).toBe('approved');
    expect(finding.narrative_approved).toBe(true);
  });

  it('blocks a foreign advisor from running verification', async () => {
    const r = body(
      await handleFunctionCall('run-verification', { engagement_id: engagementId }, ctxFor(otherAdvisorUserId)),
    );
    expect(r.status).toBe(404);
  });
});
