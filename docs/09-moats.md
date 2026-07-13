# Moats & the data we must capture

The scoring engine, the reports, the portal — competitors can rebuild all of it.
Three things they cannot copy if we capture them from day one. This doc names
the moats and the infrastructure that feeds them.

## The three moats

### 1. Outcome calibration (the FICO moat)
Every DRS is a *prediction*: "this business is Sale Ready and worth ~5×." The
moat is proving it. When a deal closes we learn the **actual** EV, multiple,
EBITDA, time-to-close, and which risks the buyer actually flagged. Feeding that
back turns the DRS from an opinion into a *calibrated* score — "companies at DRS
72 closed at 4.6–5.4× within 14 months, 82% of the time." No competitor can
retrofit this; it requires years of closed deals tied to prior scores. This is
the single highest-value asset and it costs almost nothing to start capturing.

**Substrate:** `deal_outcomes` — one record per closed (or broken) engagement,
tying the prediction (DRS, ORI, verified %, predicted EV range) to reality
(final EV, multiple, EBITDA at close, buyer type, structure, retrade, days to
close, the gaps the buyer raised).

### 2. Verified financial corpus
Self-reported numbers are worthless as a dataset. **Ledger-verified** financials
(via the QuickBooks/Xero connection) are ground truth — real revenue, margins,
concentration, by industry and size band. This is what lets us refine the
valuation multiples *from our own book of deals* rather than generic comps, and
eventually benchmark a company against verified peers. The provenance layer
(Phase 1) already tags which inputs are verified; the connection makes it real.

### 3. The engagement graph
We hold the longitudinal path: initial gaps → remediation → score movement →
outcome. That "what actually moved the score, and did it move the price" graph
is proprietary. It powers playbook effectiveness ("clearing OWNER_DEP added ~0.4×
on average") — advice grounded in our own results.

## What to capture (and when)

| Signal | Where | When |
|---|---|---|
| DRS / ORI / verified % at each assessment | `assessments` (have it) | each assessment |
| Predicted EV range | `valuation` (compute it, snapshot at signal) | at go-to-market |
| Process milestones (LOI, QoE, retrade) | `outcome_events` (have it) | as they happen |
| **Deal close: EV, multiple, EBITDA, buyer type, structure, days, retrade, buyer-flagged risks** | **`deal_outcomes` (new)** | at close/broken |
| Which playbooks were run + gap deltas | `tasks` + `gaps` (have it) | over engagement |

The gap is the bolded row: we log process *events* but never the structured
*result*. `deal_outcomes` closes it — the mining substrate for all three moats.

## Non-negotiables
- **Capture is advisor-reported fact, never inferred.** An outcome is recorded,
  not predicted (docs/02).
- **Cross-firm aggregation is anonymized and opt-in.** A firm's raw deals never
  leak; the calibration layer reads a de-identified pool. RLS stays firm-scoped
  on the raw rows; the benchmarking view is a separate, aggregated surface.
- **Calibration informs the rubric; it never edits a score directly.** A
  recalibration ships as a new `rubric_version` / `valuation_rules_version`.

## Build order
1. **`deal_outcomes` capture** (this pass) — the substrate + advisor UI to record
   at close, and a per-firm predicted-vs-actual readout.
2. Calibration analytics (predicted vs actual across the firm's closed deals).
3. Anonymized cross-firm benchmarking (the network effect; separate surface).
