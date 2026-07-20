// Workflow Engine: the destructive end of the engagement lifecycle. Everyday
// lifecycle progression (active → paused → exited → churned) is a plain status
// UPDATE the advisor makes under RLS; this file owns the one operation RLS
// cannot do on its own — permanently DELETING an engagement and everything that
// hangs off it.
//
// Why a service-role function and not a client DELETE: an engagement is the root
// of a deep tree (assessments and their answers/scores, gaps, tasks, documents +
// bytes, valuation, data room, deal outcomes, the sell-side graph, instrumentation,
// …). None of those foreign keys were declared ON DELETE CASCADE — deliberately,
// because nothing but this teardown is ever allowed to remove client history — so
// the parent row cannot be deleted until every child is gone, and several child
// tables (outcome_events, llm_calls, data_access_log) are append-only or
// service-role-only for authenticated users. So the teardown runs here, once,
// with the service client, in a single transaction: it either removes the whole
// engagement or nothing.
//
// This is a genuine hard delete, not an archive — the soft path is the status
// field. It exists so an advisor can undo a mis-created engagement or honour a
// client's "remove our data" request. The UI gates it behind a typed
// confirmation (src/pages/EngagementPage.tsx) and the removal is audited.
import type pg from 'pg';
import { logAccess } from './audit';
import { resolveStorage } from './documents/storage';

export interface DeleteEngagementSummary {
  engagement_id: string;
  company_id: string;
  deleted: {
    assessments: number;
    gaps: number;
    tasks: number;
    documents: number;
    generated_documents: number;
    log_entries: number;
    had_deal_outcome: boolean;
  };
}

// The engagement's children in FK-safe teardown order: leaves first, the
// engagement row last. Every entry deletes by engagement_id except the
// assessment-scoped tables (answers/results/provenance), which have no
// engagement_id and are reached through their assessments. Ordering rules that
// matter:
//   • roadmap_milestones references gaps AND tasks → delete it before them.
//   • deal_outcomes / scores / generated_documents / gaps reference assessments
//     → delete them before assessments.
//   • documents / ebitda_recasts cascade to their own children (blobs, fields,
//     corrections, add-backs), so deleting the parent is enough.
// The assessment-subselect tables use `assessment_id in (select … )` so they are
// independent of whether the engagement still has assessments at that point.
const ENGAGEMENT_CHILD_DELETES: string[] = [
  // Sell-side intelligence substrate (graph_edges cascades from graph_nodes, but
  // it also carries engagement_id, so delete it explicitly first).
  `delete from graph_edges where engagement_id = $1`,
  `delete from graph_nodes where engagement_id = $1`,
  `delete from assessment_values where engagement_id = $1`,
  `delete from findings where engagement_id = $1`,
  `delete from scores where engagement_id = $1`,
  `delete from jobs where engagement_id = $1`,
  `delete from review_items where engagement_id = $1`,
  `delete from llm_calls where engagement_id = $1`,
  // Documents (cascades to document_blobs, document_fields, field_corrections).
  `delete from documents where engagement_id = $1`,
  // Valuation (ebitda_recasts cascades to ebitda_addbacks).
  `delete from ebitda_recasts where engagement_id = $1`,
  `delete from valuation_inputs where engagement_id = $1`,
  // Data room.
  `delete from engagement_data_room_items where engagement_id = $1`,
  // Outcomes (deal_outcomes references assessments → before assessments).
  `delete from deal_outcomes where engagement_id = $1`,
  `delete from outcome_events where engagement_id = $1`,
  `delete from engagement_outcomes where engagement_id = $1`,
  // Roadmap milestones reference gaps/tasks → before them.
  `delete from roadmap_milestones where engagement_id = $1`,
  // Institutional memory + instrumentation.
  `delete from engagement_log where engagement_id = $1`,
  `delete from usage_events where engagement_id = $1`,
  `delete from data_access_log where engagement_id = $1`,
  // Assessment sub-tree: gap/task/doc rows that reference assessments, then the
  // assessment-scoped rows, then the assessments themselves.
  `delete from tasks where engagement_id = $1`,
  `delete from gaps where engagement_id = $1`,
  `delete from answer_provenance where assessment_id in (select id from assessments where engagement_id = $1)`,
  `delete from answers where assessment_id in (select id from assessments where engagement_id = $1)`,
  `delete from sub_score_results where assessment_id in (select id from assessments where engagement_id = $1)`,
  `delete from dimension_scores where assessment_id in (select id from assessments where engagement_id = $1)`,
  `delete from generated_documents where engagement_id = $1`,
  `delete from assessments where engagement_id = $1`,
  // The blocking agreement acceptance.
  `delete from engagement_agreements where engagement_id = $1`,
];

