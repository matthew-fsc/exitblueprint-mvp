// Portfolio dashboard row assembly (F2 / build-plan S10). The regression these
// tests lock down is a SILENT FAILURE: before the fix, the "Δ since prior"
// column subtracted two DRS scores unconditionally, so when the prior assessment
// was scored under a different rubric_version the advisor saw a real-looking
// movement number that means nothing (the scores are not on the same scale).
// S10 is explicit that this case must surface distinctly, "never blank or zero".
import { describe, expect, it } from 'vitest';
import {
  buildPortfolioRows,
  type PortfolioAssessmentInput,
  type PortfolioCompanyInput,
  type PortfolioEngagementInput,
} from '../src/lib/portfolio';

const company = (id: string, name: string): PortfolioCompanyInput => ({ id, name, industry: 'Manufacturing' });
const engagement = (id: string, companyId: string): PortfolioEngagementInput => ({
  id,
  company_id: companyId,
  status: 'active',
});
const assessment = (
  over: Partial<PortfolioAssessmentInput> & Pick<PortfolioAssessmentInput, 'engagement_id' | 'sequence_number'>,
): PortfolioAssessmentInput => ({
  id: `a-${over.engagement_id}-${over.sequence_number}`,
  rubric_version_id: 'rv1',
  status: 'completed',
  completed_at: '2026-01-01T00:00:00Z',
  drs_score: 60,
  drs_tier: 'Approaching Ready',
  ori_score: 55,
  ...over,
});

describe('buildPortfolioRows — delta is rubric-version-aware', () => {
  it('computes a numeric delta when prior and latest share a rubric_version', () => {
    const rows = buildPortfolioRows(
      [engagement('e1', 'c1')],
      [company('c1', 'Meridian')],
      [
        assessment({ engagement_id: 'e1', sequence_number: 1, drs_score: 55, rubric_version_id: 'rv1' }),
        assessment({ engagement_id: 'e1', sequence_number: 2, drs_score: 61, rubric_version_id: 'rv1' }),
      ],
      [],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].deltaState).toBe('value');
    expect(rows[0].delta).toBe(6);
    expect(rows[0].latestDrs).toBe(61);
    expect(rows[0].priorDrs).toBe(55);
  });

  it('rounds the delta to one decimal, like the prior implementation', () => {
    const rows = buildPortfolioRows(
      [engagement('e1', 'c1')],
      [company('c1', 'Meridian')],
      [
        assessment({ engagement_id: 'e1', sequence_number: 1, drs_score: 55.05 }),
        assessment({ engagement_id: 'e1', sequence_number: 2, drs_score: 61.2 }),
      ],
      [],
    );
    expect(rows[0].delta).toBe(6.2);
  });

  it('marks the row incomparable — NOT a number — when the prior is on a different rubric_version', () => {
    const rows = buildPortfolioRows(
      [engagement('e1', 'c1')],
      [company('c1', 'Meridian')],
      [
        assessment({ engagement_id: 'e1', sequence_number: 1, drs_score: 55, rubric_version_id: 'rv1' }),
        assessment({ engagement_id: 'e1', sequence_number: 2, drs_score: 61, rubric_version_id: 'rv2' }),
      ],
      [],
    );
    // The silent failure would have produced delta === 6 here. It must not.
    expect(rows[0].deltaState).toBe('incomparable');
    expect(rows[0].delta).toBeNull();
    // The current level is still shown; only the movement is withheld.
    expect(rows[0].latestDrs).toBe(61);
  });

  it('reports no delta (state "none") for an engagement with a single assessment', () => {
    const rows = buildPortfolioRows(
      [engagement('e1', 'c1')],
      [company('c1', 'Meridian')],
      [assessment({ engagement_id: 'e1', sequence_number: 1, drs_score: 60 })],
      [],
    );
    expect(rows[0].deltaState).toBe('none');
    expect(rows[0].delta).toBeNull();
    expect(rows[0].priorDrs).toBeNull();
  });

  it('picks latest/prior by sequence_number regardless of input order', () => {
    const rows = buildPortfolioRows(
      [engagement('e1', 'c1')],
      [company('c1', 'Meridian')],
      [
        assessment({ engagement_id: 'e1', sequence_number: 3, drs_score: 70, drs_tier: 'Sale Ready' }),
        assessment({ engagement_id: 'e1', sequence_number: 1, drs_score: 50 }),
        assessment({ engagement_id: 'e1', sequence_number: 2, drs_score: 60 }),
      ],
      [],
    );
    expect(rows[0].latestDrs).toBe(70);
    expect(rows[0].latestTier).toBe('Sale Ready');
    expect(rows[0].priorDrs).toBe(60);
    expect(rows[0].delta).toBe(10);
    expect(rows[0].points.map((p) => p.drs)).toEqual([50, 60, 70]);
    expect(rows[0].assessmentCount).toBe(3);
  });
});

