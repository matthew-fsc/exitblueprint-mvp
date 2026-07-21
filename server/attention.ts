// In-app "Needs attention" surface (docs/archive/35 Phase 9 — "in-app scheduling/
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
  findReassessmentReady,
  findStaleEngagements,
  findStalledTasks,
  type ReassessmentDueItem,
  type ReassessmentReadyItem,
  type StaleEngagementItem,
  type StalledTaskItem,
} from './scheduled';

export interface FirmAttention {
  generatedAt: string;
  thresholds: { staleDays: number; stalledDays: number; reassessDays: number };
  counts: {
    reassessmentReady: number;
    reassessmentDue: number;
    stalledTasks: number;
    staleEngagements: number;
    total: number;
  };
  // "Properly placed" reassessments — a Plan's work finished since the last
  // measurement (docs/37 PL4). Listed first: it's the timeliest, most actionable
  // signal, ahead of the time-cadence "due" list.
  reassessmentReady: ReassessmentReadyItem[];
  reassessmentDue: ReassessmentDueItem[];
  stalledTasks: StalledTaskItem[];
  staleEngagements: StaleEngagementItem[];
}

export async function firmAttention(
  db: pg.ClientBase,
  firmId: string,
  opts: { staleDays?: number; stalledDays?: number; reassessDays?: number } = {},
): Promise<FirmAttention> {
  const [ready, reassess, stalled, stale] = await Promise.all([
    findReassessmentReady(db, { firmId }),
    findReassessmentDue(db, { firmId, reassessDays: opts.reassessDays }),
    findStalledTasks(db, { firmId, stalledDays: opts.stalledDays }),
    findStaleEngagements(db, { firmId, staleDays: opts.staleDays }),
  ]);

  // An engagement that is reassessment-READY shouldn't also be double-counted as
  // time-cadence DUE — the ready signal supersedes the clock for those.
  const readyEngagements = new Set(ready.items.map((r) => r.engagementId));
  const dueOnly = reassess.items.filter((d) => !readyEngagements.has(d.engagementId));

  return {
    generatedAt: reassess.generatedAt,
    thresholds: {
      staleDays: stale.thresholdDays,
      stalledDays: stalled.thresholdDays,
      reassessDays: reassess.thresholdDays,
    },
    counts: {
      reassessmentReady: ready.count,
      reassessmentDue: dueOnly.length,
      stalledTasks: stalled.count,
      staleEngagements: stale.count,
      total: ready.count + dueOnly.length + stalled.count + stale.count,
    },
    reassessmentReady: ready.items,
    reassessmentDue: dueOnly,
    stalledTasks: stalled.items,
    staleEngagements: stale.items,
  };
}
