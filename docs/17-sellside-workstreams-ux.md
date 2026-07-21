# 17 - Sell-Side Preparation Work Streams & the UX Around Them

The product has grown feature-by-feature — assessment, results, roadmap, valuation,
buyer lens, documents, data room, verification, delta report, security. Each shipped
as its own tab or page. The engagement navigation is now **eight flat tabs** with no
grouping, and related concepts are scattered (documents, data room, and verification
are three separate tabs that are really one job). This document defines the **five
sell-side preparation work streams** the product actually serves, dives deep on each,
and consolidates the feature spread so the UX is organized around those work streams
instead of around individual features.

## The principle

A lower-middle-market owner preparing to sell moves through a fixed arc: *figure out
where they stand → decide what to fix → fix it and prove it → understand what it's
worth → package the story.* Every feature we have maps onto one step of that arc.
The UX should make the arc first-class and hide the feature sprawl behind it:

> **One work stream = one mental model. A concept never spreads across sibling tabs.**

## The five work streams

### 1. READINESS — "Where do we stand, and what will a buyer challenge?"

The measurement layer. The advisor runs the owner through the DRS/ORI assessment; the
deterministic engine returns a versioned score with a dimension breakdown; low
sub-scores surface as named gaps and as the specific questions a buyer will ask.

- **Core concept:** the score and its translation into buyer-facing risk. This is the
  diagnosis — nothing is fixed here, everything is named.
- **Surfaces today:** engagement Overview (readiness snapshot, open gaps, exit-pace),
  the assessment intake, the Results / score-detail page, **Buyer lens** (the buyer
  questions each weak sub-score generates).
- **Sequence:** first, and repeated quarterly. Everything downstream keys off it.
- **Done when:** a current, complete assessment exists with its gaps opened and the
  buyer-question set generated.

### 2. REMEDIATION — "What's the plan, and who owns it?"

The prescription layer. Open gaps map to remediation playbooks, which instantiate as
a sequenced task roadmap with owners and due dates, phased the way the methodology
phases risk (Phase 1 risk elimination → Phase 2 structural improvement → Phase 3
value optimization). Education content is dripped against the client's specific gaps.

- **Core concept:** the sequenced fix plan that moves the score over the engagement.
- **Surfaces today:** **Roadmap** (playbook tasks, board, phasing) and the
  gap-keyed content/education modules (today reached via Library).
- **Sequence:** second — driven by the gaps Readiness opened; its progress is what
  re-assessment measures.
- **Done when:** every critical/high gap has an owned task with a date, and Phase-1
  risk items are in motion.

### 3. EVIDENCE — "Can we prove it? Build the diligence binder."

The proof layer, and the biggest consolidation win. A buyer does not accept
self-reported numbers — they re-verify. This work stream turns claims into
document-verified facts: the owner assembles the diligence request list ahead of
time (**Data room readiness**), uploads source documents against each item
(**Documents**), and the platform reconciles self-reported answers against
document-extracted values, routing conflicts to a review queue (**Verification**).
These three tabs are **one job** and belong together.

- **Core concept:** self-reported → document-verified. The binder a buyer diligences.
- **Surfaces today:** **Data room**, **Documents**, **Verification** — three sibling
  tabs that this consolidation groups under one "Evidence" work stream. Company-level
  **Trust & Security** (the vendor-DD posture, docs/16) supports it: it is the
  evidence that *the platform and the business* survive a security review.
- **Sequence:** runs alongside Remediation — as gaps close, the evidence that they
  closed is assembled here.
- **Done when:** the data-room items a buyer will request are Ready with a linked,
  verified document, and reconciliation conflicts are resolved.

### 4. VALUE — "What is it worth, and what is getting ready worth?"

The quantification layer. The DRS maps to an industry-anchored valuation multiple;
the value gap is the dollar distance between the current EV and the target EV at a
higher DRS; the scenario workbench lets the advisor model what closing specific gaps
does to the number.

- **Core concept:** enterprise value and the dollar value of readiness — the reason
  the owner does any of the above.
- **Surfaces today:** **Valuation** (EV, recast, value gap) and the scenario
  **Workbench**.
- **Sequence:** reads from Readiness (the DRS) and Evidence (verified % narrows the
  confidence band); motivates Remediation.
- **Done when:** the owner can see current EV, target EV, and the per-initiative
  dollar impact.

### 5. DELIVERABLES — "Tell the story."

The output layer. AI drafts the narrative *from* the structured data (never scoring),
the advisor edits and finalizes, and the result is a professional report the owner or
market receives — plus the quarterly delta report that shows movement and keeps the
advisor relationship warm.

