# 21 - MVP Strategic Audit (against docs/20)

Classifies the **current** MVP — the actual screens, workflows, and tables that
exist today — against the strategy in docs/20 and its four buckets. The purpose
is to decide where to invest (A/B), where to hold the line (C), and what to defer
(D). Grounded in the real codebase, not aspiration.

**Buckets:** **A** Core strategic asset — strengthen. **B** Intelligence capture —
expand deliberately. **C** Commodity — keep functional, don't over-invest.
**D** Strategic distraction — defer until validated by demand.

## The headline finding

**The strategy is largely already scaffolded.** Every one of the seven moat
layers has a real foundation in the schema — the pieces exist, mostly as
substrate, and the work is to *connect and compound* them, not to invent them:

| Moat layer (docs/20) | It already exists as | State |
|---|---|---|
| 1 Professional workflow | assessment → results → roadmap → report | Built |
| 2 Advisor deliverables | `generated_documents` (owner report, advisor brief, delta) | Built |
| 3 Evidence management | `documents` / `document_fields` / verification / data room | Built |
| 4 Advisor Library | `advisory_library_items`, `playbooks`, `content_modules` | Partial — a catalog, not yet firm-authored logic |
| 5 Institutional Knowledge Graph | `graph_nodes` / `graph_edges` / `findings` (sell-side substrate) | **Foundation only — the biggest opportunity** |
| 6 Outcome calibration | `deal_outcomes` / `outcome_events` / `engagement_outcomes` | Substrate built; UI dormant |
| 7 AI-assisted guidance | `llm_calls` ledger, narrative service, findings patterns | Narrative + findings only; no "institutional reviewer" yet |

The strategic move is therefore **compounding, not greenfield**: turn substrate
(graph, outcomes, library) into a connected, learning system.

## Category A — Core strategic assets (strengthen)

Directly serve advisor value + institutional memory + defensible evidence.

| Surface | Where | Why A |
|---|---|---|
| Assessment versioning / immutable snapshots | `assessments` (record_status, supersede) | Defensible evidence; the spine of longitudinal memory |
| Delta reports & comparison | `compareAssessments`, delta report | Advisor value; shows movement over the engagement |
| Advisor timeline / trajectory | exit-pace chart, engagement history | Advisor value; the engagement narrative |
| Deliverables | `generated_documents` (report/brief) | Advisor credibility; the client-facing output |
| Outcome events | `outcome_events`, `deal_outcomes` | Outcome calibration — the FICO moat substrate |
| Activity & audit history | `usage_events`, `data_access_log` | Institutional memory + defensible evidence |
| Evidence pipeline | `documents` → `document_fields` → verification | Defensible evidence; self-reported → verified |

**Action:** keep these first-class and well-instrumented. They are the record the
whole intelligence layer reads from.

## Category B — Intelligence capture (expand deliberately)

Feed the knowledge graph and Advisor Library. **This is where net-new investment
should concentrate.**

| Capability | Current state | The expansion |
|---|---|---|
| Recommendation taxonomy | `gaps` → `gap_playbook_map` → `playbooks` → `gap_content_map` → `content_modules` | Rich mapping exists; make it firm-extensible and outcome-weighted |
| Advisor Library | `advisory_library_items` (system catalog + firm rows) | Move from a catalog toward **firm-authored decision trees, rationale, risk patterns** (docs/20) |
| Institutional Knowledge Graph | `graph_nodes` / `graph_edges` / `findings` | **Connect the chain**: business characteristics → gaps → recommendations → evidence → actions → progress → outcomes. The single highest-leverage B item |
| Buyer-diligence simulation | Buyer lens (buyer questions), findings patterns, Data Room Readiness | Grow into "what will sophisticated diligence discover" — proactive, not reactive |
| Structured meeting outcomes | **BUILT (v1)** — `engagement_log` | Meetings/decisions captured as structured, backdatable records on the engagement Overview |
| Advisor rationale capture | **BUILT (v1)** — `engagement_log` kind=rationale, gap_id link | Records *why*, attached to the gap it explains |
| Evidence metadata / historical comparisons | `document_fields` verification | **Comparable engagements BUILT** — firm-scoped historical cases by industry/size/shared gaps (`shared/comparables.ts`) |

