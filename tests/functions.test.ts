// Portable function router (server/functions.ts). Requires a migrated + seeded
// database (DATABASE_URL); skipped otherwise. Mounts handleFunctionCall exactly
// as a host does — a service-role client for dispatch, and an asUser runner that
// applies the caller's JWT claims so real RLS gates authorization — and proves
// every authorization branch (firm-scoped, engagement-scoped, assessment-scoped,
// and the failure cases) plus real dispatch still behave after the extraction
// from the dev emulator.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { handleFunctionCall, type FunctionContext } from '../server/functions';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('handleFunctionCall (portable router)', () => {
  let pool: pg.Pool;
  let service: pg.Client;
  let firmId: string;
  let advisorUserId: string;
  let engagementId: string;
  let assessmentId: string;

  // Mirrors the dev emulator / a production host: run fn as the authenticated
  // caller with their claims, inside a transaction, so RLS applies.
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

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    service = new pg.Client({ connectionString: url });
    await service.connect();

    const rv = (await service.query(`select id from rubric_versions where status = 'active' limit 1`)).rows[0].id;
    firmId = (await service.query(`insert into firms (name) values ('Router Test Firm') returning id`)).rows[0].id;
    advisorUserId = (
      await service.query(`insert into auth.users (id, email) values (gen_random_uuid(), 'router.adv@test.co') returning id`)
    ).rows[0].id;
    await service.query(
      `insert into profiles (user_id, firm_id, role, full_name) values ($1, $2, 'advisor', 'Router Advisor')`,
      [advisorUserId, firmId],
    );
    const companyId = (
      await service.query(
        `insert into companies (firm_id, name, industry) values ($1, 'Router Co', 'Precision Manufacturing') returning id`,
        [firmId],
      )
    ).rows[0].id;
    engagementId = (
      await service.query(`insert into engagements (firm_id, company_id) values ($1, $2) returning id`, [firmId, companyId])
    ).rows[0].id;
    assessmentId = (
      await service.query(
        `insert into assessments (firm_id, engagement_id, rubric_version_id, sequence_number, status, completed_at, drs_score, drs_tier, ori_score)
         values ($1, $2, $3, 1, 'completed', now(), 72, 'Sale Ready', 60) returning id`,
        [firmId, engagementId, rv],
      )
    ).rows[0].id;
    await service.query(
      `insert into ebitda_recasts (firm_id, engagement_id, reported_ebitda) values ($1, $2, 1000000)`,
      [firmId, engagementId],
    );
  });

  afterAll(async () => {
    if (service) {
      await service.query(`delete from deal_outcomes where firm_id = $1`, [firmId]);
      await service.query(`delete from ebitda_recasts where firm_id = $1`, [firmId]);
      await service.query(`delete from assessments where firm_id = $1`, [firmId]);
      await service.query(`delete from engagements where firm_id = $1`, [firmId]);
      await service.query(`delete from companies where firm_id = $1`, [firmId]);
      await service.query(`delete from profiles where firm_id = $1`, [firmId]);
      await service.query(`delete from auth.users where id = $1`, [advisorUserId]);
      await service.query(`delete from firms where id = $1`, [firmId]);
      await service.end();
    }
    if (pool) await pool.end();
  });

  it('firm-scoped: deal-calibration resolves the caller firm and dispatches', async () => {
    const r = await handleFunctionCall('deal-calibration', {}, ctxFor(advisorUserId));
    expect(r.kind).toBe('json');
    if (r.kind === 'json') {
      expect(r.status).toBe(200);
      expect((r.body as { deals_recorded: number }).deals_recorded).toBe(0);
    }
  });

  it('firm-scoped: rejects a caller with no advisor profile (403)', async () => {
    const strangerId = (
      await service.query(`insert into auth.users (id, email) values (gen_random_uuid(), 'router.stranger@test.co') returning id`)
    ).rows[0].id;
    const r = await handleFunctionCall('deal-calibration', {}, ctxFor(strangerId));
    expect(r).toMatchObject({ kind: 'json', status: 403 });
    await service.query(`delete from auth.users where id = $1`, [strangerId]);
  });

  it('engagement-scoped: compute-valuation authorizes via RLS and dispatches', async () => {
    const r = await handleFunctionCall('compute-valuation', { engagement_id: engagementId }, ctxFor(advisorUserId));
    expect(r.kind).toBe('json');
    if (r.kind === 'json') {
      expect(r.status).toBe(200);
      expect((r.body as { has_recast: boolean }).has_recast).toBe(true);
    }
  });

  it('engagement-scoped: unknown/foreign engagement is not authorized (404)', async () => {
    const r = await handleFunctionCall(
      'compute-valuation',
      { engagement_id: '00000000-0000-0000-0000-000000000000' },
      ctxFor(advisorUserId),
    );
    expect(r).toMatchObject({ kind: 'json', status: 404 });
  });

  it('assessment-scoped: verification-summary authorizes on the assessment id', async () => {
    const r = await handleFunctionCall('verification-summary', { assessment_id: assessmentId }, ctxFor(advisorUserId));
    expect(r.kind).toBe('json');
    if (r.kind === 'json') {
      expect(r.status).toBe(200);
      expect(r.body).toHaveProperty('pct');
    }
  });

  it('routes the PDF endpoints (reaches the handler, surfaces its error)', async () => {
    // A real PDF needs generated content + computed scores; this fixture has
    // neither, so the handler errors. The point is that routing reaches the
    // render-owner-pdf branch and surfaces a real error (not "unknown function").
    const r = await handleFunctionCall('render-owner-pdf', { assessment_id: assessmentId }, ctxFor(advisorUserId));
    expect(r.kind).toBe('json');
    if (r.kind === 'json') {
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.body).toHaveProperty('message');
    }
  });

  it('unknown function name → 404', async () => {
    const r = await handleFunctionCall('no-such-function', { engagement_id: engagementId }, ctxFor(advisorUserId));
    expect(r).toMatchObject({ kind: 'json', status: 404 });
  });
});
