// Orchestrates a verification run for an engagement: load the owner's
// self-reported financials from the current assessment, run the document
// pipeline (intake → reconcile; parks at the still-stubbed score step), then the
// findings patterns, returning a summary for the Verification tab. Runs with the
// service client after the router authorizes the engagement.
//
// The self-reported side is loaded here and passed into the job so reconcile
// performs a genuine self-vs-verified comparison (numeric tolerance). This is
// provenance/review only — it NEVER writes a score or mutates an `answers` row.
import type pg from 'pg';
import type { Json } from '../shared/intelligence/schemas';
import { createJob, runJob, engagementMetrics, type EngagementMetrics } from './pipeline/runner';
import { ASSESSMENT_FIELD_MAP, selectSelfValue } from './pipeline/field-map';
import { runFindings } from './findings/run';

export interface VerificationSummary {
  job: { id: string; step: string; status: string };
  metrics: EngagementMetrics;
  findings: number;
}

// Load the engagement's self-reported answers for the reconciled fields, keyed by
// the fact_key reconcile compares against (checkpoint.self_reported). Read-only.
//
// Direct DB read: scoring.ts owns loadAnswers but does not export it, and that
// file is off-limits to this change, so we issue the read here following the
// existing query style (join answers → questions on the latest completed
// assessment). Reported as a direct read in the change notes.
async function loadSelfReported(
  db: pg.ClientBase,
  engagementId: string,
): Promise<Record<string, Json>> {
  // Question codes we need answers for, per the field map (skip extractable-only).
  const codes = Array.from(
    new Set(
      Object.values(ASSESSMENT_FIELD_MAP)
        .map((m) => m.questionCode)
        .filter((c): c is string => c !== null),
    ),
  );
  if (codes.length === 0) return {};

  // The current assessment = the latest completed one (matches advisory.ts).
  const assessment = (
    await db.query(
      `select id from assessments
        where engagement_id = $1 and status = 'completed'
        order by completed_at desc nulls last, created_at desc
        limit 1`,
      [engagementId],
    )
  ).rows[0];
  if (!assessment) return {};

  const answers = (
    await db.query(
      `select q.code, a.value
         from answers a
         join questions q on q.id = a.question_id
        where a.assessment_id = $1 and q.code = any($2)`,
      [assessment.id, codes],
    )
  ).rows as Array<{ code: string; value: Json }>;
  const byCode = new Map<string, Json>(answers.map((r) => [r.code, r.value]));

  // Reduce each answer to the scalar its singleton fact compares against and key
  // it by fact_key, which is what reconcile reads out of the checkpoint.
  const selfReported: Record<string, Json> = {};
  for (const [factKey, mapping] of Object.entries(ASSESSMENT_FIELD_MAP)) {
    if (!mapping.questionCode || !byCode.has(mapping.questionCode)) continue;
    const scalar = selectSelfValue(byCode.get(mapping.questionCode), mapping.listSelect);
    if (scalar === undefined || scalar === null) continue;
    selfReported[factKey] = scalar as Json;
  }
  return selfReported;
}

export async function runEngagementVerification(
  service: pg.ClientBase,
  firmId: string,
  engagementId: string,
): Promise<VerificationSummary> {
  const selfReported = await loadSelfReported(service, engagementId);
  const jobId = await createJob(service, {
    firmId,
    engagementId,
    selfReported: Object.keys(selfReported).length > 0 ? selfReported : undefined,
  });
  const job = await runJob(service, jobId);
  const { findings } = await runFindings(service, firmId, engagementId);
  const metrics = await engagementMetrics(service, engagementId);
  return {
    job: { id: job.id, step: job.step, status: job.status },
    metrics,
    findings,
  };
}
