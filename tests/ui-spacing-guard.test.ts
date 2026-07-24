// UI spacing guard — enforces the "spacing contract" from docs/26-ui-system.md.
//
// The recurring UI defect is inconsistent spacing: components hand-pick a rem/px
// for a margin/padding/gap in an inline `style`, so nothing sits on the 4px token
// grid and blocks drift or touch. The contract's rule is: spacing is a --space-*
// token, never a hand-picked value, and an inline `style` is only for genuinely
// dynamic values (chart geometry, computed widths) — never static spacing.
//
// This test holds the cleanest, now-zero slice of that rule: NO inline `style`
// may set a spacing property to a unit'd raw literal ('1rem', '0.5rem', '2px').
// A `var(--space-*)` token or a bare `0` is fine; a computed JS value is fine.
// Keeping this at zero means the class of defect can't quietly grow back.
//
// (styles.css hand-picked values are governed by review + the token section of
// docs/26 — this guard is scoped to the inline-style class it can hold at zero.)
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');

// A spacing property in a CSS-in-JS inline style — `margin`, `padding`, `gap`,
// `inset`, and their directional/camelCase variants (marginTop, paddingLeft,
// rowGap, columnGap, …) — set to a quoted string whose value contains a number
// followed by a length unit. `var(--space-2)`, `'0'`, and `'0 0 0'` don't match
// (no unit'd number); `'1rem'`, `'0.5rem 0'`, `'2px'` do.
const SPACING_PROP = String.raw`(?:margin|padding|gap|inset|rowGap|columnGap|blockSize|inlineSize)[A-Za-z]*`;
const UNIT_LITERAL = String.raw`['"\`][^'"\`]*\d(?:\.\d+)?(?:rem|px|em|ex|ch|vh|vw|vmin|vmax|%)`;
const VIOLATION = new RegExp(`\\b${SPACING_PROP}\\s*:\\s*${UNIT_LITERAL}`);

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsxFiles(full));
    else if (entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

describe('UI spacing contract (docs/26)', () => {
  it('no inline style sets a spacing property to a hand-picked rem/px literal', () => {
    const offenders: string[] = [];
    for (const file of tsxFiles(SRC)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (VIOLATION.test(line)) {
          const rel = file.slice(file.indexOf('/src/') + 1);
          offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
        }
      });
    }

    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `Hand-picked spacing in an inline style — use a --space-* token (or a ` +
            `.stack / .cluster primitive), never a raw rem/px. See docs/26-ui-system.md ` +
            `"Spacing contract".\n\n${offenders.join('\n')}\n`,
    ).toEqual([]);
  });
});
