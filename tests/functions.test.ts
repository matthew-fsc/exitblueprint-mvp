// Portable function router (server/functions.ts). Requires a migrated + seeded
// database (DATABASE_URL); skipped otherwise. Mounts handleFunctionCall exactly
// as a host does — a service-role client for dispatch, and an asUser runner that
// applies the caller's JWT claims so real RLS gates authorization — and proves
// every authorization branch (firm-scoped, engagement-scoped, assessment-scoped,
// and the failure cases) plus real dispatch still behave after the extraction
// from the dev emulator.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { acceptAgreement, loadFixture } from './helpers';
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
    await acceptAgreement(service, engagementId);
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
      // The delete-engagement test leaves a durable audit row (engagement_id
      // null, firm_id set) — clear it before removing the firm.
      await service.query(`delete from data_access_log where firm_id = $1`, [firmId]);
      await service.query(`delete from deal_outcomes where firm_id = $1`, [firmId]);
      await service.query(`delete from ebitda_recasts where firm_id = $1`, [firmId]);
      await service.query(`delete from assessments where firm_id = $1`, [firmId]);
      await service.query(`delete from engagement_agreements where firm_id = $1`, [firmId]);
      await service.query(`delete from engagements where firm_id = $1`, [firmId]);
      await service.query(`delete from companies where firm_id = $1`, [firmId]);
      await service.query(`delete from profiles where firm_id = $1`, [firmId]);
      await service.query(`delete from auth.users where id = $1`, [advisorUserId]);
      await service.query(`delete from agreement_versions where firm_id = $1`, [firmId]);
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

  it('staff-scoped: an admin is firm staff and is authorized for the review queue (#65)', async () => {
    // Regression for the #65 gap one layer deeper: the frontend (RequireStaff) and
    // RLS both treat admin as firm staff, so the staff functions must too. Before
    // the fix this returned 403 "advisor or reviewer profile required".
    const adminUserId = (
      await service.query(`insert into auth.users (id, email) values (gen_random_uuid(), 'router.admin@test.co') returning id`)
    ).rows[0].id;
    await service.query(
      `insert into profiles (user_id, firm_id, role, full_name) values ($1, $2, 'admin', 'Router Admin')`,
      [adminUserId, firmId],
    );
    const r = await handleFunctionCall('list-review-queue', {}, ctxFor(adminUserId));
    expect(r).toMatchObject({ kind: 'json', status: 200 });
    await service.query(`delete from profiles where user_id = $1`, [adminUserId]);
    await service.query(`delete from auth.users where id = $1`, [adminUserId]);
  });

  it('admin-scoped: an admin invites a colleague into their own firm (invite-advisor)', async () => {
    // Team management is now an org control — invite-advisor uses the 'admin'
    // scope, so an admin (not a plain advisor) grows the team.
    const adminUserId = (
      await service.query(`insert into auth.users (id, email) values (gen_random_uuid(), 'router.orgadmin@test.co') returning id`)
    ).rows[0].id;
    await service.query(
      `insert into profiles (user_id, firm_id, role, full_name) values ($1, $2, 'admin', 'Router Org Admin')`,
      [adminUserId, firmId],
    );
    const r = await handleFunctionCall(
      'invite-advisor',
      { email: 'router.colleague@test.co', full_name: 'New Colleague', role: 'advisor' },
      ctxFor(adminUserId),
    );
    expect(r.kind).toBe('json');
    if (r.kind === 'json') {
      expect(r.status).toBe(200);
      expect((r.body as { status: string; role: string }).status).toBe('invited');
      expect((r.body as { role: string }).role).toBe('advisor');
    }
    const created = (
      await service.query(`select firm_id from profiles where email = 'router.colleague@test.co'`)
    ).rows[0];
    expect(created?.firm_id).toBe(firmId);
    await service.query(`delete from profiles where email = 'router.colleague@test.co'`);
    await service.query(`delete from auth.users where lower(email) = 'router.colleague@test.co'`);
    await service.query(`delete from profiles where user_id = $1`, [adminUserId]);
    await service.query(`delete from auth.users where id = $1`, [adminUserId]);
  });

  it('admin-scoped: a plain advisor can no longer invite a colleague (403)', async () => {
    // The enforcement half of the org-control change: an advisor with full
    // firm-scoped data access is still rejected from the admin-only team endpoint.
    const r = await handleFunctionCall(
      'invite-advisor',
      { email: 'router.blocked@test.co', role: 'advisor' },
      ctxFor(advisorUserId),
    );
    expect(r).toMatchObject({ kind: 'json', status: 403 });
  });

  it('admin-scoped: an admin reassigns an engagement owner (assign-engagement)', async () => {
    // Reassignment is server-authoritative (a guard trigger freezes advisor_id for
    // end-user roles); the admin-scoped function is the only path that changes it.
    const adminUserId = (
      await service.query(`insert into auth.users (id, email) values (gen_random_uuid(), 'router.assign.admin@test.co') returning id`)
    ).rows[0].id;
    await service.query(
      `insert into profiles (user_id, firm_id, role, full_name) values ($1, $2, 'admin', 'Assign Admin')`,
      [adminUserId, firmId],
    );
    const advisorProfileId = (
      await service.query(`select id from profiles where user_id = $1`, [advisorUserId])
    ).rows[0].id;

    const r = await handleFunctionCall(
      'assign-engagement',
      { engagement_id: engagementId, advisor_id: advisorProfileId },
      ctxFor(adminUserId),
    );
    expect(r).toMatchObject({ kind: 'json', status: 200 });
    const owner = (await service.query(`select advisor_id from engagements where id = $1`, [engagementId])).rows[0];
    expect(owner.advisor_id).toBe(advisorProfileId);

    // A plain advisor cannot reassign (admin-only).
    const denied = await handleFunctionCall(
      'assign-engagement',
      { engagement_id: engagementId, advisor_id: null },
      ctxFor(advisorUserId),
    );
    expect(denied).toMatchObject({ kind: 'json', status: 403 });

    // Reset ownership + clean up.
    await service.query(`update engagements set advisor_id = null where id = $1`, [engagementId]);
    await service.query(`delete from profiles where user_id = $1`, [adminUserId]);
    await service.query(`delete from auth.users where id = $1`, [adminUserId]);
  });

  it('manage-engagement: staff invites a view-only collaborator to the engagement', async () => {
    const r = await handleFunctionCall(
      'invite-collaborator',
      { engagement_id: engagementId, email: 'router.cpa@test.co', full_name: 'Router CPA', kind: 'cpa' },
      ctxFor(advisorUserId),
    );
    expect(r.kind).toBe('json');
    if (r.kind === 'json') {
      expect(r.status).toBe(200);
      expect((r.body as { status: string; kind: string }).status).toBe('invited');
      expect((r.body as { kind: string }).kind).toBe('cpa');
    }
    const prof = (
      await service.query(`select role, engagement_id from profiles where email = 'router.cpa@test.co'`)
    ).rows[0];
    expect(prof?.role).toBe('collaborator');
    expect(prof?.engagement_id).toBe(engagementId);
    // Clean up (revoke through the router, then drop the identity).
    const row = (
      await service.query(`select id from engagement_collaborators where email = 'router.cpa@test.co'`)
    ).rows[0];
    const rev = await handleFunctionCall(
      'revoke-collaborator',
      { engagement_id: engagementId, collaborator_id: row.id },
      ctxFor(advisorUserId),
    );
    expect(rev).toMatchObject({ kind: 'json', status: 200 });
    expect(
      (await service.query(`select id from profiles where email = 'router.cpa@test.co'`)).rowCount,
    ).toBe(0);
    await service.query(`delete from engagement_collaborators where email = 'router.cpa@test.co'`);
    await service.query(`delete from auth.users where lower(email) = 'router.cpa@test.co'`);
  });

  it('manage-engagement: a non-staff caller cannot invite a collaborator (403)', async () => {
    const strangerId = (
      await service.query(`insert into auth.users (id, email) values (gen_random_uuid(), 'router.nostaff2@test.co') returning id`)
    ).rows[0].id;
    const r = await handleFunctionCall(
      'invite-collaborator',
      { engagement_id: engagementId, email: 'router.blocked2@test.co', kind: 'cpa' },
      ctxFor(strangerId),
    );
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

  it('render-document-pdf: RLS — a portal user cannot render a doc type RLS walls off, even though the row exists', async () => {
    // Regression: the render path used to fetch the narrative on the service-role
    // client (RLS bypassed), so an owner/collaborator who could merely SEE the
    // assessment could pull ANY doc type — a teaser, or an UNFINALIZED CIM draft.
    // The fetch now runs AS THE CALLER, so RLS decides. We insert real rows so the
    // walled caller's 404 proves authorization, not an empty table.
    const ownerUserId = (
      await service.query(`insert into auth.users (id, email) values (gen_random_uuid(), 'router.owner@test.co') returning id`)
    ).rows[0].id;
    const companyId = (await service.query(`select company_id from engagements where id = $1`, [engagementId])).rows[0]
      .company_id;
    await service.query(
      `insert into profiles (user_id, firm_id, role, full_name, company_id) values ($1, $2, 'owner', 'Router Owner', $3)`,
      [ownerUserId, firmId, companyId],
    );
    const collabUserId = (
      await service.query(`insert into auth.users (id, email) values (gen_random_uuid(), 'router.collab@test.co') returning id`)
    ).rows[0].id;
    await service.query(
      `insert into profiles (user_id, firm_id, role, full_name, engagement_id) values ($1, $2, 'collaborator', 'Router Collab', $3)`,
      [collabUserId, firmId, engagementId],
    );

    // A CIM (initially unfinalized) and a teaser both exist for the assessment.
    await service.query(
      `insert into generated_documents (firm_id, engagement_id, assessment_id, doc_type, content_md, prompt_version, model)
       values ($1, $2, $3, 'cim', '# cim draft', 'cim.v1', 'test'),
              ($1, $2, $3, 'teaser', '# teaser', 'teaser.v1', 'test'),
              ($1, $2, $3, 'owner_report', '# owner', 'owner_report.v1', 'test')`,
      [firmId, engagementId, assessmentId],
    );

    const walled = (name: string, userId: string, docType: string) =>
      handleFunctionCall('render-document-pdf', { assessment_id: assessmentId, doc_type: docType }, ctxFor(userId)).then(
        (r) => (r.kind === 'json' ? r.status : 200),
      );

    // Owner is walled off the teaser and the UNFINALIZED CIM → 404 (row hidden by RLS).
    expect(await walled('owner-teaser', ownerUserId, 'teaser')).toBe(404);
    expect(await walled('owner-cim-unfinalized', ownerUserId, 'cim')).toBe(404);
    // Collaborator is walled off everything but owner_report.
    expect(await walled('collab-teaser', collabUserId, 'teaser')).toBe(404);
    expect(await walled('collab-cim', collabUserId, 'cim')).toBe(404);

    // Staff (advisor_firm_all) can reach the row — the render gets PAST the "no doc
    // generated" 404 into assembly (which may 400 on this sparse fixture, but is
    // never the walled 404).
    expect(await walled('advisor-teaser', advisorUserId, 'teaser')).not.toBe(404);

    // Once the advisor FINALIZES the CIM, the owner's RLS grants the read — the
    // finalized_at gate the render path now honors. The owner gets past 404.
    await service.query(
      `update generated_documents set finalized_at = now() where assessment_id = $1 and doc_type = 'cim'`,
      [assessmentId],
    );
    expect(await walled('owner-cim-finalized', ownerUserId, 'cim')).not.toBe(404);

    // Cleanup.
    await service.query(`delete from generated_documents where assessment_id = $1`, [assessmentId]);
    await service.query(`delete from profiles where user_id = any($1)`, [[ownerUserId, collabUserId]]);
    await service.query(`delete from auth.users where id = any($1)`, [[ownerUserId, collabUserId]]);
  });

  it('create-engagement: creates the engagement and its acceptance atomically, gating assessments', async () => {
    const companyId = (
      await service.query(`insert into companies (firm_id, name) values ($1, 'CE Co') returning id`, [firmId])
    ).rows[0].id;
    const av = (
      await service.query(
        `select id from agreement_versions where firm_id = $1 and status = 'active' limit 1`,
        [firmId],
      )
    ).rows[0].id;
    const r = await handleFunctionCall(
      'create-engagement',
      {
        company_id: companyId,
        agreement_version_id: av,
        signer_name: 'Jane Owner',
        consent: { benchmarking: true, anonymized_aggregation: false, outcome_tracking: true },
      },
      ctxFor(advisorUserId),
    );
    expect(r.kind).toBe('json');
    if (r.kind !== 'json') return;
    expect(r.status).toBe(200);
    const engId = (r.body as { engagement_id: string }).engagement_id;

    const acc = (
      await service.query(
        `select consent_benchmarking, consent_anonymized_aggregation, consent_outcome_tracking, accepted_signer_name
         from engagement_agreements where engagement_id = $1`,
        [engId],
      )
    ).rows[0];
    expect(acc).toMatchObject({
      consent_benchmarking: true,
      consent_anonymized_aggregation: false,
      consent_outcome_tracking: true,
      accepted_signer_name: 'Jane Owner',
    });

    // The gate now admits an assessment for this engagement and stamps the version.
    const rv = (await service.query(`select id from rubric_versions where status = 'active' limit 1`)).rows[0].id;
    const stamped = (
      await service.query(
        `insert into assessments (firm_id, engagement_id, rubric_version_id, sequence_number)
         values ($1, $2, $3, 1) returning agreement_version_id`,
        [firmId, engId, rv],
      )
    ).rows[0];
    expect(stamped.agreement_version_id).toBe(av);
  });

  it('create-engagement: rejects a company the caller cannot see (404)', async () => {
    const r = await handleFunctionCall(
      'create-engagement',
      {
        company_id: '00000000-0000-0000-0000-000000000000',
        agreement_version_id: '00000000-0000-0000-0000-000000000000',
      },
      ctxFor(advisorUserId),
    );
    expect(r).toMatchObject({ kind: 'json', status: 404 });
  });

  it('create-engagement: creates a brand-new company + setup dates in one transaction', async () => {
    const av = (
      await service.query(
        `select id from agreement_versions where firm_id = $1 and status = 'active' limit 1`,
        [firmId],
      )
    ).rows[0].id;
    const r = await handleFunctionCall(
      'create-engagement',
      {
        new_company: { name: 'Brand New Co', industry: 'SaaS' },
        agreement_version_id: av,
        signer_name: 'Sam Owner',
        started_at: '2026-01-15',
        target_exit_window: '24-36 months',
        target_close_date: '2028-01-15',
      },
      ctxFor(advisorUserId),
    );
    expect(r.kind).toBe('json');
    if (r.kind !== 'json') return;
    expect(r.status).toBe(200);
    const engId = (r.body as { engagement_id: string }).engagement_id;
    const row = (
      await service.query(
        `select c.name, c.industry, c.firm_id, e.target_exit_window,
                e.started_at::date::text as started_date, e.target_close_date::text as close_date
         from engagements e join companies c on c.id = e.company_id where e.id = $1`,
        [engId],
      )
    ).rows[0];
    expect(row).toMatchObject({
      name: 'Brand New Co',
      industry: 'SaaS',
      firm_id: firmId,
      target_exit_window: '24-36 months',
      started_date: '2026-01-15',
      close_date: '2028-01-15',
    });
  });

  it('create-engagement: rejects an out-of-band exit window', async () => {
    const av = (
      await service.query(
        `select id from agreement_versions where firm_id = $1 and status = 'active' limit 1`,
        [firmId],
      )
    ).rows[0].id;
    const r = await handleFunctionCall(
      'create-engagement',
      { new_company: { name: 'Bad Window Co' }, agreement_version_id: av, target_exit_window: 'someday' },
      ctxFor(advisorUserId),
    );
    expect(r).toMatchObject({ kind: 'json', status: 400 });
  });

  it('create-engagement: rejects a target close date before the start date', async () => {
    const av = (
      await service.query(
        `select id from agreement_versions where firm_id = $1 and status = 'active' limit 1`,
        [firmId],
      )
    ).rows[0].id;
    const r = await handleFunctionCall(
      'create-engagement',
      {
        new_company: { name: 'Bad Dates Co' },
        agreement_version_id: av,
        started_at: '2026-06-01',
        target_close_date: '2026-01-01',
      },
      ctxFor(advisorUserId),
    );
    expect(r).toMatchObject({ kind: 'json', status: 400 });
  });

  it('create-engagement: rejects when neither company_id nor new_company is given', async () => {
    const av = (
      await service.query(
        `select id from agreement_versions where firm_id = $1 and status = 'active' limit 1`,
        [firmId],
      )
    ).rows[0].id;
    const r = await handleFunctionCall(
      'create-engagement',
      { agreement_version_id: av },
      ctxFor(advisorUserId),
    );
    expect(r).toMatchObject({ kind: 'json', status: 400 });
  });

  it('score-assessment: auto-applies qualifying Plans onto the roadmap', async () => {
    // A fresh engagement so the auto-applied roadmap is isolated and torn down via
    // the delete-engagement function at the end.
    const rv = (await service.query(`select id from rubric_versions where status = 'active' limit 1`)).rows[0].id;
    const companyId = (
      await service.query(
        `insert into companies (firm_id, name, industry) values ($1, 'AutoApply Co', 'Precision Manufacturing') returning id`,
        [firmId],
      )
    ).rows[0].id;
    const engId = (
      await service.query(`insert into engagements (firm_id, company_id) values ($1, $2) returning id`, [
        firmId,
        companyId,
      ])
    ).rows[0].id;
    await acceptAgreement(service, engId);
    const aid = (
      await service.query(
        `insert into assessments (firm_id, engagement_id, rubric_version_id, sequence_number)
         values ($1, $2, $3, 1) returning id`,
        [firmId, engId, rv],
      )
    ).rows[0].id;
    const qids = new Map<string, string>(
      (
        await service.query(
          `select q.id, q.code from questions q join dimensions d on d.id = q.dimension_id
           where d.rubric_version_id = $1`,
          [rv],
        )
      ).rows.map((r) => [r.code, r.id]),
    );
    // Fixture 2 fires many gaps, so qualifying Plans exist to auto-apply.
    for (const [code, value] of Object.entries(loadFixture('company-2-apex-fabrication').answers)) {
      const qid = qids.get(code);
      if (!qid) continue;
      await service.query(`insert into answers (assessment_id, question_id, value) values ($1, $2, $3)`, [
        aid,
        qid,
        JSON.stringify(value),
      ]);
    }

    const r = await handleFunctionCall('score-assessment', { assessment_id: aid }, ctxFor(advisorUserId));
    expect(r).toMatchObject({ kind: 'json', status: 200 });

    // Scoring auto-applied the roadmap — Plans and tasks exist with no manual
    // "generate roadmap" call.
    const plans = (
      await service.query(
        `select count(*)::int c from engagement_plans where engagement_id = $1 and status <> 'removed'`,
        [engId],
      )
    ).rows[0].c;
    expect(plans).toBeGreaterThan(0);
    const tasks = (
      await service.query(`select count(*)::int c from tasks where engagement_id = $1`, [engId])
    ).rows[0].c;
    expect(tasks).toBeGreaterThan(0);

    // Tear the whole scored subtree down (FK order: plan items → tasks/milestones
    // → plans → scored children → gaps → assessment → agreement → engagement).
    await service.query(
      `delete from engagement_plan_items where engagement_plan_id in (select id from engagement_plans where engagement_id = $1)`,
      [engId],
    );
    await service.query(`delete from tasks where engagement_id = $1`, [engId]);
    await service.query(`delete from roadmap_milestones where engagement_id = $1`, [engId]);
    await service.query(`delete from engagement_plans where engagement_id = $1`, [engId]);
    for (const table of ['sub_score_results', 'dimension_scores', 'answers']) {
      await service.query(`delete from ${table} where assessment_id = $1`, [aid]);
    }
    await service.query(`delete from gaps where engagement_id = $1`, [engId]);
    await service.query(`delete from assessments where id = $1`, [aid]);
    await service.query(`delete from engagement_agreements where engagement_id = $1`, [engId]);
    await service.query(`delete from engagements where id = $1`, [engId]);
    await service.query(`delete from companies where id = $1`, [companyId]);
  });

  it('unknown function name → 404', async () => {
    const r = await handleFunctionCall('no-such-function', { engagement_id: engagementId }, ctxFor(advisorUserId));
    expect(r).toMatchObject({ kind: 'json', status: 404 });
  });

  it('delete-engagement: tears down the whole subtree in one call', async () => {
    // Build a disposable engagement loaded with a representative spread of
    // children — including the ones whose FK ordering is tricky (a gap that
    // references an assessment, a task and a milestone that reference the gap, a
    // deal outcome that references the assessment, a document with stored bytes,
    // append-only outcome_events) — then prove one delete removes all of it.
    const rv = (await service.query(`select id from rubric_versions where status = 'active' limit 1`)).rows[0].id;
    const gapDefId = (await service.query(`select id from gap_definitions limit 1`)).rows[0].id;
    const questionId = (await service.query(`select id from questions limit 1`)).rows[0].id;
    const dimensionId = (await service.query(`select id from dimensions limit 1`)).rows[0].id;

    const companyId = (
      await service.query(`insert into companies (firm_id, name) values ($1, 'Delete Me Co') returning id`, [firmId])
    ).rows[0].id;
    const delEng = (
      await service.query(`insert into engagements (firm_id, company_id) values ($1, $2) returning id`, [firmId, companyId])
    ).rows[0].id;
    await acceptAgreement(service, delEng);

    const asmt = (
      await service.query(
        `insert into assessments (firm_id, engagement_id, rubric_version_id, sequence_number, status, completed_at, drs_score, drs_tier, ori_score)
         values ($1, $2, $3, 1, 'completed', now(), 70, 'Sale Ready', 55) returning id`,
        [firmId, delEng, rv],
      )
    ).rows[0].id;
    await service.query(`insert into answers (assessment_id, question_id, value) values ($1, $2, '1'::jsonb)`, [asmt, questionId]);
    await service.query(`insert into dimension_scores (assessment_id, dimension_id, score) values ($1, $2, 70)`, [asmt, dimensionId]);
    const gap = (
      await service.query(
        `insert into gaps (firm_id, engagement_id, gap_definition_id, opened_by_assessment_id, status)
         values ($1, $2, $3, $4, 'open') returning id`,
        [firmId, delEng, gapDefId, asmt],
      )
    ).rows[0].id;
    const task = (
      await service.query(
        `insert into tasks (firm_id, engagement_id, gap_id, title) values ($1, $2, $3, 'Fix it') returning id`,
        [firmId, delEng, gap],
      )
    ).rows[0].id;
    await service.query(
      `insert into roadmap_milestones (firm_id, engagement_id, track, title, linked_gap_id, linked_task_id)
       values ($1, $2, 'business', 'Milestone', $3, $4)`,
      [firmId, delEng, gap, task],
    );
    await service.query(
      `insert into engagement_log (firm_id, engagement_id, kind, title, gap_id) values ($1, $2, 'decision', 'Log', $3)`,
      [firmId, delEng, gap],
    );
    await service.query(
      `insert into generated_documents (firm_id, engagement_id, assessment_id, doc_type, content_md, prompt_version, model)
       values ($1, $2, $3, 'owner_report', '# draft', 'v1', 'test')`,
      [firmId, delEng, asmt],
    );
    const recast = (
      await service.query(
        `insert into ebitda_recasts (firm_id, engagement_id, reported_ebitda) values ($1, $2, 500000) returning id`,
        [firmId, delEng],
      )
    ).rows[0].id;
    await service.query(`insert into ebitda_addbacks (firm_id, recast_id, label, amount) values ($1, $2, 'Owner salary', 100000)`, [firmId, recast]);
    const doc = (
      await service.query(
        `insert into documents (firm_id, engagement_id, original_filename, mime_type) values ($1, $2, 'f.pdf', 'application/pdf') returning id`,
        [firmId, delEng],
      )
    ).rows[0].id;
    await service.query(`insert into document_blobs (document_id, firm_id, bytes) values ($1, $2, '\\x00')`, [doc, firmId]);
    await service.query(`insert into engagement_outcomes (firm_id, engagement_id, process_status) values ($1, $2, 'closed')`, [firmId, delEng]);
    await service.query(
      `insert into outcome_events (firm_id, engagement_id, event_type, event_date) values ($1, $2, 'deal_closed', current_date)`,
      [firmId, delEng],
    );
    await service.query(
      `insert into deal_outcomes (firm_id, engagement_id, outcome, predicted_from_assessment_id) values ($1, $2, 'closed', $3)`,
      [firmId, delEng, asmt],
    );

    const r = await handleFunctionCall('delete-engagement', { engagement_id: delEng }, ctxFor(advisorUserId));
    expect(r.kind).toBe('json');
    if (r.kind !== 'json') return;
    expect(r.status).toBe(200);
    const body = r.body as { deleted: { assessments: number; had_deal_outcome: boolean } };
    expect(body.deleted.assessments).toBe(1);
    expect(body.deleted.had_deal_outcome).toBe(true);

    // The engagement and every child table are empty for this engagement.
    const gone = async (sql: string, param: string) => Number((await service.query(sql, [param])).rows[0].n);
    expect(await gone(`select count(*)::int n from engagements where id = $1`, delEng)).toBe(0);
    expect(await gone(`select count(*)::int n from assessments where engagement_id = $1`, delEng)).toBe(0);
    expect(await gone(`select count(*)::int n from answers where assessment_id = $1`, asmt)).toBe(0);
    expect(await gone(`select count(*)::int n from dimension_scores where assessment_id = $1`, asmt)).toBe(0);
    expect(await gone(`select count(*)::int n from gaps where engagement_id = $1`, delEng)).toBe(0);
    expect(await gone(`select count(*)::int n from tasks where engagement_id = $1`, delEng)).toBe(0);
    expect(await gone(`select count(*)::int n from roadmap_milestones where engagement_id = $1`, delEng)).toBe(0);
    expect(await gone(`select count(*)::int n from engagement_log where engagement_id = $1`, delEng)).toBe(0);
    expect(await gone(`select count(*)::int n from generated_documents where engagement_id = $1`, delEng)).toBe(0);
    expect(await gone(`select count(*)::int n from ebitda_recasts where engagement_id = $1`, delEng)).toBe(0);
    expect(await gone(`select count(*)::int n from ebitda_addbacks where recast_id = $1`, recast)).toBe(0);
    expect(await gone(`select count(*)::int n from documents where engagement_id = $1`, delEng)).toBe(0);
    expect(await gone(`select count(*)::int n from document_blobs where document_id = $1`, doc)).toBe(0);
    expect(await gone(`select count(*)::int n from outcome_events where engagement_id = $1`, delEng)).toBe(0);
    expect(await gone(`select count(*)::int n from engagement_outcomes where engagement_id = $1`, delEng)).toBe(0);
    expect(await gone(`select count(*)::int n from deal_outcomes where engagement_id = $1`, delEng)).toBe(0);
    expect(await gone(`select count(*)::int n from engagement_agreements where engagement_id = $1`, delEng)).toBe(0);

    // The removal is audited durably (engagement_id null, ids in detail).
    const audit = (
      await service.query(
        `select detail from data_access_log where firm_id = $1 and action = 'engagement.delete' order by created_at desc limit 1`,
        [firmId],
      )
    ).rows[0];
    expect(audit?.detail?.engagement_id).toBe(delEng);

    await service.query(`delete from companies where id = $1`, [companyId]);
  });

  it('delete-engagement: rejects a caller with no advisor/admin profile (403)', async () => {
    const strangerId = (
      await service.query(`insert into auth.users (id, email) values (gen_random_uuid(), 'router.del.stranger@test.co') returning id`)
    ).rows[0].id;
    const r = await handleFunctionCall('delete-engagement', { engagement_id: engagementId }, ctxFor(strangerId));
    expect(r).toMatchObject({ kind: 'json', status: 403 });
    // The engagement is untouched.
    expect((await service.query(`select 1 from engagements where id = $1`, [engagementId])).rowCount).toBe(1);
    await service.query(`delete from auth.users where id = $1`, [strangerId]);
  });

  it('delete-engagement: unknown/foreign engagement is not authorized (404)', async () => {
    const r = await handleFunctionCall(
      'delete-engagement',
      { engagement_id: '00000000-0000-0000-0000-000000000000' },
      ctxFor(advisorUserId),
    );
    expect(r).toMatchObject({ kind: 'json', status: 404 });
  });
});
