import { describe, expect, it } from 'vitest';
import { buildWorkstreamProgress, type WorkstreamInput } from '../src/lib/workstreams';

const base: WorkstreamInput = {
  assessed: false,
  inProgress: false,
  drsScore: null,
  openGapCount: null,
  tasksTotal: 0,
  tasksDone: 0,
  verifiedPct: null,
  valuationSet: false,
  valueGap: null,
  reportDraftCount: 0,
  reportFinalCount: 0,
};

const byKey = (i: WorkstreamInput) => Object.fromEntries(buildWorkstreamProgress(i).map((s) => [s.key, s]));

describe('buildWorkstreamProgress', () => {
  it('returns the five streams in arc order', () => {
    expect(buildWorkstreamProgress(base).map((s) => s.key)).toEqual([
      'readiness', 'remediation', 'evidence', 'value', 'deliverables',
    ]);
  });

  it('before any assessment: readiness is todo, everything downstream is blocked', () => {
    const s = byKey(base);
    expect(s.readiness.state).toBe('todo');
    expect(s.remediation.state).toBe('blocked');
    expect(s.evidence.state).toBe('blocked');
    expect(s.value.state).toBe('blocked');
    expect(s.deliverables.state).toBe('blocked');
  });

  it('an in-progress intake makes readiness active', () => {
    expect(byKey({ ...base, inProgress: true }).readiness.state).toBe('active');
  });

  it('a scored assessment makes readiness done and unblocks the rest', () => {
    const s = byKey({ ...base, assessed: true, drsScore: 72, openGapCount: 0, verifiedPct: 0 });
    expect(s.readiness.state).toBe('done');
    expect(s.readiness.headline).toBe('DRS 72');
    expect(s.remediation.state).toBe('done'); // no open gaps
    expect(s.evidence.state).toBe('todo'); // 0% verified, but assessed
    expect(s.value.state).toBe('todo');
    expect(s.deliverables.state).toBe('todo');
  });

  it('remediation: open gaps with no tasks is todo, with tasks is active', () => {
    expect(byKey({ ...base, assessed: true, openGapCount: 3, tasksTotal: 0 }).remediation).toMatchObject({
      state: 'todo', headline: '3 open gaps, no plan',
    });
    expect(byKey({ ...base, assessed: true, openGapCount: 3, tasksTotal: 8, tasksDone: 5 }).remediation).toMatchObject({
      state: 'active', headline: '5/8 tasks done',
    });
  });

  it('evidence: crosses to done at the 80% threshold', () => {
    expect(byKey({ ...base, assessed: true, openGapCount: 1, verifiedPct: 45 }).evidence.state).toBe('active');
    expect(byKey({ ...base, assessed: true, openGapCount: 1, verifiedPct: 80 }).evidence.state).toBe('done');
    expect(byKey({ ...base, assessed: true, openGapCount: 1, verifiedPct: 0 }).evidence.state).toBe('todo');
  });

  it('value: done once EV is modeled, showing the gap when positive', () => {
    const s = byKey({ ...base, assessed: true, openGapCount: 1, valuationSet: true, valueGap: 2_400_000 });
    expect(s.value.state).toBe('done');
    expect(s.value.headline).toBe('EV modeled · $2.4M gap');
  });

  it('deliverables: draft is active, finalized is done', () => {
    expect(byKey({ ...base, assessed: true, openGapCount: 1, reportDraftCount: 1 }).deliverables.state).toBe('active');
    expect(byKey({ ...base, assessed: true, openGapCount: 1, reportFinalCount: 1 }).deliverables.state).toBe('done');
  });

  it('singularizes the gap count', () => {
    expect(byKey({ ...base, assessed: true, openGapCount: 1, tasksTotal: 0 }).remediation.headline).toBe('1 open gap, no plan');
  });
});
