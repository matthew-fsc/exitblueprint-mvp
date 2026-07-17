# 19 - Vision, Work Streams & UX — the North Star

A single reference for reasoning over Exit Blueprint: what we're building, why,
how it's organized, and the principles that keep it coherent as it grows. It
synthesizes `CLAUDE.md` and docs 00, 07, 09, 15–18 into one place. When this doc
and `CLAUDE.md` disagree, `CLAUDE.md` wins — those are hard rules; this is the
frame around them.

---

## 1. Vision & thesis

**What we are.** An exit-readiness platform for lower-middle-market business
owners, distributed through the M&A advisors who guide them — Certified Exit
Planning Advisors (CEPA) and CFP® financial planners. We serve the **12–36-month
pre-deal window** that nothing else serves: existing diligence tooling (Rogo,
buy-side automation) serves institutions with a deal already in motion; we serve
the owner and advisor *before* there is a deal, when value is quietly made or lost.

**The thesis.** A sale is an interrogation — a buyer (or their customers, or the
regulators behind them) stress-tests whether a business can be cleanly and safely
transferred. Everything we build exists to **predict and pre-empt that
interrogation**, and to **model the way advisors already work** so their process
maps onto our screens instead of fighting them.

**Who we serve.**
- **Advisor** (primary — buys and drives the product): manages a portfolio of
  client companies, runs assessments, drives roadmaps, gets meeting-prep briefs.
- **Owner** (secondary): sees their score, roadmap, and education via a portal.
- **Admin** (Exit Blueprint): manages firms, rubric versions, playbook/content
  libraries.

**The core loop.** Assess → Diagnose → Prescribe → Educate → Re-assess, repeated
over a long engagement. The engagement — not the deal — is the unit; scores are
longitudinal, and progress over time is the product.

---

## 2. Non-negotiable architecture (the guardrails)

These are hard rules (`CLAUDE.md`). Every feature respects them.

1. **Deterministic scoring.** The DRS is rule-based, versioned code. No LLM ever
   computes, adjusts, or influences a score. The reference implementation
   (`seed/fixtures/reference_scorer.py`) is ground truth.
2. **AI is narrative-only.** Claude writes reports/briefs/summaries *from*
   structured data, always labeled draft. It never writes *to* scoring tables.
3. **Rubric lives in data, not code.** Dimensions, questions, sub-scores, weights,
   bands, and thresholds are rows seeded from `/seed`. Methodology changes ship as
   a new `rubric_version`, never as edited engine logic.
4. **Engagement is the unit.** Assessments are immutable snapshots tied to a
   `rubric_version`; corrections supersede, never mutate. Score history and deltas
   are first-class.
5. **Two score groups, never mixed.** `business_readiness` dimensions roll into the
   **DRS**; `owner_readiness` dimensions roll into the separate **Owner Readiness
   Index (ORI)**.
6. **Multi-tenant from day one.** Every domain table carries `firm_id`; RLS
   enforces firm isolation, covered by an automated test suite.
7. **Versioning.** `rubric_version` on assessments, `prompt_version` on AI docs,
   `playbook_version` on task sets, `valuation_rules_version` on valuations.

---

## 3. The methodology we model

We deliberately model how CEPAs and CFPs actually run exit preparation (docs/18),
because our users think in this vocabulary.

**CEPA — Value Acceleration Methodology™ (Exit Planning Institute).**
- **Three gates:** *Discover* (assess business + personal + financial, value the
  business, produce a prioritized action plan) → *Prepare* (execute in 90-day
  sprints on parallel business and personal-financial tracks) → *Decide* (hold and
  keep growing, or go to market).
- **Three Legs of the Stool:** the **Business**, **Personal**, and **Financial**
  legs must balance; a short leg wobbles the whole plan. The personal leg is the
  most overlooked.
- **The gaps CEPAs quantify:** *Wealth Gap* (owner's post-exit goal − net worth
  excluding the business), *Value / Profit Gap* (current value vs. best-in-class).
- **Four Intangible Capitals:** Human, Structural, Customer, Social — most of
  enterprise value.
- **Attractiveness vs. Readiness:** buyer appeal vs. transferability — two axes.

