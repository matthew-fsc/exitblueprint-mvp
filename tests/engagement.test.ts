// Pure engagement-setup helpers (shared/engagement.ts): exit-window / date
// validation and the re-assessment cadence derivation. No database.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REASSESS_INTERVAL_DAYS,
  isCalendarDate,
  isExitWindow,
  reassessmentStatus,
} from '../shared/engagement';

describe('isExitWindow', () => {
  it('accepts the four canonical bands and rejects anything else', () => {
    expect(isExitWindow('under 12 months')).toBe(true);
    expect(isExitWindow('12-24 months')).toBe(true);
    expect(isExitWindow('36+ months')).toBe(true);
    expect(isExitWindow('someday')).toBe(false);
    expect(isExitWindow('12–24 months')).toBe(false); // en-dash label, not the value
    expect(isExitWindow(null)).toBe(false);
  });
});

describe('isCalendarDate', () => {
  it('accepts YYYY-MM-DD and rejects malformed or impossible dates', () => {
    expect(isCalendarDate('2026-01-15')).toBe(true);
    expect(isCalendarDate('2026-2-3')).toBe(false);
    expect(isCalendarDate('2026-02-31')).toBe(false);
    expect(isCalendarDate('not-a-date')).toBe(false);
    expect(isCalendarDate('2026-01-15T00:00:00Z')).toBe(false);
  });
});

describe('reassessmentStatus', () => {
  const now = '2026-07-22T12:00:00Z';

  it('is baseline when no assessment has completed', () => {
    const s = reassessmentStatus({ lastCompletedAt: null, now });
    expect(s.state).toBe('baseline');
    expect(s.dueDate).toBeNull();
    expect(s.daysUntil).toBeNull();
    expect(s.daysSince).toBeNull();
    expect(s.intervalDays).toBe(DEFAULT_REASSESS_INTERVAL_DAYS);
  });

  it('is in_progress (overriding cadence) while an assessment is open', () => {
    const s = reassessmentStatus({
      lastCompletedAt: '2026-01-01T00:00:00Z',
      now,
      hasInProgress: true,
    });
    expect(s.state).toBe('in_progress');
  });

  it('is upcoming with a future due date at the default cadence', () => {
    const s = reassessmentStatus({ lastCompletedAt: '2026-06-22T00:00:00Z', now });
    expect(s.state).toBe('upcoming');
    expect(s.daysSince).toBe(30);
    expect(s.daysUntil).toBe(60);
    expect(s.dueDate).toBe('2026-09-20');
  });

  it('is due once the cadence has elapsed', () => {
    const s = reassessmentStatus({ lastCompletedAt: '2026-04-01T00:00:00Z', now });
    expect(s.state).toBe('due');
    expect(s.daysUntil).toBeLessThanOrEqual(0);
  });

  it('honors a per-engagement interval override', () => {
    const s = reassessmentStatus({
      lastCompletedAt: '2026-05-13T00:00:00Z', // 70 days before now
      now,
      intervalDays: 60,
    });
    expect(s.intervalDays).toBe(60);
    expect(s.state).toBe('due');
  });

  it('is ready when remediation is complete with gains still to capture', () => {
    const s = reassessmentStatus({
      lastCompletedAt: '2026-07-01T00:00:00Z', // well within cadence
      now,
      remediationComplete: true,
    });
    expect(s.state).toBe('ready');
  });
});
