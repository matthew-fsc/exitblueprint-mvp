// Typed design tokens — the single TS source of truth for values that code
// (charts, inline SVG, canvas) needs to read directly. Anything rendered with
// CSS should prefer the CSS custom properties in styles.css (same values);
// this module exists for the cases where a component computes geometry/color
// in JS (TrajectoryChart, ScoreDial) and cannot read a CSS variable cheaply.
//
// Palette direction (F0, recorded in docs/06-decisions.md): deep forest/green,
// institutional-wealth register. The five DRS tiers each get ONE fixed color
// used everywhere a tier appears — chips, dials, charts, and PDFs — so the
// reader learns the color once. Tier colors are an ordinal, always-labeled
// scale (never color-alone), validated with the dataviz palette validator for
// contrast and monotonic lightness.

export const TIER_ORDER = [
  'Not Saleable (Yet)',
  'High Risk',
  'Needs Work',
  'Sale Ready',
  'Institutional Grade',
] as const;

export type TierName = (typeof TIER_ORDER)[number];

// Floors match shared/scoring/engine.ts drsTier() exactly.
export const TIER_FLOORS: { tier: TierName; floor: number }[] = [
  { tier: 'Institutional Grade', floor: 85 },
  { tier: 'Sale Ready', floor: 70 },
  { tier: 'Needs Work', floor: 55 },
  { tier: 'High Risk', floor: 40 },
  { tier: 'Not Saleable (Yet)', floor: 0 },
];

// Fixed tier colors, validated (light on #fcfcfb, dark on chart surface).
export const TIER_COLORS: Record<TierName, { light: string; dark: string }> = {
  'Not Saleable (Yet)': { light: '#c0362c', dark: '#ef6a5e' },
  'High Risk': { light: '#e0670f', dark: '#f0883c' },
  'Needs Work': { light: '#9a7d0a', dark: '#d9b23a' },
  'Sale Ready': { light: '#2f9e44', dark: '#46c46f' },
  'Institutional Grade': { light: '#0e8f9e', dark: '#35b6c9' },
};

export function tierForScore(score: number): TierName {
  for (const { tier, floor } of TIER_FLOORS) if (score >= floor) return tier;
  return 'Not Saleable (Yet)';
}

export function tierColor(tier: TierName | string, mode: 'light' | 'dark' = 'light'): string {
  const entry = TIER_COLORS[tier as TierName];
  return entry ? entry[mode] : mode === 'dark' ? '#9aabc0' : '#64748b';
}

// A short status word for a tier, used in badges/relief so color is never the
// sole cue (dataviz: status ships with a label).
export const TIER_STATUS: Record<TierName, 'good' | 'ok' | 'warning' | 'serious' | 'critical'> = {
  'Institutional Grade': 'good',
  'Sale Ready': 'good',
  'Needs Work': 'warning',
  'High Risk': 'serious',
  'Not Saleable (Yet)': 'critical',
};

// Tolerant lookup for a tier label coming from the DB/engine as a plain string.
export function tierStatusOf(tier: string): 'good' | 'ok' | 'warning' | 'serious' | 'critical' | 'neutral' {
  return TIER_STATUS[tier as TierName] ?? 'neutral';
}

// Brand + accent (forest). Mirrors the CSS variables; for JS consumers.
export const BRAND = {
  forestDeep: '#16352a',
  forest: '#1b4a38',
  accent: '#1f7a52',
  accentStrong: '#17603f',
  accentDark: '#4bb888', // brighter accent for dark surfaces
} as const;