**CFP® — the 7-step process:** understand circumstances → goals → analyze vs.
alternatives → recommend → present → implement → monitor. Goals-first and
continuously reviewed.

**How our model maps.** The DRS is *readiness*; the ORI is the *personal + financial*
legs; valuation carries the *wealth gap* and *value gap*; the roadmap is the
*Prepare*-gate execution in 90-day sprints; re-assessment is the *monitor* loop.
Where their vocabulary was missing (three-legs view, wealth-gap surfacing, sprints,
capitals lens) we added it as a **lens over data we already produce** — never a
second scoring system.

---

## 4. The five sell-side work streams (the product's spine)

Every feature maps to exactly one work stream. The work streams read left-to-right
in the order the work actually happens (docs/17).

### 1. Readiness — "Where do we stand, and what will a buyer challenge?"
- **Core concept:** the DRS/ORI measurement and its translation into buyer-facing
  risk (named gaps, buyer questions), plus the Three Legs of the Stool alignment.
- **Surfaces:** engagement Overview, assessment intake, Results/score-detail, Buyer
  lens; the Four Intangible Capitals lens.
- **CEPA gate:** Discover. **Done when:** a current assessment exists with gaps
  opened and buyer questions generated.

### 2. Remediation — "What's the plan, and who owns it?"
- **Core concept:** open gaps → playbooks → a sequenced task roadmap in 90-day
  sprints, with owners and dates; education dripped against the client's gaps.
- **Surfaces:** Roadmap (sprints, deal-team handoff, milestones), education modules.
- **CEPA gate:** Prepare. **Done when:** every critical/high gap has an owned task
  with a date and Phase-1 risk items are moving.

### 3. Evidence — "Can we prove it? Build the diligence binder."
- **Core concept:** turn self-reported claims into document-verified facts — the
  binder a buyer diligences. The consolidation win: data room, documents, and
  verification are one job.
- **Surfaces:** Data room readiness, Documents, Verification; company-level Trust &
  Security (docs/16) as evidence the platform survives a vendor review.
- **CEPA gate:** Prepare (parallel). **Done when:** the items a buyer will request
  are Ready with linked, verified documents and reconciliation conflicts resolved.

### 4. Value — "What is it worth, and what is getting ready worth?"
- **Core concept:** DRS → industry-anchored EV; the value-creation gap; the owner's
  **wealth gap** (net-to-owner vs. their post-exit goal); scenario modeling.
- **Surfaces:** Valuation (EV, recast, wealth-gap capture), scenario Workbench.
- **CEPA gate:** motivates Prepare, feeds Decide. **Done when:** current EV, target
  EV, and the wealth gap are all visible.

### 5. Deliverables — "Tell the story."
- **Core concept:** AI drafts the narrative from structured data; the advisor edits
  and finalizes; the owner/market receives a professional report; quarterly delta
  reports keep the relationship warm.
- **Surfaces:** owner report, advisor brief, delta report.
- **CEPA gate:** every cycle's close. **Done when:** a finalized report exists for
  the current assessment.

**Cross-cutting surfaces** (support the streams, live at the app level): Portfolio
(Readiness across the book), the staff Review queue (Evidence across engagements),
the Library (Remediation content), and Trust & Security (company-level Evidence).

---

## 5. UX & information-architecture principles

1. **One work stream = one mental model.** A concept never spreads across sibling
   tabs. The engagement nav is grouped by work stream (Readiness · Remediation ·
   Evidence · Value · Deliverables), not by feature.
2. **The arc is legible.** Navigation reads left-to-right in the order the work
   happens; the three Evidence tabs read as one binder-building job.
3. **Summarize on the owning stream; capture where the data lives; link across.**
   E.g., the Three Legs financial leg is summarized on Readiness but links to the
   wealth-gap capture on Value. Screens reference one taxonomy, never two.
4. **Progressive disclosure.** Default views show what an untrained advisor needs;
   analytical/power tools sit one click away behind labeled disclosures.
5. **Deterministic vs. narrative surfaces are distinct.** Scores, checklists, and
   gaps are rule-based fact; AI output is always a labeled, editable draft.
