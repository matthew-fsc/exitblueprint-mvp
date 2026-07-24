# 04 — Benchmarking & aggregate-data interaction (and how we buy it)

**Status:** Strategy / design record. No code ships from reading this.
**Owner of the calls it raises:** Matthew (product + commercial) and counsel
(licensing). This writeup frames the decision and recommends; it does not decide.

> **Why this lives here.** It extends `01-market-intelligence-rag.md` (paid
> third-party data) from "how the data enters the engine" to "how a *user* meets
> it, how the firm's own book blends with it, and who pays for it." It touches
> the moats (docs/09), the licensing agenda (docs/41 §7, §8), and the
> entitlements gate (`server/entitlements.ts`). Numbering stays local to this
> folder (Matthew assigns any main-sequence number if promoted).

---

## TL;DR (the three answers)

1. **Interaction.** Benchmarking is a **lens on the deterministic score the owner
   already has, never a second number.** Every benchmark cell renders with its
   sample size (`n`), currency (`as_of`), and source label; cells below a
   k-anonymity floor are suppressed; advisors get the rich view, owners a curated,
   disclaimered slice. Read-only — it informs judgment and narrative, it never
   edits an assessment.

2. **Blend.** Three roles, not three competitors: **licensed market data is the
   cold-start floor, the firm's own book is the proprietary refinement, the
   cross-firm calibration pool is the predictive overlay.** Blend them at
   *selection time* with a deterministic, versioned, confidence-weighted function
   (the natural evolution of today's strict-precedence `selectValuationMultiple`)
   — **never** by physically merging the datasets, which would breach the IP wall.

3. **Pass-through vs. pay — the answer is "both, split by lane."** The rule-#1
   two-lane split (facts → deterministic; text → narrative) is *also* the
   IP-risk gradient (`01` §"IP & licensing") *and* the commercial-model split:
   **platform-pay to *own* the cheap, Feist-unprotectable facts** that feed the
   deterministic multiple and seed the moat; **pass-through the firm's own license
   (or a paid per-firm entitlement) for the expensive, copyright-bearing,
   display-restricted row-level comps and verbatim passages** in the RAG lane.

Everything below is the reasoning.

---

## First, disentangle three data pools that the question conflates

"Benchmarking / aggregate data" is three different assets in this codebase, with
different owners, visibility, and legal risk. Conflating them is the most common
way to get this wrong, so name them first:

| Pool | Where it lives | Whose data | Who may read it | Moat? | Cost to us |
|---|---|---|---|---|---|
| **A. Licensed market** | `market` schema (non-tenant, `20260724013906_market_reference_schema.sql`) | A **vendor's** (bought) | `authenticated`, gated by `market.datasets` exposure flags | **No** — anyone can buy it | **Vendor license $$$** |
| **B. Firm own-book** | `deal_outcomes` → `ownBookMultiple` (firm-scoped, RLS) | The **firm's** own closed deals | Only that firm | Yes, per-firm | Free (their data) |
| **C. Cross-firm pool** | `analytics` schema (service-role only, `financial-corpus.ts`, calibration engine) | **De-identified customer** data, pooled | Superadmin/internal **only** today; client-facing surface is out of scope | **Yes — the network moat** | Free to us (our derivative, §7 consent) |

The load-bearing insight: **C is not a licensing question at all.** It is built
from our customers' own de-identified data under the docs/41 §7 data-use consent,
and *we own the derivative* (docs/09; §7 "we own the benchmark; the firm retains
its raw data"). It costs us nothing to a vendor. Only **A** involves paying a
third party. So "do we pass through or pay?" is a question about **A**, and the
answer must not leak A's restricted inputs into B or C (that would taint moat
ownership — docs/41 §8 "derivative works").

Keep this table in view for the rest of the doc.

---

## Question 1 — How should users interact with benchmarking/aggregate data?

### Principle 1: a benchmark is a *lens on the score*, never a competing score

The DRS/ORI is the anchor and it is deterministic (rule #1). A benchmark
contextualizes it — *"your DRS 68 sits at the 60th percentile of manufacturing
companies in the $5–10M band"*, *"your working-capital sub-score trails the
sector median by ~15 points"* — it never produces a second, softer number that an
owner could mistake for the readiness score. A percentile against a distribution
is itself a **deterministic computation** (rank in a sorted array — the same
`quantile()` primitive already in `shared/own-book.ts`), so benchmarking stays on
the correct side of rule #1 with no LLM anywhere near it.

Consequence: benchmarks attach to things that already exist — the DRS, each
dimension, each sub-score, the valuation multiple — as an adjacent "vs. peers"
band, not as a new tile with its own headline figure.

### Principle 2: three interaction surfaces, matched to the three pools

Every surface already exists; none needs a new page (mirrors `01`
§"Where it surfaces"):

| Surface | Pool(s) | What the user sees |
|---|---|---|
| **Valuation** (`ValuationPage.tsx`) | A + B (+ C later) | Table vs. own-book vs. market multiple side-by-side; one drives, versioned. Already the `selectValuationMultiple` seam. |
| **Dimension / sub-score benchmarking** (Assessment / DRS surfaces) | C (rubric-native peer distributions) or A (licensed sector benchmarks normalized to the rubric key-space) | "You vs. sector" percentile bands per dimension. **New surface — out of scope until requested.** |
| **Narrative context** (Buyer Lens, CIM, diligence sim) | A, RAG lane | Cited market context: *"a buyer will benchmark you against comps at 5.2–6.1× (source, n=14)."* Already shipped. |

### Principle 3: provenance is not optional — `n`, `as_of`, and source on every cell

Harvey's "source score" (docs/sellside-ai/02) made user-facing. Every benchmark
figure renders with **sample size**, **data currency**, and a **source label**
(licensed vendor / firm own-book / cross-firm pool). This is already the posture
in the data: `market.datasets.as_of` gates freshness, the corpus note flags
`contributing_firms = 1` as low-confidence, and `ownBookConfidence()` bands by
depth. Surface those, don't hide them. An advisor putting a number in front of a
buyer must be able to defend where it came from and how current it is.

### Principle 4: k-anonymity / small-cell suppression is a hard floor

Never render a cross-firm (pool C) benchmark cell computed from fewer than *k*
firms — pick k with counsel (§7 de-identification standard), but the mechanism is
non-negotiable. A cell aggregated from one firm *is* that firm's deal, and showing
it both leaks a competitor's data and violates the docs/09 non-negotiable that "a
firm's raw deals never leak." The corpus already emits `contributing_firms`
precisely so the exposure layer can suppress on it. Own-book (pool B) is exempt —
it's the firm's own data — but should still show a low-confidence band under its
sample floor rather than pretending 3 deals is a distribution.

### Principle 5: advisor-rich, owner-curated

The advisor is the professional who interprets (docs/41 §4: firm = controller).
Advisors get the full benchmark view — distributions, percentiles, comp lists
(subject to license display scope). Owners get a **curated, disclaimered** slice:
enough to motivate remediation ("you're behind peers on customer concentration"),
never the raw licensed comp table (that's third-party *display*, the expensive
license tier — §8, and Question 3 below). Firm-injected disclosures must not
override our required disclaimers (docs/41 §11: `footer_disclosure_md` is additive,
our disclaimers non-removable).

### Principle 6: read-only, and it never feeds back into a score

Benchmarks inform the advisor's judgment and the narrative payloads; they never
mutate an assessment (rule #4, immutability) and never edit a score (rule #1). If
a benchmark reveals the rubric is miscalibrated, that ships as a **new
`rubric_version` / `valuation_rules_version`** — the docs/09 non-negotiable
("calibration informs the rubric; it never edits a score directly").

---

## Question 2 — How should the firm's own book blend with paid datasets?

### The seam already exists; today it's a cliff

`selectValuationMultiple` (`shared/own-book.ts`) blends by **strict precedence**:
`override > own_book > market > table`. Deterministic, versioned, correct — and
crude. With four own-book deals, own-book wins *outright* over a market median
backed by 200 comps, purely because it's higher in the precedence list. That's a
cliff, not a blend.

### Recommended evolution: a confidence-weighted blend — still fully deterministic

Replace winner-takes-all with a **deterministic weight function** of the signals
already on each candidate — sample size, freshness (`as_of`), and same-band match
— so the multiple is a weighted combination whose mix *shifts as the proprietary
signal deepens*:

- **Early (thin own-book):** the licensed **market** median dominates — the
  cold-start does its job.
- **As own-book grows:** its weight rises (the `ownBookConfidence` bands already
  express the depth ladder); it earns influence rather than seizing it at n=4.
- **With calibration (pool C) live:** a predictive overlay nudges toward the
  band that historically *closed* at a given multiple.

This is exactly the `01` §"How this strengthens the moats" end-state — *"over
time the proprietary signals earn more weight"* — made a **formula instead of a
cliff**. It stays inside rule #1 because the weight function is ordinary
arithmetic in code, reproduces the fixtures exactly, and — like today — **only
takes effect when a new `valuation_rules_version` elects it** (the current
strict-precedence behavior is the default until a version turns the blend on,
byte-for-byte, exactly as the `marketConfig`-disabled default works now).

### The four blend rules

1. **Three roles, not three competitors.** Market = cold-start floor (broad,
   bought). Own-book = proprietary refinement (narrow, ours-per-firm).
   Calibration = predictive overlay (what actually closed). Each answers a
   different question; the blend layers them, it doesn't pit them.

2. **Blend at *selection time*, never by merging datasets.** The candidates are
   assembled from three physically separate stores (`market` schema, firm-scoped
   `deal_outcomes`, `analytics` pool) and combined by a pure function at the point
   of valuation. They are **never written into one table.** Merging licensed
   market rows into the own-book corpus would (a) breach the vendor's
   no-derived-benchmark / redistribution terms (§8) and (b) taint moat ownership —
   the whole reason the `market` schema is non-tenant and quarantined from
   own-book/calibration (`01` §"Keep licensed data out of the proprietary corpus").

3. **Transparent candidates.** The `MultipleSelection` shape already carries every
   candidate with `driving: true|false` even when it isn't the one used, precisely
   so the surface can show table-vs-own-book-vs-market together. A blend keeps that
   — show each input, its `n`, and its weight; show the blended result and why.

4. **Versioned, never live-edited.** Adopting or reweighting the blend is a new
   `valuation_rules_version` with a fixture (rule #1, rule #6). No in-place tuning.

### The same layering applies to *benchmarking*, not just the multiple

Don't collapse the three pools into one peer number either. A dimension benchmark
should be able to say "licensed sector benchmark: p50 = X (n=200); your firm's
own book: p50 = Y (n=6); calibrated peer pool: p50 = Z" — three provenanced
layers the advisor reads together, not one silently-merged figure. Breadth from
A, specificity from B, predictive weight from C.

---

## Question 3 — Do we pass through data with client subscriptions, or pay for it?

This is a question about **pool A only** (B and C cost us nothing to a vendor).
Frame it as three commercial models, then map the recommendation onto the
architecture we already have.

### The three models

**Model A — Platform-paid (we license, we serve).** Provider negotiates one
license, ingests into the `market` schema out-of-band, serves every tenant.
- **Pros:** uniform data, single pipeline (built), cold-start works day one for
  every firm, bounded/predictable cost (ingest once; per-report cost is a local
  query, not a vendor API hit — `01` §"Cost & caching"), and it's the only model
  that can legally seed a cross-firm benchmark.
- **Cons:** the license we'd need — **redistribution + third-party display +
  derived-benchmark** — is the most expensive and most-restricted tier, and it's
  exactly what financial-data vendors most often forbid (§8: "many financial-data
  licenses forbid redistribution and forbid use of the data in a derived index or
  benchmark — exactly the direction we're heading"). We distribute *through
  advisors to their clients*, so surfacing a comp is *display*, not internal use.

**Model B — Pass-through (the firm brings its own license/seat).** Many LMM M&A
firms already subscribe to a vendor (Capital IQ / PitchBook / DealStats / BVR).
Integrate under the firm's own entitlement; surface data the firm is already
licensed to use with its own clients.
- **Pros:** a firm's own professional license typically *already permits* its use
  with its clients (internal-modeling + client-deliverable is a normal advisor
  entitlement), so it sidesteps the redistribution license we'd otherwise buy;
  shifts cost and license compliance to the firm.
- **Cons:** fragmented (every firm on a different vendor/tier); **cannot be pooled
  into pool C** — pooling a firm's licensed data into a cross-firm benchmark would
  breach *that firm's* license and contaminate our moat (§8); per-seat licenses
  frequently forbid programmatic/API access or feeding a SaaS at all; operationally
  heavy (per-firm credentials, per-vendor connectors). It buys reach for *that
  firm* and nothing for the platform.

**Model C — Hybrid (recommended).** Split by the two lanes we already built.

### The recommendation: the lane split *is* the commercial split

The rule-#1 fact/text split is already the IP-risk gradient in `01`
§"IP & licensing". The same table is also the buy/pass-through decision — because
**what's cheap to license is what's cheap to *own*, and what's expensive to
license is what you'd rather not own at all:**

| Lane | Data kind | IP risk (`01`) | **Commercial model** | Why |
|---|---|---|---|---|
| **Rules lane** — `'market'` multiple → versioned `valuation_rules_version` | **Facts** (sector median, size-band spread, `n`, `as_of`) | **Low** — *Feist*, facts aren't copyrightable | **Platform-pay — buy and *own***  | Cheaper "aggregate stats" tier; the derived multiple is ours; can seed pool C; every firm gets the cold-start day one |
| **Reasoning lane** — retrieved passages → cited narrative | **Verbatim text, row-level comps** | **High** — copyright, display-gated, AI-ingestion clauses | **Pass-through, or paid per-firm entitlement** | Redistribution/third-party-display is the expensive tier; let the firm's own license cover display to *its* clients, or charge the firm for the add-on so we buy per-firm access rather than blanket redistribution |

So the elegant answer: **pay to own the facts, pass through (or gate) the text.**
You buy the low-risk aggregate multiples once, own the derivative, feed the
deterministic valuation for everyone, and use them to seed the moat. You do *not*
buy a blanket redistribution license for copyrightable row-level comps you'd have
to purge on termination — you let each firm's existing license carry that display
to its own clients, or you sell it as a metered add-on so the platform's cost
tracks usage.

### It maps onto mechanics we already have

- **`market.datasets` exposure flags** (`display_scope`, `ai_ingestion_allowed`,
  `derivative_rights`, `purge_on_termination`) are the enforcement point and the
  retrieval layer already filters on them — so an aggregate-only dataset can never
  surface a row-level passage regardless of which model funded it.
- **The entitlements gate** (`server/entitlements.ts`, `firm_subscriptions`, plan
  `features[]`) is the natural home for a **"premium benchmarking / market data"
  feature**: the deterministic facts ship to everyone; the row-level RAG lane is a
  plan-tier or add-on entitlement. Enforcement is already OFF-by-default and
  comped-firm-aware, so beta is unaffected.
- **Pass-through** would add one concept: a `market.datasets` row (or an adjacent
  per-firm table) **scoped and entitled to a single firm**, loaded under *that
  firm's* license terms, and — critically — flagged so it is **never** swept into
  pool C. The non-tenant `market` schema already separates licensed data from the
  proprietary corpus; a per-firm licensed dataset is the same idea with a firm
  scope and a "do-not-pool" flag.

### Two hard don'ts (both from §8)

1. **Never pool pass-through (Model B) vendor data into pool C.** It breaches the
   firm's license and taints the moat. Per-firm licensed data stays per-firm.
2. **Buy derivative + perpetual-on-aggregates rights for the facts you platform-pay
   for**, or a license lapse purges your improved multiples and the outputs already
   delivered (§8 "survivability / termination"). Counsel owns this; the schema
   already has `purge_on_termination` to record the answer.

---

## Where this needs a decision (not ours to make)

Per CLAUDE.md, product and commercial behavior is Matthew's and licensing is
counsel's. This doc recommends; it does not decide. Open calls:

1. **Commercial model per lane** (Matthew + counsel): confirm platform-pay for the
   deterministic facts and pass-through/entitlement for row-level — or override.
2. **Which vendor(s), which tier** (Matthew + counsel, docs/41 §8, §14 fast-follow):
   no dataset loads until counsel maps its terms to both lanes.
3. **The k-anonymity floor** for pool-C benchmarks (counsel, docs/41 §7).
4. **Whether to build the dimension-benchmarking surface at all** — it's out of
   scope under CLAUDE.md until explicitly requested. This doc is the research, not
   a green light to build.

---

*Cross-references: `01-market-intelligence-rag.md` (the two-lane architecture and
the IP-risk gradient this reuses), `02-evaluation-bench.md` (source-score
discipline behind Principle 3), docs/09-moats.md (the three pools; C is the moat),
docs/41 §7 (cross-firm benchmarking consent) and §8 (third-party paid-data
licensing), `shared/own-book.ts` / `server/comparables.ts` (`selectValuationMultiple`,
the blend seam), `server/financial-corpus.ts` (pool C, service-role only),
`server/entitlements.ts` (the gate the commercial model rides on),
`supabase/migrations/20260724013906_market_reference_schema.sql` (license terms as
enforced flags). This is a design record — no code ships from it, and none of it
touches the load-bearing rules.*
