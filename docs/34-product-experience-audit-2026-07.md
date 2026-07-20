# 34 — Product Experience Audit (2026-07)

A workflow/usability audit of the advisor workspace by a nine-lens panel (UX
Architect, Workflow Designer, Human Factors, Enterprise Consultant, Customer
Success, Power User, Accessibility, PM, AI-Product critic). **Not a visual
redesign** — docs/26 tokens and docs/33's polish are the source of truth. This
pass optimizes *workflow, efficiency, discoverability, and cognitive load*: make
experienced advisors dramatically faster and first-time advisors dramatically
more successful.

The system is mature and heavily reviewed (docs/17, 19–22, 33). Most IA is
already sound: the five-work-stream arc, the WorkstreamRail, the tabbed
Evidence surface, per-assessment next-step CTAs, two clean empty-state variants.
This audit therefore targets the few remaining places where the software makes
the operator do work the software should do.

## The two core journeys, mapped

### Journey A — Onboard a new client and run the first assessment (first-run success)

| Step | Screen | Action | System response |
|---|---|---|---|
| 1 | Portfolio (empty) | click "Add your first client" | → /clients |
| 2 | Clients | **scroll past the list** to the form at the bottom; type name + industry; submit | company row inserted, form clears, toast — **stays on /clients** |
| 3 | Clients | **re-find the new card**; click "Start engagement" | agreement modal opens |
| 4 | Agreement modal | type signer; 0–3 consents; confirm | engagement created, toast — **stays on /clients** |
| 5 | Clients | **re-find the card again** (now "Engagement (active)"); click it | → engagement Overview |
| 6 | Engagement | click "Start baseline assessment" | → intake |

