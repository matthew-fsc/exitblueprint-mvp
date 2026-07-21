# 41 — Advisor-library & Plans content: research plan + implementation map

> **Status: Strategy / Reference — Matthew-owned.** This is the sourcing and build
> plan for ExitBlueprint's proprietary advisor-library and Plans content. It does
> **not** change scoring logic or the rubric (that would be a `rubric_version` bump,
> per `CLAUDE.md` rule 3). It defines (a) the research topics needed to fill the
> content surfaces, (b) the reputable lower-middle-market (LMM) M&A sources those
> topics draw from, and (c) a phased plan that maps each research output to a
> specific seed file / table. Read alongside `seed/README.md` (canonical methodology),
> `docs/07-drs-methodology.md`, and `docs/37-programs-plans-design.md` (Plans).
>
> **Market facts in this doc are time-sensitive** (multiples and benchmarks move).
> Every number that lands in `/seed` must carry a source + as-of date via the
> provenance register proposed in §4.4.

---

## 0. Why this exists

The scoring engine is complete and canonical. What is *thin* is the **narrative and
prescription content** an advisor actually hands a client: the buyer-question coaching,
the remediation playbooks, the education modules, the reusable Plans, and the
valuation reference data. Today that content is real but sparse and — critically —
**uncited**. Benchmarks like "customer >30% = near-uninvestable" or "field services
1–3M ≈ 4.5x EBITDA" are baked into the seed with no source of record. For a product
sold *through M&A advisors*, the content's credibility is the product. This plan fills
the surfaces and puts a reputable source behind every claim.

---

## 1. Content inventory — what's built vs. what's thin

Every proprietary asset lives as rows seeded from `/seed`. Current state:

| Content surface | Seed file / table | Now | Gap |
| --- | --- | --- | --- |
| Advisory library (buyer_question / initiative / risk_flag / education) | `advisory-library.csv` → `advisory_library_items` | ~34 items | Concentrated in REV/FIN/OPS/CUS/MGT. **Almost nothing for GRW, GOL, PFN, VAL.** Not every sub-score has a buyer question + risk flag + initiative triad. |
| Education / content modules | `content-modules.csv` → `content_modules` | 12 (10 buyer-prep + 2 edu) | Education library is shallow; no owner-readiness, deal-process, or valuation-literacy tracks. |
| Remediation playbooks | `seed/playbooks/*.md` → `playbooks` + `playbook_task_templates` | 13 playbooks, ~5 tasks each | Task lists only. No how-to detail, templates, checklists, owner-facing worksheets, or **cited** EV-impact ranges. |
| System Plans (reusable bundles) | `server/seed-methodology.ts` → `plan_templates` | 3 starter Plans (§37 §5) | Need a full phased set (Phase 1 risk-elimination → Phase 3 value-optimization) and dimension-specific Plans. |
| Valuation reference multiples | `valuation-multiples.csv` → valuation engine | 5 industries + default, one `base_multiple` per size band | Few industries; single point (no range/spread); no source; no size/quality **adjustment factors**; SDE-vs-EBITDA basis unstated. |
| Rubric thresholds & bands | `drs-rubric-subscores.csv`, `gap-definitions.csv` | Canonical (Blueprint II) | Correct but **uncited**. Each threshold needs a supporting-evidence entry (not to change it — to defend it). |

The **research topics in §2 are organized to fill exactly these gaps**, and the
**plan in §4 maps each back to the file above.**

---

## 2. Research topics

Grouped by the content surface they feed. Each topic states the question to answer and
the target seed artifact. Topics tagged **[DATA]** produce numbers (need a Tier-1
source + as-of date); **[FRAME]** produce methodology/coaching content (need a Tier-2
framework or Tier-3 practitioner source); **[PROC]** produce process/how-to content.

### 2.1 Valuation reference data → `valuation-multiples.csv` (+ new adjustments file)

1. **[DATA] LMM EBITDA multiples by industry × size band**, refreshed to current
   period, for the six business archetypes we serve (field services, manufacturing,
   distribution, healthcare services, software, professional/B2B services) plus a
   default. Capture a **low/median/high range**, not a single point.
