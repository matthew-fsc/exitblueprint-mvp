# DRS/ORI Scoring Stress Test & Remediation Plan

> **Status: Strategy / proposal — awaiting Matthew's ratification.** This doc has
> no assigned number yet (doc numbers are Matthew-owned; assign one if this
> becomes canonical). It captures an empirical stress test of the deterministic
> scoring model and proposes methodology changes for band-by-band sign-off
> **before** any rubric change ships. Part 1 (input validation) has already
> shipped; everything in Part 3 is proposed, not built.

## Why this exists

The prompt that started this was narrow: *how should the assessment treat a
business that's only been around a year or two — a client we want to retain
because we build value for owners who don't want to sell yet?* Rather than patch
that one case, we stress-tested the **whole** model against 12 business
archetypes, scoring concrete companies through the **real engine logic** (a
harness validated to reproduce all three canonical fixtures exactly). The young-
business issue is real — but it turned out to be the lowest-severity finding.
The test surfaced engine crashes and whole mis-tiered business classes that
matter far more.

## Method

- 12 archetype "lenses," each building 3–6 realistic companies and scoring them
  empirically: young/high-growth, old/consistent, declining/turnaround,
  concentration extremes, micro/solo, frontier/market-timing, strategic/synergy,
  asset-heavy, seasonal/lumpy, regulated/key-person, adversarial-robustness, and
  the top-tier ceiling.
- Every number below is an actual engine output, not an estimate.
- Findings were deduped and ranked, then split into **fixable scoring
  bugs/unfairness** (in scope for the rubric) vs **by-design limits** where the
  DRS structurally cannot represent a kind of value (product-scope questions).

---

## Part 1 — SHIPPED: input-validation guard (crashes & silent corruption)

Not a methodology change; pure correctness. The engine did no input validation.
On ordinary inputs from its own target population it did not crash — it
**silently produced meaningless scores**:

| Input (from a real archetype) | Old silent output |
| --- | --- |
| `REV-ANNUAL=[0, 1_000_000]` (pre-revenue / rebuild year) | **DRS 85.7 → "Institutional Grade"** |
| `REV-ANNUAL=[4_000_000]` (one closed fiscal year) | DRS 79.2 "Sale Ready" (meaningless CAGR) |
| `OPS-FUNC-COUNT=0` (solo / holdco) | DRS 83.6 (Infinity depth ratio → full marks) |
| `CUS-CHURN=-5` | DRS 83 (scored a perfect 100) |
| `PFN-DEPEND=10, VAL-CONF=10` | **ORI 139.2** (outside 0–100) |
| `REV-TOP5-SHARES=[]` | DRS 80.2 (NaN swallowed) |

The reference scorer hit the same sites as `ZeroDivisionError`/`IndexError`
(9 of 12 archetypes tripped the single-year crash alone).

**Fix (shipped):** `validateAnswers()` in `shared/scoring/engine.ts`, called by
`scoreFromAnswers` after the completeness check, with a mirrored `validate()` in
`seed/fixtures/reference_scorer.py` so engine and reference agree on invalid
inputs too. Guards: revenue series must have ≥2 strictly-positive years;
customer shares must be a non-empty list of ≤5 values each 0–100 summing to
≤100; core-function count ≥1; 1–5 scales in range; selects within options; no
negative numerics. **Validation only — a well-formed assessment's score is
unchanged, so the fixtures are byte-identical and rule #1 holds.** 13 guard cases
added to `tests/engine.test.ts`.

> Note: the guard currently **rejects** a genuinely 1-year-old business with a
> clear message ("at least two fiscal years… required"). Making that business
> *scorable* (rather than rejected) is the young-business methodology item in
> Part 3 (§3.9). The guard is the safe interim: a clear error beats a silent
> "Sale Ready."

---

## Part 2 — The map: in-scope bugs vs by-design limits

**IN SCOPE (fixable in the rubric/engine) — Part 3 proposes each:**
endpoint-only CAGR, concentration-band saturation, recurring-revenue bias, the
solo/owner-operator floor + gaming premium, NRR-"unknown" scored at the worst
band, gap mislabeling, the pipeline construct, `GRW-POS` capped at 80, and the
young-company/mature-business band tuning.

**BY DESIGN / PHILOSOPHICAL (out of scope as scoring bugs — §4):** blindness to
IP/patents/tech moat, acquihire-team value, balance-sheet/asset-floor value,
market-timing/category-creation, and license/CON/franchise/named-professional
transferability. The DRS is deliberately a **standalone, transferable, EBITDA-
based** diligence-readiness index. Whether to expand that scope is a product
decision, not a bug.

