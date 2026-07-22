// Engagement setup constants shared by the client (creation dialog + Setup tab)
// and the server (create-engagement validation), so the two never drift.
//
// `engagements.target_exit_window` is free `text` in the schema (docs/02), but the
// product only ever writes one of these four coarse bands. `targetExitDate()`
// (EngagementPage) parses the leading integer out of the string to derive the
// "ready-by" date, so the server whitelists incoming values against this list to
// keep that parse meaningful — an arbitrary string would silently fall back to the
// 24-month default.

export const EXIT_WINDOWS = [
  'under 12 months',
  '12-24 months',
  '24-36 months',
  '36+ months',
] as const;

export type ExitWindow = (typeof EXIT_WINDOWS)[number];

// Display labels for the four bands (en-dash ranges). One source of truth for the
// creation dialog and the Setup tab.
export const EXIT_WINDOW_LABEL: Record<ExitWindow, string> = {
  'under 12 months': 'Under 12 months',
  '12-24 months': '12–24 months',
  '24-36 months': '24–36 months',
  '36+ months': '36+ months',
};

export function isExitWindow(v: unknown): v is ExitWindow {
  return typeof v === 'string' && (EXIT_WINDOWS as readonly string[]).includes(v);
}

// A calendar date in the `<input type="date">` value shape ('YYYY-MM-DD'). Rejects
// malformed strings and impossible dates (e.g. 2026-02-31) by round-tripping
// through Date and comparing back to the input.
const CALENDAR_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isCalendarDate(v: unknown): v is string {
  if (typeof v !== 'string' || !CALENDAR_DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

// --- Re-assessment cadence ----------------------------------------------------
// The engagement is re-scored on a cadence (the "monitor" loop). The default
// cadence is quarterly; an engagement may override it (engagements
// .reassessment_interval_days). One source of truth for the server analyzers
// (server/scheduled.ts) and the engagement's forward-looking "re-assess by
// <date>" surface, so the dashboard flag and the engagement never disagree.
export const DEFAULT_REASSESS_INTERVAL_DAYS = 90;

// Advisor-selectable cadences for the Setup control (null = platform default).
export const REASSESS_INTERVAL_CHOICES = [60, 90, 120, 180, 365] as const;

export type ReassessmentState = 'baseline' | 'in_progress' | 'ready' | 'due' | 'upcoming';

export interface ReassessmentInput {
  lastCompletedAt: string | null; // ISO of the latest completed assessment, or null
  now: string; // ISO 'now' (caller supplies it so the result is pure/testable)
  intervalDays?: number | null; // per-engagement override; null → default
  hasInProgress?: boolean; // an assessment is currently in progress
  // The remediation work is done with score gains still to capture (all tasks
  // complete while gaps remain open) — the timeliest reason to re-assess.
  remediationComplete?: boolean;
}

export interface ReassessmentStatus {
  state: ReassessmentState;
  intervalDays: number;
  dueDate: string | null; // 'YYYY-MM-DD' the next re-assessment is due (null at baseline)
  daysUntil: number | null; // days from now to due; negative = overdue
  daysSince: number | null; // days since the last completed assessment
}

const MS_PER_DAY = 86_400_000;
const dayNumber = (iso: string): number => Math.floor(new Date(iso).getTime() / MS_PER_DAY);

// Derive when the next re-assessment is due and why, from assessment timing plus
// the (optional) remediation-complete signal. Pure — all "now"/inputs are passed
// in — so it unit-tests cleanly and renders identically on the server and client.
export function reassessmentStatus(input: ReassessmentInput): ReassessmentStatus {
  const intervalDays =
    input.intervalDays && input.intervalDays > 0 ? input.intervalDays : DEFAULT_REASSESS_INTERVAL_DAYS;
  const nowDay = dayNumber(input.now);
  const hasLast = typeof input.lastCompletedAt === 'string';
  const daysSince = hasLast ? nowDay - dayNumber(input.lastCompletedAt as string) : null;
  const dueDayNum = hasLast ? dayNumber(input.lastCompletedAt as string) + intervalDays : null;
  const dueDate = dueDayNum != null ? new Date(dueDayNum * MS_PER_DAY).toISOString().slice(0, 10) : null;
  const daysUntil = dueDayNum != null ? dueDayNum - nowDay : null;

  let state: ReassessmentState;
  if (input.hasInProgress) state = 'in_progress';
  else if (!hasLast) state = 'baseline';
  else if (input.remediationComplete) state = 'ready';
  else if ((daysUntil ?? 0) <= 0) state = 'due';
  else state = 'upcoming';

  return { state, intervalDays, dueDate, daysUntil, daysSince };
}
