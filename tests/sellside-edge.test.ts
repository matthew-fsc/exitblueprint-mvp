// Edge cases and oddities in the sell-side layer that only show up a layer down:
// an engagement with no documents, a malformed extraction that must not corrupt
// already-verified data, resolving a review item that no longer exists, and the
// LLM cost ledger failing without losing a paid-for completion.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { acceptAgreement } from './helpers';
import { runEngagementVerification } from '../server/sellside';
import { createJob, runJob } from '../server/pipeline/runner';
import { handleFunctionCall, type FunctionContext, type FunctionResult } from '../server/functions';
import { LlmClient, type LlmTransport } from '../server/llm/client';

const url = process.env.DATABASE_URL;
const body = (r: FunctionResult) => r as { kind: 'json'; status: number; body: any };

// --- Pure unit: cost-logging is best-effort ----------------------------------

describe('llm client cost ledger', () => {
  it('returns the completion even when the ledger write fails', async () => {
    const transport: LlmTransport = async (req) => ({
      text: 'done',
      model: req.model,
      usage: { input_tokens: 5, output_tokens: 5 },
    });
    // A db whose insert always throws; the call must still resolve.
    const brokenDb = {
      query: async () => {
        throw new Error('ledger down');
      },
    } as unknown as pg.ClientBase;
    const client = new LlmClient({ transport, db: brokenDb });
    const res = await client.call({ promptKey: 'extract.financials.v1', vars: { documentText: '', category: '' } });
    expect(res.text).toBe('done');
    expect(res.cost_usd).toBeGreaterThan(0);
  });
});

// --- DB-backed edge cases -----------------------------------------------------

describe.skipIf(!url)('verification edge cases', () => {
  let pool: pg.Pool;
  let service: pg.Client;
  let firmId: string;
  let advisorUserId: string;
  let engagementId: string;

  const ctxFor = (userId: string): FunctionContext => ({
    userId,
    asUser: async (fn) => {
      const c = await pool.connect();
      try {
        await c.query('begin');
        await c.query(`select set_config('request.jwt.claims', $1, true)`, [
          JSON.stringify({ sub: userId, role: 'authenticated' }),
        ]);
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
    },
    service,
  });

  const nodeCount = async () =>
    Number(
      (await service.query(`select count(*)::int as n from graph_nodes where engagement_id = $1`, [engagementId]))
        .rows[0].n,
    );

  beforeAll(async () => {
    process.env.EB_PARSER = 'fixture';
    pool = new pg.Pool({ connectionString: url });
    service = new pg.Client({ connectionString: url });
    await service.connect();
    firmId = (await service.query(`insert into firms (name) values ('Edge Firm') returning id`)).rows[0].id;
    advisorUserId = (
      await service.query(`insert into auth.users (id, email) values (gen_random_uuid(), 'edge.adv@test.co') returning id`)
    ).rows[0].id;
    await service.query(`insert into profiles (user_id, firm_id, role, full_name) values ($1, $2, 'advisor', 'Edge Advisor')`, [
      advisorUserId,
      firmId,
    ]);
    const companyId = (
      await service.query(`insert into companies (firm_id, name) values ($1, 'Edge Co') returning id`, [firmId])
    ).rows[0].id;
    engagementId = (
      await service.query(`insert into engagements (firm_id, company_id) values ($1, $2) returning id`, [firmId, companyId])
    ).rows[0].id;
    await acceptAgreement(service, engagementId);
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
      await service.query(`delete from profiles where firm_id = $1`, [firmId]);
      await service.query(`delete from auth.users where id = $1`, [advisorUserId]);
      await service.query(`delete from firms where id = $1`, [firmId]);
      await service.end();
    }
    if (pool) await pool.end();
  });

  const addDoc = async (fields: unknown) => {
    const bytes = Buffer.from(JSON.stringify({ classification: 'financial_statement', fields }));
    const id = (
      await service.query(
        `insert into documents (firm_id, engagement_id, category, original_filename, mime_type, byte_size, status)
         values ($1, $2, 'financial_statement', 'd.json', 'application/json', $3, 'uploaded') returning id`,
        [firmId, engagementId, bytes.length],
      )
    ).rows[0].id;
    await service.query(`insert into document_blobs (document_id, firm_id, bytes) values ($1, $2, $3)`, [id, firmId, bytes]);
    return id as string;
  };

  it('runs cleanly against an engagement with no documents', async () => {
    const summary = await runEngagementVerification(service, firmId, engagementId);
    expect(summary.metrics.reconciled_total).toBe(0);
    expect(summary.findings).toBe(0);
    // Empty engagement: nothing to automate, ratio defined as 1 (no penalty).
    expect(summary.metrics.automation_ratio).toBe(1);
    expect(await nodeCount()).toBe(0);
  });

  it('rolls back a step that hits a malformed fact, preserving prior graph', async () => {
    // A good document first: builds a Company + 2 customers = 3 nodes.
    await addDoc([
      { fieldKey: 'Company:self:name', value: 'Edge Co', confidence: 1 },
      { fieldKey: 'Company:self:revenue_usd', value: '5000000', confidence: 0.95 },
      { fieldKey: 'Customer:Acme:name', value: 'Acme', confidence: 0.9 },
      { fieldKey: 'Customer:Acme:revenue_pct', value: '0.4', confidence: 0.9 },
      { fieldKey: 'Customer:Beta:name', value: 'Beta', confidence: 0.9 },
    ]);
    await runEngagementVerification(service, firmId, engagementId);
    expect(await nodeCount()).toBe(3);

    // Now a document with a non-numeric revenue: populate_graph must throw when
    // coercing it. Because the step is transactional, the prior 3 nodes survive
    // rather than being wiped by the delete-then-rebuild.
    await addDoc([{ fieldKey: 'Company:self:revenue_usd', value: 'not-a-number', confidence: 0.9 }]);
    const jobId = await createJob(service, { firmId, engagementId });
    await expect(runJob(service, jobId)).rejects.toThrow();
    expect(await nodeCount()).toBe(3);

    const job = (await service.query(`select step, status from jobs where id = $1`, [jobId])).rows[0];
    expect(job.status).toBe('failed');
    expect(job.step).toBe('populate_graph');
  });

  it('404s when resolving a review item that does not exist', async () => {
    const r = body(
      await handleFunctionCall(
        'resolve-review-item',
        { review_item_id: '00000000-0000-0000-0000-000000000000', resolution: { verified_value: 'x' } },
        ctxFor(advisorUserId),
      ),
    );
    expect(r.status).toBe(404);
  });
});