- **Core concept:** the narrative artifacts handed to the owner and the market.
- **Surfaces today:** Owner report, Advisor brief, **Delta report**, and the
  **CIM** (Confidential Information Memorandum) — the market-facing deliverable.
- **Sequence:** last in each cycle — it packages everything the other four produced.
- **Done when:** a finalized report exists for the current assessment.

#### The CIM — packaging Evidence into the market document

The CIM is where the Evidence work stream lands: the collected, verified diligence
binder, packaged into the buyer-facing marketing document. Two connected pieces:

- **Posture (CIM readiness).** The CIM's eight buyer-facing sections (Investment
  Highlights, Company Overview, Products & Services, Market & Growth Opportunity,
  Customers & Revenue, Operations & Organization, Financial Overview, The
  Opportunity) map onto the **same seven data-room sections** the Evidence work
  stream already collects — one taxonomy, not a second checklist (docs/15
  decision 4). The CIM page leads with a readiness panel that rolls up per-section
  evidence coverage (Ready / verified / missing) and routes the advisor back into
  Evidence to collect what's still missing. This is what gives evidence collection
  a visible destination.
- **Generation.** The CIM is auto-drafted the same way every other document is:
  prose composed FROM structured data (company profile, the assessment's strengths
  as investment highlights, adjusted EBITDA, and the verified-evidence list),
  never computing a score. Because it is buyer-facing marketing, the payload
  carries **strengths and verified facts only** — no gaps, no weaknesses, no
  internal DRS score, and never an asking price or valuation. It generates → edits
  → finalizes → exports as a branded PDF, exactly like the owner report, and is a
  clearly-labeled draft the advisor reviews before any buyer sees it. The owner
  sees the CIM in their portal **once the advisor finalizes it** — the draft stays
  private to the firm until sign-off (RLS gates the owner's read on `finalized_at`,
  migration 20260721000600), so the advisor-review guardrail holds while still
  giving the owner the finished memorandum.

The methodology (the section set and its evidence mapping) lives in
`shared/cim/template.ts`; the coverage rollup and the generation payload/composer
live in `server/cim.ts`. A DB-backed, firm-editable CIM template is a follow-up if
firms need to customise the section set.

## Consolidated information architecture

Every current surface maps to exactly one work stream. Nothing is orphaned; nothing
is duplicated.

| Work stream | Engagement tabs (consolidated) | Related surfaces |
|---|---|---|
| **Readiness** | Overview · Buyer lens | Assessment intake · Results / score detail |
| **Remediation** | Roadmap | Education modules (Library) |
| **Evidence** | Data room · Documents · Verification | Review queue (staff) · Trust & Security |
| **Value** | Valuation | Scenario workbench |
| **Deliverables** | Delta report | Owner report · Advisor brief |

**Cross-cutting surfaces** (not one engagement's work stream, but supporting the five):
Portfolio dashboard (Readiness across the book), the staff Review queue (Evidence
across engagements), the Library (Remediation content catalog), and Trust & Security
(company-level evidence). These stay at the app level.

### The navigation change

The engagement navigation moves from **eight flat, ungrouped tabs** to **five labeled
work-stream groups**:

```
Readiness      Remediation   Evidence                      Value        Deliverables
Overview       Roadmap       Data room · Documents ·        Valuation    Delta report
Buyer lens                   Verification
```

This is implemented in `src/components/ui/EngagementNav.tsx`: the tabs are the same
routes, but rendered under work-stream labels so the grouping is visible at a glance —
in particular the three Evidence tabs read as one job, which is the whole point. No
routes change; this is pure information architecture.

## Why consolidate now

- **Discoverability:** an advisor new to the product sees five jobs, not eight tools.
- **Sequence is legible:** the groups read left-to-right in the order the work happens.
- **The Evidence cluster stops reading as three unrelated features** — data room,
  documents, and verification are one binder-building job.
- **Future headroom:** with the five work streams named in the UI, the next step is a
  per-work-stream progress indicator on the Overview (e.g., "Evidence: 12/37 items
  verified") so the owner sees the arc, not a checklist of tabs. Specced here, not
  built in this pass. **Built in docs/archive/22** — the work-stream progress rail.

## Non-goals for this pass

No routes, scoring, or data change. This is navigation/IA plus this document — a
deliberate, low-risk consolidation. Deeper moves (a work-stream landing rail,
progress meters per stream, merging the assessment-scoped pages into the engagement
shell) are follow-ups for Matthew to prioritize.
