# 18 - Modeling the CFP / CEPA Practitioner Workflow

Exit Blueprint is sold to and through the advisors who actually run exit
preparation — Certified Exit Planning Advisors (CEPA) and CFP® financial
planners. The product is most useful when it **models the way they already
work**, so their process maps onto our screens instead of fighting them. This
document reviews their real work streams, maps them onto the five sell-side work
streams (docs/17), names the gaps, and records what we built to close the first one.

## The two methodologies we're modeling

### CEPA — the Value Acceleration Methodology™ (Exit Planning Institute)

- **Three gates.** *Discover* (assess business + personal + financial value
  factors, run a valuation, produce a **prioritized action plan**) → *Prepare*
  (execute in **90-day sprints** on parallel paths — business improvements
  alongside personal & financial planning) → *Decide* (weigh advanced value
  creation vs. going to market).
- **Three legs of the stool.** A successful transition needs the **Business**
  leg (transferable value), the **Personal** leg (the owner's post-exit vision
  and identity — *the most overlooked leg*), and the **Financial** leg (does a
  sale actually fund the owner's life?) to be balanced. A short leg wobbles the
  whole plan.
- **The gaps CEPAs quantify.** *Wealth Gap* = the owner's post-exit wealth goal −
  their net worth excluding the business. *Value Gap* / *Profit Gap* = current
  business value vs. its potential if the company were **best-in-class** on
  EBITDA.
- **Attractiveness vs. Readiness.** Two distinct axes: how attractive the
  business is *to a buyer* vs. how *ready* the owner and business are to
  transfer. A high attractiveness score does not mean the business is ready.
- **Four Intangible Capitals** — Human, Structural, Customer, Social — the
  non-financial assets that make up the majority of enterprise value.

### CFP® — the 7-step financial planning process (CFP Board)

Understand circumstances → identify & select goals → analyze current course vs.
alternatives → develop recommendations → present → implement → **monitor &
update**. A disciplined, goals-first, continuously-reviewed loop.

## How their work maps onto our five work streams

| Practitioner step | Our work stream (docs/17) | Fit |
|---|---|---|
| CEPA *Discover* · CFP steps 1–3 | **Readiness** (assess, diagnose) | Good — DRS + ORI + gaps. **Missing: the three-legs alignment view.** |
| CEPA *Prepare* · CFP steps 4–6 | **Remediation** + **Evidence** | Good — roadmap + data room. **Missing: 90-day sprint framing; parallel personal/financial track.** |
| CEPA value/wealth gap · CFP goals | **Value** | Partial — value gap + net proceeds exist; **wealth gap is computed but never surfaced in context.** |
| CEPA *Decide* | (none yet) | **Missing: hold-vs-exit options analysis.** |
| CFP step 7 · re-assessment | **Deliverables** + re-assess | Good — delta reports + quarterly re-scoring. |

## Gap analysis

| # | CEPA/CFP concept | Current coverage | Gap | Disposition |
|---|---|---|---|---|
| 1 | **Three legs of the stool** | DRS (business), ORI (personal), valuation wealth gap (financial) — all exist, scattered | No single balanced readout; the frame CEPAs *lead* with is absent | **BUILT this pass** |
| 2 | **Value Acceleration gates** | Roadmap phases 1/2/3 ≈ Prepare | Not framed as Discover / Prepare / Decide | Gate is now inferred on the alignment panel; full framing proposed |
| 3 | **Quantified wealth gap** | `owner_wealth_target` + `wealth_gap` computed in valuation | Target was buried in advanced inputs, so the gap read "not sized" | **BUILT** — first-class capture on the Value screen + a link from the alignment financial leg |
| 4 | **Profit gap (best-in-class EBITDA)** | Value gap is readiness-driven (EV at DRS 85) | No EBITDA-margin-vs-peer profit gap | Proposed — needs industry margin benchmarks alongside the multiples |
| 5 | **Attractiveness vs. readiness** | DRS ≈ readiness; GRW hints at attractiveness | No distinct attractiveness axis / 2×2 | Proposed (candidate overlay, docs/15 decision 2) |
| 6 | **Four Intangible Capitals** | Sub-scores map to Human/Structural/Customer/Social | Not presented in the capitals vocabulary CEPAs use | Proposed — a lens/relabeling over existing sub-scores |
| 7 | **Decide-gate options analysis** | `GOL-PATH` captures a preferred path | No structured hold vs. third-party / recap / ESOP / internal-transfer comparison | Proposed |
| 8 | **90-day sprints & parallel tracks** | Tasks have offset dates | Not grouped into sprints; personal/financial track thin | Proposed |
| 9 | **Personal & financial de-risking** | ORI dimensions; PFN signals | Personal/financial *action items* (estate, guarantees, financial independence) are light vs. business tasks | Proposed |

## What we built: the Three Legs of the Stool alignment

The signature CEPA frame, on the engagement Overview (the Readiness work stream) —
deterministic, assembled from data the platform already produces, **no engine,
scoring, or LLM change**:

- **Business leg** — from the DRS score and tier.
- **Personal leg** — from the ORI, pulled down when a `TIMELINE_MISMATCH` gap is
  open (the owner wants to exit sooner than they're ready). Named explicitly as
  "the most overlooked leg" when weak.
- **Financial leg** — from the valuation's wealth gap (`owner_wealth_target −
  net_proceeds`): *goal covered*, a sized *wealth gap*, or *not yet quantified*
  (which prompts capturing financials + a wealth target — the CFP goals-first
  move). The `VALUE_GAP` gap reinforces a short leg.
- **Verdict + gate** — the "wobbly stool" read (which leg is short and what that
  means), plus the Value Acceleration gate the engagement is effectively at
  (Discover if the picture is incomplete, Prepare if a leg needs work, Decide if
  all three are strong).

Implementation: `src/lib/alignment.ts` (pure `buildAlignment`, unit-tested in
`tests/alignment.test.ts`, 10 cases) rendered as a panel on `EngagementPage`.
Pure-logic + presentation over existing reads — mirrors the `buildPortfolioRows`
pattern.

## Recommended next (in priority order)

1. ~~**Wealth-gap capture** (gap 3)~~ — **DONE.** A first-class "set the owner's
   wealth goal" prompt now lives in the wealth-gap slot on the Value screen; the
   alignment financial leg links straight to it when unsized, and the demo seeds a
   wealth target so all three legs show out of the box.
2. **Value Acceleration gate framing + 90-day sprints** (gaps 2, 8) — group the
   roadmap into sprints and label the engagement's gate; make the Prepare cadence
   explicit.
3. **Four Intangible Capitals lens** (gap 6) — relabel/roll up existing sub-scores
   into Human/Structural/Customer/Social so CEPAs see their own vocabulary.
4. **Decide-gate options analysis** (gap 7) and **profit gap** (gap 4) — larger,
   need product decisions and (for the profit gap) industry margin benchmarks.

## Sources

- Exit Planning Institute — Value Acceleration Methodology (Discover / Prepare /
  Decide): https://exit-planning-institute.org/about-us-methodology
- EPI blog — the Discover, Prepare, and Decide gates:
  https://blog.exit-planning-institute.org/what-is-value-acceleration-methodology
- EPI — the Four Intangible Capitals:
  https://blog.exit-planning-institute.org/an-in-depth-look-at-the-four-intangible-capitals
- CFP Board — the 7-step financial planning process:
  https://www.cfp.net/ethics/compliance-resources/2018/11/focus-on-ethics---the-7-step-financial-planning-process
- Wealthspire — the case for exit planning / three legs of the stool:
  https://www.wealthspire.com/blog/case-exit-planning-certified-exit-planning-advisor-cepa-credential/
