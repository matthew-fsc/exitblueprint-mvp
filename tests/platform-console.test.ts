import { describe, expect, it } from 'vitest';
import {
  firmActivityStatus,
  funnelSteps,
  sumColumn,
  toNumber,
  topEvents,
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