2. **[DATA] SDE vs. adjusted-EBITDA basis by deal size.** Sub-$2M deals price on SDE;
   $2M+ on recast EBITDA. Document the crossover and the multiple basis per size band
   so the engine states which metric it is applying.
3. **[DATA] Size premium curve.** Quantify the multiple lift from $1M → $3M → $5M →
   $10M+ EBITDA (the "bigger = higher multiple" gradient GF Data and Capstone publish).
4. **[FRAME] Quality-adjustment factors that move a multiple within its band** —
   recurring-revenue mix, customer concentration, growth rate, management depth,
   margin vs. peer. This is the bridge from **DRS → an EV estimate**; produces a new
   `valuation-adjustments.csv` (adjustment table), not a change to base multiples.
5. **[DATA] Deal-process reality benchmarks:** typical time-on-market, close rate /
   probability of sale, sale-to-asking ratio, and financial-vs-strategic buyer mix by
   size band (Market Pulse / Pepperdine track these). Feeds owner-education realism.

### 2.2 Financial Integrity (FIN) content → advisory library, playbooks, education

6. **[FRAME] Quality-of-Earnings expectations in the LMM:** when a QoE is expected
   (≈ $1M+ EBITDA), what it tests, and the documented finding that **unsupported
   addbacks are the #1 source of post-LOI price reductions.** Feeds `AL-BQ-ADDBACKS`,
   `AL-RISK-ADDBACK`, `PB-ADDBACK-DOC`.
7. **[PROC] Addback defensibility standard** — the evidence required per addback
   category (owner comp vs. market, one-time items, personal expenses, related-party)
   and a challenge-likelihood rubric. Feeds the addback playbook + an owner worksheet.
8. **[FRAME] GAAP-proximity / accrual-vs-cash and reconciliation cadence** buyers
   expect. Feeds `FIN-GAAP`, `FIN-RECON`, `PB-CLEAN-BOOKS`.
9. **[PROC] Working-capital peg / net-working-capital target** basics — a top LMM
   value-leakage point advisors coach but the library doesn't yet cover. New advisory
   items + education module.

### 2.3 Revenue Quality & Customer Risk (REV, CUS) → advisory library, playbooks

10. **[DATA] Customer-concentration risk thresholds** and the discount they carry
    (the 10% / 20% / 30% / 40% escalation; ~20–35% price impact above threshold).
    Backs `CUS-TOP1`, `CUS-TOP5`, `REV-HHI`, `AL-RISK-CONC`, `AL-BQ-CONC`.
11. **[DATA] Recurring-revenue & retention benchmarks** (recurring-mix bands, NRR/GRR,
    churn) and their multiple impact (recurring revenue prices at a premium; +10pts NRR
    ≈ +20–30% value in SaaS). Backs `REV-RECUR`, `REV-NRR`, `REV-DURABILITY`,
    `PB-RECURRING-CONVERT`, `PB-RETENTION-NRR`.
12. **[FRAME] Contract durability** — what makes recurring revenue "bankable" to a
    buyer (assignability, term remaining, auto-renew, change-of-control clauses).
    Feeds `REV-DURABILITY`, `CUS-COVERAGE`, and new buyer-question content.

### 2.4 Operations & Management (OPS, MGT) → advisory library, playbooks

13. **[FRAME] Owner-dependence / transferability** — why "runs without the owner" is
    the top value driver; the owner-hours and management-depth benchmarks a buyer
    underwrites. Backs `OPS-HOURS`, `OPS-DEPTH`, `MGT-LAYERS`, `PB-OWNER-EXTRACT`,
    `PB-MGMT-DEPTH`.
14. **[PROC] SOP / process-documentation** standard — what "documented and transferable"
    means in diligence and how to prove transfer. Feeds `OPS-SOP`, `PB-SOP-LIBRARY`.
15. **[FRAME] Key-person retention: non-competes, stay bonuses, comp-vs-market.**
    Include the **jurisdictional enforceability** caveat (non-compete law varies by
    state / recent FTC activity) already flagged in the `MGT-NC` methodology note.
    Feeds `MGT-NC`, `MGT-COMP`, `MGT-RETENTION`, `PB-NONCOMPETES`, `PB-COMP-BENCHMARK`.

