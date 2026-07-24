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
- **`Switch`** — the on/off slider for a **single boolean that applies
  immediately** (a filter, a setting). A checkbox is for picking items in a set
  or acknowledging a form field; a `Switch` is for flipping one thing on/off.
  Checkboxes and radios are restyled globally (on-brand, no markup change) — never
  ship the raw OS widget.
- **`LoadingState` / `ErrorState` / `AsyncBoundary`** — the loading & error
  ladder. See the rule below.
- **Buttons & icon actions.** Primary is the default `<button>`; `.btn-secondary`
  / `.btn-ghost` / `.btn-danger` for hierarchy, `.btn-sm` for dense rows. A
  single-glyph action is a `.icon-btn` (`.icon-btn-sm`), the one square icon
  button — don't re-roll a bespoke square-icon control per surface. All size off
  `--control-h` / `--control-h-sm`.

## Structures — the card, row & content skeletons (compose these, don't re-roll)
Three structural primitives cover almost every panel in the app. The recurring
mistake is hand-rolling a `.xxx-card` / `.xxx-row` that re-implements one of them
and drifts — hand-picked padding, a missing `min-width:0`, no `gap`, a raw `px`
radius. **Reuse the primitive; add a bespoke class only for genuinely new
structure.**

- **Surface = `Card` / `SectionCard`** (`.ui-card`). One bordered box:
  `--surface-1` fill, `--border` frame, `--radius` (8px), `--shadow-sm` at rest,
  `--pad-card` padding. A *titled* panel is a `SectionCard` (eyebrow title +
  optional subtitle + right-aligned `action`), never `<Card><h3>` or a fresh
  `.xxx-card`. Padding is `pad="md|lg|flush"`, not a hand-picked rem. Elevation is
  the border + tonal step — a drop shadow is only `--shadow-lift` (hover/popover),
  never a resting card.

- **List row = `.eb-list-row`** — the "left info block + trailing chips/actions"
  record row. Its structure is fixed so it never overflows or lets items touch:
  `.eb-list-row` (flex · `gap` · `align-items:center` · hairline divider) →
  `.eb-list-row-main` (the shrinkable `min-width:0` text column) →
  `.eb-list-row-push` (trailing actions, `margin-left:auto`); it wraps on a phone.
  Use it for any "name + meta + actions" row instead of a new `.xxx-row`. (Tabular
  data is a `DataTable`, not a stack of rows; a label→value row is `.list-row`, a
  `160px 1fr` grid.)

- **Content inside a card:**
  - **Form field = `.field`** (`.field-label` + control + `.field-hint`) — the
    vertical label/control/hint group; a row of fields is a `.cluster` or a grid
    that wraps.
  - **Vertical rhythm = `.stack` / `.stack-sm` / `.stack-lg`** — a card body is a
    stack so blocks never butt together.
  - **Horizontal group = `.cluster`** — chips, buttons, inline meta; always gapped
    and wrapping (see "Overflow & spacing protection").

**Every card/row shares one token set:** `--radius` for a surface, `--radius-sm`
for controls/chips, `--shadow-sm` at rest, `--surface-1` fill, `--border` frame,
`--space-*`/`--pad-card` for padding — never a raw `px` radius, a hand-picked rem
pad, or an **undefined** token (`--radius-1`, `--radius-2`, `--surface`,
`--text-2` are not in `:root`; a `var()` on them silently resolves to nothing —
use `--radius-sm`, `--input-bg`/`--surface-1`, `--text-secondary`).

## Loading & error states — never bare text
A loading or error message is a **component**, never a raw `<p>Loading…</p>` or
`<p className="form-error">{err.message}</p>`. Two symptoms this rule kills:
unstyled text on a live surface, and dumping a raw Postgres/PostgREST string at a
user.

- **`LoadingState`** — `variant="page"` (full-surface spinner + label, for a
  route/gate), `"section"` (shimmer lines standing in for content), `"inline"`
  (small spinner + label inside loaded UI). Prefer `section` so there's no layout
  shift.
- **`ErrorState`** — pass a thrown value as `error={…}` and it runs through
  `describeError()` (`src/lib/errors.ts`), which humanizes the message and, for
  an auth/RLS-shaped failure, adds a config hint. Same three variants; `inline`
  replaces the old `<p className="form-error">`. Wire `onRetry` for anything
  retryable (it defaults to a query refetch inside `AsyncBoundary`).
- **`AsyncBoundary`** — wraps a TanStack Query result and renders the
  loading → error → empty → content ladder for you:
  ```tsx
  <AsyncBoundary query={engagementQ} variant="section"
    isEmpty={(rows) => rows.length === 0} empty={<EmptyState title="…" />}>
    {(data) => <View data={data} />}
  </AsyncBoundary>
  ```
- **Exceptions** (stay as `.form-error`): a short field-level validation hint next
  to an input (e.g. `invalid hex`), and a deliberate static config panel. Dynamic
  runtime errors and any server/DB message go through `ErrorState`.
- `DataTable` keeps its own built-in `loading`/`error`/`empty` props — don't wrap
  a table in `AsyncBoundary`.

