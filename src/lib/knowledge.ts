// Engagement knowledge chain (docs/20/21 Category B): connect the institutional
// record the platform already holds — the gap (a preparation risk) → the
// recommendation (its playbook) → the advisor's reasoning (engagement_log) → the
// progress (tasks) — into one connected view instead of isolated records.
//
// Deterministic assembly over source tables (the advisory layer of the knowledge
// graph), NOT a duplicate written into the document-verified graph_nodes/edges.
// Pure and unit-tested (tests/knowledge.test.ts).

export interface KnowledgeGap {
  id: string;
  name: string;
  severity: 'critical' | 'high' | 'med' | 'low';
  status: string;
  playbookName?: string | null;
}
export interface KnowledgeTask {
  gap_id: string | null;
  status: string;
}
export interface KnowledgeLogEntry {
  id: string;
  kind: 'meeting' | 'decision' | 'rationale' | 'note';
  title: string;
  occurred_on: string;
  gap_id: string | null;
}

export interface KnowledgeChain {
  gapId: string;
  gapName: string;
  severity: KnowledgeGap['severity'];
  status: string;
  recommendation: string | null; // the playbook that addresses the gap
  done: number;
  total: number;
  reasoning: KnowledgeLogEntry[]; // the advisor's logged "why", tied to this gap
}

export interface EngagementKnowledge {
  chains: KnowledgeChain[];
  /** Log entries not tied to any gap (general meetings/notes). */
  unlinkedReasoning: KnowledgeLogEntry[];
  /** How much of the reasoning is connected to a specific recommendation. */
  connectedPct: number;
}

const SEV_RANK: Record<KnowledgeGap['severity'], number> = { critical: 0, high: 1, med: 2, low: 3 };

export function buildEngagementKnowledge(input: {
  gaps: KnowledgeGap[];
  tasks: KnowledgeTask[];
  log: KnowledgeLogEntry[];
}): EngagementKnowledge {
  const { gaps, tasks, log } = input;

  const chains: KnowledgeChain[] = gaps
    .map((gap) => {
      const gapTasks = tasks.filter((t) => t.gap_id === gap.id);
      const reasoning = log
        .filter((l) => l.gap_id === gap.id)
        .sort((a, b) => (a.occurred_on < b.occurred_on ? 1 : -1));
      return {
        gapId: gap.id,
        gapName: gap.name,
        severity: gap.severity,
        status: gap.status,
        recommendation: gap.playbookName ?? null,
        done: gapTasks.filter((t) => t.status === 'done').length,
        total: gapTasks.length,
        reasoning,
      };
    })
    .sort((a, b) => (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9));

  const unlinkedReasoning = log
    .filter((l) => !l.gap_id)
    .sort((a, b) => (a.occurred_on < b.occurred_on ? 1 : -1));

  const linked = log.filter((l) => l.gap_id && gaps.some((g) => g.id === l.gap_id)).length;
  const connectedPct = log.length === 0 ? 0 : Math.round((linked / log.length) * 100);

  return { chains, unlinkedReasoning, connectedPct };
}
