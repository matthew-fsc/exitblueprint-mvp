// Plan authoring (docs/37, slice PL2). An advisor curates reusable Plans
// (plan_templates) from the existing catalogs — playbooks, education modules,
// advisory items — plus inline milestones/manual tasks. These functions are the
// Workflow-engine, firm-scoped authoring surface behind the Library UI. They run
// under the service-role client (RLS bypassed), so every read/write filters by
// the caller's resolved firmId EXPLICITLY, and every referenced asset is checked
// visible to the firm (global rows, or the firm's own) before it is written.
//
// This module covers Plan authoring (list/create/update, PL2 — editing an active
// Plan mints a new lineage version) and applying a Plan to an engagement (PL3,
// applyPlan at the bottom).
import type pg from 'pg';
import { fireAdvisoryItems } from './advisory';

const ITEM_KINDS = ['playbook', 'education', 'advisory', 'milestone', 'manual_task'] as const;
type ItemKind = (typeof ITEM_KINDS)[number];
const TRACKS = ['business', 'personal'] as const;
const OWNER_ROLES = ['owner', 'advisor', 'cpa', 'attorney', 'ops'] as const;

// A normalized plan item: exactly the columns the check constraint expects for
// its kind are set; the rest are null.
interface NormalizedItem {
  kind: ItemKind;
  playbook_id: string | null;
  content_module_id: string | null;
  advisory_library_item_id: string | null;
  title: string | null;
  description: string | null;
  owner_role: string | null;
  track: string | null;
  target_offset_days: number | null;
}

export interface PlanTemplateView {
  id: string;
  firm_id: string | null;
  is_system: boolean;
  source: string;
  code: string | null;
  lineage_id: string | null;
  name: string;
  summary: string | null;
  plan_version: number;
  status: string;
  items: {
    id: string;
    item_kind: ItemKind;
    playbook_id: string | null;
    content_module_id: string | null;
    advisory_library_item_id: string | null;
    title: string | null;
    description: string | null;
    owner_role: string | null;
    track: string | null;
    target_offset_days: number | null;
    sort_order: number;
  }[];
}

const ITEM_COLS =
  'id, item_kind, playbook_id, content_module_id, advisory_library_item_id, title, description, owner_role, track, target_offset_days, sort_order';

async function loadPlanTemplate(db: pg.ClientBase, id: string): Promise<PlanTemplateView | null> {
  const p = (
    await db.query(
      `select id, firm_id, source, code, lineage_id, name, summary, plan_version, status
       from plan_templates where id = $1`,
      [id],
    )
  ).rows[0];
  if (!p) return null;
  const items = (
    await db.query(`select ${ITEM_COLS} from plan_template_items where plan_template_id = $1 order by sort_order`, [id])
  ).rows;
  return { ...p, is_system: p.firm_id === null, items };
}

// System Plans (firm_id null) + the caller firm's own, system first then by name.
export async function listPlanTemplates(
  db: pg.ClientBase,
  firmId: string,
): Promise<{ plans: PlanTemplateView[] }> {
  // Retired rows (superseded prior versions) stay for applied-instance lineage
  // but are hidden from the authoring surface — only current Plans are listed.
  const plans = (
    await db.query(
      `select id, firm_id, source, code, lineage_id, name, summary, plan_version, status
       from plan_templates
       where (firm_id is null or firm_id = $1) and status <> 'retired'
       order by (firm_id is null) desc, name`,
      [firmId],
    )
  ).rows;
  if (plans.length === 0) return { plans: [] };
  const items = (
    await db.query(
      `select plan_template_id, ${ITEM_COLS} from plan_template_items
       where plan_template_id = any($1) order by sort_order`,
      [plans.map((p) => p.id)],
    )
  ).rows;
  const byPlan = new Map<string, PlanTemplateView['items']>();
  for (const it of items) {
    const { plan_template_id, ...item } = it;
    const list = byPlan.get(plan_template_id) ?? [];
    list.push(item);
    byPlan.set(plan_template_id, list);
  }
  return {
    plans: plans.map((p) => ({ ...p, is_system: p.firm_id === null, items: byPlan.get(p.id) ?? [] })),
  };
}

