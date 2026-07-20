# 36 - Competitive Positioning: The CFP-Led Wedge

**What this doc is.** The competitive landscape — Maus, Capitaliz, Value
Builder, BizEquity — mapped against where Exit Blueprint actually differs, and
the case for leading go-to-market with **CFP® financial planners** as the primary
acquisition wedge. It sits beneath the apex strategy (docs/20) and beside the
practitioner-alignment work (docs/18): docs/20 says *what* we are (the
intelligence layer above advisory workflows), this doc says *who we sell to first
and why we win*. `CLAUDE.md` hard rules still win over everything.

> The incumbents built exit-planning software for exit planners. We build the
> system a financial planner runs to turn a client's biggest illiquid asset into
> the largest AUM event of the relationship.

## Thesis

For most lower-middle-market owners, ~80% of net worth is locked in the business —
the one asset a CFP® *cannot* bill AUM on and therefore structurally ignores. The
Silver Tsunami is now forcing that asset into motion: an estimated $5–10T of
business value transitions this decade, peaking 2027–28, and ~72% of boomer owners
have no written succession plan. Every incumbent tool serves the Certified Exit
Planning Advisor (CEPA) / M&A advisor on feature-dense, learning-curve software.
The CFP® channel — larger, structurally underserved, and holding the client
relationship *before* the liquidity event — is wide open. We do not out-feature the
incumbents (docs/20); we own a channel they were never built for, on software that
looks and feels like it belongs in this decade.

## The market moment

**The wave.** ~2.3–3M boomer-owned U.S. SMBs are expected to transition this
decade; McKinsey puts >1M viable-for-sale firms at up to ~$5T enterprise value, and
~$10T in business assets is projected to change hands by 2030. Peak transition years
are ~2027–28 with an elevated tail through ~2032. Yet ~72% of boomer owners have no
written succession plan and 32% of owners have no formal exit strategy at all.

**Why CFPs, specifically.** A financial planner is measured on assets under
management — and can only bill AUM on *liquid* wealth. For a business owner, the
largest asset on the personal balance sheet is the illiquid, "held-away" business,
which the planner typically never touches. When that business sells it throws off
$1M–$20M+ of newly-liquid capital in a single event. The advisor who has been in the
room *before* the exit — helping the owner get ready — is the advisor who manages the
proceeds. Exit readiness is therefore not a side service for a CFP; it is the single
highest-leverage AUM-capture motion available to them, and today they have no
software built for it.

Sources: Forbes / Fox Business / CT Acquisitions (Silver Tsunami sizing); Exit
Planning Institute, *"Behind the Numbers: How Exit Planning Grows AUM"*; U.S. News,
*"Why Illiquid Wealth is Valuable to Financial Advisors"*; eMoney Advisor; Jump.ai,
*"5 Reasons You Should Ask Clients About Held-Away Assets."*

## Competitive landscape

| Product | Core tooling | Built for | Pricing (public) | The seam we exploit |
|---|---|---|---|---|
| **Capitaliz** | 21-step value-acceleration roadmap, Value Gap Assessment, Business Insights Report, Dynamic Revaluation™ benchmarked on 800+ businesses | CEPAs / exit-planning advisors (Succession Plus DNA) | ~$350/mo per business | Powerful but "complex to learn / not intuitive" (G2, SoftwareWorld); CEPA-centric; report-and-roadmap, not a CFP planning loop |
| **Maus** | Up to 17 modules — Value Gap, Value Range, Wealth Gap, Business Attractiveness — Xero/QuickBooks import, "Maus Attract" lead-gen | CEPAs; explicitly aligned to EPI's Value Acceleration Methodology™ | Per advisor, unlimited clients | Feature-dense, methodology-locked to VAM; advisor-tool framing, legacy UX; no CFP-native planning workflow |
| **Value Builder System** | 8 value drivers, thumbnail "Value Builder Score," practice-management layer | Advisors building a value-building practice | Per advisor (tiered) | Single questionnaire + score; light on longitudinal, evidence, and diligence rigor |
| **BizEquity** | On-demand valuation on a 1M+ business database, white-label, triggering-event prospecting | Valuation/prospecting for advisors & CEPAs | White-label / per seat | Valuation-first, not readiness; a number, not an engagement or a remediation path |
| **Others** | Exitplanner (broker/accountant workflow), SuccessionPlanning.com (multi-year succession), BEI/CExP (certification + tools) | Brokers, accountants, exit planners | Varies | All CEPA/M&A/broker-shaped; none built around the CFP financial-planning process |