// Best-effort count for the return summary / audit detail. Never blocks the
// delete: a counting hiccup must not leave an engagement half-removed.
async function countChildren(
  db: pg.ClientBase,
  engagementId: string,
): Promise<DeleteEngagementSummary['deleted']> {
  const one = async (sql: string): Promise<number> => {
    try {
      return Number((await db.query(sql, [engagementId])).rows[0]?.n ?? 0);
    } catch {
      return 0;
    }
  };
  return {
    assessments: await one(`select count(*)::int as n from assessments where engagement_id = $1`),
    gaps: await one(`select count(*)::int as n from gaps where engagement_id = $1`),
    tasks: await one(`select count(*)::int as n from tasks where engagement_id = $1`),
    documents: await one(`select count(*)::int as n from documents where engagement_id = $1`),
    generated_documents: await one(
      `select count(*)::int as n from generated_documents where engagement_id = $1`,
    ),
    log_entries: await one(`select count(*)::int as n from engagement_log where engagement_id = $1`),
    had_deal_outcome:
      (await one(`select count(*)::int as n from deal_outcomes where engagement_id = $1`)) > 0,
  };
}

// After the ordered deletes, prove nothing is left behind. Discovers EVERY table
// in the public schema that carries an engagement_id column and asserts it holds
// no rows for this engagement. If a future table adds engagement_id and isn't
// added to the teardown above, this fails loudly (rolling the whole delete back)
// instead of silently orphaning client data or letting the final DELETE fail with
// an opaque FK error.
async function assertNoOrphans(db: pg.ClientBase, engagementId: string): Promise<void> {
  const tables = (
    await db.query(
      `select table_name from information_schema.columns
       where table_schema = 'public' and column_name = 'engagement_id'
         and table_name <> 'engagements'`,
    )
  ).rows.map((r) => r.table_name as string);

  const offenders: string[] = [];
  for (const t of tables) {
    // table_name comes from information_schema (not user input); safe to inline.
    const left = (await db.query(`select 1 from "${t}" where engagement_id = $1 limit 1`, [engagementId]))
      .rowCount;
    if (left && left > 0) offenders.push(t);
  }
  if (offenders.length > 0) {
    throw new Error(
      `engagement teardown incomplete — rows remain in: ${offenders.join(', ')}. ` +
        `A table referencing engagement_id was added without updating the teardown in server/engagements.ts.`,
    );
  }
}

// Permanently delete an engagement and its entire subtree. firmId is trusted
// (resolved from the caller's advisor/admin profile upstream); the engagement is
// re-checked against it here as defence in depth. Returns a summary of what was
// removed. Throws (→ rollback) on any failure, including the orphan check.
export async function deleteEngagement(
  db: pg.ClientBase,
  firmId: string,
  actorUserId: string,
  engagementId: string,
): Promise<DeleteEngagementSummary> {
  const eng = (
    await db.query(`select id, firm_id, company_id from engagements where id = $1 and firm_id = $2`, [
      engagementId,
      firmId,
    ])
  ).rows[0];
  if (!eng) throw new Error('engagement not found');
  const companyId = eng.company_id as string;

  const deleted = await countChildren(db, engagementId);

  // Snapshot the document ids BEFORE teardown. The DB rows (and their document_blobs)
  // are removed by the transaction, but a Supabase Storage object is a side-effect
  // outside the DB and won't cascade — so we delete those objects after the commit.
  const docIds = (
    await db.query(`select id from documents where engagement_id = $1`, [engagementId])
  ).rows.map((r) => r.id as string);

  // The service connection autocommits per statement, so wrap the whole teardown
  // in one transaction: the engagement and its children go together or not at all.
  await db.query('begin');
  try {
    for (const sql of ENGAGEMENT_CHILD_DELETES) {
      await db.query(sql, [engagementId]);
    }
    await assertNoOrphans(db, engagementId);
    const gone = await db.query(`delete from engagements where id = $1 and firm_id = $2`, [
      engagementId,
      firmId,
    ]);
    if (gone.rowCount !== 1) throw new Error('engagement not found');
    await db.query('commit');
  } catch (e) {
    await db.query('rollback').catch(() => {});
    throw e;
  }

  // Audit the removal AFTER commit, with engagement_id null (the engagement — and
  // its own data_access_log rows — are gone); the ids live in `detail` so the
  // firm keeps a durable, compliance-readable record of what was destroyed.
  await logAccess(db, {
    firmId,
    actorUserId,
    action: 'engagement.delete',
    resourceType: 'engagement',
    resourceId: null,
    engagementId: null,
    detail: { engagement_id: engagementId, company_id: companyId, deleted },
  });

  // Clean up stored bytes that live outside the DB (Supabase bucket objects).
  // Best-effort and post-commit: a leftover object is a lesser evil than failing a
  // delete the client asked for. No-op for the DB backend (the blobs already
  // cascaded with the documents rows).
  const storage = resolveStorage();
  for (const documentId of docIds) {
    await storage.remove(db, { documentId, firmId }).catch(() => {});
  }

  return { engagement_id: engagementId, company_id: companyId, deleted };
}
