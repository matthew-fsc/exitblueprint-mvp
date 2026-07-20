# Design review — production polish pass (2026-07)

A "good → exceptional" review of the shipped UI by five lenses (Principal Product
Designer, UX Researcher, Interaction Designer, Accessibility Specialist, Design
Systems Architect, Performance Engineer, SaaS critic). **Not a redesign** — the
institutional identity (docs/26: 8/6px geometry, border-defined elevation,
tabular numerals, token-only color, composition spine) is the source of truth.
Every item is grounded in a specific line of the current code.

The system is already strong. These are the drift points, dead-ends, and
accessibility gaps that separate handcrafted software from a generated app.

## Legend
Impact / Complexity / Risk are L·M·H. Confidence is the reviewer's 1–10.

---

## CRITICAL — implemented this pass

| # | Finding | File(s) | Conf |
|---|---------|---------|------|
| C1 | **Owners see raw markdown** (`##`, `**`, `\|---\|`) in shared reports — `{d.content_md}` printed instead of `renderMarkdown()` | `pages/owner/OwnerDocumentsPage.tsx:60`, `styles.css:4171` | 10 |
| C2 | Owner query **errors masquerade as empty states** ("assessment is being prepared") — `useOwnerContext` never surfaces `isError` | `lib/owner.ts:30`, all `pages/owner/*` | 9 |
| C3 | Owner home **hero spins forever** on a failed sub-query — gated on `!explain`, no error branch | `pages/owner/OwnerHomePage.tsx:49` | 9 |
| C4 | `ConfirmDialog` has **no focus management / focus trap**; keyboard/SR users tab into the page behind the modal | `components/ui/ConfirmDialog.tsx:36` | 9 |
| C5 | Sticky table headers & workbench board **slide under the 60px sticky app bar** (`top:0`) | `styles.css:2790, 2392, 3440` | 7 |
| C6 | Reconciliation grid is a **hand-rolled `<table>`**, bypassing `DataTable` and its state ladder | `pages/VerificationPage.tsx:215` | 9 |
| C7 | Data-room load failure renders **bare text in a Card**; query error swallowed, no retry | `pages/DataRoomPage.tsx:146` | 9 |
| C8 | Disconnect accounting — **destructive, no confirmation, no in-flight state** | `components/AccountingCard.tsx:54`, `pages/owner/OwnerConnectPage.tsx:60` | 8 |
| C9 | Five engagement/landing pages **don't use the composition spine** (masthead + PageSection) | `Dashboard/Valuation/Roadmap/BuyerLens` | 8–9 |

## HIGH VALUE — implemented this pass

| # | Finding | File(s) | Conf |
|---|---------|---------|------|
| H1 | Dashboard shows **wrong empty state** ("add your first client") when filters exclude everything | `pages/DashboardPage.tsx:174` | 9 |
| H2 | Dashboard **flashes false zeros** in the stat band while the portfolio loads | `pages/DashboardPage.tsx:129` | 8 |
| H3 | Raw enum / snake_case leaks to screen incl. a **truncation bug** (`replace('_',' ')` on `doc_type`) | `RoadmapPage:153`, `EngagementPage:732`, `Verification:272`, others | 8 |
| H4 | Text-style buttons (sort headers, toggles) **inherit the tactile drop-shadow + gradient** meant for solid buttons | `styles.css:3580, 4575` | 8 |
| H5 | Keyboard-focusable **table rows have no visible focus ring** | `styles.css:3651`, `DataTable.tsx:102` | 9 |
| H6 | `report-spin` spinner has **no `prefers-reduced-motion` guard** | `styles.css:1496` | 9 |
| H7 | Danger confirm button **loses hover state** to an inline style; danger color not a class | `ConfirmDialog.tsx:51` | 8 |
| H8 | Floating overlays (modal, toast) use the **resting whisper shadow**, not `--shadow-lift` | `styles.css:2969, 3032` | 8 |
| H9 | `<summary>` disclosures **missing from the focus-visible ring** rule | `styles.css:3586` | 8 |
| H10 | Review-queue actions have **no loading/disabled state** (double-submit); Reject unconfirmed | `pages/VerificationPage.tsx:166` | 8 |
| H11 | Document **status colors are wrong** — `rejected` renders as amber "warning" | `pages/DocumentsPage.tsx:144` | 8 |
| H12 | Uploaded documents are a **dead-end list** — not clickable, fetched date unused | `pages/DocumentsPage.tsx:137` | 7 |
| H13 | `SubTabs` is an ARIA tablist with **no keyboard model / panel association** | `components/ui/SubTabs.tsx:30` | 7 |
| H14 | `GapBurndown` & `GanttChart` convey severity/status **by color alone** (hover-only labels) | `components/ui/GapBurndown.tsx`, `GanttChart.tsx` | 8 |
| H15 | `DataTable` sort state **not exposed to assistive tech** (`aria-sort`) | `components/ui/DataTable.tsx:84` | 8 |
| H16 | Two engagement disclosures **hand-roll a toggle** instead of `Collapsible` | `ResultsPage:311`, `BuyerLensPage:34` | 7 |
| H17 | No **global `prefers-reduced-motion`** guard — transitions/`:active` transform still run | `styles.css` (global) | 8 |

## MEDIUM / NICE-TO-HAVE — logged, not in this pass

Chip-radius drift on secondary chip families (`styles.css:1189…`); `.sev-chip`
white-on-amber AA fail (`styles.css:3888`); icon buttons below 44px target
(`.rm-check`, `.rank-move`); unify input focus ring; Toast error urgency +
dismiss; `ExitPaceChart` legend/line color mismatch; data-level chart
`aria-label`s (`TrajectoryChart`/`ExitPaceChart`); owner plan overdue chip +
collapse completed; `Settings` 3-digit-hex swatch dead code; select-arrow
hardcoded hex; `SectionCard` adoption on titled cards; shared `busy` on
multi-button toolbars. See git history of this file for the full enumerated set.

---

All Critical + High Value items above were implemented incrementally with a
`tsc` typecheck + `vitest` run after each batch; identity tokens, type scale,
spacing scale, and the component library were preserved.