**THE BRIDGE (§3.6):** even where valuing an unscored factor is out of scope, the
DRS still emits confident **tier labels and gap sets** — so it can *invert*.
Fixing the *framing* (label scope + blind-spot flags) is in scope.

---

## Part 3 — Proposed methodology changes (ratify each before build)

Each item: the finding (with real numbers), the proposed direction, and the
decision needed from you. All of these are rubric-in-data changes and would ship
as a **new `rubric_version`** (rule #3), mirrored in the reference scorer with new
young/edge fixtures (rule #1).

### 3.1 — Endpoint-only CAGR is trajectory-blind `[CRITICAL]`

**Finding.** CAGR uses only the first and last year; both `REV-GROWTH` and
`GRW-CAGR` key off the *sign* of that one number. Consequences, all empirical:
- A terminal decliner `[5.0,4.5,4.0,3.5]M` and a stabilizing/recovering firm
  `[5.0,4.0,3.8,3.7]M` score **byte-identical DRS 54.0**.
- The strongest turnaround (nearly tripled off the trough, `[10,3,5,8]M`) scores
  the **lowest** at 52.9.
- A **$2,000** swing in year-4 revenue flips High Risk 54.0 ↔ Needs Work 55.6.
- `[3M,4M]` (one YoY jump) → `REV-GROWTH 100 / GRW-CAGR 100` — a "33% 3-yr CAGR"
  from two points.

**Proposed.** Compute growth from the **full series** (multi-period CAGR + a
trend/slope and the down-year count together, not the endpoints alone); replace
the `c<0 → 0` hard-zero with a **graded negative band** so a −2%/yr annuity and a
−15%/yr collapse aren't equal; and **decouple** `REV-GROWTH` from `GRW-CAGR` so
one down endpoint can't zero two dimensions at once. **Decision:** approve the
full-series direction + a graded negative band? (I'll bring exact bands.)

### 3.2 — Concentration bands saturate to a 0-floor `[CRITICAL]`

**Finding.** `CUS-TOP1`, `CUS-TOP5`, and `REV-HHI` all hit 0 far below real-world
extremes, so the whole severe range is indistinguishable and the max total
concentration penalty is ~14 points:
- `[100]` (100% one customer), `[60,40]`, `[50,50]`, `[50,30,20]`, `[40,35,25]`
  **all score DRS 46.6** — a captive single-customer business == a diversified
  three-client firm.
- An otherwise-institutional single-customer business reaches **DRS 82.9 "Sale
  Ready."**
- Under-reporting wins: dishonest `[3,3,3,3,3]` (15% total) → **DRS 61.1**, beating
  honest `[20,20,20,20,20]` (100%) → **50.5**. *(The 100%-cap guard from Part 1
  now blocks the >100% case; the gradient below is still needed.)*

**Proposed.** Extend the bands with a real gradient across 40–100%; lower the CUS
floor / raise the penalty ceiling so a single-customer business **cannot** reach
Sale Ready; add a **contracted-tenure offset** so a deliberately locked-in anchor
tenant (long contract, change-of-control protection) isn't scored like a fragile
whale. **Decision:** approve the gradient + the anchor-tenant offset?

### 3.3 — REV dimension presupposes recurring/contract revenue `[CRITICAL]`

**Finding.** REV is the heaviest dimension (0.25) and ~60% of it
(`REV-RECUR` 0.30, `REV-DURABILITY` 0.20, `REV-NRR` 0.10) presupposes
subscription/contract revenue. Transactional/project/rental/retail/practice
models score ~0 on those by **business-model design, not weakness**:
- Best-possible **transactional** business caps at **DRS 83.2** (REV dim 42.5);
  its recurring twin reaches 88–99.6.
- A flawless **project** firm caps REV at 52.5 → DRS 84.7 — **never** Institutional.
- Equipment-rental REV dim collapses to 35.4.

**Proposed.** Add a **revenue-model branch** (new intake question: recurring /
mixed / transactional-project / asset-rental). When revenue is legitimately
transactional, **neutralize or reweight** `REV-RECUR`/`DURABILITY`/`NRR` and
re-normalize REV across the applicable sub-scores — treating recurring revenue as
*one* valid revenue-quality shape, not the only path to a high REV score.
**Decision:** approve a revenue-model branch, and does the neutralize-and-
renormalize mechanic (same as §3.9) fit here?

### 3.4 — Solo/owner-operator floors + a ~15pt gaming premium `[HIGH]`

**Finding.** `OPS-HOURS`, `OPS-DEPTH`, `MGT-LAYERS`, `MGT-NC` all floor for a solo
by definition, and `OWNER_DEP` (critical) fires on any owner ≥50 hrs. Because
manager/layer/non-compete answers aren't validated against headcount, gaming pays:
- Honest perfect full-time solo caps at **DRS 83.5** (never Institutional); the
  *same* solo claiming "I'm my own manager / I have a non-compete" jumps to
  **98.6 (+15)**.
- Routinely-sold practices score "Not Saleable": solo dentist 35.7, boutique law
  47.7, solo CPA 62.4 (these sell at ~0.7–1.3× collections / ~1× revenue).

**Proposed.** An **owner-operator branch**: value = transferable book + a
transition/earnout, scored on SDE-style terms; capture the **owner as the key
person** and the **owner non-compete** as a deal term; and validate
manager/layer/non-compete answers against headcount to kill the gaming premium.
**Decision:** approve an owner-operator branch + headcount-consistency validation?

### 3.5 — NRR "unknown" scored at the worst band, beatable by fabrication `[HIGH]`

**Finding.** Honest "unknown"/not-applicable NRR is hard-coded to 25 (ties the
worst honest band), flags "not tracked," **and** trips `CHURN_HIGH`. A fabricated
NRR≥110 scores 100 — so honesty loses right at the tier line:
- Same elite transactional business: `REV-NRR='unknown'` → **DRS 83.2 "Sale
  Ready"**; `REV-NRR=110` → **DRS 85.1 "Institutional Grade."**
- A farm with 10-yr tenure and 5% churn still gets a `CHURN_HIGH` gap purely from
  NRR "unknown."

**Proposed.** Treat "unknown"/"not applicable" as **neutral — exclude the
sub-score and renormalize REV weights** (§3.9 mechanic) rather than assigning the
worst band; and **decouple `CHURN_HIGH`** from NRR-unknown. **Decision:** approve
neutral-exclude for unknown NRR?

### 3.6 — THE BRIDGE: tier labels over-claim on value-fragile businesses `[HIGH]`

**Finding — the dangerous inversion.** A CON/Medicare/medical-director-license-
dependent surgery center scores **DRS 95.1 "Institutional Grade" with ZERO gaps**
— its single largest risk (license non-transferability) is invisible. Meanwhile a
patent licensor scores 19.5 and a routinely-sold dental practice 35.7 "Not
Saleable." `GRW-POS` (the sole differentiation proxy) caps at 80 and moves the DRS
~1.4 pts.

**Proposed (in scope even though the underlying value is not).** Scope the tier
labels to **"standalone operational readiness"** and add **blind-spot flags** that
fire on known-unscored conditions (single license/CON dependence, IP-as-primary-
value, asset-floor value, named-professional dependence) so the output never
asserts "Institutional Grade, no gaps" on a value-fragile business. **Decision:**
approve label-scoping + a blind-spot-flag set?

### 3.7 — Gap engine turns inherent traits into false, mislabeled gaps `[MEDIUM]`

**Finding.** Triggers key off structurally-floored sub-scores with contradictory
labels: `REV_VOLATILITY` "Revenue Inconsistency" fires on **low/flat** growth
(not volatility) — a dollar-flat $5M×8yr annuity (DRS 94.0) gets it; `CONTRACT_GAP`
"Undocumented Recurring Revenue" fires on fully-**contracted** short-cycle project
work; `PIPELINE_BLIND`/`NONCOMPETE_GAP`/`STALE_VALUATION` fire on model- or
age-structural facts. Result: playbooks full of non-actionable items.

**Proposed.** Relabel gaps to match the actual signal (low growth ≠
inconsistency; contracted project revenue ≠ undocumented), and **suppress** gaps
structural to the business model (no B2B pipeline for an annuity; no employee
non-competes for a solo). **Decision:** approve relabel + structural suppression?

### 3.8 — Pipeline-coverage construct is trend-blind `[MEDIUM]`

**Finding.** `GRW-PIPE = pipeline / most-recent-year revenue`, banded
[3→100, 2→70, 1→35, else 0]. Any coverage <1× maps to 0 (a real $2M pipeline at
0.43× == no pipeline), and because the divisor is the latest year, a **revenue
collapse mechanically inflates** coverage (a collapsed $3M year with a $6M
pipeline scores 70 vs 35 for its healthier $4.4M peer). `PIPELINE_BLIND` assumes a
B2B sales motion that recurring/consumer/asset models don't run.

**Proposed.** Normalize against a trend/expected-revenue baseline (not the latest,
possibly-collapsed year), give **graded credit below 1×**, and suppress
`PIPELINE_BLIND` for models with no sales-pipeline motion. **Decision:** approve?

### 3.9 — Young business + healthy maturity `[LOW — the original question]`

**Finding.** The item that started this. Bounded impact (Growth is 10% of DRS),
but two structural unfairnesses:
- **Age-capped tenure/valuation.** `CUS-TENURE` is mathematically bounded by
  company age (a 2-yr-old caps at 50 no matter how loyal its customers), and
  `VAL-LASTVAL="never"` docks the ORI 15 pts + fires `STALE_VALUATION` on every
  young company — conflating youth with owner-unpreparedness. A near-perfect
  2-yr rocket scores **ORI 85.0 vs 100.0** for a byte-identical mature business.
- **Maturity double-penalty.** A flat annuity is dinged in *both* Growth
  (`GRW-CAGR` floors at 20) and Revenue (`REV-GROWTH` floors at 25) for the same
  fact — a perfect flat cash cow caps at DRS 94.0 vs 99.6 for its 20%-growth twin.

**Proposed — the mechanic you already chose (neutralize & re-normalize).**
1. New intake question: **operating history / years in business** (and/or use
   `len(REV-ANNUAL)`).
2. Add a **sub-score "applicability"** concept: a sub-score can be marked N/A for
   an assessment via a data-driven condition in `logic_json` (e.g.
   `na_if_years_lt`). When N/A, it's **excluded from its dimension and the
   dimension's remaining weights re-normalize to sum to 1.0.**
3. Apply to the age-gated sub-scores (`CUS-TENURE`, growth-history, retention-
   history) when history is insufficient; make `VAL-LASTVAL`/`ORI-LASTVAL`
   age-aware so youth isn't scored as staleness.
4. Same mechanic serves §3.3 (transactional REV) and §3.5 (unknown NRR).

This is the largest engine change (N/A + re-normalization in **both** the TS
engine and the reference scorer, a new `rubric_version`, and new young-company
fixtures). **Decision:** confirm the N/A + re-normalization design, and the
history threshold (propose: <3 fiscal years neutralizes growth-history and
tenure; <5 years makes tenure age-aware rather than hard-capped).

### 3.10 — `GRW-POS` caps at 80 while every other select_map tops at 100 `[LOW]`

Almost certainly an unintended inconsistency (methodology note says "max 80").
**Decision:** raise to 100, or confirm intentional?

---

## Part 4 — By-design limits (product-scope, not scoring bugs)

The DRS **cannot** currently see, and by design does not score:

| Value type | Archetype evidence (DRS) | Product question |
| --- | --- | --- |
| IP / patents / tech moat | Patent licensor **19.5**; pre-revenue GenAI **17.4** | Add an intangible module or separate index? |
| Acquihire / assembled team | 18-person AI/ML boutique **36.7** | " |
| Balance-sheet / asset-floor | $25M-fleet renter **49.2**; $12M-machinery CNC **46.1** | Add an asset-value overlay? |
| Market timing / category creation | EV network **42.3**; frontier cos crash or floor | Is this ever in scope for a diligence-readiness index? |
| License / CON / franchise / named-pro transferability | ASC **95.1 (inverted!)**; scarce-license holder **29.6** | Blind-spot flags (§3.6) are the interim; a real module is a product call. |

These aren't defects in a standalone-EBITDA readiness index — they're a scope
boundary. **Decision (later):** whether any of these becomes a module or a
separate index. Not required to fix the Part 3 bugs.

---

## Suggested sequencing (once Part 3 is ratified)

1. **Ship** Part 1 validation (done).
2. **New `rubric_version`** carrying the ratified Part 3 band/formula changes +
   the N/A/re-normalization mechanic + revenue-model & owner-operator branches,
   mirrored in the reference scorer with young/transactional/solo fixtures.
3. **Framing** (§3.6/§3.7): tier-label scope + blind-spot flags + gap relabels —
   can ship alongside or just after (2).
4. **Part 4** modules: separate, product-scoped, only if you want them.

Reproducibility of the stress test: the harness and archetype definitions are in
the session scratchpad; every figure here is a real engine output.