Note on sourcing: incumbent feature pages block automated fetch (HTTP 403); the
facts above are drawn from vendor descriptions surfaced in search plus third-party
review sites (G2, Capterra, SoftwareWorld, Exit Planning Institute). Pricing that
isn't publicly listed is marked accordingly.

## The seams — where every incumbent is structurally weak

1. **All CEPA/M&A-built; none CFP-native.** The category was defined by the Exit
   Planning Institute and its Value Acceleration Methodology. Every major tool
   models the CEPA gate flow, not the CFP® Board's 7-step planning loop, and none
   frames the engagement around the planner's actual job — the client's financial
   life and the AUM that follows. The wedge is a channel, not a feature.

2. **Legacy, feature-dense UX in a market that rewards clarity.** Capitaliz's own
   reviews cite a learning curve; Maus ships 17 modules. Boomer owners and the
   generalist CFP serving them are not the power users these tools assume. Modern,
   plain-language, low-friction software is a moat here, not a nicety.

3. **Point-in-time report, not a longitudinal engagement.** Incumbents produce a
   valuation and an assessment — a snapshot. Our unit is the *engagement*:
   immutable, rubric-versioned assessments with computed deltas, re-scored
   quarterly (docs/00, docs/07). The relationship stays warm across the 12–36 month
   pre-deal window — exactly the window a CFP needs to own to capture the proceeds.

4. **Opinion/black-box scoring vs. deterministic + auditable.** Our DRS is rule-
   based, versioned, reproducible against a reference implementation, with AI used
   for narrative only and never to compute a score (`CLAUDE.md` rules 1–2, docs/04).
   That is a credibility and defensibility difference when the output has to survive
   institutional diligence — and when a fiduciary CFP puts their name on it.

5. **No outcome-calibration moat.** No incumbent ties a predicted readiness score
   back to actual close outcomes. Our "FICO moat" (docs/09) — calibrating DRS against
   realized EV/multiple/retrade across closed deals — is un-retrofittable and
   compounds with every engagement.

## What sets us apart — differentiating tooling

Framed as wedge-deepeners, not a feature arms race (docs/20). Each item is tagged
**[built]** (ships today) or **[net-new]** (a CFP bet to schedule into docs/05).

**Built moats to lead with.**
- **[built] Deterministic DRS + separate ORI**, rule-based and reproducible; AI
  narrative-only (docs/07, docs/04). The auditable score a fiduciary can stand behind.
- **[built] Longitudinal, immutable, versioned engagement** with computed deltas and
  quarterly re-scoring (docs/00) — the relationship-warming engine incumbents' snapshots
  lack.
- **[built] Buyer Lens** — the specific diligence question each weak sub-score
  generates (docs/17). Preparation becomes "simulate institutional diligence before the
  market does," not a generic checklist.
- **[built] Evidence / Verification + Data Room readiness** — self-reported vs.
  document-verified reconciliation, confidence-scored (docs/17). Rigor incumbents don't
  reach.