6. **Model reality, not just greenfield.** Advisors onboard engagements already in
   flight — so the system must be catch-up-able: editable engagement start date and
   target window, per-task due dates, and manual tasks for work done outside the
   generated playbooks.
7. **State reads at a glance.** Severity/readiness is encoded in form (chips,
   stripes, bands), not just number; semantic color (good/warning/critical) is
   separate from brand accent.
8. **Advisor-branded, owner-facing.** Client-facing output carries the advisor
   firm's brand; the platform is the engine, the advisor is the face.

---

## 6. Vision statements — how the build advances the vision

Each area earns its place by advancing the thesis and protecting what compounds.

- **We measure readiness against the real buyer interrogation** (buyer-DD analysis,
  the Transferability layer, the Data Room Readiness binder) *so that* owners walk
  into diligence with no surprises and advisors close on schedule.
- **We model the advisor's own methodology** (Three Legs, gates, 90-day sprints,
  intangible capitals, the wealth gap) *so that* the software fits how CEPAs and
  CFPs already work and earns their trust as the system of record.
- **We quantify the dollar stakes** (EV, value-creation gap, wealth gap) *so that*
  readiness work is tied to the number the owner actually cares about — funding
  their next chapter.
- **We turn claims into verified facts** (document intake → reconciliation →
  verified corpus) *so that* the score, the report, and eventually the benchmark
  rest on ground truth, not self-report.
- **We keep the engagement longitudinal** (immutable snapshots, deltas, re-assessment)
  *so that* the relationship — and the dataset — compounds over years.

**What compounds (the moats — docs/09), protect these:**
1. **Outcome calibration (the FICO moat).** Every DRS is a prediction; tying closed
   deals back to prior scores turns it into a *calibrated* score no competitor can
   retrofit. Capture is advisor-reported fact, never inferred.
2. **The verified financial corpus.** Ledger/document-verified financials are the
   ground truth that lets us refine multiples from our own book and benchmark
   against real peers.
3. **The engagement graph.** The longitudinal path (gaps → remediation → score
   movement → outcome) powers "what actually moved the score, and did it move the
   price" — advice grounded in our own results.

Calibration informs the rubric; it never edits a score directly. A recalibration
ships as a new `rubric_version`.

---

## 7. Current state & direction

**Built (recent arc — docs/15–18 and their merged PRs):**
- Buyer-expectations & vendor-DD analysis; the **Data Room Readiness** binder
  (deterministic checklist + per-item document tagging).
- **DRS-2.0** second-pass weighted rubric *drafted* (adds a Transferability &
  Legal Readiness dimension + hard gating flags; awaiting approval to become a
  `rubric_version`).
- Vendor-security posture to the RIA vendor-DD standard (docs/16) + idle-session
  timeout, sub-processor register.
- **Work-stream nav consolidation** (8 flat tabs → 5 grouped).
- **Three Legs of the Stool** alignment; first-class **wealth-gap capture**;
  **90-day sprints** on the roadmap; the **Four Intangible Capitals** lens.
- **Catch-up controls** for in-flight engagements.

**Open / next (decisions belong to Matthew):**
- Approve **DRS-2.0** → build it as a new `rubric_version` (work stream A:
  supplier/channel concentration, working-capital, sales-tax nexus, and the
  Transferability layer, reusing the data-room item taxonomy).
- **Profit gap** (needs an industry EBITDA-margin benchmark source) and
  **Decide-gate options analysis** (needs the exit-path set to model).
- **SOC 2** readiness (the long pole on enterprise vendor reviews).
- Attractiveness axis and a dedicated parallel personal/financial track remain
  proposed.

---

## 8. Using this doc in a reasoning session

- **Precedence:** the user's words → `CLAUDE.md` hard rules → this north star →
  individual design docs.
- **Build only the current slice; don't scaffold ahead.** Methodology changes are a
  new `rubric_version`; product-behavior decisions belong to Matthew.
- **Source docs:** 00 (product brief), 02 (data model), 03 (scoring spec), 07 (DRS
  methodology), 09 (moats), 15 (buyer expectations & vendor DD), 16 (vendor
  security), 17 (work streams & UX), 18 (CFP/CEPA workflow alignment).
