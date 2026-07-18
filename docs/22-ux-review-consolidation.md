# 22 — UX Review & Consolidation into Core Workflows

A review of the advisor workspace against the five sell-side preparation work
streams (docs/17) and the strategic IA principles (docs/19–21), plus the
consolidation this pass ships. The governing principle is unchanged:

> **One work stream = one mental model. The UX makes the arc first-class and
> hides the feature sprawl behind it.**

## What the review looked at

The engagement is the unit of work (CLAUDE.md rule 4). Everything an advisor does
for a client happens on the engagement Overview and the tabs hanging off it. So
the review focused there: is the five-stream arc — *Readiness → Remediation →
Evidence → Value → Deliverables* — legible, and does every surface sit in exactly
one stream without duplication?

## Findings

### F1 — The nav names the arc, but the Overview didn't show *progress* through it (fixed this pass)

`EngagementNav` already groups the tabs under the five work-stream labels
(docs/17). But the Overview — the first screen an advisor lands on — showed a
readiness snapshot, the three legs of the stool, and an exit-pace chart, with no
answer to the plainer question *"where are we in the process?"* An advisor had to
open each tab to learn that Evidence is at 0%, Value is sized, and no report
exists yet. docs/17 explicitly deferred this ("a per-work-stream progress
indicator on the Overview … so the owner sees the arc, not a checklist of tabs").

**Consolidation shipped:** a **work-stream progress rail** across the top of the
Overview. Five chips, in arc order, each showing the stream's state and one-line
status and deep-linking to that stream's tab:

| Stream | Done when | Reads from |
|---|---|---|
| **Readiness** | a current assessment is scored | completed assessments · DRS |
| **Remediation** | every open gap is owned by a task, or no gaps remain | gaps · tasks |
| **Evidence** | ≥80% of financial inputs are document-verified | verification summary |
| **Value** | enterprise value is modeled (recast present) | valuation |
| **Deliverables** | a report is finalized | generated documents |

States are `done` / `active` / `todo` / `blocked` (downstream streams are
`blocked` until a scored assessment exists — the arc has a real dependency order).
The model is a **pure, deterministic function** (`src/lib/workstreams.ts`,
unit-tested) fed by data the Overview already loads — no new queries, no scoring,
no writes. It only *summarizes* progress; it never computes a score (CLAUDE.md
rule 1).

### F2 — The three Evidence tabs are grouped in nav but still read as three tools (partially addressed)

Data room · Documents · Verification are one binder-building job (docs/17 §3).
The nav groups them under "Evidence," and the rail now collapses all three into a
single Evidence state ("0% verified", one link). This is the biggest *legibility*
win of the rail: the advisor sees one Evidence number, not three tabs to
reconcile. Merging the three tabs into a single tabbed surface remains a larger,
separate move (deferred — see below).

### F3 — The assessment-scoped pages sit outside the engagement shell (noted, deferred)

`/assessment/:id/intake`, `/results`, `/workbench`, `/report` render without
`EngagementNav`, so they drop the advisor out of the work-stream frame mid-task.
Per docs/17 they belong to Readiness (intake/results), Value (workbench), and
Deliverables (report). Folding them into the engagement shell is real routing
work with breadcrumb and back-navigation implications; scoped out of this pass and
recorded here so it isn't lost.

### F4 — The Overview's lower half is a deep stack of collapsibles (acceptable)

Score detail, engagement log, "how the plan connects," deal outcome, comparable
engagements, compare-two-assessments, and setup/admin are all collapsed by
default, so the default view stays calm and the depth is opt-in. This is the right
pattern and needs no change; the new rail sits *above* this stack as the
orientation strip, so the density below is reached deliberately, not stumbled
into.

## What shipped this pass

- `src/lib/workstreams.ts` — `buildWorkstreamProgress(input)`, the pure model.
- `tests/workstreams.test.ts` — 9 unit tests (arc order, dependency blocking,
  each stream's state transitions and thresholds).
- `src/components/ui/WorkstreamRail.tsx` — the presentational rail.
- `src/pages/EngagementPage.tsx` — builds the model from already-loaded data and
  renders the rail atop the Overview.
- `src/styles.css` — the rail styling (theme-aware, responsive: 5→2→1 columns).

No routes, schema, scoring, or AI behavior changed. This is information
architecture plus a pure summary function — a low-risk consolidation.

## Deferred (recorded, not built)

- **F2 deep-merge:** collapse Data room / Documents / Verification into one tabbed
  Evidence surface (not just one nav group and one rail state).
- **F3:** fold the assessment-scoped pages into the engagement shell so they keep
  the work-stream nav and breadcrumbs.
- **Portfolio rail:** the same five-stream summary per engagement on the Portfolio
  dashboard, so an advisor scans the whole book by stream. `buildWorkstreamProgress`
  is written to be reused here.