- **[built] Scenario Workbench + Valuation with value-gap and wealth-gap** — model what
  closing a gap does to the number; size the value gap (EV at Institutional Grade −
  current) and the **wealth gap** (owner's target − net-to-owner after tax/debt)
  (docs/07, docs/18).
- **[built] CIM generation** and branded owner/advisor/delta deliverables — the advisor
  is the face, the platform is the engine (docs/17, docs/04).
- **[built] Institutional-grade modern UX + trust posture** — token-driven design
  system, RLS on every table, at-rest encryption, audit log, vendor-DD readiness
  (docs/16, docs/26). "Software a billion-dollar firm runs on," against legacy incumbents.
- **[built] Three data moats** — outcome calibration, verified financial corpus, the
  engagement graph (docs/09).

**CFP-native bets that widen the wedge (net-new; candidates for docs/05).**
- **[net-new] Wealth-Gap → AUM-in-motion view.** Extend the existing wealth-gap
  computation (docs/18 gap #3, already built) into a planner-facing readout: the owner's
  post-exit financial-independence number, net-to-owner-after-tax, and the *liquidity the
  CFP will be positioned to manage*. This makes the AUM thesis concrete on-screen and is
  the single most CFP-resonant surface we can add. Builds on `owner_wealth_target` /
  `wealth_gap` in the valuation engine.
- **[net-new] CFP® 7-step process as a first-class lens.** The mapping already exists in
  docs/18 (steps 1–3 → Readiness, 4–6 → Remediation+Evidence, 7 → re-assessment); surface
  it as the planner's native workflow view so their process maps onto our screens instead
  of the CEPA gate vocabulary. Low build cost, high adoption leverage (CE-credit and
  CFP-Board alignment as on-ramps).
- **[net-new] "Held-away business asset" triage / conversation starter.** A short,
  plain-language top-of-funnel assessment a CFP runs in a client review to surface the
  ignored asset and open the exit-readiness conversation — the wedge that converts an
  existing AUM client into an engagement. Reuses the intake/DRS engine at a lighter depth.
- **[net-new] Boomer-market owner experience.** A plain-language, low-jargon owner-facing
  readiness view tuned to a non-power-user, retirement-minded audience (docs/34/35 already
  flag "dense domain vocabulary" as a UX risk). Clarity as competitive advantage per seam #2.

## The CFP go-to-market wedge

**Why CFP-first beats CEPA-first.**
- **Larger, underserved TAM.** The CEPA population is the incumbents' saturated home
  turf. The far larger CFP® / generalist-planner population serves business owners today
  *without* exit-readiness software — a channel no incumbent was built for.
- **Structural pain, not aspiration.** A CFP literally cannot bill AUM on the client's
  biggest asset. Exit readiness resolves that — it is ROI, not a feature preference.
- **The exit is the AUM-capture event.** $1M–$20M+ of proceeds go to whoever was in the
  room first. Our longitudinal engagement *is* the mechanism for being that advisor.
- **Built-in on-ramps.** CFP-Board 7-step alignment (docs/18) and CE-credit eligibility
  make adoption feel native to how planners already work and certify.

**Adjacent channel, same engine.** CEPAs / M&A advisors remain a real market; the same
deterministic engine, roadmap, and deliverables serve them — reframed in VAM / gate
vocabulary (docs/18). CFP is the wedge; CEPA/M&A is the adjacent expansion, not a fork.

**Positioning statement.** *For financial planners whose clients own the business that
holds most of their wealth, Exit Blueprint is the modern readiness system that turns the
one asset they can't manage into the largest AUM event of the relationship — with a
deterministic, defensible score no black-box tool can match.*

**One-line category claim.** The exit-readiness system built for the financial planner,
not the exit planner.

## Risks & open questions

- **ICP line in `CLAUDE.md`.** `CLAUDE.md` still reads "distributed through M&A
  advisors," while docs/18–19 and this doc lead with CFPs. This is a product-behavior
  call for Matthew; recorded in docs/06 as a decision to lead with the CFP wedge, with a
  follow-up to reconcile the `CLAUDE.md` one-liner (not edited in this pass).
- **Personal-financial depth is currently a thin lens.** The built product is
  business-diligence-heavy; the personal/financial-planning side (wealth gap, three legs)
  is layered over existing data rather than a full planning engine (docs/18 gap #9). The
  CFP wedge raises the bar on this side — the Wealth-Gap → AUM view is the first step, not
  the finish line.
- **Sequencing the net-new bets.** Which CFP bets enter docs/05 first (recommend:
  Wealth-Gap → AUM view, then the 7-step lens) is a build-plan decision, not settled here.