### 2.5 Growth Drivers (GRW) — **largest content gap** → advisory library, playbooks

16. **[FRAME] Pipeline discipline & coverage** — what pipeline evidence a buyer credits
    vs. dismisses; coverage-ratio norms. Backs `GRW-PIPE`, `PB-GROWTH-ENGINE`. Add a
    buyer_question + risk_flag + initiative + education triad (GRW currently has almost
    no library items).
17. **[FRAME] Market positioning & differentiation** and **product/service
    repeatability** as value drivers. Backs `GRW-POS`, `GRW-REPEAT`.

### 2.6 Owner-readiness (GOL, PFN, VAL) — **almost no content today** → ORI education, Plans

18. **[FRAME] Exit-planning methodology** — the CEPA / Value Acceleration
    "three legs of the stool" (business, personal, financial readiness) and the
    Discover → Prepare → Decide gates. This is the backbone for the ORI education track
    and owner-facing Plans. Feeds `GOL`, `PFN`, `VAL` dimensions.
19. **[DATA] State-of-owner-readiness statistics** (e.g. share of owners with a
    documented plan / aligned goals) to anchor the "why now" education. Feeds ORI
    education modules.
20. **[FRAME] Personal financial / wealth-gap planning** — the "your number" vs. what
    the business supports gap; outside-asset sufficiency; personal-business financial
    separation. Backs `PFN-*`, `VAL-SEP`, `PB-VALUE-GAP-PLAN`.
21. **[FRAME] Exit timeline & readiness sequencing** — why timing follows readiness;
    the risk of going to market unprepared. Backs `TIMELINE_MISMATCH`, `AL-EDU-TIMELINE`.

### 2.7 Deal-process literacy (cross-cutting education) → content modules, Plans

22. **[FRAME] The sell-side process** — LOI, exclusivity, diligence, escrow/holdback,
    earnouts, reps & warranties, working-capital peg at close. Owners consistently
    under-understand these; a strong education track differentiates the advisor.
23. **[FRAME] Buyer archetypes** (strategic vs. financial/PE vs. search fund/individual)
    and how each prices and structures. Feeds education + the `buyer_type` field already
    on `advisory_library_items`.

---

## 3. Reputable LMM M&A sources

Vetted for **lower-middle-market relevance** ($2M–$50M+ enterprise value). Tiered by
role. Tier 1 = primary transaction data (cite for any **[DATA]** number). Tier 2 =
methodology / standards bodies (cite for **[FRAME]** frameworks). Tier 3 =
practitioner/market color (corroborate, never the sole source for a number).

### Tier 1 — Primary transaction & valuation data

