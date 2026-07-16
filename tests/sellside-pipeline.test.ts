// End-to-end sell-side pipeline over a fixture document. Requires a migrated DB
// (DATABASE_URL); skipped otherwise. Proves: a document runs intake → reconcile
// through the resumable job runner, populates the graph per the ontology, writes
// reconciled assessment_values with provenance, queues low-confidence / conflict
// review items, and that the customer_concentration finding matches. Also proves
// idempotency (re-running rebuilds rather than doubles) and that the job parks at
// the first unimplemented step.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { acceptAgreement } from './helpers';
import { createJob, runJob, engagementMetrics } from '../server/pipeline/runner';
import { customerConcentration } from '../server/findings/patterns';

const url = process.env.DATABASE_URL;
const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'sellside');

describe.skipIf(!url)('sell-side pipeline (fixture parser)', () => {
  let service: pg.Client;
  let firmId: string;
  let engagementId: string;
  let documentId: string;

  beforeAll(async () => {
    process.env.EB_PARSER = 'fixture';
    service = new pg.Client({ connectionString: url });
    await service.connect();

    firmId = (await service.query(`insert into firms (name) values ('Sellside Firm') returning id`)).rows[0].id;
    const companyId = (
      await service.query(`insert into companies (firm_id, name) values ($1, 'Fixture Co') returning id`, [firmId])
    ).rows[0].id;
    engagementId = (
      await service.query(`insert into engagements (firm_id, company_id) values ($1, $2) returning id`, [firmId, companyId])
    ).rows[0].id;
    await acceptAgreement(service, engagementId);

    const bytes = readFileSync(join(fixtureDir, 'customer-financials.doc.json'));
    documentId = (
      await service.query(
        `insert into documents (firm_id, engagement_id, category, original_filename, mime_type, byte_size, status)
         values ($1, $2, 'financial_statement', 'customer-financials.json', 'application/json', $3, 'uploaded')
         returning id`,
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
    if (!service) return;
    for (const t of [
      'graph_edges',
      'graph_nodes',
      'assessment_values',
      'review_items',
      'findings',
      'scores',
      'jobs',
      'document_fields',
      'document_blobs',
      'documents',
    ]) {
      await service.query(`delete from ${t} where firm_id = $1`, [firmId]);
    }
    await service.query(`delete from engagement_agreements where firm_id = $1`, [firmId]);
    await service.query(`delete from engagements where firm_id = $1`, [firmId]);
    await service.query(`delete from agreement_versions where firm_id = $1`, [firmId]);
    await service.query(`delete from companies where firm_id = $1`, [firmId]);
    await service.query(`delete from firms where id = $1`, [firmId]);
    await service.end();
  });

  const countWhere = async (table: string) =>
    Number((await service.query(`select count(*)::int as n from ${table} where engagement_id = $1`, [engagementId])).rows[0].n);

  it('runs intake → reconcile and parks at the first unimplemented step', async () => {
    const jobId = await createJob(service, {
      firmId,
      engagementId,
      // Self-reported revenue matches the document; ebitda not self-reported.
      selfReported: { 'Company:self:revenue_usd': '10000000' },
    });
    const job = await runJob(service, jobId);
    // score is the first unimplemented step; runner parks there, pending.
    expect(job.step).toBe('score');
    expect(job.status).toBe('pending');
  });

  it('builds the graph per the ontology', async () => {
    // Company + Acme + Beta = 3 nodes; each customer joined to Company = 2 edges.
    expect(await countWhere('graph_nodes')).toBe(3);
    expect(await countWhere('graph_edges')).toBe(2);
    const customers = await service.query(
      `select attributes->>'name' as name from graph_nodes where engagement_id = $1 and node_type = 'Customer' order by name`,
      [engagementId],
    );
    expect(customers.rows.map((r) => r.name)).toEqual(['Acme', 'Beta']);
  });

  it('links facts to the nodes they populated (provenance)', async () => {
    const linked = Number(
      (
        await service.query(
          `select count(*)::int as n from document_fields df
             join documents d on d.id = df.document_id
            where d.engagement_id = $1 and df.node_id is not null`,
          [engagementId],
        )
      ).rows[0].n,
    );
    expect(linked).toBeGreaterThan(0);
  });

  it('reconciles values and queues low-confidence review', async () => {
    const values = await service.query(
      `select field_key, source, confidence from assessment_values where engagement_id = $1 order by field_key`,
      [engagementId],
    );
    const byField = Object.fromEntries(values.rows.map((r) => [r.field_key, r]));
    expect(byField['annual_revenue'].source).toBe('document_verified');
    expect(byField['ebitda'].source).toBe('document_verified');

    // ebitda confidence 0.6 < 0.8 threshold -> queued as low_confidence_extraction.
    const reviews = await service.query(
      `select type, payload->>'field_key' as field_key from review_items where engagement_id = $1`,
      [engagementId],
    );
    expect(reviews.rows).toHaveLength(1);
    expect(reviews.rows[0].type).toBe('low_confidence_extraction');
    expect(reviews.rows[0].field_key).toBe('ebitda');
  });

  it('reports the automation-ratio KPI', async () => {
    const m = await engagementMetrics(service, engagementId);
    expect(m.reconciled_total).toBe(2);
    expect(m.human_required).toBe(1);
    expect(m.auto_resolved).toBe(1);
    expect(m.automation_ratio).toBeCloseTo(0.5, 5);
  });

  it('matches the customer_concentration finding from the graph', async () => {
    const matches = await customerConcentration.match({ db: service, engagementId });
    expect(matches).toHaveLength(1);
    expect(matches[0].severity).toBe('high'); // 0.32 -> high (>0.3)
    expect(matches[0].evidence.facts.top_customer_name).toBe('Acme');
    expect(Number(matches[0].evidence.facts.top_customer_pct)).toBeCloseTo(0.32, 5);
  });

  it('is idempotent: a second run rebuilds rather than doubles', async () => {
    const jobId = await createJob(service, {
      firmId,
      engagementId,
      selfReported: { 'Company:self:revenue_usd': '10000000' },
    });
    await runJob(service, jobId);
    expect(await countWhere('graph_nodes')).toBe(3);
    expect(await countWhere('graph_edges')).toBe(2);
    expect(await countWhere('assessment_values')).toBe(2);
  });

  it('flags a conflict when self-reported disagrees with the document', async () => {
    const jobId = await createJob(service, {
      firmId,
      engagementId,
      selfReported: { 'Company:self:revenue_usd': '9000000' }, // != document's 10,000,000
    });
    await runJob(service, jobId);
    const rev = (
      await service.query(
        `select source from assessment_values where engagement_id = $1 and field_key = 'annual_revenue'`,
        [engagementId],
      )
    ).rows[0];
    expect(rev.source).toBe('conflicting');
    const conflicts = await service.query(
      `select count(*)::int as n from review_items where engagement_id = $1 and type = 'conflict'`,
      [engagementId],
    );
    expect(Number(conflicts.rows[0].n)).toBe(1);
  });
});
