// Plan authoring (docs/37, slice PL2). An advisor curates reusable Plans
// (plan_templates) from the existing catalogs — playbooks, education modules,
// advisory items — plus inline milestones/manual tasks. These functions are the
// Workflow-engine, firm-scoped authoring surface behind the Library UI. They run
// under the service-role client (RLS bypassed), so every read/write filters by
// the caller's resolved firmId EXPLICITLY, and every referenced asset is checked
// visible to the firm (global rows, or the firm's own) before it is written.
//
// Applying a Plan to an engagement is a separate slice (PL3, server/…apply).
// Editing an already-active Plan (mint a new plan_version) is deferred pending a
// product decision on firm-plan version lineage (docs/37 §3.1) — this slice
// creates and lists.
import type pg from 'pg';

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
      `select id, firm_id, source, code, name, summary, plan_version, status from plan_templates where id = $1`,
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
  const plans = (
    await db.query(
      `select id, firm_id, source, code, name, summary, plan_version, status
       from plan_templates
       where firm_id is null or firm_id = $1
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
  const rawItems = Array.isArray(body.items) ? body.items : [];
  const items = rawItems.map((it, i) => normalizeItem(it, i));

  // Referenced assets must be visible to the firm before we write anything.
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

  // created_by is a profiles.id (uuid), not the Clerk subject (userId) — resolve
  // the caller's profile in their firm (same pattern as server/agreements.ts).
  const createdBy =
    ((await db.query(`select id from profiles where user_id = $1 and firm_id = $2`, [userId, firmId]))
      .rows[0]?.id as string | undefined) ?? null;

  try {
    await db.query('begin');
    const planId = (
      await db.query(
        `insert into plan_templates (firm_id, source, name, summary, plan_version, status, created_by)
         values ($1, 'advisor', $2, $3, 1, $4, $5) returning id`,
        [firmId, name, summary, status, createdBy],
      )
    ).rows[0].id;
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
    await db.query('commit');
    return (await loadPlanTemplate(db, planId))!;
  } catch (err) {
    await db.query('rollback').catch(() => {});
    throw err;
  }
}