// Validate + normalize one raw item into check-constraint-safe columns. Throws a
// caller-facing message (mapped to 400 by the router) on any problem.
function normalizeItem(raw: unknown, i: number): NormalizedItem {
  const r = (raw ?? {}) as Record<string, unknown>;
  const kind = String(r.kind ?? '');
  if (!ITEM_KINDS.includes(kind as ItemKind)) throw new Error(`item ${i}: invalid kind "${kind}"`);
  const out: NormalizedItem = {
    kind: kind as ItemKind,
    playbook_id: null,
    content_module_id: null,
    advisory_library_item_id: null,
    title: null,
    description: r.description != null ? String(r.description).trim() || null : null,
    owner_role: null,
    track: null,
    target_offset_days: r.target_offset_days != null ? Number(r.target_offset_days) : null,
  };
  if (out.target_offset_days != null && !Number.isFinite(out.target_offset_days)) {
    throw new Error(`item ${i}: target_offset_days must be a number`);
  }
  if (kind === 'playbook') {
    if (!r.playbook_id) throw new Error(`item ${i}: playbook_id required`);
    out.playbook_id = String(r.playbook_id);
  } else if (kind === 'education') {
    if (!r.content_module_id) throw new Error(`item ${i}: content_module_id required`);
    out.content_module_id = String(r.content_module_id);
  } else if (kind === 'advisory') {
    if (!r.advisory_library_item_id) throw new Error(`item ${i}: advisory_library_item_id required`);
    out.advisory_library_item_id = String(r.advisory_library_item_id);
  } else if (kind === 'milestone') {
    const title = String(r.title ?? '').trim();
    if (!title) throw new Error(`item ${i}: milestone needs a title`);
    if (!TRACKS.includes(r.track as (typeof TRACKS)[number])) {
      throw new Error(`item ${i}: milestone track must be business|personal`);
    }
    out.title = title;
    out.track = String(r.track);
  } else {
    // manual_task
    const title = String(r.title ?? '').trim();
    if (!title) throw new Error(`item ${i}: manual_task needs a title`);
    out.title = title;
    if (r.owner_role != null) {
      if (!OWNER_ROLES.includes(r.owner_role as (typeof OWNER_ROLES)[number])) {
        throw new Error(`item ${i}: invalid owner_role`);
      }
      out.owner_role = String(r.owner_role);
    }
  }
  return out;
}

async function refExists(db: pg.ClientBase, table: 'playbooks' | 'content_modules', id: string): Promise<boolean> {
  // table is a compile-time literal union, never caller input — safe to inline.
  return ((await db.query(`select 1 from ${table} where id = $1`, [id])).rowCount ?? 0) > 0;
}

// Advisory items are firm-scoped: a firm may reference a GLOBAL item or its OWN,
// never another firm's (docs/37 §2.4 cross-firm reference guard).
async function advisoryVisible(db: pg.ClientBase, id: string, firmId: string): Promise<boolean> {
  return (
    ((
      await db.query(
        `select 1 from advisory_library_items where id = $1 and (firm_id is null or firm_id = $2)`,
        [id, firmId],
      )
    ).rowCount ?? 0) > 0
  );
}

// Normalize the raw items and verify every referenced asset is visible to the
// firm (global rows, or the firm's own) before anything is written. Throws a
// caller-facing message (→ 400) on any problem.
async function resolveItems(
  db: pg.ClientBase,
  firmId: string,
  rawItems: unknown[],
): Promise<NormalizedItem[]> {
  const items = rawItems.map((it, i) => normalizeItem(it, i));
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind === 'playbook' && !(await refExists(db, 'playbooks', it.playbook_id!))) {
      throw new Error(`item ${i}: unknown playbook`);
    }
    if (it.kind === 'education' && !(await refExists(db, 'content_modules', it.content_module_id!))) {
      throw new Error(`item ${i}: unknown content module`);
    }
    if (it.kind === 'advisory' && !(await advisoryVisible(db, it.advisory_library_item_id!, firmId))) {
      throw new Error(`item ${i}: advisory item not found in your library`);
    }
  }
  return items;
}

