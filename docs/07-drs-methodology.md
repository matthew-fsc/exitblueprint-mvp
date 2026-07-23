# 07 - DRS Methodology Reference (from Blueprint II: Ontology to Insight)

In-repo canonical summary of Matthew's methodology so no session needs the source docx.
The seed CSVs implement this exactly. Confidential IP of Exit Blueprint.

## DRS composite

DRS = RevenueQuality x 0.25 + FinancialIntegrity x 0.20 + OperationalIndependence x 0.20
    + CustomerRisk x 0.15 + Management x 0.10 + Growth x 0.10   (0-100)

Owner-side dimensions (Exit Goals, Personal Financial Readiness, Value Confidence) form
the separate Owner Readiness Index and never enter the DRS.

## Tiers and buyer posture

| DRS | Tier | Buyer posture |
|---|---|---|
| 85-100 | Institutional Grade | Competitive process, multiple bids, seller-favorable terms |
| 70-84 | Sale Ready | Standard diligence, closes on schedule |
| 55-69 | Needs Work | Extended diligence, earnouts, escrow, retrade risk on flagged items |
| 40-54 | High Risk | Distressed pricing, heavy escrow, contingent consideration |
| <40 | Not Saleable (Yet) | No institutional bid; do not go to market |

Key milestones: Diligence Ready = DRS 70. Competitive Process Ready = DRS 85.
Rule: every sub-score below 70 generates at least one buyer question (see content modules).

**Scope of the score (DRS-2.0).** The DRS measures **standalone operational
readiness** from transferable, EBITDA-based operations. It deliberately does not
value a non-transferable license/CON/franchise, primary IP, market-timing/scarcity,
or balance-sheet/asset-floor value. When a value-defining factor sits outside the
model, the engine raises a **blind-spot flag** (in `flags`) so a high score is
never read as "no risks" on a business whose value lives where the DRS cannot look
(e.g. a CON/license-dependent practice, or an asset-heavy holdco). Inputs:
`OPS-LICENSE-DEP` (license/CON/franchise transferability) and `VAL-ASSETS-CTX`
(material assets/IP).

## Sub-score weights and 100-point benchmarks

Full band logic lives in /seed/drs-rubric-subscores.csv and the reference scorer. Summary:

- Revenue Quality (25%): Recurring % (30%, >=80%), HHI concentration (25%, HHI<1000 and top1<10%; cap 60 if top1>30%), Contract durability (20%, >=75% contracted and >=18mo), Growth consistency (15%, CAGR>=15% no down years), NRR (10%, >=110%)
- Financial Integrity (20%): Reconciliation (30%, monthly), Addback defensibility (30%, >=80% LOW CHALLENGE), GAAP proximity (20%, accrual consistent), Statement completeness (20%, all three statements)
- Operational Independence (20%): Owner hours (35%, <10/wk), SOP coverage (30%, >=80%), Management depth ratio (20%, >=1 per function), Automation (15%, >=70%)
- Customer Risk (15%): Top-1 % (30%, <10%), Top-5 % (25%, <30%), Avg tenure (20%, >=5yr), Contract coverage (15%, >=80% of revenue), Churn (10%, <5%)
- Management (10%): Layers (30%, 2+), Non-competes (25%, 100% of key employees), Comp vs market (25%, within +/-15%), Retention (20%, <10% turnover)
- Growth (10%): CAGR (35%, >=20%), Pipeline coverage (30%, >=3x annual revenue), Positioning (20%, strong_defined=100 as of DRS-2.0; was capped at 80 in DRS-1.0), Repeatability (15%, >=70% standardized)

## Roadmap phasing (drives playbook phase field)

- Phase 1 (0-6mo) Risk elimination: critical flags, addback documentation, non-competes, highest-dependency SOPs. Target DRS +8 to +12.
- Phase 2 (6-18mo) Structural improvement: complete SOPs, transition owner relationships, diversification, recurring conversion, clean books. Target +10 to +18.
- Phase 3 (18-36mo) Value optimization: management deepening, pipeline, contracts, comp benchmarking, reporting.

## Later-phase engines (methodology reference)

> **Build note (2026-07).** Several of these have since shipped: the valuation and
> comparables engines are live (`server/valuation.ts`, `server/comparables.ts`,
> `compute-valuation` / `engagement-comparables`, `ValuationPage.tsx`), covering
> EBITDA recast (A2), Enterprise Value (A10), and Value Gap (A11). The projection
> (A12.3), confidence bands (A9.2), and the Blueprint I ingestion ontology remain
> unbuilt. The methodology text below stays as the canonical spec regardless of
> build status.

- **EBITDA Recast (A2):** Net income + D&A + interest + taxes = Reported EBITDA; + owner comp normalization, personal expense addbacks, one-time items, related-party normalization, pro forma adjustments = Defensible EBITDA. Every addback rated LOW/MEDIUM/HIGH/NOT DEFENSIBLE challenge likelihood; conservative/base/aggressive scenarios.
- **Enterprise Value (A10):** industry baseline multiple (IBBA Market Pulse / DealStats / GF Data, cited) adjusted by DRS: 90-100 -> +1.0 to +1.5x; 80-89 -> +0.5 to +1.0x; 70-79 -> +0.1 to +0.5x; 60-69 -> baseline; 45-59 -> -0.5 to -0.75x; 30-44 -> -1.0 to -1.5x; <30 -> -2.0x or no bid.
- **Value Gap (A11):** Target EV (target EBITDA x target-DRS multiple) minus Current EV; per-initiative dollar impact; cost-of-inaction framing.
- **DRS/EV monthly projection (A12.3):** step-function projection with initiative milestones.
- **Confidence bands (A9.2)** and the Blueprint I ingestion ontology arrive with the data-ingestion phase; v1 questionnaire inputs are treated as advisor-verified.
