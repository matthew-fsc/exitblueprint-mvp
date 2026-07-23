// PL2 (docs/37): Plan authoring through the portable router. Needs a real
// database (DATABASE_URL); skipped otherwise, like the other router tests. Runs
// handleFunctionCall exactly as a host does — a service-role client for dispatch
// and an asUser runner so the firm-scope resolution and RLS apply.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { handleFunctionCall, type FunctionContext } from '../server/functions';
import { findReassessmentReady } from '../server/scheduled';
import { autoApplyQualifyingPlans, reconcileEngagementPlans, recommendPlans } from '../server/plans';
import { acceptAgreement } from './helpers';

const url = process.env.DATABASE_URL;

interface PlanBody {
  id: string;
  name: string;
  status: string;
  is_system: boolean;
  firm_id: string | null;
  items: { item_kind: string }[];
}

describe.skipIf(!url)('Plan authoring (list-plans / create-plan)', () => {
  let pool: pg.Pool;
  let service: pg.Client;
  let firmId: string;
  let otherFirmId: string;
  const advisorUserId = 'user_plans_adv';
  let libTask1Id: string;
  let libTask2Id: string;
  let contentId: string;
  let advisoryOwnId: string;
  let advisoryOtherId: string;
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

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    service = new pg.Client({ connectionString: url });
    await service.connect();
    firmId = (await service.query(`insert into firms (name) values ('Plans Test Firm') returning id`)).rows[0].id;
    otherFirmId = (await service.query(`insert into firms (name) values ('Plans Other Firm') returning id`)).rows[0].id;
    await service.query(
      `insert into profiles (user_id, firm_id, role, full_name) values ($1, $2, 'advisor', 'Plans Advisor')`,
      [advisorUserId, firmId],
    );
    libTask1Id = (
      await service.query(
        `insert into library_tasks (firm_id, source, code, title, default_owner_role, target_offset_days)
         values ($1, 'advisor', 'FIRM-LT-1', 'Lib task 1', 'owner', 0) returning id`,
        [firmId],
      )
    ).rows[0].id;
    libTask2Id = (
      await service.query(
        `insert into library_tasks (firm_id, source, code, title, default_owner_role, target_offset_days)
         values ($1, 'advisor', 'FIRM-LT-2', 'Lib task 2', 'advisor', 30) returning id`,
        [firmId],
      )
    ).rows[0].id;
    contentId = (
      await service.query(`insert into content_modules (code, title, body_md) values ('PL-TEST-CM', 'Test Module', 'x') returning id`)
    ).rows[0].id;
    advisoryOwnId = (
      await service.query(
        `insert into advisory_library_items (firm_id, source, item_type, title, body) values ($1, 'advisor', 'initiative', 'Own item', 'x') returning id`,
        [firmId],
      )
    ).rows[0].id;
    advisoryOtherId = (
      await service.query(
        `insert into advisory_library_items (firm_id, source, item_type, title, body) values ($1, 'advisor', 'initiative', 'Other firm item', 'x') returning id`,
        [otherFirmId],
      )
    ).rows[0].id;
    const companyId = (
      await service.query(`insert into companies (firm_id, name) values ($1, 'Plans Co') returning id`, [firmId])
    ).rows[0].id;
    engagementId = (
      await service.query(
        `insert into engagements (firm_id, company_id, started_at) values ($1, $2, current_date) returning id`,
        [firmId, companyId],
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    await service.query(`delete from engagement_plan_items where firm_id = $1`, [firmId]);
    await service.query(`delete from roadmap_milestones where firm_id = $1`, [firmId]);
    await service.query(`delete from tasks where firm_id = $1`, [firmId]);
    await service.query(`delete from engagement_plans where firm_id = $1`, [firmId]);
    await service.query(`delete from gaps where firm_id = $1`, [firmId]);
    // dimension_scores (seeded by the initiative-recommendation test) FK to
    // assessments, so clear them before the assessments they hang off.
    await service.query(
      `delete from dimension_scores where assessment_id in (select id from assessments where firm_id = $1)`,
      [firmId],
    );
    await service.query(`delete from assessments where firm_id = $1`, [firmId]);
    await service.query(`delete from engagement_agreements where firm_id = $1`, [firmId]);
    await service.query(`delete from engagements where firm_id = $1`, [firmId]);
    await service.query(`delete from agreement_versions where firm_id = $1`, [firmId]);
    await service.query(`delete from companies where firm_id = $1`, [firmId]);
    await service.query(`delete from plan_template_items where firm_id = $1`, [firmId]);
    await service.query(`delete from plan_templates where firm_id = $1`, [firmId]);
    await service.query(`delete from advisory_library_items where firm_id = any($1)`, [[firmId, otherFirmId]]);
    await service.query(`delete from content_modules where code = 'PL-TEST-CM'`);
    // Firm-authored library tasks created across these tests.
    await service.query(`delete from library_tasks where firm_id = any($1)`, [[firmId, otherFirmId]]);
    await service.query(`delete from profiles where user_id = $1`, [advisorUserId]);
    await service.query(`delete from firms where id = any($1)`, [[firmId, otherFirmId]]);
    await service.end();
    await pool.end();
  });

  it('creates a firm plan with all five item kinds', async () => {
    const r = await handleFunctionCall(
      'create-plan',
      {
        name: 'My Signature Plan',
        summary: 'a test plan',
        status: 'active',
        items: [
          { kind: 'task', library_task_id: libTask1Id },
          { kind: 'education', content_module_id: contentId },
          { kind: 'advisory', advisory_library_item_id: advisoryOwnId },
          { kind: 'milestone', title: 'Business is buyer-ready', track: 'business' },
          { kind: 'manual_task', title: 'Do a one-off thing', owner_role: 'owner' },
        ],
      },
      ctxFor(advisorUserId),
    );
    expect(r).toMatchObject({ kind: 'json', status: 200 });
    if (r.kind === 'json') {
      const plan = r.body as PlanBody;
      expect(plan.name).toBe('My Signature Plan');
      expect(plan.status).toBe('active');
      expect(plan.is_system).toBe(false);
      expect(plan.firm_id).toBe(firmId);
      expect(plan.items.map((i) => i.item_kind)).toEqual([
        'task', 'education', 'advisory', 'milestone', 'manual_task',
      ]);
    }
  });

  it('lists own firm plans and never another firm’s', async () => {
    const r = await handleFunctionCall('list-plans', {}, ctxFor(advisorUserId));
    expect(r).toMatchObject({ kind: 'json', status: 200 });
    if (r.kind === 'json') {
      const plans = (r.body as { plans: PlanBody[] }).plans;
      expect(plans.some((p) => p.name === 'My Signature Plan' && p.firm_id === firmId)).toBe(true);
      // Only system (null) or own-firm rows are ever visible.
      expect(plans.every((p) => p.firm_id === null || p.firm_id === firmId)).toBe(true);
    }
  });

  it('rejects referencing another firm’s advisory item (cross-firm guard, 400)', async () => {
    const r = await handleFunctionCall(
      'create-plan',
      { name: 'Sneaky', items: [{ kind: 'advisory', advisory_library_item_id: advisoryOtherId }] },
      ctxFor(advisorUserId),
    );
    expect(r).toMatchObject({ kind: 'json', status: 400 });
  });

  it('rejects a plan with no name (400)', async () => {
    const r = await handleFunctionCall('create-plan', { items: [] }, ctxFor(advisorUserId));
    expect(r).toMatchObject({ kind: 'json', status: 400 });
  });

  it('rejects a milestone item with no track (400)', async () => {
    const r = await handleFunctionCall(
      'create-plan',
      { name: 'Bad Milestone', items: [{ kind: 'milestone', title: 'no track' }] },
      ctxFor(advisorUserId),
    );
    expect(r).toMatchObject({ kind: 'json', status: 400 });
  });

  it('rejects a caller with no advisor profile (403)', async () => {
    const r = await handleFunctionCall('list-plans', {}, ctxFor('user_plans_stranger'));
    expect(r).toMatchObject({ kind: 'json', status: 403 });
  });

  it('edits a draft plan in place (version stays 1)', async () => {
    const created = await handleFunctionCall(
      'create-plan',
      { name: 'Draft Plan', status: 'draft', items: [{ kind: 'manual_task', title: 'a' }] },
      ctxFor(advisorUserId),
    );
    const id = (created as { body: PlanBody }).body.id;
    const r = await handleFunctionCall(
      'update-plan',
      { id, name: 'Draft Plan Renamed', items: [{ kind: 'manual_task', title: 'b' }, { kind: 'milestone', title: 'm', track: 'personal' }] },
      ctxFor(advisorUserId),
    );
    expect(r).toMatchObject({ kind: 'json', status: 200 });
    if (r.kind === 'json') {
      const plan = r.body as PlanBody & { id: string; plan_version: number };
      expect(plan.id).toBe(id); // same row
      expect(plan.name).toBe('Draft Plan Renamed');
      expect((plan as unknown as { plan_version: number }).plan_version).toBe(1);
      expect(plan.items).toHaveLength(2);
    }
  });

  it('editing an active plan mints a new linked version and retires the old', async () => {
    const created = await handleFunctionCall(
      'create-plan',
      { name: 'Active Plan', status: 'active', items: [{ kind: 'manual_task', title: 'v1 task' }] },
      ctxFor(advisorUserId),
    );
    const v1 = (created as { body: PlanBody & { lineage_id: string; plan_version: number } }).body;
    const r = await handleFunctionCall(
      'update-plan',
      { id: v1.id, name: 'Active Plan v2', items: [{ kind: 'manual_task', title: 'v2 task' }] },
      ctxFor(advisorUserId),
    );
    expect(r).toMatchObject({ kind: 'json', status: 200 });
    const v2 = (r as { body: PlanBody & { lineage_id: string; plan_version: number } }).body;
    expect(v2.id).not.toBe(v1.id); // new row
    expect(v2.plan_version).toBe(2);
    expect(v2.lineage_id).toBe(v1.lineage_id); // same lineage
    expect(v2.status).toBe('active');
    // Old row retired in the DB, and hidden from the authoring list.
    const oldStatus = (await service.query(`select status from plan_templates where id = $1`, [v1.id])).rows[0].status;
    expect(oldStatus).toBe('retired');
    const list = await handleFunctionCall('list-plans', {}, ctxFor(advisorUserId));
    const listed = (list as { body: { plans: PlanBody[] } }).body.plans;
    expect(listed.some((p) => p.id === v2.id)).toBe(true);
    expect(listed.some((p) => p.id === v1.id)).toBe(false); // retired hidden
  });

  it('cannot edit another firm’s or a nonexistent plan (400)', async () => {
    const foreign = (
      await service.query(
        `insert into plan_templates (firm_id, source, name, status, lineage_id)
         values ($1, 'advisor', 'Foreign Plan', 'active', gen_random_uuid()) returning id`,
        [otherFirmId],
      )
    ).rows[0].id;
    const r = await handleFunctionCall('update-plan', { id: foreign, name: 'hijack' }, ctxFor(advisorUserId));
    expect(r).toMatchObject({ kind: 'json', status: 400 });
    await service.query(`delete from plan_templates where id = $1`, [foreign]);
  });

  it('applies a plan: materializes tasks + milestone + item records, idempotently', async () => {
    // A plan with one of every kind.
    const created = await handleFunctionCall(
      'create-plan',
      {
        name: 'Apply Me',
        status: 'active',
        items: [
          { kind: 'task', library_task_id: libTask1Id },
          { kind: 'task', library_task_id: libTask2Id },
          { kind: 'manual_task', title: 'a manual task', owner_role: 'owner' },
          { kind: 'milestone', title: 'a milestone', track: 'business', target_offset_days: 60 },
          { kind: 'education', content_module_id: contentId },
          { kind: 'advisory', advisory_library_item_id: advisoryOwnId },
        ],
      },
      ctxFor(advisorUserId),
    );
    const planId = (created as { body: PlanBody }).body.id;

    const r = await handleFunctionCall(
      'apply-plan',
      { engagement_id: engagementId, plan_template_id: planId, anchor_date: '2026-08-01' },
      ctxFor(advisorUserId),
    );
    expect(r).toMatchObject({ kind: 'json', status: 200 });
    const applied = (r as { body: { engagement_plan: { id: string; applied_plan_version: number }; tasks_created: number; milestones_created: number } }).body;
    // 2 library tasks + 1 manual task = 3 created; 1 milestone.
    expect(applied.tasks_created).toBe(3);
    expect(applied.milestones_created).toBe(1);
    const epId = applied.engagement_plan.id;

    // Tasks tagged with the applied plan; milestone present; 6 item records.
    const taggedTasks = await service.query(`select count(*)::int c from tasks where engagement_plan_id = $1`, [epId]);
    expect(taggedTasks.rows[0].c).toBe(3);
    const ms = await service.query(`select count(*)::int c from roadmap_milestones where engagement_plan_id = $1`, [epId]);
    expect(ms.rows[0].c).toBe(1);
    const epItems = await service.query(`select count(*)::int c from engagement_plan_items where engagement_plan_id = $1`, [epId]);
    expect(epItems.rows[0].c).toBe(6);

    // Re-apply is an idempotent no-op: same snapshot, nothing new created.
    const again = await handleFunctionCall(
      'apply-plan',
      { engagement_id: engagementId, plan_template_id: planId, anchor_date: '2026-08-01' },
      ctxFor(advisorUserId),
    );
    const applied2 = (again as { body: { engagement_plan: { id: string }; tasks_created: number; milestones_created: number } }).body;
    expect(applied2.engagement_plan.id).toBe(epId);
    expect(applied2.tasks_created).toBe(0);
    expect(applied2.milestones_created).toBe(0);
    const tasksAfter = await service.query(`select count(*)::int c from tasks where engagement_plan_id = $1`, [epId]);
    expect(tasksAfter.rows[0].c).toBe(3); // not duplicated
  });

  it('claims a library task another Plan already created rather than duplicating it', async () => {
    // A fresh engagement so this test is isolated from the apply test above.
    const companyId2 = (
      await service.query(`insert into companies (firm_id, name) values ($1, 'Claim Co') returning id`, [firmId])
    ).rows[0].id;
    const engagement2 = (
      await service.query(
        `insert into engagements (firm_id, company_id, started_at) values ($1, $2, current_date) returning id`,
        [firmId, companyId2],
      )
    ).rows[0].id;
    // Pre-create a task as if another applied Plan already laid down library task 1.
    await service.query(
      `insert into tasks (firm_id, engagement_id, library_task_id, title, status)
       values ($1, $2, $3, 'Lib task 1', 'todo')`,
      [firmId, engagement2, libTask1Id],
    );
    const plan = await handleFunctionCall(
      'create-plan',
      {
        name: 'Claim Test',
        status: 'active',
        items: [
          { kind: 'task', library_task_id: libTask1Id },
          { kind: 'task', library_task_id: libTask2Id },
        ],
      },
      ctxFor(advisorUserId),
    );
    const planId = (plan as { body: PlanBody }).body.id;
    const r = await handleFunctionCall(
      'apply-plan',
      { engagement_id: engagement2, plan_template_id: planId },
      ctxFor(advisorUserId),
    );
    const applied = (r as { body: { engagement_plan: { id: string }; tasks_created: number; tasks_claimed: number } }).body;
    // Library task 1 exists → claimed; library task 2 → created. No duplicate for task 1.
    expect(applied.tasks_claimed).toBe(1);
    expect(applied.tasks_created).toBe(1);
    const t1 = await service.query(
      `select count(*)::int c from tasks where engagement_id = $1 and library_task_id = $2`,
      [engagement2, libTask1Id],
    );
    expect(t1.rows[0].c).toBe(1); // not duplicated
  });

  it('re-adding a removed Plan reclaims its stranded tasks onto the new snapshot', async () => {
    // Regression: a soft-removed Plan's tasks keep their engagement_plan_id. The
    // old coalesce() kept that (dead) id on re-apply, so the re-added Plan's board
    // group showed empty. The reclaim must move a task off a REMOVED plan.
    const companyId3 = (
      await service.query(`insert into companies (firm_id, name) values ($1, 'Readd Co') returning id`, [firmId])
    ).rows[0].id;
    const engagement3 = (
      await service.query(
        `insert into engagements (firm_id, company_id, started_at) values ($1, $2, current_date) returning id`,
        [firmId, companyId3],
      )
    ).rows[0].id;
    const plan = await handleFunctionCall(
      'create-plan',
      { name: 'Readd Test', status: 'active', items: [{ kind: 'task', library_task_id: libTask1Id }] },
      ctxFor(advisorUserId),
    );
    const planId = (plan as { body: PlanBody }).body.id;

    // Apply, then soft-remove — the task stays tagged to the now-removed snapshot.
    const first = await handleFunctionCall(
      'apply-plan',
      { engagement_id: engagement3, plan_template_id: planId },
      ctxFor(advisorUserId),
    );
    const ep1 = (first as { body: { engagement_plan: { id: string } } }).body.engagement_plan.id;
    await service.query(`update engagement_plans set status = 'removed' where id = $1`, [ep1]);

    // Re-apply the same Plan: a new snapshot that must reclaim the stranded task.
    const again = await handleFunctionCall(
      'apply-plan',
      { engagement_id: engagement3, plan_template_id: planId },
      ctxFor(advisorUserId),
    );
    const readd = (again as { body: { engagement_plan: { id: string }; tasks_created: number; tasks_claimed: number } })
      .body;
    expect(readd.engagement_plan.id).not.toBe(ep1); // a fresh snapshot
    expect(readd.tasks_claimed).toBe(1);
    expect(readd.tasks_created).toBe(0);
    // The task now belongs to the re-added plan, not the dead one.
    const owner = (
      await service.query(
        `select engagement_plan_id from tasks where engagement_id = $1 and library_task_id = $2`,
        [engagement3, libTask1Id],
      )
    ).rows[0].engagement_plan_id;
    expect(owner).toBe(readd.engagement_plan.id);
    expect(owner).not.toBe(ep1);
  });

  it('reports plan progress and stamps completion when all work is done (PL4)', async () => {
    const companyId3 = (
      await service.query(`insert into companies (firm_id, name) values ($1, 'Progress Co') returning id`, [firmId])
    ).rows[0].id;
    const eng3 = (
      await service.query(
        `insert into engagements (firm_id, company_id, started_at) values ($1, $2, current_date) returning id`,
        [firmId, companyId3],
      )
    ).rows[0].id;
    const plan = await handleFunctionCall(
      'create-plan',
      {
        name: 'Progress Plan',
        status: 'active',
        items: [
          { kind: 'manual_task', title: 'task A' },
          { kind: 'manual_task', title: 'task B' },
          { kind: 'milestone', title: 'ms A', track: 'business' },
        ],
      },
      ctxFor(advisorUserId),
    );
    const planId = (plan as { body: PlanBody }).body.id;
    const applied = await handleFunctionCall(
      'apply-plan',
      { engagement_id: eng3, plan_template_id: planId },
      ctxFor(advisorUserId),
    );
    const epId = (applied as { body: { engagement_plan: { id: string } } }).body.engagement_plan.id;

    // Halfway: one task done.
    await service.query(
      `update tasks set status = 'done' where engagement_plan_id = $1 and title = 'task A'`,
      [epId],
    );
    let prog = await handleFunctionCall('list-engagement-plans', { engagement_id: eng3 }, ctxFor(advisorUserId));
    let row = (prog as { body: { plans: { id: string; total: number; done: number; pct: number; completed_at: string | null }[] } }).body.plans.find((p) => p.id === epId)!;
    expect(row.total).toBe(3);
    expect(row.done).toBe(1);
    expect(row.pct).toBe(33);
    expect(row.completed_at).toBeNull(); // not complete yet

    // Finish the rest: second task + the milestone.
    await service.query(`update tasks set status = 'done' where engagement_plan_id = $1`, [epId]);
    await service.query(`update roadmap_milestones set completed_at = now() where engagement_plan_id = $1`, [epId]);
    prog = await handleFunctionCall('list-engagement-plans', { engagement_id: eng3 }, ctxFor(advisorUserId));
    row = (prog as { body: { plans: { id: string; total: number; done: number; pct: number; completed_at: string | null }[] } }).body.plans.find((p) => p.id === epId)!;
    expect(row.done).toBe(3);
    expect(row.pct).toBe(100);
    expect(row.completed_at).not.toBeNull(); // completion stamped once fully done
  });

  it('flags an engagement as reassessment-ready once a plan completes after the last assessment (PL4b)', async () => {
    const companyId4 = (
      await service.query(`insert into companies (firm_id, name) values ($1, 'Ready Co') returning id`, [firmId])
    ).rows[0].id;
    const eng4 = (
      await service.query(
        `insert into engagements (firm_id, company_id, started_at) values ($1, $2, current_date) returning id`,
        [firmId, companyId4],
      )
    ).rows[0].id;
    await acceptAgreement(service, eng4);
    // A completed assessment IN THE PAST — the plan will finish after it.
    const rv = (await service.query(`select id from rubric_versions where status = 'active' limit 1`)).rows[0].id;
    await service.query(
      `insert into assessments (firm_id, engagement_id, rubric_version_id, sequence_number, status, completed_at)
       values ($1, $2, $3, 1, 'completed', now() - interval '2 days')`,
      [firmId, eng4, rv],
    );

    // Not ready before any plan is applied/finished.
    const before = await findReassessmentReady(service, { firmId });
    expect(before.items.map((r) => r.engagementId)).not.toContain(eng4);

    const plan = await handleFunctionCall(
      'create-plan',
      { name: 'Ready Plan', status: 'active', items: [{ kind: 'manual_task', title: 'the work' }] },
      ctxFor(advisorUserId),
    );
    const planId = (plan as { body: PlanBody }).body.id;
    const applied = await handleFunctionCall(
      'apply-plan',
      { engagement_id: eng4, plan_template_id: planId },
      ctxFor(advisorUserId),
    );
    const epId = (applied as { body: { engagement_plan: { id: string } } }).body.engagement_plan.id;

    // Work not done yet → still not ready.
    const midway = await findReassessmentReady(service, { firmId });
    expect(midway.items.map((r) => r.engagementId)).not.toContain(eng4);

    // Finish the plan's work (trigger stamps completed_at = now(), after the assessment).
    await service.query(`update tasks set status = 'done' where engagement_plan_id = $1`, [epId]);

    const ready = await findReassessmentReady(service, { firmId });
    const item = ready.items.find((r) => r.engagementId === eng4);
    expect(item).toBeDefined();
    expect(item!.readyPlanCount).toBe(1);
    expect(item!.readyPlanNames).toContain('Ready Plan');
  });

  it('reconcile marks a plan completed once its targeted gaps all resolve (PL4c, Q7)', async () => {
    // Use a seeded gap↔Plan mapping so the applied Plan targets a real gap.
    const map = (
      await service.query(`select gap_definition_id, plan_template_id from gap_plan_map limit 1`)
    ).rows[0];
    const companyId5 = (
      await service.query(`insert into companies (firm_id, name) values ($1, 'Reconcile Co') returning id`, [firmId])
    ).rows[0].id;
    const eng5 = (
      await service.query(`insert into engagements (firm_id, company_id) values ($1, $2) returning id`, [firmId, companyId5])
    ).rows[0].id;
    await acceptAgreement(service, eng5);
    const rv = (await service.query(`select id from rubric_versions where status = 'active' limit 1`)).rows[0].id;
    const a1 = (
      await service.query(
        `insert into assessments (firm_id, engagement_id, rubric_version_id, sequence_number, status, completed_at)
         values ($1, $2, $3, 1, 'completed', now()) returning id`,
        [firmId, eng5, rv],
      )
    ).rows[0].id;
    // An OPEN gap the Plan is linked to (gap_plan_map).
    const gapId = (
      await service.query(
        `insert into gaps (firm_id, engagement_id, gap_definition_id, opened_by_assessment_id, status)
         values ($1, $2, $3, $4, 'open') returning id`,
        [firmId, eng5, map.gap_definition_id, a1],
      )
    ).rows[0].id;

    // Apply the seeded system Plan the gap maps to.
    const applied = await handleFunctionCall(
      'apply-plan',
      { engagement_id: eng5, plan_template_id: map.plan_template_id },
      ctxFor(advisorUserId),
    );
    const epId = (applied as { body: { engagement_plan: { id: string } } }).body.engagement_plan.id;

    // Gap still open → reconcile leaves the plan active.
    const r1 = await reconcileEngagementPlans(service, eng5);
    expect(r1.completed).not.toContain(epId);
    expect((await service.query(`select status from engagement_plans where id = $1`, [epId])).rows[0].status).toBe('active');

    // Resolve the gap → reconcile completes the plan.
    await service.query(`update gaps set status = 'resolved', resolved_by_assessment_id = $2 where id = $1`, [gapId, a1]);
    const r2 = await reconcileEngagementPlans(service, eng5);
    expect(r2.completed).toContain(epId);
    expect((await service.query(`select status from engagement_plans where id = $1`, [epId])).rows[0].status).toBe('completed');
  });

  it('recommends a plan whose content targets an open gap’s area, and drops it once applied (Q5)', async () => {
    // A gap definition and its readiness area (dimension).
    const gd = (
      await service.query(
        `select gd.id as gap_definition_id, gd.code as gap_code, d.code as dim
         from gap_definitions gd join dimensions d on d.id = gd.dimension_id limit 1`,
      )
    ).rows[0];
    // A firm library task in that readiness area, so a Plan containing it covers the gap.
    const libId = (
      await service.query(
        `insert into library_tasks (firm_id, source, code, title, default_owner_role, dimension_code)
         values ($1, 'advisor', 'FIRM-LT-REC', 'Rec task', 'owner', $2) returning id`,
        [firmId, gd.dim],
      )
    ).rows[0].id;
    const companyId6 = (
      await service.query(`insert into companies (firm_id, name) values ($1, 'Recommend Co') returning id`, [firmId])
    ).rows[0].id;
    const eng6 = (
      await service.query(`insert into engagements (firm_id, company_id) values ($1, $2) returning id`, [firmId, companyId6])
    ).rows[0].id;
    await acceptAgreement(service, eng6);
    const rv = (await service.query(`select id from rubric_versions where status = 'active' limit 1`)).rows[0].id;
    const a1 = (
      await service.query(
        `insert into assessments (firm_id, engagement_id, rubric_version_id, sequence_number, status, completed_at)
         values ($1, $2, $3, 1, 'completed', now()) returning id`,
        [firmId, eng6, rv],
      )
    ).rows[0].id;
    await service.query(
      `insert into gaps (firm_id, engagement_id, gap_definition_id, opened_by_assessment_id, status)
       values ($1, $2, $3, $4, 'open')`,
      [firmId, eng6, gd.gap_definition_id, a1],
    );
    const plan = await handleFunctionCall(
      'create-plan',
      { name: 'Recommendable Plan', status: 'active', items: [{ kind: 'task', library_task_id: libId }] },
      ctxFor(advisorUserId),
    );
    const planId = (plan as { body: PlanBody }).body.id;

    // Recommended while the gap is open and the plan isn't applied.
    const before = await recommendPlans(service, eng6);
    const rec = before.recommendations.find((r) => r.plan_template_id === planId);
    expect(rec).toBeDefined();
    expect(rec!.matched_gap_count).toBeGreaterThanOrEqual(1);
    expect(rec!.matched_gap_codes).toContain(gd.gap_code);

    // After applying, it drops out of the recommendations (already applied).
    await handleFunctionCall('apply-plan', { engagement_id: eng6, plan_template_id: planId }, ctxFor(advisorUserId));
    const after = await recommendPlans(service, eng6);
    expect(after.recommendations.find((r) => r.plan_template_id === planId)).toBeUndefined();
  });

  it('recommends a plan whose advisory item is a fired initiative (Q5, initiative arm)', async () => {
    const dim = (await service.query(`select id, code from dimensions limit 1`)).rows[0];
    const companyId7 = (
      await service.query(`insert into companies (firm_id, name) values ($1, 'Initiative Co') returning id`, [firmId])
    ).rows[0].id;
    const eng7 = (
      await service.query(`insert into engagements (firm_id, company_id) values ($1, $2) returning id`, [firmId, companyId7])
    ).rows[0].id;
    await acceptAgreement(service, eng7);
    const rv = (await service.query(`select id from rubric_versions where status = 'active' limit 1`)).rows[0].id;
    const a1 = (
      await service.query(
        `insert into assessments (firm_id, engagement_id, rubric_version_id, sequence_number, status, completed_at)
         values ($1, $2, $3, 1, 'completed', now()) returning id`,
        [firmId, eng7, rv],
      )
    ).rows[0].id;
    // A low dimension score so an initiative triggered on that dimension fires.
    await service.query(`insert into dimension_scores (assessment_id, dimension_id, score) values ($1, $2, 20)`, [a1, dim.id]);
    const initiativeId = (
      await service.query(
        `insert into advisory_library_items
           (firm_id, source, item_type, active, title, body, dimension_code, score_trigger)
         values ($1, 'advisor', 'initiative', true, 'Fireable Initiative', 'x', $2, 100) returning id`,
        [firmId, dim.code],
      )
    ).rows[0].id;
    const plan = await handleFunctionCall(
      'create-plan',
      { name: 'Initiative Plan', status: 'active', items: [{ kind: 'advisory', advisory_library_item_id: initiativeId }] },
      ctxFor(advisorUserId),
    );
    const planId = (plan as { body: PlanBody }).body.id;

    const rec = (await recommendPlans(service, eng7)).recommendations.find((r) => r.plan_template_id === planId);
    expect(rec).toBeDefined();
    // Matched via the fired initiative, not a gap.
    expect(rec!.matched_initiative_count).toBeGreaterThanOrEqual(1);
    expect(rec!.matched_gap_count).toBe(0);
    expect(rec!.matched_initiative_titles).toContain('Fireable Initiative');
    expect(rec!.match_score).toBeGreaterThanOrEqual(1);
  });

  it('auto-applies a plan whose content mostly targets open gaps, skips a mostly-off-target one (Q5b)', async () => {
    // A gap definition's readiness area (dimension), and a different area with no gap.
    const gd = (
      await service.query(
        `select gd.id as gap_definition_id, d.code as dim
         from gap_definitions gd join dimensions d on d.id = gd.dimension_id limit 1`,
      )
    ).rows[0];
    const otherDim = (
      await service.query(`select code from dimensions where code <> $1 order by code limit 1`, [gd.dim])
    ).rows[0].code;
    // One library task in the gap's area (matches), two in an area with no gap (dilute).
    const libMatch = (
      await service.query(
        `insert into library_tasks (firm_id, source, code, title, default_owner_role, dimension_code)
         values ($1, 'advisor', 'FIRM-LT-M', 'match task', 'owner', $2) returning id`,
        [firmId, gd.dim],
      )
    ).rows[0].id;
    const libNo1 = (
      await service.query(
        `insert into library_tasks (firm_id, source, code, title, default_owner_role, dimension_code)
         values ($1, 'advisor', 'FIRM-LT-N1', 'off task 1', 'owner', $2) returning id`,
        [firmId, otherDim],
      )
    ).rows[0].id;
    const libNo2 = (
      await service.query(
        `insert into library_tasks (firm_id, source, code, title, default_owner_role, dimension_code)
         values ($1, 'advisor', 'FIRM-LT-N2', 'off task 2', 'owner', $2) returning id`,
        [firmId, otherDim],
      )
    ).rows[0].id;

    const companyId8 = (
      await service.query(`insert into companies (firm_id, name) values ($1, 'AutoApply Co') returning id`, [firmId])
    ).rows[0].id;
    const eng8 = (
      await service.query(`insert into engagements (firm_id, company_id, started_at) values ($1, $2, current_date) returning id`, [firmId, companyId8])
    ).rows[0].id;
    await acceptAgreement(service, eng8);
    const rv = (await service.query(`select id from rubric_versions where status = 'active' limit 1`)).rows[0].id;
    const a1 = (
      await service.query(
        `insert into assessments (firm_id, engagement_id, rubric_version_id, sequence_number, status, completed_at)
         values ($1, $2, $3, 1, 'completed', now()) returning id`,
        [firmId, eng8, rv],
      )
    ).rows[0].id;
    await service.query(
      `insert into gaps (firm_id, engagement_id, gap_definition_id, opened_by_assessment_id, status)
       values ($1, $2, $3, $4, 'open')`,
      [firmId, eng8, gd.gap_definition_id, a1],
    );

    // Qualifying: 1 of 2 content items in an open-gap area → 50% ≥ threshold.
    const majorityPlan = (
      (await handleFunctionCall(
        'create-plan',
        { name: 'Majority Plan', status: 'active', items: [{ kind: 'task', library_task_id: libMatch }, { kind: 'task', library_task_id: libNo1 }] },
        ctxFor(advisorUserId),
      )) as { body: PlanBody }
    ).body.id;
    // Not qualifying: 1 of 3 content items in an open-gap area → 33% < threshold.
    const minorityPlan = (
      (await handleFunctionCall(
        'create-plan',
        {
          name: 'Minority Plan',
          status: 'active',
          items: [
            { kind: 'task', library_task_id: libMatch },
            { kind: 'task', library_task_id: libNo1 },
            { kind: 'task', library_task_id: libNo2 },
          ],
        },
        ctxFor(advisorUserId),
      )) as { body: PlanBody }
    ).body.id;

    const res = await autoApplyQualifyingPlans(service, eng8, advisorUserId, null);
    const appliedIds = res.applied.map((p) => p.plan_template_id);
    expect(appliedIds).toContain(majorityPlan);
    expect(appliedIds).not.toContain(minorityPlan);

    // The majority plan really landed as an applied engagement_plan with tasks.
    const majoritySummary = res.applied.find((p) => p.plan_template_id === majorityPlan)!;
    expect(majoritySummary.tasks_created + majoritySummary.tasks_claimed).toBeGreaterThanOrEqual(1);
    const ep = (
      await service.query(
        `select id from engagement_plans where engagement_id = $1 and plan_template_id = $2 and status <> 'removed'`,
        [eng8, majorityPlan],
      )
    ).rows[0];
    expect(ep).toBeDefined();

    // Idempotent: a second pass applies nothing new (majority already applied).
    const res2 = await autoApplyQualifyingPlans(service, eng8, advisorUserId, null);
    expect(res2.applied.map((p) => p.plan_template_id)).not.toContain(majorityPlan);
  });
});
