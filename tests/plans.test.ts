// PL2 (docs/37): Plan authoring through the portable router. Needs a real
// database (DATABASE_URL); skipped otherwise, like the other router tests. Runs
// handleFunctionCall exactly as a host does — a service-role client for dispatch
// and an asUser runner so the firm-scope resolution and RLS apply.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { handleFunctionCall, type FunctionContext } from '../server/functions';

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
  let playbookId: string;
  let contentId: string;
  let advisoryOwnId: string;
  let advisoryOtherId: string;

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
    playbookId = (
      await service.query(`insert into playbooks (code, name, version) values ('PL-TEST-PB', 'Test Playbook', 1) returning id`)
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
  });

  afterAll(async () => {
    await service.query(`delete from plan_template_items where firm_id = $1`, [firmId]);
    await service.query(`delete from plan_templates where firm_id = $1`, [firmId]);
    await service.query(`delete from advisory_library_items where firm_id = any($1)`, [[firmId, otherFirmId]]);
    await service.query(`delete from content_modules where code = 'PL-TEST-CM'`);
    await service.query(`delete from playbooks where code = 'PL-TEST-PB'`);
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
          { kind: 'playbook', playbook_id: playbookId },
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
        'playbook', 'education', 'advisory', 'milestone', 'manual_task',
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
});
