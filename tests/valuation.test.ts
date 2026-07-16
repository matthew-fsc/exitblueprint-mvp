// Phase 2 valuation engine. Requires a migrated + seeded database (DATABASE_URL);
// skipped otherwise. Locks the deterministic math against hand-computed values so
// the number can never silently drift — the same discipline as the DRS engine.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { acceptAgreement } from './helpers';
import { computeValuation } from '../server/valuation';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('computeValuation', () => {
  let db: pg.Client;
  let firmId: string;
  let engagementId: string;

  beforeAll(async () => {
    db = new pg.Client({ connectionString: url });
    await db.connect();
    const rv = (await db.query(`select id from rubric_versions where status = 'active' limit 1`)).rows[0].id;
    firmId = (await db.query(`insert into firms (name) values ('Valuation Test Firm') returning id`)).rows[0].id;
    const companyId = (
      await db.query(`insert into companies (firm_id, name, industry) values ($1, 'Val Co', 'Precision Manufacturing') returning id`, [firmId])
    ).rows[0].id;
    engagementId = (
      await db.query(`insert into engagements (firm_id, company_id) values ($1, $2) returning id`, [firmId, companyId])
    ).rows[0].id;
    await acceptAgreement(db, engagementId);
    // Sale-Ready tier → readiness 1.0; no provenance → self-reported → width 0.30.
    await db.query(
      `insert into assessments (firm_id, engagement_id, rubric_version_id, sequence_number, status, completed_at, drs_score, drs_tier)
       values ($1, $2, $3, 1, 'completed', now(), 72, 'Sale Ready')`,
      [firmId, engagementId, rv],
    );
    const recastId = (
      await db.query(`insert into ebitda_recasts (firm_id, engagement_id, reported_ebitda) values ($1, $2, 1000000) returning id`, [firmId, engagementId])
    ).rows[0].id;
    await db.query(
      `insert into ebitda_addbacks (firm_id, recast_id, label, amount, challenge_likelihood) values
        ($1, $2, 'Owner comp', 200000, 'low'),
        ($1, $2, 'Personal', 50000, 'medium'),
        ($1, $2, 'Aggressive', 100000, 'not_defensible')`,
      [firmId, recastId],
    );
    await db.query(
      `insert into valuation_inputs (firm_id, engagement_id, interest_bearing_debt, owner_wealth_target)
       values ($1, $2, 1000000, 5000000)`,
      [firmId, engagementId],
    );
  });

  afterAll(async () => {
    if (!db) return;
    await db.query(`delete from valuation_inputs where firm_id = $1`, [firmId]);
    await db.query(`delete from ebitda_addbacks where firm_id = $1`, [firmId]);
    await db.query(`delete from ebitda_recasts where firm_id = $1`, [firmId]);
    await db.query(`delete from assessments where firm_id = $1`, [firmId]);
    await db.query(`delete from engagement_agreements where firm_id = $1`, [firmId]);
    await db.query(`delete from engagements where firm_id = $1`, [firmId]);
    await db.query(`delete from companies where firm_id = $1`, [firmId]);
    await db.query(`delete from agreement_versions where firm_id = $1`, [firmId]);
    await db.query(`delete from firms where id = $1`, [firmId]);
    await db.end();
  });

  it('reports no valuation until a recast exists', async () => {
    const other = (
      await db.query(
        `insert into engagements (firm_id, company_id) select $1, id from companies where firm_id = $1 limit 1 returning id`,
        [firmId],
      )
    ).rows[0].id;
    const v = await computeValuation(db, other);
    expect(v.has_recast).toBe(false);
    expect(v.ev_base).toBe(0);
    await db.query(`delete from engagements where id = $1`, [other]);
  });

  it('computes EV, gaps, and net-to-owner to the hand-computed cents', async () => {
    const v = await computeValuation(db, engagementId);
    // recast: reported 1.0M + defensible add-backs (low+medium) 250k; not_defensible excluded
    expect(v.defensible_ebitda).toBe(1_250_000);
    expect(v.full_recast_ebitda).toBe(1_350_000);
    // manufacturing @ 1_3m = 5.0×, Sale-Ready readiness 1.0
    expect(v.industry_key).toBe('manufacturing');
    expect(v.size_band).toBe('1_3m');
    expect(v.base_multiple).toBe(5);
    expect(v.ev_base).toBe(6_250_000);
    // self-reported width 0.30
    expect(v.ev_low).toBe(4_375_000);
    expect(v.ev_high).toBe(8_125_000);
    // potential at Institutional (1.15) and the value-creation gap
    expect(v.potential_ev).toBe(7_187_500);
    expect(v.value_creation_gap).toBe(937_500);
    // net to owner: EV 6.25M − debt 1.0M − costs (8% of EV = 500k) − taxes (28% of 4.75M = 1.33M)
    expect(v.transaction_costs).toBe(500_000);
    expect(v.taxes).toBe(1_330_000);
    expect(v.net_proceeds).toBe(3_420_000);
    // wealth gap: target 5.0M − net 3.42M
    expect(v.wealth_gap).toBe(1_580_000);
  });

  it('honors a manual multiple override', async () => {
    await db.query(`update valuation_inputs set multiple_override = 6 where engagement_id = $1`, [engagementId]);
    const v = await computeValuation(db, engagementId);
    expect(v.multiple_source).toBe('override');
    expect(v.base_multiple).toBe(6);
    expect(v.ev_base).toBe(7_500_000); // 1.25M × 6 × 1.0
    await db.query(`update valuation_inputs set multiple_override = null where engagement_id = $1`, [engagementId]);
  });
});