## Overflow & spacing protection — never let content escape or touch
The two defects that keep recurring: content **overflowing** its container (an
input wider than its card, a long email / URL / id / snake_case key forcing the
page to scroll sideways, a table or code block blowing out the layout) and items
**touching** with no gap. There is now one documented defensive layer for both —
the "Overflow & spacing protection" section in `styles.css`. **Use it; don't
hand-roll overflow CSS or an inline width.**

**Global guards (already on, nothing to do).** `input/select/textarea` are capped
at `max-width:100%`; `textarea` resizes vertical-only; `img/svg/video/canvas` are
capped at `max-width:100%`; raw `<pre>` scrolls in its own box. You get these for
free — don't re-declare them.

**The overflow trap you must still handle: the flex row.** A flex/grid child
defaults to `min-width:auto`, so a long name/value **stretches the row wider than
its parent** instead of truncating. This is the #1 UI bug in this codebase. The fix:

- **`.min-w-0`** on the text column of a `justify-content:space-between` row (and on
  *every* flex ancestor up to the row edge — one level is often not enough). This
  lets it shrink so the text can truncate/wrap.
- **`.truncate`** — single-line ellipsis (self-applies `min-width:0`, still needs
  `.min-w-0` ancestors). **`.clamp-2` / `.clamp-3`** — multi-line clamp.
- **`.break-anywhere`** — on the element holding a raw machine string (URL, email,
  id, storage path, API key) so it breaks instead of pushing the container wider.
- **`.scroll-x`** — wrap any wide block (chart, non-`DataTable` table, code) so it
  scrolls inside itself. (Data tables already have `.ui-table-wrap`; a fixed input
  width goes through `MoneyInput`/`.numfield`, which are already safe.)
- **Flex controls float on a floor, not a wall.** An input/select in a flex row
  wants `flex: 1 1 <preferred>; min-width: 0`, never a bare `min-width:<Npx>` —
  the floor keeps it from shrinking and it overflows on narrow widths.

**Spacing primitives — items never touch.** `.cluster` is the canonical horizontal
group (wraps, always keeps `--gap-tight`; `.cluster-tight`/`.cluster-sm` tune the
gap, `.cluster-between` pushes the ends apart) — reach for it for any row of chips,
buttons, tags, or inline meta instead of a bare `display:flex`. `.stack` /
`.stack-sm` / `.stack-lg` are the vertical rhythms; a stack's `gap` is the single
source of spacing between blocks, so blocks never butt together. **A horizontal
group of items always has a `gap` and (unless deliberately single-line) `flex-wrap`.**

## Formatting — always via `src/lib/format.ts`
`fmtCurrency` / `fmtCurrencyCompact`, `fmtScore`, `fmtDelta`, `fmtDate`, and —
for anything coming from the DB — **`humanizeKey`** (snake_case → label; machine
identifiers must never reach the screen) and **`formatFieldValue`** (money →
currency, ratio → %, other numbers → separators). No raw integers or snake_case
in the UI.

## Utilities
Text/margin: `.text-xs/-sm/-md`, `.m-0`, `.mt-0`, `.muted`, `.eyebrow`.
Overflow: `.min-w-0`, `.truncate`, `.clamp-2/-3`, `.break-anywhere`, `.scroll-x`.
Spacing: `.cluster` (+ `.cluster-tight/-sm/-between`), `.stack/-sm/-lg`. See
"Overflow & spacing protection" above for when to reach for each. Utilities are
for one-off nudges; a recurring need becomes a token or a component, not a
repeated inline `style`. (Inline `style` stays only for genuinely dynamic values
— chart geometry, computed widths.)

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

## Page composition — a reading path, not a flat stack
A page is composed, not just a `stack-lg` of equal-weight cards. Every primary
page follows the same spine so the eye always knows where it is and what's
primary vs. secondary (see the "Composition system" section in `styles.css`):

1. **A `page-shell`** wraps the page body (`display:flex; column`).
2. **A `page-masthead`** leads: the `PageHeader` (+ any tab bar like
   `EngagementNav`) read as *one* "where am I" band, divided from the content by
   section space. Don't let the tabs float as a separate stacked peer.
3. **`PageSection`s** group the content into major regions. Each is introduced by
   a quiet eyebrow **title** + optional right-aligned **note** and a hairline
   rule, and sits on the page's section rhythm (`--space-8` between regions).
   This is the move that turns a flat card-stack into a composed page.

```tsx
<div className="page-shell">
  <header className="page-masthead"><PageHeader … /><EngagementNav … /></header>
  <PageSection title="Readiness at a glance" note="Where the engagement stands today">
    <div className="stack-lg">{/* primary cards */}</div>
  </PageSection>
  <PageSection title="Analysis & detail" note="Folded away — open what you need">…</PageSection>
  <PageSection title="Record">…</PageSection>
</div>
```

**Gutters share the block rhythm.** `card-grid` (and the legacy `eng-grid` /
`owner-grid` / `roadmap-cols`) all gutter on `--gap-block`, so grids line up on
one system. Use `card-grid` (`--col-min` tunes the wrap width) for new
multi-card rows. **`layout-rail`** is the primary+rail primitive (`minmax(0,1fr)`
+ a fixed rail) for pages with a clear lead column. `EngagementPage` is the
reference implementation; adopt the same spine on other primary pages.
