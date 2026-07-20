// In-app "Needs attention" surface (docs/35 Phase 9 — "in-app scheduling/
// notifications"). The continuous-evaluation analyzers in server/scheduled.ts
// power external n8n nudges, but until now there was no IN-PRODUCT worklist: an
// advisor had to wait for an email instead of opening the app and seeing what
// needs doing. This composes the same three analyzers, scoped to the caller's own
// firm, into one payload the advisor dashboard renders.
//
// Read-only and firm-scoped: firmId is resolved from the caller's profile upstream
// (scope 'firm'), then passed to the analyzers' firm-scoped SQL. Never writes a
// score, never mutates an assessment (rules 4 & 5) — it reports that a
// re-assessment is due, it does not create one.
import type pg from 'pg';
import {
  findReassessmentDue,
  findStaleEngagements,
  findStalledTasks,
  type ReassessmentDueItem,
  type StaleEngagementItem,
  type StalledTaskItem,
} from './scheduled';

export interface FirmAttention {
  generatedAt: string;
  thresholds: { staleDays: number; stalledDays: number; reassessDays: number };
  counts: { reassessmentDue: number; stalledTasks: number; staleEngagements: number; total: number };
  reassessmentDue: ReassessmentDueItem[];
  stalledTasks: StalledTaskItem[];
  staleEngagements: StaleEngagementItem[];
}

export async function firmAttention(
  db: pg.ClientBase,
  firmId: string,
  opts: { staleDays?: number; stalledDays?: number; reassessDays?: number } = {},
): Promise<FirmAttention> {
  const [reassess, stalled, stale] = await Promise.all([
    findReassessmentDue(db, { firmId, reassessDays: opts.reassessDays }),
    findStalledTasks(db, { firmId, stalledDays: opts.stalledDays }),
    findStaleEngagements(db, { firmId, staleDays: opts.staleDays }),
  ]);

  return {
    generatedAt: reassess.generatedAt,
    thresholds: {
      staleDays: stale.thresholdDays,
      stalledDays: stalled.thresholdDays,
      reassessDays: reassess.thresholdDays,
    },
    counts: {
      reassessmentDue: reassess.count,
      stalledTasks: stalled.count,
      staleEngagements: stale.count,
      total: reassess.count + stalled.count + stale.count,
    },
    reassessmentDue: reassess.items,
    stalledTasks: stalled.items,
    staleEngagements: stale.items,
  };
}