describe('buildPortfolioRows — counts and joins', () => {
  it('counts open gaps per engagement and leaves others at zero', () => {
    const rows = buildPortfolioRows(
      [engagement('e1', 'c1'), engagement('e2', 'c2')],
      [company('c1', 'Meridian'), company('c2', 'Apex')],
      [
        assessment({ engagement_id: 'e1', sequence_number: 1 }),
        assessment({ engagement_id: 'e2', sequence_number: 1 }),
      ],
      [
        { engagement_id: 'e1', status: 'open' },
        { engagement_id: 'e1', status: 'in_remediation' },
      ],
    );
    const byId = Object.fromEntries(rows.map((r) => [r.engagementId, r]));
    expect(byId.e1.openGaps).toBe(2);
    expect(byId.e2.openGaps).toBe(0);
  });

  it('counts open tasks and the overdue subset, ignoring done tasks', () => {
    const rows = buildPortfolioRows(
      [engagement('e1', 'c1'), engagement('e2', 'c2')],
      [company('c1', 'Meridian'), company('c2', 'Apex')],
      [
        assessment({ engagement_id: 'e1', sequence_number: 1 }),
        assessment({ engagement_id: 'e2', sequence_number: 1 }),
      ],
      [],
      [
        { engagement_id: 'e1', status: 'todo', due_date: '2026-01-01' }, // overdue vs today
        { engagement_id: 'e1', status: 'doing', due_date: '2026-12-31' }, // open, not overdue
        { engagement_id: 'e1', status: 'done', due_date: '2026-01-01' }, // done — ignored
        { engagement_id: 'e2', status: 'blocked', due_date: null }, // open, no due date
      ],
      '2026-06-01',
    );
    const byId = Object.fromEntries(rows.map((r) => [r.engagementId, r]));
    expect(byId.e1.openTasks).toBe(2);
    expect(byId.e1.overdueTasks).toBe(1);
    expect(byId.e2.openTasks).toBe(1);
    expect(byId.e2.overdueTasks).toBe(0);
  });

  it('leaves task counts at zero when no tasks are supplied', () => {
    const rows = buildPortfolioRows(
      [engagement('e1', 'c1')],
      [company('c1', 'Meridian')],
      [assessment({ engagement_id: 'e1', sequence_number: 1 })],
      [],
    );
    expect(rows[0].openTasks).toBe(0);
    expect(rows[0].overdueTasks).toBe(0);
  });

  it('renders an engagement with no assessments as an empty shell (no crash, nulls)', () => {
    const rows = buildPortfolioRows(
      [engagement('e1', 'c1')],
      [company('c1', 'Meridian')],
      [],
      [],
    );
    expect(rows[0]).toMatchObject({
      companyName: 'Meridian',
      latestDrs: null,
      latestTier: null,
      delta: null,
      deltaState: 'none',
      assessmentCount: 0,
      points: [],
    });
  });

  it('falls back to an em dash when the company row is missing', () => {
    const rows = buildPortfolioRows(
      [engagement('e1', 'missing-company')],
      [],
      [assessment({ engagement_id: 'e1', sequence_number: 1 })],
      [],
    );
    expect(rows[0].companyName).toBe('—');
  });
});
