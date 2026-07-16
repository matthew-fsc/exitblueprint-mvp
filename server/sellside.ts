// Orchestrates a verification run for an engagement: run the document pipeline
// (intake → reconcile; parks at the still-stubbed score step) and then the
// findings patterns, returning a summary for the Verification tab. Runs with the
// service client after the router authorizes the engagement. Self-reported
// answers are not yet wired from the assessment, so reconciliation resolves
// against documents alone (conflicts still surface once that mapping lands).
import type pg from 'pg';
import { createJob, runJob, engagementMetrics, type EngagementMetrics } from './pipeline/runner';
import { runFindings } from './findings/run';

export interface VerificationSummary {
  job: { id: string; step: string; status: string };
  metrics: EngagementMetrics;
  findings: number;
}

export async function runEngagementVerification(
  service: pg.ClientBase,
  firmId: string,
  engagementId: string,
): Promise<VerificationSummary> {
  const jobId = await createJob(service, { firmId, engagementId });
  const job = await runJob(service, jobId);
  const { findings } = await runFindings(service, firmId, engagementId);
  const metrics = await engagementMetrics(service, engagementId);
  return {
    job: { id: job.id, step: job.step, status: job.status },
    metrics,
    findings,
  };
}