**Before:** 6 screens, ~7 clicks, **two dead-stops** where a completed action
leaves the advisor on the same page to hunt for their own item and click again
(after add-company; after start-engagement). Heuristic violations: *User control
& freedom / flow* (the system doesn't carry the user forward), *Recognition over
recall* (re-finding a row you just created), *Fitts / scanning* (add-company form
buried below an unbounded list).

### Journey B — Quarterly re-assessment (the core repeated action)

The engine re-scores every ~90 days; `server/scheduled.ts` actively flags
engagements as "reassessment due." Yet **every re-assessment started from a
completely blank rubric** — the advisor re-typed all 50+ answers each quarter,
even though most are unchanged quarter-over-quarter. Heuristic violations:
*Efficiency of use / smarter defaults* (Tesler's Law — the app pushed inherent
complexity onto the user), *Error prevention* (hand re-entry of dozens of stable
figures invites transcription errors), *Pareto* (80% of answers don't change; the
UI treated 100% as new).

## Findings — grouped by severity

### CRITICAL — implemented this pass

**C1 — Re-assessment carries forward the prior scored answers.**
- *Current:* new assessment = empty form; advisor re-enters the whole rubric each quarter.
- *Proposed:* when the last completed assessment used the same rubric version, its
  answers seed the new assessment as an editable starting draft; the advisor
  updates only what changed. A new methodology version still starts blank (question
  set changed). Provenance is deliberately **not** copied — a carried-forward figure
  is a draft, not a re-verified fact, so it reverts to self-reported until re-checked.
- *Impact:* removes ~50 field re-entries per quarterly cycle; the dominant repeated
  workflow. *Clicks/typing saved:* dozens of fields → a handful of edits.
  *Errors:* eliminates re-transcription of stable figures. *Users:* every advisor,
  every quarter. *Complexity:* Low (client-side copy, rubric-version-gated).
  *Respects CLAUDE.md rule 4* — a new immutable assessment, never an edit of the old.
- Intake shows a one-line banner on re-assessments so the carried-forward state is
  explicit ("update what's changed"), not silently pre-filled.

**C2 — Onboarding flow carries the advisor forward instead of stranding them.**
- *Current:* add-company and start-engagement each leave the advisor parked on
  /clients to re-find their row.
- *Proposed:* (a) adding a company flows straight into "Start engagement" (the
  agreement modal opens for the just-created company — you add a client *because*
  you're about to work with them); (b) recording the agreement lands the advisor
  **inside the new engagement**, where "Start baseline assessment" is the one
  waiting action. Journey A collapses from 6 screens / 2 dead-stops to a single
  continuous flow.
- *Impact:* ~3 clicks and 2 re-find/scan cycles removed from every new-client
  onboarding. *Users:* every advisor onboarding every client (highest-stakes
  first-run moment). *Complexity:* Low.

### HIGH — implemented this pass

**H1 — The "New company" form is the first thing, not the last.**
- *Current:* the create form sits below the client list; the empty state points
  "below," forcing a first-timer to scroll past an empty state, and forcing an
  advisor with a long book to scroll the whole list to add one.
- *Proposed:* the create affordance sits directly under the page header (primary
  action where the eye lands); empty-state copy updated to match. *Fitts's Law:*
  the most common action is now the closest target.

### MEDIUM — logged, not in this pass

- **"Security" in the top primary nav** is personal MFA setup done once — an
  account concern sitting as a daily-workflow peer of Portfolio/Clients (Hick's
  Law: 6 primary items where 5 are destinations). Candidate to fold into a user-chip
  menu or Settings. Deferred (needs a new menu affordance + focus management; the
  MFA gate route must stay reachable).
- **Portfolio masthead has no "new engagement" action** on a populated book; adding
  a client always routes through the Clients tab. Low friction (Clients is one nav
  click) — deferred.
- **Intake submit** reports "N questions still need an answer" and jumps to the
  first offending step, but doesn't visually mark *which* fields; recognition could
  be sharper. Deferred (the per-step answered/scored counter already narrows it).

### LOW — logged

- No global command palette / keyboard-first navigation for power users (would help
  the three-year-daily-user persona; large surface, out of scope for a targeted pass).
- No saved portfolio views/filters beyond the two selects (adequate for current book sizes).

## What shipped this pass

- `src/pages/EngagementPage.tsx` — `startAssessment` copies the prior scored
  assessment's answers into a re-assessment (rubric-version-gated; copy failure
  never blocks starting).
- `src/pages/IntakePage.tsx` — carried-forward banner on re-assessments.
- `src/pages/ClientsPage.tsx` — add-company flows into Start engagement; recording
  the agreement navigates into the new engagement; create form moved above the list;
  empty-state copy updated.

No scoring, schema, AI behavior, or routes changed. This is workflow/IA plus one
client-side copy of existing rows — a low-risk efficiency consolidation.

## Follow-up — Portfolio + Clients merged into one Engagements tab

The primary nav carried **two tabs for one mental model**: *Portfolio* (the scored
engagements table) and *Clients* (the company list + create flow). An advisor
manages a book of engagements; splitting "see the book" from "add to the book"
across two destinations is redundant navigation (a UX-Architect *screen-ownership*
violation and needless Hick's-Law load in the primary nav).

**Shipped:** a single **Engagements** tab (`/`) in the Portfolio format — stat band
+ the sortable/filterable engagements table — with an **Add engagement** action in
the masthead top-right. Add-engagement opens one dialog that absorbs the entire
former Clients flow: pick an existing client without an engagement *or* add a new
company inline, record the agreement acceptance (signer + consents, unchanged —
beta Requirement 1), then land the advisor inside the new engagement (docs/34 C2).
`/clients` redirects to `/`; the "Portfolio" breadcrumb root is relabeled
"Engagements" app-wide. Primary nav drops from 6 items to 5.

*Impact:* removes a whole redundant destination; the create path is now one click
from the book (top-right) instead of a tab switch; companies-without-engagements
are reached through the same Add-engagement picker rather than a separate list.
*Files:* `src/pages/DashboardPage.tsx` (merged page + `AddEngagementDialog`),
`src/App.tsx` (nav + `/clients` redirect), `src/lib/nav.ts` + breadcrumb labels,
`src/styles.css`; `src/pages/ClientsPage.tsx` deleted.

## Re-audit of the affected workflows

- **Journey A (onboarding):** now add company → agreement → *land in engagement* →
  Start baseline assessment. No dead-stops; no re-finding a row. No reviewer on the
  panel raises a further High issue on this path.
- **Journey B (re-assessment):** the advisor opens intake pre-populated with last
  quarter's answers, the banner sets the expectation, and they edit deltas only.
  Verification correctly resets (carried figures are self-reported until re-checked),
  so no false "verified" state leaks forward.
