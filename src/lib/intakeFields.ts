// Presentation metadata for intake questions: units, humanized option labels,
// per-item list layout, and scale anchors. Pure and data-light — it shapes how
// a question is *shown*, never what is stored (the answer value format is
// unchanged: numbers, arrays of numbers, option strings, 1-5). Keyed by the
// stable question code so it survives prompt wording tweaks.
import type { QuestionRow } from './rubric';

export interface FieldUnit {
  prefix?: string; // shown inside the field on the left (e.g. "$")
  suffix?: string; // shown inside the field on the right (e.g. "%", "hrs/week")
  dollars?: boolean; // format a live "$1,234,000" hint under the field
  placeholder?: string;
}

const PERCENT: FieldUnit = { suffix: '%', placeholder: '0' };

// Per-code overrides; anything ending in -PCT defaults to percent.
const UNITS: Record<string, FieldUnit> = {
  'REV-CONTRACT-AVG-MO': { suffix: 'months', placeholder: '0' },
  'REV-NRR': { suffix: '%', placeholder: 'e.g. 104' },
  'OPS-OWNER-HOURS': { suffix: 'hrs/week', placeholder: '0' },
  'OPS-MGR-COUNT': { suffix: 'functions', placeholder: '0' },
  'OPS-FUNC-COUNT': { suffix: 'functions', placeholder: '4' },
  'CUS-TENURE': { suffix: 'years', placeholder: '0' },
  'GRW-PIPELINE': { prefix: '$', dollars: true, placeholder: '0' },
};

export function fieldUnit(q: QuestionRow): FieldUnit {
  if (UNITS[q.code]) return UNITS[q.code];
  if (q.code.endsWith('-PCT') || /percentage|percent|\(%\)/i.test(q.prompt)) return PERCENT;
  return {};
}

export interface ListConfig {
  labels: string[]; // one per row, in order
  unit: FieldUnit;
}

// The two list questions, rendered as labeled per-item rows instead of one
// comma-separated box. Order matters (the engine reads position).
const LISTS: Record<string, ListConfig> = {
  'REV-TOP5-SHARES': {
    labels: ['Largest customer', '2nd largest', '3rd largest', '4th largest', '5th largest'],
    unit: { suffix: '%', placeholder: '0' },
  },
  'REV-ANNUAL': {
    labels: ['Oldest year', 'Next year', 'Following year', 'Most recent year'],
    unit: { prefix: '$', dollars: true, placeholder: '0' },
  },
};

export function listConfig(q: QuestionRow): ListConfig {
  return (
    LISTS[q.code] ?? {
      // Generic fallback: four unlabeled rows the user can add to.
      labels: ['Item 1', 'Item 2', 'Item 3', 'Item 4'],
      unit: { placeholder: '0' },
    }
  );
}

// Concise, readable option labels for select questions (raw values are snake
// case). Curated where a plain title-case would read oddly; title-cased
// otherwise.
const OPTION_LABELS: Record<string, string> = {
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annual: 'Annually',
  none: 'Not done',
  fully_documented: 'Fully documented',
  mostly_documented: 'Mostly documented',
  partially_documented: 'Partially documented',
  undocumented: 'Undocumented',
  accrual_consistent: 'Accrual, consistent',
  cash_with_bridge: 'Cash, with accrual bridge',
  cash_mixed: 'Cash, mixed',
  unreconcilable: 'Not reconcilable',
  all_three: 'All three (P&L, Balance sheet, Cash flow)',
  pl_and_bs: 'P&L + Balance sheet',
  pl_only: 'P&L only',
  spreadsheet_only: 'Spreadsheets only',
  yes_clean: 'Yes, clean',
  yes_gaps: 'Yes, with gaps',
  no: 'No',
  minimal_churn: 'Minimal churn',
  some_churn: 'Some churn',
  major_churn: 'Major churn',
  unknown: 'Unknown',
  two_plus_layers: 'Two or more layers',
  one_clear_layer: 'One clear layer',
  informal_partial: 'Informal / partial',
  none_all_report_to_owner: 'None: all report to owner',
  within_15pct: 'Within 15% of market',
  below_15_25pct: '15-25% below market',
  below_25pct_plus: '25%+ below market',
  above_25pct_plus: '25%+ above market',
  strong_defined: 'Strong, clearly defined',
  moderate: 'Moderate',
  undifferentiated_unclear: 'Undifferentiated / unclear',
  some_unreviewed: 'Some, unreviewed',
  yes_material: 'Yes, material',
  one_minor: 'One minor',
  mostly: 'Mostly',
  partially: 'Partially',
  minor_issues: 'Minor issues',
  significant_issues: 'Significant issues',
  yes: 'Yes',
  within_12mo: 'Within 12 months',
  one_3yr: '1-3 years ago',
  over_3yr: 'Over 3 years ago',
  never: 'Never',
  fully: 'Fully separate',
  mixed: 'Mixed',
  stay_longterm: 'Stay long-term',
  transition_period: 'Stay through a transition',
  leave_immediately: 'Leave at close',
  third_party: 'Sale to a third party',
  mgmt_employee: 'Management / employee buyout',
  partner: 'Sale to a partner',
  family: 'Transfer to family',
  step_back_retain: 'Step back but retain',
  under_12mo: 'Under 12 months',
  one_2yr: '1-2 years',
  two_3yr: '2-3 years',
  three_plus_yr: '3+ years',
  none_expected: 'None expected',
  earnout: 'Earnout',
  seller_note: 'Seller note',
  consulting: 'Consulting',
  equity_rollover: 'Equity rollover',
  real_estate: 'Real estate',
  ip: 'Intellectual property',
  equipment: 'Equipment',
  other: 'Other',
};

export function humanizeOption(value: string): string {
  if (OPTION_LABELS[value]) return OPTION_LABELS[value];
  return value
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export interface ScaleAnchors {
  low: string;
  high: string;
}

// Pull "(1 fully dependent - 5 not dependent)" style anchors from the prompt;
// otherwise a sensible generic pair.
export function scaleAnchors(q: QuestionRow): ScaleAnchors {
  const m = q.prompt.match(/\(\s*1\s+([^-]+?)\s*-\s*5\s+([^)]+?)\s*\)/i);
  if (m) return { low: m[1].trim(), high: m[2].trim() };
  return { low: 'Not at all', high: 'Completely' };
}

// Whether a select should render as inline option cards (short list) or a
// dropdown (longer list, e.g. ranking-style option sets).
export function useOptionCards(options: string[]): boolean {
  return options.length > 0 && options.length <= 5 && options.every((o) => humanizeOption(o).length <= 42);
}
