import { describe, expect, it } from 'vitest';
import {
  activationSteps,
  churnBook,
  firmActivityStatus,
  funnelSteps,
  sumColumn,
  toNumber,
  topEvents,
  unitEconomics,
} from '../src/lib/platformConsole';

describe('firmActivityStatus', () => {
  it('is dormant with no active engagements, regardless of recency', () => {
    expect(firmActivityStatus(0, 1)).toBe('dormant');
    expect(firmActivityStatus(0, null)).toBe('dormant');
  });
  it('is dormant when silent for more than two months', () => {
    expect(firmActivityStatus(3, 61)).toBe('dormant');
    expect(firmActivityStatus(3, null)).toBe('dormant');
  });
  it('is idle in the 30–60 day quiet window', () => {
    expect(firmActivityStatus(2, 31)).toBe('idle');
    expect(firmActivityStatus(2, 60)).toBe('idle');
  });
  it('is active when engaged and recently seen', () => {
    expect(firmActivityStatus(1, 0)).toBe('active');
    expect(firmActivityStatus(5, 30)).toBe('active');
  });
});

describe('funnelSteps', () => {
  it('orders steps and computes conversion off the first step', () => {
    const steps = funnelSteps({
      engagements: 40,
      assessments_started: 30,
      assessments_completed: 20,
      assessments_scored: 12,
    });
    expect(steps.map((s) => s.key)).toEqual([
      'engagements',
      'assessments_started',
      'assessments_completed',
      'assessments_scored',
    ]);
    expect(steps[0].pctOfStart).toBe(100);
    expect(steps[3]).toMatchObject({ value: 12, pctOfStart: 30 });
  });
  it('reports null conversion (not a divide-by-zero) with no engagements', () => {
    const steps = funnelSteps({ engagements: 0, assessments_started: 0 });
    expect(steps[0].pctOfStart).toBeNull();
  });
  it('skips keys the funnel view does not provide', () => {
    const steps = funnelSteps({ engagements: 5, assessments_started: 4 });
    expect(steps).toHaveLength(2);
  });
});

describe('toNumber / sumColumn', () => {
  it('coerces Postgres string numerics and treats junk as 0', () => {
    expect(toNumber('12.5')).toBe(12.5);
    expect(toNumber(null)).toBe(0);
    expect(toNumber('nope')).toBe(0);
  });
  it('sums a column across rows', () => {
    expect(sumColumn([{ cost_usd: '1.5' }, { cost_usd: 2 }, { cost_usd: null }], 'cost_usd')).toBe(3.5);
  });
});

describe('topEvents', () => {
  it('aggregates events by name, biggest first, with a lower-bound firm count', () => {
    const rows = [
      { event_name: 'report_downloaded', events: 5, firms: 3 },
      { event_name: 'report_downloaded', events: 2, firms: 4 },
      { event_name: 'section_viewed', events: 10, firms: 2 },
    ];
    const top = topEvents(rows);
    expect(top[0]).toMatchObject({ label: 'section_viewed', events: 10 });
    // events summed across days; firms is the max on any one day (not summed).
    expect(top[1]).toMatchObject({ label: 'report_downloaded', events: 7, firms: 4 });
  });
  it('respects the limit', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ event_name: `e${i}`, events: i, firms: 1 }));
    expect(topEvents(rows, 5)).toHaveLength(5);
  });
});

describe('activationSteps', () => {
  it('orders the firm-level activation funnel and converts off firms created', () => {
    const steps = activationSteps({
      firms_created: 10,
      firms_activated: 8,
      firms_first_assessment: 6,
      firms_first_deliverable: 4,
    });
    expect(steps.map((s) => s.key)).toEqual([
      'firms_created',
      'firms_activated',
      'firms_first_assessment',
      'firms_first_deliverable',
    ]);
    expect(steps[0].pctOfStart).toBe(100);
    expect(steps[3]).toMatchObject({ value: 4, pctOfStart: 40 });
  });
  it('reports null conversion (not divide-by-zero) with no firms', () => {
    expect(activationSteps({ firms_created: 0, firms_activated: 0 })[0].pctOfStart).toBeNull();
  });
});

describe('unitEconomics', () => {
  it('derives null-safe per-unit COGS ratios from the raw components', () => {
    const e = unitEconomics({
      ai_cost_30d: 12.5,
      ai_cost_total: 90,
      active_firms: 5,
      completed_assessments: 9,
      engagements: 12,
    });
    expect(e.cost_per_active_firm_30d).toBe(2.5);
    expect(e.cost_per_completed_assessment).toBe(10);
    expect(e.cost_per_engagement).toBe(7.5);
  });
  it('returns null (never Infinity/NaN) when a denominator is zero', () => {
    const e = unitEconomics({ ai_cost_30d: 5, ai_cost_total: 5, active_firms: 0, completed_assessments: 0, engagements: 0 });
    expect(e.cost_per_active_firm_30d).toBeNull();
    expect(e.cost_per_completed_assessment).toBeNull();
    expect(e.cost_per_engagement).toBeNull();
    expect(e.ai_cost_30d).toBe(5);
  });
});

describe('churnBook', () => {
  const recent = new Date().toISOString();
  const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

  it('classifies firms with the same status logic the table renders', () => {
    const book = churnBook([
      { active_engagements: 2, last_activity_at: recent, subscription_status: 'active' },
      { active_engagements: 2, last_activity_at: days(45), subscription_status: 'active' }, // idle + paying → at risk
      { active_engagements: 0, last_activity_at: recent, subscription_status: 'active' }, // dormant + paying → at risk
      { active_engagements: 1, last_activity_at: days(90), comp: true }, // dormant + comped → at risk
      { active_engagements: 1, last_activity_at: days(90), subscription_status: null }, // dormant, not paying
    ]);
    expect(book.active).toBe(1);
    expect(book.idle).toBe(1);
    expect(book.dormant).toBe(3);
    expect(book.atRiskPaying).toBe(3);
  });
  it('is all-zero on an empty book', () => {
    expect(churnBook([])).toEqual({ active: 0, idle: 0, dormant: 0, atRiskPaying: 0 });
  });
});
