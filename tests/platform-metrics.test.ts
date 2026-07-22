// Unit test for the platform monitoring rails assembler (docs/38). No live DB:
// a fake pg client returns canned view rows so we exercise the SHAPE and the
// numeric coercion of the four-domain snapshot. The cross-firm isolation of the
// `analytics` schema itself is proven live in scripts/rls-test.ts.
import { describe, it, expect } from 'vitest';
import { platformMetrics } from '../server/platform-metrics';
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

describe('platformMetrics', () => {
  it('assembles the four-domain snapshot and coerces scalar counts to numbers', async () => {
    const db = fakeDb([
      ['analytics.platform_totals', [{ firms: '3', active_firms: '2', engagements: '5', completed_assessments: '4' }]],
      ['analytics.assessment_funnel', [{ engagements: '5', assessments_started: '6', assessments_completed: '4', assessments_scored: '4' }]],
      ['analytics.usage_daily', [{ day: '2026-07-20', event_type: 'assessment', event_name: 'section_viewed', events: '12', firms: '2', sessions: '3' }]],
      ['analytics.firm_overview', [{ firm_id: 'f1', name: 'Acme Advisors', plan_code: 'practice', subscription_status: 'active' }]],
      ['analytics.subscription_summary', [{ plan_code: 'practice', status: 'active', firms: '2', seats: '7' }]],
      ['analytics.access_log_daily', [{ day: '2026-07-20', action: 'document.download', resource_type: 'document', events: '9', firms: '1' }]],
      ['analytics.ops_webhook_health', [{ type: 'invoice.paid', events: '10', unprocessed: '0' }]],
      ['analytics.ai_cost_daily', [{ day: '2026-07-20', model: 'claude-opus-4-8', calls: '4', cost_usd: '1.2345' }]],
      ['analytics.activation_funnel', [{ firms_created: '10', firms_activated: '8', firms_first_assessment: '6', firms_first_deliverable: '4' }]],
      ['analytics.revenue_summary', [{ subscribed_firms: '7', paying_firms: '5', comped_firms: '2', active_seats: '18' }]],
      ['analytics.unit_economics', [{ ai_cost_30d: '12.5', ai_cost_total: '90', active_firms: '5', completed_assessments: '9', engagements: '12' }]],
      ['analytics.engagement_health', [{ active_engagements: '12', stalled_engagements: '3' }]],
    ]);

    const m = await platformMetrics(db);

    // Scalar rollups are numified.
    expect(m.totals.firms).toBe(3);
    expect(m.totals.active_firms).toBe(2);
    expect(m.product.funnel.assessments_completed).toBe(4);
    expect(typeof m.totals.engagements).toBe('number');

    // Row arrays pass through per domain.
    expect(m.product.usage_30d).toHaveLength(1);
    expect(m.business.firms[0]).toMatchObject({ name: 'Acme Advisors' });
    expect(m.business.subscriptions[0]).toMatchObject({ plan_code: 'practice' });
    expect(m.security.access_30d[0]).toMatchObject({ action: 'document.download' });
    expect(m.ops.webhooks[0]).toMatchObject({ type: 'invoice.paid' });
    expect(m.ops.ai_cost_30d[0]).toMatchObject({ model: 'claude-opus-4-8' });

    // Company operating plan (docs/40 §4b): four numified one-row rollups.
    expect(m.operating.activation.firms_created).toBe(10);
    expect(m.operating.activation.firms_first_deliverable).toBe(4);
    expect(m.operating.revenue.paying_firms).toBe(5);
    expect(m.operating.revenue.active_seats).toBe(18);
    expect(m.operating.unit_economics.ai_cost_total).toBe(90);
    expect(m.operating.engagement_health.stalled_engagements).toBe(3);

    // Ops note points at the hosting-service telemetry (not in the DB).
    expect(m.ops.note).toMatch(/Render|Sentry|Vercel/);
    // Stamped generation time.
    expect(() => new Date(m.generated_at).toISOString()).not.toThrow();
  });

  it('degrades to empty aggregates when the views return no rows', async () => {
    const m = await platformMetrics(fakeDb([]));
    expect(m.totals).toEqual({});
    expect(m.product.funnel).toEqual({});
    expect(m.product.usage_30d).toEqual([]);
    expect(m.business.firms).toEqual([]);
    expect(m.ops.webhooks).toEqual([]);
    expect(m.operating.activation).toEqual({});
    expect(m.operating.revenue).toEqual({});
    expect(m.operating.unit_economics).toEqual({});
    expect(m.operating.engagement_health).toEqual({});
  });
});