| Source | What it's authoritative for | Feeds | Access |
| --- | --- | --- | --- |
| **GF Data** (ACG) | PE-sponsored deal multiples $10M–$500M TEV, by size band & sector; leverage & terms. The LMM multiple benchmark. | §2.1 (1–3), §3 valuation refresh | Paid subscription |
| **Pepperdine Private Capital Markets Report** (Graziadio) | Cost of capital & multiples across private segments; deal-killer reasons; valuation-gap data. Free, academic, annual. | §2.1 (1,5), §2.6 (19) | Free download |
| **IBBA / M&A Source — Market Pulse** | Quarterly Main-Street→LMM ($2M–$50M) multiples, time-on-market, buyer mix, sale-to-asking. Advisor-survey based. | §2.1 (1,5) | Free summaries; full report to members |
| **BVR — DealStats** (formerly Pratt's Stats) | 29k+ acquired private-company transactions; realized multiples & ratios by SIC/NAICS. Comparable-transaction backbone. | §2.1 (1–4) | Paid database |
| **Capstone Partners — Middle Market M&A Valuations Index** | EBITDA purchase multiples for middle market, proprietary + market data. | §2.1 (1,3) | Free report |

> Cross-check any multiple across **at least two** Tier-1 sources before it enters
> `valuation-multiples.csv`; record both in the provenance register (§4.4).

### Tier 2 — Methodology, standards & frameworks

| Source | What it's authoritative for | Feeds |
| --- | --- | --- |
| **Exit Planning Institute (EPI) — CEPA / Value Acceleration Methodology** | Owner-readiness framework, three-legs-of-the-stool, Discover/Prepare/Decide gates, State of Owner Readiness survey. | §2.6 (18,19), §2.7, ORI Plans |
| **Value Builder System** | The eight value-driver framework (recurring revenue, growth potential, valuation teeter-totter, switzerland structure = concentration, hierarchy of value). Maps cleanly onto our dimensions. | §2.3, §2.4, §2.5 |
| **AICPA / ASA** (appraisal & QoE standards) | Quality-of-Earnings methodology; the "unsupported addbacks drive post-LOI cuts" finding; appraisal standards. | §2.2 (6,7) |
| **AM&AA / M&A Source** (advisor associations) | Sell-side process standards, deal-structure norms, professional practice. | §2.7 (22,23) |

### Tier 3 — Practitioner & market color (corroborating only)

Reputable advisory-firm and QoE-firm insight libraries (e.g. Capstone, FOCUS, Software
Equity Group for SaaS, and specialist QoE/CPA firms), industry-association benchmarking,
and broker-market commentary. Use to **illustrate and corroborate** Tier-1/2 findings and
to source coaching language — never as the sole authority for a seeded number.

---

## 4. Finalized implementation plan

Sequenced so each phase is one coherent, testable content drop that follows the seed
discipline in `seed/README.md` and the engineering DoD in `docs/27`. **No phase touches
scoring logic**; content is data.

### Phase A — Provenance foundation (do first)

- **A1. Add a source-of-record register.** New `seed/sources.csv`
  (`source_id, name, tier, publisher, url, as_of_date, access, notes`) listing the §3
  sources, plus a `source_ref` (comma-sep `source_id`s) + `as_of` column added to
  `valuation-multiples.csv` and a companion `seed/methodology-evidence.csv` that ties each
  rubric threshold/band (`drs-rubric-subscores.csv`, `gap-definitions.csv`) to its
  supporting source. **This backs the numbers without editing them** — the rubric stays
  canonical (rule 3); we are documenting, not re-scoring.
- **Accept:** every existing seeded number has ≥1 `source_ref`; a test asserts no
  `valuation-multiples` row lacks a `source_ref`/`as_of`.

### Phase B — Valuation reference refresh & EV bridge (§2.1)

- **B1.** Refresh `valuation-multiples.csv` to current-period ranges across the six
  archetypes + default; add `multiple_low/median/high` and state SDE-vs-EBITDA basis per
  size band (topics 1–3). Cross-checked against ≥2 Tier-1 sources.
- **B2.** New `seed/valuation-adjustments.csv` — the quality-adjustment table (topic 4)
  that maps DRS/sub-score signals to within-band multiple movement. This is the
  DRS→EV bridge and is **prescriptive reference data, not a score input.**
- **Accept:** valuation engine renders a ranged multiple with a cited basis; adjustments
  file loads and is referential-integrity-clean.

### Phase C — Advisory-library completion (§2.2–2.5)

- **C1.** Fill the **buyer_question + risk_flag + initiative** triad for every sub-score
  that lacks one, prioritizing **GRW** (topics 16–17) and the FIN working-capital gap
  (topic 9). Extend `advisory-library.csv`; wire new items where a `score_trigger` /
  `sub_score_code` applies.
- **C2.** Add the corresponding `content-modules.csv` buyer-prep modules and wire
  `gap-content-map.csv`.
- **Accept:** each of the 32 sub-scores has ≥1 buyer_question and ≥1 risk_flag; new items
  carry `source_ref`; seed loads.

### Phase D — Playbook deepening (§2.2–2.5)

- **D1.** Expand each `seed/playbooks/*.md` from a task list into a full program:
  objective, cited EV-impact range (replace the current hand-wavy ranges with
  source-backed ones), task detail, owner worksheets/checklists, and evidence produced.
  Add net-working-capital and (if in scope) a QoE-prep playbook.
- **Accept:** every playbook's EV-impact line carries a `source_ref`; `playbook_task_templates`
  unchanged in shape (no engine change); fixtures still reproduce exactly.

### Phase E — Owner-readiness & deal-process education (§2.6–2.7)

- **E1.** Build the ORI education track (topics 18–21) and the deal-process literacy track
  (topics 22–23) as `content_modules` / advisory `education` items, structured on the CEPA
  three-legs framework and buyer-archetype model.
- **Accept:** GOL/PFN/VAL each have education coverage; owner portal surfaces them.

### Phase F — System Plans build-out (§2, `docs/37`)

- **F1.** Author the full phased system-Plan set in `server/seed-methodology.ts`:
  **Phase 1 Risk Elimination**, **Owner-Dependence Reduction**, **Customer
  Concentration**, **Financial Cleanup / QoE-Prep**, **Recurring-Revenue Conversion**,
  **Growth-Engine**, and an **Owner Personal-Readiness** Plan — each bundling the
  now-deepened playbooks + education + milestones (composing only global content, per
  §37 §5 so they're safe for every firm).
- **Accept:** Plans seed idempotently; each applies to a demo engagement and materializes
  tasks/milestones; `npm run test:rls` green.

### 4.4 Sourcing discipline (applies to every phase)

1. Any **[DATA]** number entering `/seed` needs ≥1 Tier-1 source + `as_of` date, and for
   valuation multiples ≥2 corroborating Tier-1 sources.
2. Any **[FRAME]** claim needs a Tier-2 source (Tier-3 may corroborate).
3. Nothing is copied verbatim from a source — content is written in ExitBlueprint's voice;
   sources are for **facts and frameworks**, not prose. (Respects the "prefer boring,
   original" house style and avoids IP issues.)
4. The provenance register (`seed/sources.csv`) is the single place `as_of` dates live, so
   the time-sensitive numbers have one refresh checklist.

---

## 5. Compliance with `CLAUDE.md`

| Rule | How this plan complies |
| --- | --- |
| **1. Deterministic scoring** | Nothing here computes or adjusts a score. Valuation adjustments (Phase B2) are **reference/prescription data** the advisor reads, not a sub-score input. The rubric bands are documented (Phase A), never edited. |
| **2. AI is narrative-only** | Research and authoring are human/advisor-curated content into seed tables. No LLM writes to any table; if AI drafts a module later it's labeled draft narrative. |
| **3 / 3a. Rubric lives in data; two score groups** | Content is added as data rows; DRS/ORI weights, dimensions, and thresholds are untouched. Any future threshold change = new `rubric_version`, out of scope here. |
| **4. Engagement is the unit; immutability** | Content is global methodology; applying it to engagements uses the existing immutable Plans/roadmap path (§37). |
| **5. Multi-tenant / RLS** | All new content seeds as `firm_id`-null system methodology (readable, not editable by firms), exactly like existing advisory items and playbooks. |
| **6. Versioning** | System Plans carry `plan_version`; playbooks carry `version`; the provenance register carries `as_of` so refreshes are explicit, not silent edits. |

---

## 6. Open questions for Matthew

1. **Multiple basis & EV in-product.** v1 deliberately does **not** compute EV
   (`seed/README.md`). Phase B2's adjustment table is the bridge — do we ship it as
   advisor **reference** now, or hold until the EV engine (A10/A11) is scoped?
2. **Data-source budget.** GF Data and BVR/DealStats are paid. Are we licensing them, or
   building the first pass on the free authorities (Pepperdine, Market Pulse summaries,
   Capstone) with paid sources as a fast-follow?
3. **Industry archetype list.** Confirm the six archetypes in `valuation-multiples.csv`
   are the right served set, or add (e.g. construction/trades, transportation/logistics).
4. **Framework licensing.** CEPA/EPI and Value Builder are proprietary frameworks — we
   draw on their *public* concepts and cite them, but confirm we're not reproducing
   licensed material.
5. **Phase order.** Recommended A → B → C → D → E → F (provenance first, then the
   highest-visibility gaps: valuation data and the GRW/owner-readiness holes). Confirm or
   re-prioritize.
