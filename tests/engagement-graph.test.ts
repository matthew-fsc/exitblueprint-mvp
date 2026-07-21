// Unit test for the engagement-graph effectiveness analytics (docs/09 moat 3). No
// live DB: a fake pg client returns canned rows for the single resolved-gap query,
// so we exercise the pure aggregation, the same-rubric-version guard, and the
// numeric coercion — without a database. Firm isolation of the underlying rows is
// enforced by RLS and proven live in scripts/rls-test.ts.
import { describe, it, expect } from 'vitest';
import { engagementGraph } from '../server/engagement-graph';
import type pg from 'pg';

// Map a substring of the SQL to the rows that query should return.
function fakeDb(routes: Array<[string, Record<string, unknown>[]]>): pg.ClientBase {
  return {
    query: async (text: string) => {
      for (const [needle, rows] of routes) {
        if (text.includes(needle)) return { rows } as never;
      }
      return { rows: [] } as never;
    },
  } as unknown as pg.ClientBase;
}

// A resolved-gap "clear" row as the SQL would return it. Numeric columns arrive as
// strings from pg, matching production coercion.
function clear(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    engagement_id: 'e1',
    gap_code: 'OWNER_DEP',
    gap_name: 'Owner dependence',
    severity: 'high',
    dimension_code: 'OWNER_INDEPENDENCE',
    current_assessment_id: 'a2',
    current_rubric: 'rv1',
    prior_assessment_id: 'a1',
    prior_rubric: 'rv1',
    current_drs: '72.0',
    prior_drs: '68.0',
    current_dim: '80',
    prior_dim: '60',
    outcome: null,
    final_multiple: null,
    ...over,
  };
}

describe('engagementGraph', () => {
  it('aggregates DRS and dimension movement per cleared gap, and associates closed-deal multiples', async () => {
    const db = fakeDb([
      [
        'from gaps g',
        [
          // OWNER_DEP cleared twice (same rubric): DRS +4.0 and +6.0 -> avg 5.0;
          // dimension +20 and +10 -> avg 15; one engagement closed at 5.2x.
          clear({ current_drs: '72.0', prior_drs: '68.0', current_dim: '80', prior_dim: '60' }),
          clear({
            engagement_id: 'e2',
            current_assessment_id: 'b2',
            prior_assessment_id: 'b1',
            current_drs: '70.0',
            prior_drs: '64.0',
            current_dim: '75',
            prior_dim: '65',
            outcome: 'closed',
            final_multiple: '5.2',
          }),
          // A different gap cleared once with a smaller DRS move -> sorts below.
          clear({
            gap_code: 'CUSTOMER_CONC',
            gap_name: 'Customer concentration',
            dimension_code: 'REVENUE_QUALITY',
            engagement_id: 'e3',
            current_assessment_id: 'c2',
            prior_assessment_id: 'c1',
            current_drs: '61.0',
            prior_drs: '60.0',
            current_dim: '55',
            prior_dim: '50',
          }),
        ],
      ],
    ]);

    const g = await engagementGraph(db, 'firm-1');

    expect(g.firm_id).toBe('firm-1');
    expect(g.gaps_cleared).toBe(3);
    expect(g.incomparable_clears).toBe(0);

    // Sorted most-DRS-movement first: OWNER_DEP (5.0) before CUSTOMER_CONC (1.0).
    expect(g.effectiveness.map((e) => e.gap_code)).toEqual(['OWNER_DEP', 'CUSTOMER_CONC']);

    const owner = g.effectiveness[0];
    expect(owner.clears).toBe(2);
    expect(owner.avg_drs_delta).toBe(5); // (4 + 6) / 2
    expect(owner.avg_dimension_delta).toBe(15); // (20 + 10) / 2
    expect(owner.deals_closed).toBe(1);
    expect(owner.avg_final_multiple).toBe(5.2);

    const conc = g.effectiveness[1];
    expect(conc.clears).toBe(1);
    expect(conc.avg_drs_delta).toBe(1);
    expect(conc.avg_final_multiple).toBeNull(); // no closed deal recorded
  });

  it('never subtracts across rubric versions — a cross-rubric clear is incomparable, not averaged', async () => {
    const db = fakeDb([
      [
        'from gaps g',
        [
          // Comparable clear: DRS +4.0 on rv1.
          clear({ current_rubric: 'rv1', prior_rubric: 'rv1', current_drs: '72.0', prior_drs: '68.0' }),
          // Cross-version clear: prior on rv1, resolved on rv2 -> incomparable. Its
          // (bogus, different-scale) numbers must NOT enter the average.
          clear({
            engagement_id: 'e9',
            current_assessment_id: 'z2',
            prior_assessment_id: 'z1',
            current_rubric: 'rv2',
            prior_rubric: 'rv1',
            current_drs: '95.0',
            prior_drs: '10.0',
            current_dim: '99',
            prior_dim: '1',
          }),
        ],
      ],
    ]);

    const g = await engagementGraph(db, 'firm-1');

    expect(g.gaps_cleared).toBe(1); // only the same-rubric clear counts
    expect(g.incomparable_clears).toBe(1);

    const owner = g.effectiveness[0];
    expect(owner.clears).toBe(1);
    expect(owner.incomparable_clears).toBe(1);
    expect(owner.avg_drs_delta).toBe(4); // the +85 cross-version jump is excluded
    expect(owner.avg_dimension_delta).toBe(20);
  });

  it('returns an empty graph for a firm with no resolved gaps', async () => {
    const g = await engagementGraph(fakeDb([]), 'empty-firm');
    expect(g).toEqual({
      firm_id: 'empty-firm',
      gaps_cleared: 0,
      incomparable_clears: 0,
      effectiveness: [],
    });
  });
});
