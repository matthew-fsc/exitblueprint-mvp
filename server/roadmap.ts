// Roadmap generation. Playbooks are retired (docs/06): a gap links to a
// remediation Plan (gap_plan_map), and generating the roadmap AUTO-APPLIES every
// Plan whose content is majority-applicable to the engagement's open gaps
// (server/plans.ts autoApplyQualifyingPlans). Applying a Plan is now the SOLE
// path that lays tasks onto the roadmap — there is no separate gap→task loop.
// Kept under this name/signature so callers (registry generate-roadmap,
// scripts/seed-demo) need no change.
import type pg from 'pg';
import { autoApplyQualifyingPlans, type AutoAppliedPlanSummary } from './plans';

export interface RoadmapResult {
  tasksCreated: number;
  plansApplied: AutoAppliedPlanSummary[];
}

export async function instantiateTasksForGaps(
  db: pg.ClientBase,
  engagementId: string,
  anchorDate?: string | null,
  userId?: string | null,
): Promise<RoadmapResult> {
  const auto = await autoApplyQualifyingPlans(db, engagementId, userId ?? null, anchorDate ?? null);
  const tasksCreated = auto.applied.reduce((n, p) => n + p.tasks_created, 0);
  return { tasksCreated, plansApplied: auto.applied };
}
