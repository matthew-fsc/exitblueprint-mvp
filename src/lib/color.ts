// Pure, dependency-free color helpers for per-firm white-labeling. A firm sets
// ONE accent hex; from it we derive the full coherent set of CSS variables that
// rebrand accents, links, focus rings AND primary buttons in one subtree
// (branding.tsx). Kept tiny and side-effect-free so it's trivially testable and
// reusable by the settings live preview. No chart/tier colors here — those are a
// fixed validated ordinal palette (tokens.ts) and are never firm-brandable.

export type RGB = [number, number, number];

/** Parse #rgb or #rrggbb into [r,g,b]; returns null for anything unparseable. */
export function parseHex(hex: string): RGB | null {
  if (typeof hex !== 'string') return null;
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));

export function toHex([r, g, b]: RGB): string {
  return '#' + [r, g, b].map((c) => clamp(c).toString(16).padStart(2, '0')).join('');
}

/**
 * Darken a hex color toward black by `amount` (0..1). 0.2 ≈ the shade step used
 * for a hover/`--accent-strong`. Returns null if the input can't be parsed.
 */
export function darken(hex: string, amount = 0.2): string | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const f = 1 - Math.max(0, Math.min(1, amount));
  return toHex([rgb[0] * f, rgb[1] * f, rgb[2] * f]);
}

// WCAG relative luminance + contrast, used to keep on-accent text readable.
function relLuminance([r, g, b]: RGB): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: RGB, b: RGB): number {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const ON_LIGHT: RGB = [255, 255, 255]; // white
const ON_DARK: RGB = [20, 37, 29]; // #14251d — our --text-primary (near-black forest)

/**
 * Pick a readable foreground (#ffffff or a near-black) for text/icons sitting on
 * a solid `hex` fill, choosing whichever gives the higher WCAG contrast. Falls
 * back to white for an unparseable input.
 */
export function readableOn(hex: string): string {
  const bg = parseHex(hex);
  if (!bg) return '#ffffff';
  return contrast(bg, ON_LIGHT) >= contrast(bg, ON_DARK) ? '#ffffff' : toHex(ON_DARK);
}

/**
 * The full coherent CSS-variable set derived from a single firm accent hex. Sets
 * the accent (links, focus rings) AND the primary-button surface so one value
 * rebrands the whole client-facing subtree. Returns null for an invalid accent,
 * so callers can simply keep the default forest tokens.
 */
export function accentVars(hex: string | null | undefined): Record<string, string> | null {
  if (!hex) return null;
  const strong = darken(hex, 0.2);
  if (!strong) return null; // invalid hex → keep defaults
  return {
    '--accent': hex,
    '--accent-strong': strong,
    // Primary buttons follow the accent (this is the white-label bug fix): the
    // button variable set used to be hardcoded forest, unrelated to --accent.
    '--btn-bg': hex,
    '--btn-bg-hover': strong,
    '--btn-fg': readableOn(hex),
  };
}
