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