**Action (started):** the **engagement_log** (staff-only, backdatable, optionally
tied to a gap) now captures meetings, decisions, and the *rationale* behind
recommendations — the first Category-B build. Next: feed these entries into the
knowledge graph (`graph_edges` from a rationale entry → the gap it explains → the
recommendation), and grow the Advisor Library from a catalog into firm-authored
decision trees.

## Category C — Commodity (keep functional, don't over-invest)

Expected, not differentiating.

| Surface | Where |
|---|---|
| Portfolio dashboard | `DashboardPage` |
| Task lists | roadmap `tasks` |
| File storage | `document_blobs` (behind StorageAdapter) |
| Questionnaire UI | assessment intake |

**Action:** maintain, keep clean, but no deep investment. Note the intake
*questionnaire* is C, but the *rubric behind it* is core methodology IP (A).

## Category D — Strategic distractions (defer until demand)

Widen the product without deepening the moat.

| Candidate | Current state | Disposition |
|---|---|---|
| Large owner portal | basic owner portal exists | Keep minimal; don't expand into a second full app |
| Complex valuation modeling | valuation (EV, recast, wealth gap) built | **Hold** — enough to size the wealth/value gap; **defer the profit-gap and Decide-gate options modeling** I had teed up (docs/18 §4) until demand |
| Extensive accounting integrations | `ledger_connections` (QuickBooks/Xero) | Keep the seam; don't deepen |
| Generic AI chat | not built | Do not build |
| Broad workflow automation | n8n webhooks (minimal) | Keep minimal |

**Reprioritization note:** docs/18's remaining items (profit gap, Decide-gate
options) fall in Category D under this strategy — **defer them** in favor of the
Category B knowledge-graph and rationale-capture work. This supersedes the earlier
"next up" framing in docs/18 §4.

## What this changes about "what's next"

Reading the roadmap through docs/20's decision framework:

1. **Connect the chain (B) — DONE (v1):** the "How the plan connects" read
   assembles gap → recommendation → the advisor's reasoning (`engagement_log`) →
   progress (`tasks`) into one connected view (`buildEngagementKnowledge`,
   `src/lib/knowledge.ts`), surfaced on the engagement Overview. Design choice:
   assembled **deterministically over source tables**, not duplicated into the
   document-verified `graph_nodes/edges` (which stay for extracted facts) — same
   information, no sync/staleness. Cross-engagement pattern lookup (comparable
   engagements) is now BUILT; next is connecting outcomes onto the chain.
2. ~~**New capture (B):** structured meeting outcomes + advisor rationale~~ —
   **DONE (v1)** via `engagement_log`, now connected to recommendations (item 1).
3. **Activate substrate (A→Outcome Intelligence):** surface the dormant
   `deal_outcomes` calibration UI (docs/09 moat 1) — start turning predictions into
   a calibrated score.
4. **Grow (B):** the **Advisor Library** from a catalog into firm-authored decision
   trees / risk patterns / rationale.
5. **Defer (D):** profit-gap and Decide-gate valuation modeling, owner-portal
   expansion, deeper accounting integrations, any generic AI chat.

Every item above satisfies the framework: it improves advisor effectiveness or
preparation quality, captures institutional knowledge, increases evidence quality,
or improves outcome calibration. Items that satisfy none are not prioritized.

## Non-negotiables still hold

Nothing here overrides `CLAUDE.md`: scoring stays deterministic and rubric-in-data;
AI stays narrative/reviewer-only and never grades; the engagement stays the unit;
multi-tenant RLS everywhere; calibration informs the rubric via a new
`rubric_version`, never by editing a score. The "AI as institutional reviewer"
(docs/20) lives entirely on the narrative/analysis side of that line.
