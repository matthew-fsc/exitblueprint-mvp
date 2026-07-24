# Content provenance — advisor library, playbooks & Plans

This register backs the **narrative and prescription** content in `/seed` (advisory
library, content modules, playbooks, system Plans) with reputable, **free** lower-middle-
market (LMM) M&A sources. It documents where claims come from **without changing the
canonical rubric** — the DRS/ORI weights, bands, and thresholds in
`drs-rubric-subscores.csv` and `gap-definitions.csv` are unchanged (a threshold change
would be a new `rubric_version`, per `CLAUDE.md` rule 3). See `docs/41` for the plan
this executes.

**Foundation is industry-agnostic.** The content covers cross-industry value drivers
(owner dependence, concentration, recurring revenue, financial integrity, management
depth, growth durability, owner readiness, deal process). Industry-specific valuation
multiples in `valuation-multiples.csv` are **unchanged** and remain directional; refining
them per-industry needs paid transaction data and is out of scope here.

## Sources (see `seed/sources.csv` for machine-readable rows)

| Tier | Source | Free? | Used for |
| --- | --- | --- | --- |
| 1 | Pepperdine Private Capital Markets Report | Yes (download) | Multiples direction, recast-EBITDA dominance, deal-killer reasons |
| 1 | IBBA / M&A Source Market Pulse | Yes (summaries) | LMM sale multiples, time on market, buyer mix, sentiment |
| 1 | BVR DealStats Value Index | Yes (quarterly summary) | Realized private-transaction multiple trend |
| 1 | Capstone Middle-Market M&A Valuations Index | Yes | Size-premium gradient |
| 2 | Exit Planning Institute (State of Owner Readiness / Value Acceleration) | Yes | Owner-readiness framework + statistics |
| 2 | Value Builder System (8 value drivers) | Yes (public framework) | Cross-industry value-driver framing |
| 2 | ASA / AICPA (QoE & financial DD) | Partly | QoE scope, addback substantiation |
| 3 | Practitioner consensus | Yes | Concentration thresholds, working-capital & structure norms — corroborating only |

## Cross-checked figures used in content (with as-of)

Every number that appears in an education module or playbook is stated as a **directional
range** and cross-checked across ≥2 sources where it drives a claim:

- **Recast (adjusted) EBITDA is the number buyers pay on**, not reported profit — the
  dominant valuation method in the LMM. _[SRC-PEPPERDINE, SRC-ASA; 2024–2025]_
- **Unsupported addbacks are among the most common sources of price reductions between LOI and close.** _[SRC-ASA, SRC-PRACTITIONER; 2024]_
- **A Quality-of-Earnings review is standard practice above ~$1–2M EBITDA.**
  _[SRC-ASA, SRC-AICPA, SRC-PRACTITIONER; 2024]_
- **Customer-concentration risk bands:** under 10% clean; 10–20% draws diligence
  questions; 20–30% a yellow flag; over 30% many buyers decline; over 40% is
  near-uninvestable on conventional terms. Concentration above threshold commonly costs
  ~20–35% of value or shifts deal structure (earnouts, holdbacks). _[SRC-PRACTITIONER
  consensus corroborated across multiple reputable advisors; SRC-VALUEBUILDER
  "Switzerland Structure"; 2026]_
- **Contracted, recurring revenue commands a premium multiple over project/transactional
  revenue** because a buyer can underwrite it — a cross-industry driver, stated without
  sector-specific multiples. _[SRC-VALUEBUILDER, SRC-PEPPERDINE; 2023–2025]_
- **A business that runs without the owner is a leading transferable-value driver;** owner
  dependence is discounted or deal-breaking. _[SRC-VALUEBUILDER, SRC-EPI; 2023]_
- **Most owners have not aligned business, personal, and financial readiness** — a
  minority have a documented plan or aligned goals — which is a leading cause of failed or
  regretted exits. _[SRC-EPI State of Owner Readiness; 2023]_
- **~3 in 10 sell-side engagements end without a transaction; a valuation gap is the most
  common reason.** _[SRC-PEPPERDINE; 2025]_
- **The working-capital peg is a common point of value leakage at close;** the owner who
  owns the trailing-average net-working-capital number negotiates from evidence.
  _[SRC-AICPA, SRC-PRACTITIONER; 2024]_
- **Bigger companies earn higher multiples (size premium)** within an industry.
  _[SRC-CAPSTONE, SRC-PEPPERDINE; 2025]_
- **Non-compete enforceability is state-specific and has been the subject of federal
  regulatory action;** confirm current law with counsel rather than relying on a template.
  _[SRC-PRACTITIONER; 2026]_

## Market-reference multiples — PLACEHOLDER, not licensed data

`seed/market-multiples.csv` seeds the non-tenant `market` schema
(`market.datasets` + `market.multiples`, migration
`20260724013906_market_reference_schema.sql`) so the valuation engine can surface a
sector median/spread as **reference context** alongside the seeded table multiple and
the firm's own-book multiple (`server/valuation.ts`; docs/sellside-ai/01, build order
step 1).

**This is DIRECTIONAL PLACEHOLDER DATA, not a licensed feed** (both
`market-multiples.csv` and the `market-passages.csv` commentary/precedent notes). The
values are plausible, ordered (`p25 < median < p75`) directional numbers with small
sample sizes, covering the same `industry_key × size_band` combinations as
`valuation-multiples.csv`. Their sole purpose is to exercise the seed/read pipeline
before a licensed comps dataset (e.g. Pepperdine/DealStats/PitchBook, per the table above
and docs/41 §8) is purchased. It is seeded as a single `market.datasets` row named
**"Directional market reference (composite)"**, vendor `Internal composite estimate`,
with its license flags set to the most restrictive posture
(`display_scope = aggregate_only`, `ai_ingestion_allowed = false`,
`derivative_rights = false`). Note: the **client-facing** name/citation stay professional
on purpose — the "not licensed / directional" fact lives here, in the license flags, and
in a single subtle in-UI disclaimer, never as the word "placeholder" on a page a business
owner reads.

**It does NOT drive any valuation number.** The market multiple is REFERENCE ONLY;
letting it inform the base multiple requires a new `valuation_rules_version` with
`market_multiples.enabled` (a deliberate, versioned opt-in — CLAUDE.md rule 1), which
this seed does not touch. Every existing valuation output is byte-identical.

When a licensed dataset is acquired, counsel maps its terms to the `market.datasets`
license flags first (**license-review-before-ingest is a hard gate** — docs/41 §8), then
the placeholder rows are replaced with the licensed rows in the same key-space. No engine
or handler code changes — only this dataset row and its multiples.

## Discipline

1. Any figure entering an education module or playbook is stated as a **directional
   range**, tagged to a source here, with an as-of year.
2. Nothing is copied verbatim from a source — content is written in ExitBlueprint's
   voice; sources supply **facts and frameworks**, not prose.
3. Time-sensitive numbers (multiples, survey stats) carry the source's as-of year so the
   refresh checklist is this one file.
