// Workflow Engine: self-serve engagement data export (docs/archive/35 Phase 9 —
// "self-serve data export/purge"). The purge half already exists (deleteEngagement);
// this is the export half: a firm can take a full, portable copy of an engagement's
// data out of the platform — for a client's "give us our data" request, a backup,
// or migration — without a developer running SQL.
//
// Staff-only and firm-scoped (same authorization surface as the delete: the person
// who can remove the data can export it). Read-only — it never writes a score or
// mutates anything (rules 1–5 untouched). Runs with the service client (RLS
// bypassed) AFTER the caller's firm ownership of the engagement is verified
// upstream; firmId is re-checked here as defence in depth.
//
// What it includes: the engagement's business substance — company, assessments and
// their inputs/scores, gaps, roadmap tasks/milestones, valuation, data room,
// outcomes, the engagement log, and the generated report TEXT. Documents are
// exported as METADATA ONLY (filename/category/status) — the encrypted bytes are
// intentionally excluded (large, binary, and downloadable individually through the
// signed-URL path). Internal instrumentation (usage_events, data_access_log,
// llm_calls) is operational telemetry, not engagement data, and is excluded.
import type pg from 'pg';

export interface EngagementExport {
  schema_version: 1;
  generated_at: string;
  firm: { id: string; name: string | null };
  company: Record<string, unknown> | null;
  engagement: Record<string, unknown> | null;
  assessments: Record<string, unknown>[];
  answers: Record<string, unknown>[];
  dimension_scores: Record<string, unknown>[];
  sub_score_results: Record<string, unknown>[];
  gaps: Record<string, unknown>[];
  tasks: Record<string, unknown>[];
  roadmap_milestones: Record<string, unknown>[];
  valuation_inputs: Record<string, unknown>[];
  ebitda_recasts: Record<string, unknown>[];
  data_room_items: Record<string, unknown>[];
  deal_outcomes: Record<string, unknown>[];
  engagement_outcomes: Record<string, unknown>[];
  engagement_log: Record<string, unknown>[];
  generated_documents: Record<string, unknown>[];
  documents: Record<string, unknown>[]; // metadata only
  counts: Record<string, number>;
}

// Read every row of `table` for this engagement. table names are literals from
// this module (never user input), so inlining them is safe.
async function byEngagement(db: pg.ClientBase, table: string, engagementId: string): Promise<Record<string, unknown>[]> {
  const r = await db.query(`select * from ${table} where engagement_id = $1`, [engagementId]);
  return r.rows;
}

// Read assessment-scoped rows (no engagement_id column) via the engagement's
// assessments.
async function byAssessment(db: pg.ClientBase, table: string, engagementId: string): Promise<Record<string, unknown>[]> {
  const r = await db.query(
    `select * from ${table} where assessment_id in (select id from assessments where engagement_id = $1)`,
    [engagementId],
  );
  return r.rows;
}

export async function exportEngagement(
  db: pg.ClientBase,
  firmId: string,
  engagementId: string,
): Promise<EngagementExport> {
  const engagement = (
    await db.query(`select * from engagements where id = $1 and firm_id = $2`, [engagementId, firmId])
  ).rows[0] as Record<string, unknown> | undefined;
  if (!engagement) throw new Error('engagement not found');

  const company = (
    await db.query(`select * from companies where id = $1`, [engagement.company_id])
  ).rows[0] ?? null;
  const firmName = (await db.query(`select name from firms where id = $1`, [firmId])).rows[0]?.name ?? null;

  const [
    assessments,
    answers,
    dimension_scores,
    sub_score_results,
    gaps,
    tasks,
    roadmap_milestones,
    valuation_inputs,
    ebitda_recasts,
    data_room_items,
    deal_outcomes,
    engagement_outcomes,
    engagement_log,
    generated_documents,
    documents,
  ] = await Promise.all([
    byEngagement(db, 'assessments', engagementId),
    byAssessment(db, 'answers', engagementId),
    byAssessment(db, 'dimension_scores', engagementId),
    byAssessment(db, 'sub_score_results', engagementId),
    byEngagement(db, 'gaps', engagementId),
    byEngagement(db, 'tasks', engagementId),
    byEngagement(db, 'roadmap_milestones', engagementId),
    byEngagement(db, 'valuation_inputs', engagementId),
    byEngagement(db, 'ebitda_recasts', engagementId),
    byEngagement(db, 'engagement_data_room_items', engagementId),
    byEngagement(db, 'deal_outcomes', engagementId),
    byEngagement(db, 'engagement_outcomes', engagementId),
    byEngagement(db, 'engagement_log', engagementId),
    byEngagement(db, 'generated_documents', engagementId),
    // Documents: metadata only — never the encrypted bytes.
    db
      .query(
        `select id, engagement_id, category, original_filename, mime_type, status, scan_status, created_at
         from documents where engagement_id = $1`,
        [engagementId],
      )
      .then((r) => r.rows),
  ]);

  const counts: Record<string, number> = {
    assessments: assessments.length,
    gaps: gaps.length,
    tasks: tasks.length,
    generated_documents: generated_documents.length,
    documents: documents.length,
    engagement_log: engagement_log.length,
  };

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    firm: { id: firmId, name: firmName },
    company,
    engagement,
    assessments,
    answers,
    dimension_scores,
    sub_score_results,
    gaps,
    tasks,
    roadmap_milestones,
    valuation_inputs,
    ebitda_recasts,
    data_room_items,
    deal_outcomes,
    engagement_outcomes,
    engagement_log,
    generated_documents,
    documents,
    counts,
  };
}