async function writeItems(
  db: pg.ClientBase,
  firmId: string,
  planId: string,
  items: NormalizedItem[],
): Promise<void> {
  let sort = 0;
  for (const it of items) {
    await db.query(
      `insert into plan_template_items
         (firm_id, plan_template_id, item_kind, playbook_id, content_module_id,
          advisory_library_item_id, title, description, owner_role, track,
          target_offset_days, sort_order)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        firmId, planId, it.kind, it.playbook_id, it.content_module_id,
        it.advisory_library_item_id, it.title, it.description, it.owner_role,
        it.track, it.target_offset_days, sort++,
      ],
    );
  }
}

// created_by / applied_by columns hold a profiles.id (uuid), not the Clerk
// subject (userId) — resolve the caller's profile (same pattern as agreements.ts).
async function profileId(db: pg.ClientBase, userId: string, firmId: string): Promise<string | null> {
  return (
    ((await db.query(`select id from profiles where user_id = $1 and firm_id = $2`, [userId, firmId]))
      .rows[0]?.id as string | undefined) ?? null
  );
}

// Create a firm-authored Plan (plan_templates firm_id = caller firm) with its
// items. status defaults to 'draft'; pass status:'active' to publish immediately.
export async function createPlan(
  db: pg.ClientBase,
  firmId: string,
  body: Record<string, unknown>,
  userId: string,
): Promise<PlanTemplateView> {
  const name = String(body.name ?? '').trim();
  if (!name) throw new Error('a plan name is required');
  const summary = body.summary != null ? String(body.summary).trim() || null : null;
  const status = body.status === 'active' ? 'active' : 'draft';
  const items = await resolveItems(db, firmId, Array.isArray(body.items) ? body.items : []);
  const createdBy = await profileId(db, userId, firmId);

  try {
    await db.query('begin');
    const planId = (
      await db.query(
        `insert into plan_templates (firm_id, source, name, summary, plan_version, status, created_by)
         values ($1, 'advisor', $2, $3, 1, $4, $5) returning id`,
        [firmId, name, summary, status, createdBy],
      )
    ).rows[0].id;
    // A Plan is its own lineage root until a future edit mints a new version.
    await db.query(`update plan_templates set lineage_id = id where id = $1`, [planId]);
    await writeItems(db, firmId, planId, items);
    await db.query('commit');
    return (await loadPlanTemplate(db, planId))!;
  } catch (err) {
    await db.query('rollback').catch(() => {});
    throw err;
  }
}

// Edit a firm-authored Plan. A DRAFT is edited in place. An ACTIVE Plan is
// immutable once it may have been applied, so an edit MINTS a new version — a new
// plan_templates row sharing the original's lineage_id at plan_version + 1 — and
// retires the prior row (docs/37 §3.1). System Plans and other firms' Plans are
// never editable here. If `items` is omitted, the existing item set is carried
// forward; if present, it replaces the set.
export async function updatePlan(
  db: pg.ClientBase,
  firmId: string,
  body: Record<string, unknown>,
  userId: string,
): Promise<PlanTemplateView> {
  const id = String(body.id ?? '');
  if (!id) throw new Error('a plan id is required');
  const existing = (
    await db.query(
      `select id, firm_id, lineage_id, name, summary, plan_version, status
       from plan_templates where id = $1`,
      [id],
    )
  ).rows[0] as
    | { id: string; firm_id: string | null; lineage_id: string | null; name: string; summary: string | null; plan_version: number; status: string }
    | undefined;
  if (!existing || existing.firm_id !== firmId) throw new Error('plan not found');
  if (existing.status === 'retired') throw new Error('this plan version is retired; edit its current version');

  const name = body.name != null ? String(body.name).trim() : existing.name;
  if (!name) throw new Error('a plan name is required');
  const summary = 'summary' in body ? (body.summary != null ? String(body.summary).trim() || null : null) : existing.summary;

  // Items: replace if provided, else carry forward the existing set.
  const items = Array.isArray(body.items)
    ? await resolveItems(db, firmId, body.items)
    : await carryForwardItems(db, id);

  try {
    await db.query('begin');
    let resultId: string;
    if (existing.status === 'draft') {
      // Edit in place; a draft may also be activated here.
      const status = body.status === 'active' ? 'active' : 'draft';
      await db.query(`update plan_templates set name = $2, summary = $3, status = $4 where id = $1`, [
        id, name, summary, status,
      ]);
      await db.query(`delete from plan_template_items where plan_template_id = $1`, [id]);
      await writeItems(db, firmId, id, items);
      resultId = id;
    } else {
      // Active → mint a new linked version; retire the old one.
      const createdBy = await profileId(db, userId, firmId);
      resultId = (
        await db.query(
          `insert into plan_templates (firm_id, source, name, summary, plan_version, status, created_by, lineage_id)
           values ($1, 'advisor', $2, $3, $4, 'active', $5, $6) returning id`,
          [firmId, name, summary, existing.plan_version + 1, createdBy, existing.lineage_id ?? id],
        )
      ).rows[0].id;
      await writeItems(db, firmId, resultId, items);
      await db.query(`update plan_templates set status = 'retired' where id = $1`, [id]);
    }
    await db.query('commit');
    return (await loadPlanTemplate(db, resultId))!;
  } catch (err) {
    await db.query('rollback').catch(() => {});
    throw err;
  }
}

// Re-read an existing plan's items as NormalizedItem[] (for carry-forward on a
// version mint where the caller didn't send a new item set).
async function carryForwardItems(db: pg.ClientBase, planId: string): Promise<NormalizedItem[]> {
  const rows = (
    await db.query(`select ${ITEM_COLS} from plan_template_items where plan_template_id = $1 order by sort_order`, [
      planId,
    ])
  ).rows;
  return rows.map((r) => ({
    kind: r.item_kind,
    playbook_id: r.playbook_id,
    content_module_id: r.content_module_id,
    advisory_library_item_id: r.advisory_library_item_id,
    title: r.title,
    description: r.description,
    owner_role: r.owner_role,
    track: r.track,
    target_offset_days: r.target_offset_days,
  }));
}

// ── PL3: apply a Plan to an engagement ───────────────────────────────────────
// Materialize a Plan onto an engagement: create the immutable engagement_plans
// snapshot (pinning applied_plan_version + name) and turn each item into concrete
// execution rows tagged with engagement_plan_id — playbook/manual_task → tasks,
// milestone → roadmap_milestones, education/advisory → an engagement_plan_items
// reference. Honors the once-per-engagement (playbook_id, sequence) idempotency
// from server/roadmap.ts (docs/37 §1.4): a playbook a gap already instantiated is
// CLAIMED (tagged), never duplicated. Re-applying the same version is idempotent
// (the existing snapshot is reused and its items rebuilt). No scoring/gap write.
export interface ApplyPlanResult {
  engagement_plan: {
    id: string;
    engagement_id: string;
    plan_template_id: string;
    applied_plan_version: number;
    name: string;
    anchor_date: string | null;
    status: string;
  };
  tasks_created: number;
  tasks_claimed: number;
  milestones_created: number;
}

export async function applyPlan(
  db: pg.ClientBase,
  firmId: string,
  body: Record<string, unknown>,
  userId: string,
): Promise<ApplyPlanResult> {
  const engagementId = String(body.engagement_id ?? '');
  const planTemplateId = String(body.plan_template_id ?? body.plan_id ?? '');
  if (!engagementId) throw new Error('engagement_id required');
  if (!planTemplateId) throw new Error('plan_template_id required');

  const eng = (
    await db.query(`select id, firm_id, started_at from engagements where id = $1 and firm_id = $2`, [
      engagementId, firmId,
    ])
  ).rows[0];
  if (!eng) throw new Error('engagement not found');
  // The template must be visible to the firm: a system Plan or the firm's own.
  const tmpl = (
    await db.query(
      `select id, name, plan_version from plan_templates
       where id = $1 and (firm_id is null or firm_id = $2)`,
      [planTemplateId, firmId],
    )
  ).rows[0];
  if (!tmpl) throw new Error('plan not found');

  const anchor = (body.anchor_date ? String(body.anchor_date) : null) ?? eng.started_at;
  const appliedBy = await profileId(db, userId, firmId);

  // Idempotent re-apply: if this exact plan version is already applied (and not
  // removed), return the existing snapshot untouched rather than re-materializing
  // — manual-task/milestone items have no natural key, so a rebuild would
  // duplicate them. Applying a NEWER version is a new snapshot; re-anchoring is a
  // later concern (docs/37 PL4).
  const already = (
    await db.query(
      `select id from engagement_plans
       where engagement_id = $1 and plan_template_id = $2 and status <> 'removed' limit 1`,
      [engagementId, planTemplateId],
    )
  ).rows[0]?.id as string | undefined;
  if (already) {
    const applied = (
      await db.query(
        `select id, engagement_id, plan_template_id, applied_plan_version, name, anchor_date, status
         from engagement_plans where id = $1`,
        [already],
      )
    ).rows[0];
    return { engagement_plan: applied, tasks_created: 0, tasks_claimed: 0, milestones_created: 0 };
  }

  const items = (
    await db.query(`select ${ITEM_COLS} from plan_template_items where plan_template_id = $1 order by sort_order`, [
      planTemplateId,
    ])
  ).rows;

  try {
    await db.query('begin');

    const ep = (
      await db.query(
        `insert into engagement_plans
           (firm_id, engagement_id, plan_template_id, applied_plan_version, name, anchor_date, applied_by, status)
         values ($1, $2, $3, $4, $5, $6, $7, 'active') returning id`,
        [firmId, engagementId, planTemplateId, tmpl.plan_version, tmpl.name, anchor, appliedBy],
      )
    ).rows[0].id;

    // Existing playbook-derived tasks (from gaps or a prior apply) keyed for
    // claim-or-create — the shared idempotency key with server/roadmap.ts.
    const existing = new Map<string, string>();
    for (const r of (
      await db.query(
        `select id, playbook_id, sequence from tasks where engagement_id = $1 and playbook_id is not null`,
        [engagementId],
      )
    ).rows) {
      existing.set(`${r.playbook_id}:${r.sequence}`, r.id);
    }

    let tasksCreated = 0;
    let tasksClaimed = 0;
    let milestonesCreated = 0;
    const dueFromAnchor = `($1::date + ((coalesce($2, 0))::text || ' days')::interval)::date`;

    for (const it of items) {
      if (it.item_kind === 'playbook') {
        const templates = (
          await db.query(
            `select title, description, default_owner_role, sequence, target_offset_days
             from playbook_task_templates where playbook_id = $1 order by sequence`,
            [it.playbook_id],
          )
        ).rows;
        for (const t of templates) {
          const key = `${it.playbook_id}:${t.sequence}`;
          const existingId = existing.get(key);
          if (existingId) {
            await db.query(
              `update tasks set engagement_plan_id = coalesce(engagement_plan_id, $2) where id = $1`,
              [existingId, ep],
            );
            tasksClaimed++;
          } else {
            const newId = (
              await db.query(
                `insert into tasks
                   (firm_id, engagement_id, gap_id, playbook_id, engagement_plan_id, title, description,
                    owner_role, status, due_date, sequence)
                 values ($3, $4, null, $5, $6, $7, $8, $9, 'todo', ${dueFromAnchor}, $10) returning id`,
                [
                  anchor, t.target_offset_days ?? 0, firmId, engagementId, it.playbook_id, ep,
                  t.title, t.description, t.default_owner_role, t.sequence,
                ],
              )
            ).rows[0].id;
            existing.set(key, newId);
            tasksCreated++;
          }
        }
        await db.query(
          `insert into engagement_plan_items (firm_id, engagement_plan_id, source_plan_template_item_id, item_kind)
           values ($1, $2, $3, 'playbook')`,
          [firmId, ep, it.id],
        );
      } else if (it.item_kind === 'manual_task') {
        const taskId = (
          await db.query(
            `insert into tasks
               (firm_id, engagement_id, gap_id, playbook_id, engagement_plan_id, title, description,
                owner_role, status, due_date)
             values ($3, $4, null, null, $5, $6, $7, coalesce($8, 'owner')::task_owner_role, 'todo', ${dueFromAnchor})
             returning id`,
            [anchor, it.target_offset_days, firmId, engagementId, ep, it.title, it.description, it.owner_role],
          )
        ).rows[0].id;
        tasksCreated++;
        await db.query(
          `insert into engagement_plan_items
             (firm_id, engagement_plan_id, source_plan_template_item_id, item_kind, task_id)
           values ($1, $2, $3, 'manual_task', $4)`,
          [firmId, ep, it.id, taskId],
        );
      } else if (it.item_kind === 'milestone') {
        const milestoneId = (
          await db.query(
            `insert into roadmap_milestones
               (firm_id, engagement_id, track, title, description, target_date, engagement_plan_id)
             values ($1, $2, $3::milestone_track, $4, $5,
                     case when $6::int is null then null
                          else ($7::date + (($6)::text || ' days')::interval)::date end, $8)
             returning id`,
            [firmId, engagementId, it.track, it.title, it.description, it.target_offset_days, anchor, ep],
          )
        ).rows[0].id;
        milestonesCreated++;
        await db.query(
          `insert into engagement_plan_items
             (firm_id, engagement_plan_id, source_plan_template_item_id, item_kind, milestone_id)
           values ($1, $2, $3, 'milestone', $4)`,
          [firmId, ep, it.id, milestoneId],
        );
      } else if (it.item_kind === 'education') {
        await db.query(
          `insert into engagement_plan_items
             (firm_id, engagement_plan_id, source_plan_template_item_id, item_kind, content_module_id)
           values ($1, $2, $3, 'education', $4)`,
          [firmId, ep, it.id, it.content_module_id],
        );
      } else if (it.item_kind === 'advisory') {
        await db.query(
          `insert into engagement_plan_items
             (firm_id, engagement_plan_id, source_plan_template_item_id, item_kind, advisory_library_item_id)
           values ($1, $2, $3, 'advisory', $4)`,
          [firmId, ep, it.id, it.advisory_library_item_id],
        );
      }
    }

    await db.query('commit');
    const applied = (
      await db.query(
        `select id, engagement_id, plan_template_id, applied_plan_version, name, anchor_date, status
         from engagement_plans where id = $1`,
        [ep],
      )
    ).rows[0];
    return {
      engagement_plan: applied,
      tasks_created: tasksCreated,
      tasks_claimed: tasksClaimed,
      milestones_created: milestonesCreated,
    };
  } catch (err) {
    await db.query('rollback').catch(() => {});
    throw err;
  }
}

// ── PL4: plan progress + reassessment coordination ───────────────────────────
// Computed progress for each Applied Plan on an engagement — done/total over the
// tasks + milestones tagged with its engagement_plan_id (progress is computed,
// not stored, mirroring "deltas are computed, not stored"). completedAt is the
// latest child completion once a plan's work is fully done — the signal PL4b uses
// to place a reassessment after the last measurement. Education/advisory items
// produce no execution rows, so they don't count toward the work total.
export interface EngagementPlanProgress {
  id: string;
  plan_template_id: string;
  name: string;
  status: string;
  applied_plan_version: number;
  anchor_date: string | null;
  total: number;
  done: number;
  pct: number;
  completed_at: string | null;
}

export async function engagementPlanProgress(
  db: pg.ClientBase,
  engagementId: string,
): Promise<EngagementPlanProgress[]> {
  const rows = (
    await db.query(
      `select
         ep.id, ep.plan_template_id, ep.name, ep.status, ep.applied_plan_version, ep.anchor_date,
         (select count(*) from tasks t where t.engagement_plan_id = ep.id)
           + (select count(*) from roadmap_milestones m where m.engagement_plan_id = ep.id) as total,
         (select count(*) from tasks t where t.engagement_plan_id = ep.id and t.status = 'done')
           + (select count(*) from roadmap_milestones m where m.engagement_plan_id = ep.id and m.completed_at is not null) as done,
         greatest(
           (select max(t.completed_at) from tasks t where t.engagement_plan_id = ep.id),
           (select max(m.completed_at) from roadmap_milestones m where m.engagement_plan_id = ep.id)
         ) as last_completed_at
       from engagement_plans ep
       where ep.engagement_id = $1 and ep.status <> 'removed'
       order by ep.applied_at`,
      [engagementId],
    )
  ).rows;
  return rows.map((r) => {
    const total = Number(r.total) || 0;
    const done = Number(r.done) || 0;
    const complete = total > 0 && done === total;
    return {
      id: r.id,
      plan_template_id: r.plan_template_id,
      name: r.name,
      status: r.status,
      applied_plan_version: Number(r.applied_plan_version) || 0,
      anchor_date: r.anchor_date ? new Date(r.anchor_date).toISOString() : null,
      total,
      done,
      pct: total > 0 ? Math.round((done / total) * 100) : 0,
      // Only surface a completion time once the whole plan's work is done.
      completed_at: complete && r.last_completed_at ? new Date(r.last_completed_at).toISOString() : null,
    };
  });
}

// Reconcile active Applied Plans against the engagement's current gap state
// (docs/37 Q7). Called after a reassessment resolves gaps: a Plan whose targeted
// gaps — the gaps its playbook items map to (gap_playbook_map) — are now ALL
// resolved has achieved its remediation goal, so it is marked 'completed'. This is
// the score-based completion (distinct from work-based "all tasks done", which
// PL4 progress computes on read). Additive + idempotent; never reopens or deletes,
// never writes a score/gap (rules 1 & 4). Surfacing plans for NEWLY-opened gaps is
// the separate score-driven recommendation slice (Q5), not this.
export interface PlanReconcileResult {
  reconciled: number; // active plans examined
  completed: string[]; // engagement_plan ids newly marked completed
}

export async function reconcileEngagementPlans(
  db: pg.ClientBase,
  engagementId: string,
): Promise<PlanReconcileResult> {
  const plans = (
    await db.query(`select id from engagement_plans where engagement_id = $1 and status = 'active'`, [engagementId])
  ).rows;
  const completed: string[] = [];
  for (const ep of plans) {
    // The gaps this plan targets on this engagement, via its playbook items'
    // gap mappings, and how many are resolved.
    const g = (
      await db.query(
        `select count(*)::int as total,
                count(*) filter (where status = 'resolved')::int as resolved
         from (
           select distinct gp.id, gp.status
           from engagement_plan_items epi
           join plan_template_items pti
             on pti.id = epi.source_plan_template_item_id and pti.item_kind = 'playbook'
           join gap_playbook_map gpm on gpm.playbook_id = pti.playbook_id
           join gaps gp on gp.gap_definition_id = gpm.gap_definition_id and gp.engagement_id = $2
           where epi.engagement_plan_id = $1
         ) t`,
        [ep.id, engagementId],
      )
    ).rows[0];
    if (Number(g.total) > 0 && Number(g.resolved) === Number(g.total)) {
      await db.query(`update engagement_plans set status = 'completed' where id = $1`, [ep.id]);
      completed.push(ep.id);
    }
  }
  return { reconciled: plans.length, completed };
}

// ── Q5: score-driven Plan recommendation ─────────────────────────────────────
// Which Plans would help this engagement right now — surfaced from two
// deterministic signals it already computes:
//   • GAPS — the Plan's playbook items target the engagement's OPEN gaps
//     (via gap_playbook_map), as before.
//   • INITIATIVES — the Plan's advisory items reference an initiative that has
//     FIRED for the latest assessment (advisory.ts, item_type='initiative',
//     score ≤ score_trigger). This lets a Plan built around coaching/initiative
//     content be recommended even when it carries no gap-mapped playbook.
// Ranked by combined coverage (gaps + initiatives). Plans already applied (any
// version, by lineage) are excluded. Read-only over the deterministic gap +
// score state; never writes a score or gap (rules 1 & 4). Mirrors advisory.ts
// firing, keyed on gaps and fired initiatives rather than raw triggers.
export interface PlanRecommendation {
  plan_template_id: string;
  name: string;
  is_system: boolean;
  matched_gap_count: number;
  matched_gap_codes: string[];
  matched_initiative_count: number;
  matched_initiative_titles: string[];
  // Combined coverage, the primary rank key (gaps + initiatives).
  match_score: number;
}

export async function recommendPlans(
  db: pg.ClientBase,
  engagementId: string,
): Promise<{ recommendations: PlanRecommendation[] }> {
  const eng = (await db.query(`select firm_id from engagements where id = $1`, [engagementId])).rows[0];
  if (!eng) throw new Error('engagement not found');

  // The initiatives that have fired for this engagement's latest assessment —
  // reuse the advisory firing engine verbatim (single source of truth) and keep
  // only item_type='initiative'. Empty when the engagement has no completed
  // assessment; the gap arm still recommends on its own.
  const fired = await fireAdvisoryItems(db, engagementId);
  const initiativeIds = fired.items.filter((i) => i.item_type === 'initiative').map((i) => i.id);

  // Per-plan coverage of each signal via correlated subqueries (a single joined
  // aggregate would fan out gaps × initiatives and double-count). A Plan is a
  // candidate when it covers at least one gap OR one fired initiative.
  const rows = (
    await db.query(
      `with open_gaps as (
         select distinct gap_definition_id from gaps
         where engagement_id = $1 and status in ('open', 'in_remediation')
       ),
       applied as (
         select distinct pt.lineage_id
         from engagement_plans ep
         join plan_templates pt on pt.id = ep.plan_template_id
         where ep.engagement_id = $1 and ep.status <> 'removed'
       )
       select
         pt.id as plan_template_id,
         pt.name,
         (pt.firm_id is null) as is_system,
         (select count(distinct gpm.gap_definition_id)
            from plan_template_items pti
            join gap_playbook_map gpm on gpm.playbook_id = pti.playbook_id
            join open_gaps og on og.gap_definition_id = gpm.gap_definition_id
            where pti.plan_template_id = pt.id and pti.item_kind = 'playbook') as matched_gap_count,
         (select coalesce(array_agg(distinct gd.code), '{}')
            from plan_template_items pti
            join gap_playbook_map gpm on gpm.playbook_id = pti.playbook_id
            join open_gaps og on og.gap_definition_id = gpm.gap_definition_id
            join gap_definitions gd on gd.id = og.gap_definition_id
            where pti.plan_template_id = pt.id and pti.item_kind = 'playbook') as matched_gap_codes,
         (select count(distinct pti.advisory_library_item_id)
            from plan_template_items pti
            where pti.plan_template_id = pt.id and pti.item_kind = 'advisory'
              and pti.advisory_library_item_id = any($3::uuid[])) as matched_initiative_count,
         (select coalesce(array_agg(distinct ali.title), '{}')
            from plan_template_items pti
            join advisory_library_items ali on ali.id = pti.advisory_library_item_id
            where pti.plan_template_id = pt.id and pti.item_kind = 'advisory'
              and pti.advisory_library_item_id = any($3::uuid[])) as matched_initiative_titles
       from plan_templates pt
       where pt.status = 'active'
         and (pt.firm_id is null or pt.firm_id = $2)
         and pt.lineage_id not in (select lineage_id from applied)`,
      [engagementId, eng.firm_id, initiativeIds],
    )
  ).rows;

  const recommendations = rows
    .map((r) => {
      const matched_gap_count = Number(r.matched_gap_count) || 0;
      const matched_initiative_count = Number(r.matched_initiative_count) || 0;
      return {
        plan_template_id: r.plan_template_id as string,
        name: r.name as string,
        is_system: r.is_system as boolean,
        matched_gap_count,
        matched_gap_codes: ((r.matched_gap_codes as string[]) ?? []).filter(Boolean),
        matched_initiative_count,
        matched_initiative_titles: ((r.matched_initiative_titles as string[]) ?? []).filter(Boolean),
        match_score: matched_gap_count + matched_initiative_count,
      };
    })
    .filter((r) => r.match_score > 0)
    .sort(
      (a, b) =>
        b.match_score - a.match_score ||
        Number(b.is_system) - Number(a.is_system) ||
        a.name.localeCompare(b.name),
    );
  return { recommendations };
}

// ── Q5b: auto-apply the substantively-applicable Plans on roadmap generation ──
// When an advisor builds the roadmap from gaps (server/roadmap.ts →
// generate-roadmap), also lay down any Plan that is "substantively applicable":
// a MAJORITY (≥50%) of the Plan's playbook items map to the engagement's open
// gaps. This is stricter than the recommendation arm above (which fires on any
// single match) so bulk generation only pulls in Plans that are mostly on-target
// for this engagement, not ones that merely graze a gap. Already-applied Plans
// (by lineage) are skipped; application reuses applyPlan, so its once-per-
// engagement (playbook_id, sequence) idempotency claims — never duplicates —
// tasks a gap already created. Read-only over scoring/gaps (rules 1 & 4).
const AUTO_APPLY_MIN_COVERAGE = 0.5;

export interface AutoAppliedPlanSummary {
  plan_template_id: string;
  name: string;
  tasks_created: number;
  tasks_claimed: number;
  milestones_created: number;
}

export async function autoApplyQualifyingPlans(
  db: pg.ClientBase,
  engagementId: string,
  userId?: string | null,
  anchorDate?: string | null,
): Promise<{ applied: AutoAppliedPlanSummary[] }> {
  const eng = (
    await db.query(`select id, firm_id from engagements where id = $1`, [engagementId])
  ).rows[0];
  if (!eng) throw new Error('engagement not found');

  // Candidate Plans not yet applied, with how many of their playbook items map to
  // an open gap (matched) out of their total playbook items (denominator). Only
  // playbook items map to gaps, so a Plan with no playbook items can't qualify.
  const candidates = (
    await db.query(
      `with open_gaps as (
         select distinct gap_definition_id from gaps
         where engagement_id = $1 and status in ('open', 'in_remediation')
       ),
       applied as (
         select distinct pt.lineage_id
         from engagement_plans ep
         join plan_templates pt on pt.id = ep.plan_template_id
         where ep.engagement_id = $1 and ep.status <> 'removed'
       )
       select
         pt.id as plan_template_id,
         pt.name,
         count(*) filter (where pti.item_kind = 'playbook') as playbook_items,
         count(*) filter (
           where pti.item_kind = 'playbook' and exists (
             select 1 from gap_playbook_map gpm
             join open_gaps og on og.gap_definition_id = gpm.gap_definition_id
             where gpm.playbook_id = pti.playbook_id
           )
         ) as matched_items
       from plan_templates pt
       join plan_template_items pti on pti.plan_template_id = pt.id
       where pt.status = 'active'
         and (pt.firm_id is null or pt.firm_id = $2)
         and pt.lineage_id not in (select lineage_id from applied)
       group by pt.id, pt.name
       having count(*) filter (where pti.item_kind = 'playbook') > 0`,
      [engagementId, eng.firm_id],
    )
  ).rows;

  const applied: AutoAppliedPlanSummary[] = [];
  for (const c of candidates) {
    const playbookItems = Number(c.playbook_items) || 0;
    const matched = Number(c.matched_items) || 0;
    if (matched < 1 || matched / playbookItems < AUTO_APPLY_MIN_COVERAGE) continue;
    const res = await applyPlan(
      db,
      eng.firm_id,
      { engagement_id: engagementId, plan_template_id: c.plan_template_id, anchor_date: anchorDate ?? null },
      userId ?? '',
    );
    applied.push({
      plan_template_id: c.plan_template_id,
      name: res.engagement_plan.name,
      tasks_created: res.tasks_created,
      tasks_claimed: res.tasks_claimed,
      milestones_created: res.milestones_created,
    });
  }
  return { applied };
}
