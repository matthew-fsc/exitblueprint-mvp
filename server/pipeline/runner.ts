// The job runner. Drives a job through the pipeline one step at a time,
// persisting the checkpoint after each step so a crash or retry resumes at the
// current step rather than the start. No Temporal — state lives in the jobs row.
import type pg from 'pg';
import { PIPELINE_STEPS, type Json } from '../../shared/intelligence/schemas';
import { loadOntology, type OntologyRegistry } from '../ontology/registry';
import type { LlmClient } from '../llm/client';
import { STEP_HANDLERS } from './steps';
import { NotImplementedError, type JobRow } from './types';

export const DEFAULT_PIPELINE = 'sellside_intake';

export interface CreateJobInput {
  firmId: string;
  engagementId: string;
  pipeline?: string;
  // Self-reported questionnaire answers reconcile compares against, keyed by the
  // fact_key they correspond to. Stored in the checkpoint at creation.
  selfReported?: Record<string, Json>;
}

export async function createJob(db: pg.ClientBase, input: CreateJobInput): Promise<string> {
  const checkpoint = input.selfReported ? { self_reported: input.selfReported } : {};
  const row = await db.query(
    `insert into jobs (firm_id, engagement_id, pipeline, step, status, checkpoint)
     values ($1, $2, $3, $4, 'pending', $5) returning id`,
    [
      input.firmId,
      input.engagementId,
      input.pipeline ?? DEFAULT_PIPELINE,
      PIPELINE_STEPS[0],
      JSON.stringify(checkpoint),
    ],
  );
  return row.rows[0].id as string;
}

async function loadJob(db: pg.ClientBase, jobId: string): Promise<JobRow> {
  const row = await db.query(`select * from jobs where id = $1`, [jobId]);
  if (row.rowCount !== 1) throw new Error(`job ${jobId} not found`);
  return row.rows[0] as JobRow;
}

async function persist(
  db: pg.ClientBase,
  job: JobRow,
  patch: Partial<Pick<JobRow, 'step' | 'status' | 'attempts' | 'last_error'>> & {
    finished?: boolean;
    started?: boolean;
  },
): Promise<void> {
  await db.query(
    `update jobs set
       step = $2, status = $3, attempts = $4, last_error = $5, checkpoint = $6,
       updated_at = now(),
       started_at = case when $7 then now() else started_at end,
       finished_at = case when $8 then now() else finished_at end
     where id = $1`,
    [
      job.id,
      patch.step ?? job.step,
      patch.status ?? job.status,
      patch.attempts ?? job.attempts,
      patch.last_error ?? null,
      JSON.stringify(job.checkpoint),
      patch.started ?? false,
      patch.finished ?? false,
    ],
  );
}

export interface RunOptions {
  ontology?: OntologyRegistry;
  llm?: LlmClient;
}

// Run the job from its current step to completion, a review park, or an
// unimplemented step. Returns the final job state. Re-invoking after a failure
// or a NotImplemented park resumes from the same step.
export async function runJob(
  db: pg.ClientBase,
  jobId: string,
  opts: RunOptions = {},
): Promise<JobRow> {
  const ontology = opts.ontology ?? loadOntology();
  let job = await loadJob(db, jobId);
  if (job.status === 'completed') return job;

  const startIndex = PIPELINE_STEPS.indexOf(job.step as (typeof PIPELINE_STEPS)[number]);
  if (startIndex < 0) throw new Error(`job ${jobId} at unknown step ${job.step}`);

  await persist(db, job, { status: 'running', started: true });

  for (let i = startIndex; i < PIPELINE_STEPS.length; i++) {
    const step = PIPELINE_STEPS[i];
    job.step = step;
    const handler = STEP_HANDLERS[step];
    try {
      const result = await handler({ db, job, ontology, llm: opts.llm });
      if (result?.checkpoint) job.checkpoint = { ...job.checkpoint, ...result.checkpoint };

      const isLast = i === PIPELINE_STEPS.length - 1;
      if (result?.waitForReview) {
        const next = isLast ? step : PIPELINE_STEPS[i + 1];
        job.step = next;
        job.status = 'waiting_review';
        await persist(db, job, { step: next, status: 'waiting_review' });
        return job;
      }
      if (isLast) {
        job.status = 'completed';
        await persist(db, job, { step, status: 'completed', finished: true });
        return job;
      }
      // Advance the pointer to the next step and persist progress.
      const next = PIPELINE_STEPS[i + 1];
      job.step = next;
      await persist(db, job, { step: next, status: 'running' });
    } catch (err) {
      if (err instanceof NotImplementedError) {
        // Park at the unimplemented step; a later slice implements it and resumes.
        job.status = 'pending';
        await persist(db, job, { step, status: 'pending' });
        return job;
      }
      job.attempts += 1;
      job.status = 'failed';
      await persist(db, job, {
        step,
        status: 'failed',
        attempts: job.attempts,
        last_error: (err as Error).message,
      });
      throw err;
    }
  }
  return job;
}

// Automation-ratio KPI per engagement: how many reconciled fields resolved
// automatically vs needed a human (a pending/escalated review item). Exposed by
// the metrics endpoint (built in the review API slice).
export interface EngagementMetrics {
  reconciled_total: number;
  auto_resolved: number;
  human_required: number;
  automation_ratio: number; // auto / total, 0..1
}

export async function engagementMetrics(
  db: pg.ClientBase,
  engagementId: string,
): Promise<EngagementMetrics> {
  const total = Number(
    (
      await db.query(`select count(*)::int as n from assessment_values where engagement_id = $1`, [
        engagementId,
      ])
    ).rows[0].n,
  );
  const human = Number(
    (
      await db.query(
        `select count(*)::int as n from review_items
          where engagement_id = $1 and type in ('conflict', 'low_confidence_extraction')
            and status in ('pending', 'in_review', 'escalated')`,
        [engagementId],
      )
    ).rows[0].n,
  );
  const auto = Math.max(0, total - human);
  return {
    reconciled_total: total,
    auto_resolved: auto,
    human_required: human,
    automation_ratio: total === 0 ? 1 : auto / total,
  };
}
