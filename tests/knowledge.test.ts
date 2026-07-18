import { describe, expect, it } from 'vitest';
import { buildEngagementKnowledge } from '../src/lib/knowledge';

const gaps = [
  { id: 'g1', name: 'Owner Dependence', severity: 'critical' as const, status: 'open', playbookName: 'Owner Independence Program' },
  { id: 'g2', name: 'Weak Pricing Power', severity: 'med' as const, status: 'open', playbookName: null },
];
const tasks = [
  { gap_id: 'g1', status: 'done' },
  { gap_id: 'g1', status: 'todo' },
  { gap_id: 'g2', status: 'todo' },
  { gap_id: null, status: 'todo' }, // manual, unlinked
];
const log = [
  { id: 'l1', kind: 'rationale' as const, title: 'Sequenced owner-independence first', occurred_on: '2026-05-01', gap_id: 'g1' },
  { id: 'l2', kind: 'decision' as const, title: 'Hired a GM', occurred_on: '2026-06-01', gap_id: 'g1' },
  { id: 'l3', kind: 'meeting' as const, title: 'Kickoff', occurred_on: '2026-04-01', gap_id: null },
];

describe('buildEngagementKnowledge', () => {
  it('connects gap → recommendation → reasoning → progress, severity-ordered', () => {
    const k = buildEngagementKnowledge({ gaps, tasks, log });
    expect(k.chains.map((c) => c.gapId)).toEqual(['g1', 'g2']); // critical first
    const g1 = k.chains[0];
    expect(g1.recommendation).toBe('Owner Independence Program');
    expect(g1.done).toBe(1);
    expect(g1.total).toBe(2);
    expect(g1.reasoning.map((r) => r.id)).toEqual(['l2', 'l1']); // newest first
    expect(k.chains[1].recommendation).toBeNull();
    expect(k.chains[1].total).toBe(1);
  });

  it('separates unlinked reasoning and computes connectedPct', () => {
    const k = buildEngagementKnowledge({ gaps, tasks, log });
    expect(k.unlinkedReasoning.map((r) => r.id)).toEqual(['l3']);
    // 2 of 3 log entries tied to a gap → 67%
    expect(k.connectedPct).toBe(67);
  });

  it('reasoning tied to an unknown gap does not count as connected', () => {
    const k = buildEngagementKnowledge({
      gaps,
      tasks: [],
      log: [{ id: 'x', kind: 'note' as const, title: 'orphan', occurred_on: '2026-01-01', gap_id: 'gone' }],
    });
    expect(k.connectedPct).toBe(0);
    expect(k.unlinkedReasoning).toEqual([]); // it has a gap_id, just not a known one
  });

  it('handles empty inputs', () => {
    const k = buildEngagementKnowledge({ gaps: [], tasks: [], log: [] });
    expect(k.chains).toEqual([]);
    expect(k.connectedPct).toBe(0);
  });
});
