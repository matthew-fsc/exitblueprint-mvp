// Pipeline job + step contracts. A job owns one pipeline run for an engagement.
// The runner drives it step by step, persisting checkpoint between steps so a
// retry resumes where it left off. Steps are plain async functions of a context;
// they must be idempotent (safe to re-run) and checkpointed.
import type pg from 'pg';
import type { OntologyRegistry } from '../ontology/registry';
import type { LlmClient } from '../llm/client';
import type { JobStatus, PipelineStep } from '../../shared/intelligence/schemas';

export interface JobRow {
  id: string;
  firm_id: string;
  engagement_id: string;
  pipeline: string;
  step: string;
  status: JobStatus;
  attempts: number;
  // Resumable step state, persisted as JSONB. Steps read/merge their own slice;
  // values are anything JSON-serializable.
  checkpoint: Record<string, unknown>;
  last_error: string | null;
}

export interface StepContext {
  db: pg.ClientBase; // service-role client; the pipeline runs server-side
  job: JobRow;
  ontology: OntologyRegistry;
  llm?: LlmClient;
}

// A step may return a checkpoint patch (merged into job.checkpoint) and/or ask
// the runner to park the job pending human review.
export interface StepResult {
  checkpoint?: Record<string, unknown>;
  waitForReview?: boolean;
}

export type StepFn = (ctx: StepContext) => Promise<StepResult | void>;

// Thrown by steps that are declared in the pipeline but land in a later slice.
// The runner parks the job at that step (pending) rather than failing it.
export class NotImplementedError extends Error {
  readonly step: PipelineStep;
  constructor(step: PipelineStep) {
    super(`pipeline step '${step}' is not implemented in this build`);
    this.name = 'NotImplementedError';
    this.step = step;
  }
}
