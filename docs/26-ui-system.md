# UI system — canonical tokens & patterns

The single source of truth for the app's look. Reach for these before writing new
CSS or an inline `style` — the point is that a pattern is defined **once** and
reused, so the UI never drifts back into ~40 hand-picked values. All tokens live
in `:root` in `src/styles.css`; the typed mirror for JS (chart geometry/colors)
is `src/lib/tokens.ts`.

## Spacing — `--space-1 … --space-9` (4px grid)
`0.25 · 0.5 · 0.75 · 1 · 1.25 · 1.5 · 2 · 2.5 · 4 rem`. Semantic aliases:
`--gap-tight` (2), `--gap-block` (6, the `.stack-lg` rhythm), `--gap-section`
(7), `--pad-card` (6), `--pad-page-x` (6). Never hand-pick a rem for margin,
padding, or gap — use a step.

## Type — `--text-xs / -sm / -md`
`0.72 / 0.8 / 0.88 rem`, the sub-body sizes. Prose is the 15px body. Utility
classes `.text-xs/.text-sm/.text-md` apply them in markup (replacing inline
`fontSize`).

## Eyebrow label — the uppercase micro-label
The most-reused text pattern (stat/section labels, filter labels, tile labels,
chip labels, table headers). Defined once via `--eyebrow-size` / `-weight` /
`-tracking` and the canonical `.eyebrow` class. Component label classes
(`.stat-block-label`, `.filter-label`, `.tile-label`, `.ws-chip-label`,
`.consensus-label`, `.val-gap-label`, `.ui-table thead th`, …) all read those
tokens, so changing the token restyles every label. **New label → use `.eyebrow`
(or a class that references the tokens), never a fresh font-size/transform.**

## Components (prefer these over hand-rolled markup)
- **`Card` / `SectionCard`** — the surface. `SectionCard` gives the standard
  eyebrow title + optional subtitle/action. A titled card is a `SectionCard`,
  not `<Card><h3>`.
- **`PageHeader`** — every page top (breadcrumb, title, subtitle, actions).
- **`StatBlock` / `StatRow`** — KPI tiles. Give **every** tile in a row a `hint`
  (or none) so they align.
- **`DataTable`** — tabular data (sticky eyebrow headers, states). Don't hand-roll
  `<table>`.
- **`Collapsible`** — the one disclosure (chevron). Don't build a `<details>`
  with a custom marker.
- **`EmptyState`, `SkeletonLines`, `TierBadge`, `DeltaChip`, `GapSeverityChip`,
  status chips (`.status-chip .status-*`).**

## Formatting — always via `src/lib/format.ts`
`fmtCurrency` / `fmtCurrencyCompact`, `fmtScore`, `fmtDelta`, `fmtDate`, and —
for anything coming from the DB — **`humanizeKey`** (snake_case → label; machine
identifiers must never reach the screen) and **`formatFieldValue`** (money →
currency, ratio → %, other numbers → separators). No raw integers or snake_case
in the UI.

## Utilities
`.text-xs/-sm/-md`, `.m-0`, `.mt-0`, `.muted`, `.eyebrow`. Utilities are for
one-off nudges; a recurring need becomes a token or a component, not a repeated
inline `style`. (Inline `style` stays only for genuinely dynamic values — chart
geometry, computed widths.)

## Theming
Light/dark via `:root[data-theme]` + `prefers-color-scheme`. Every color is a
semantic token (`--surface-*`, `--text-*`, `--border*`, `--status-*`, `--chip-*`,
`--tier-*`); per-firm branding overrides `--accent` only. Never a raw hex in a
component.

## Institutional register — the craft bar
The app should read like software a billion-dollar firm runs on, not a generic
build. Five rules carry that, all token-driven (see the "Institutional register
pass" section at the foot of `styles.css`):

1. **Crisp geometry.** Surfaces are `--radius` **8px**, controls `--radius-sm`
   **6px**, `--radius-lg` **12px** for hero surfaces only. Status/tier chips are
   rounded-rects (6px), not pills. Tighter than consumer-SaaS on purpose.
2. **Border-defined elevation.** A surface is framed by its 1px border and a
   tonal step, not a drop shadow. `--shadow`/`--shadow-sm` are whispers;
   `--shadow-lift` is the *one* deliberate raise (hover, popovers) — never a
   card's resting state.
3. **Engineered numerals.** Every figure that is read or compared uses
   `font-variant-numeric: tabular-nums slashed-zero` via the `--num` token
   (`'tnum' 1, 'zero' 1`). This is the clearest "financial software" tell. Any
   new numeric class joins the `--num` selector list.
4. **Neutrals are neutral.** The accent is spent, not smeared: greys carry only a
   whisper of green. Don't tint borders/labels/hints with the brand.
5. **Data surfaces are the hero.** The `DataTable` is dense, border-framed, with
   an engineered uppercase header rule and a whisper-tint row hover; sparklines
   render as charts (area fill + endpoint dot), never stray lines.

The details that signal craft — tinted `::selection`, a styled scrollbar, a
tactile primary button, a refined 2px focus ring — live in that same section.
When adding UI, match this bar; don't reintroduce soft radii, drop-shadowed
cards, or lining/proportional figures in a data context.
