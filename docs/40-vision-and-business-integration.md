# 40 — Where the software goes, and how it runs its own business

**Status: Strategy (Matthew-owned direction, not a build spec).** This is the
horizon doc. It sits above the operational docs and answers one question the
others don't ask directly: **as ExitBlueprint the *product* grows into the
"institutional operating system for business-owner advisory" (docs/20), how does
ExitBlueprint the *company* run its own plan and its own internal systems on the
same architecture it sells?**

Precedence, as always: the user's words → `CLAUDE.md` hard rules → docs/20 (apex
product strategy) → docs/19 (north star) → this doc → individual design docs.
Where this doc and `CLAUDE.md` disagree, `CLAUDE.md` wins. **Nothing here is a
green light to build** — product-behavior decisions belong to Matthew, and the
out-of-scope list at the end still holds.

Companions this synthesizes rather than restates: **docs/20** (the product
strategy and its four architectural phases), **docs/09** (the three data moats),
**docs/38** (the internal monitoring rails), **docs/24** (production readiness),
**docs/36** (go-to-market wedge).

---

## 1. The thesis in one sentence

We sell a system that turns a business into a **legible, defensible, continuously
improving, buyer-ready asset** — so we should be the first company to run
*ourselves* that way, on our own rails, and let the two loops feed each other.

Everything below is a consequence of taking that sentence literally.

---

## 2. Three loops that should become one

The company today reasons about three loops separately. The vision is to make
them a single instrumented system.

1. **The product loop** — Assess → Diagnose → Prescribe → Educate → Re-assess,
   run for advisor firms and their owner-clients (docs/00, 19). This is what we
   ship.
2. **The business loop** — acquire firms → activate advisors → prove outcomes →
   compound the moats → raise/expand on the strength of the dataset. This is the
   company's plan.
3. **The platform-operations loop** — the internal rails that keep the product
   alive and honest: monitoring, provisioning, billing, calibration, security
   (docs/38, 24, 08).

They are currently three mental models with three sets of dashboards. The horizon
is **one nervous system**: the same append-only event spine (docs/38 §2) that
tells us the platform is healthy also tells us the *business* is healthy, and the
same outcome-calibration substrate (docs/09) that sharpens the *product's*
predictions is the evidence base for the *company's* fundraising and pricing.
One rail, many readouts — extended from "four monitoring domains" (docs/38) to
"the whole company."

---

## 3. Where the software should go (product horizons)

This extends docs/20's four phases (Advisor Excellence → Institutional
Intelligence → Outcome Intelligence → Predictive Advisory) with the *direction of
travel*, not a task list. Each horizon must still satisfy the docs/20 decision
framework (improve advisor effectiveness / preparation quality / institutional
knowledge / evidence quality / outcome calibration) and respect every `CLAUDE.md`
rule.

- **Deepen the moat we already started (docs/09).** The single highest-value
  direction is not a new feature — it is *closing the outcome-calibration loop*.
  We have `deal_outcomes` capture; the horizon is turning a growing corpus of
  prediction-vs-reality records into a calibrated DRS ("companies at DRS 72 close
  at 4.6–5.4× within 14 months, 82% of the time") that no competitor can
  retrofit. Calibration always ships as a new `rubric_version` /
  `valuation_rules_version`; it never edits a score in place.
- **Simulate the interrogation before the market does (docs/20).** Move
  preparation from reactive to proactive: the buyer lens grows from "questions a
  buyer will ask" toward "what sophisticated, AI-assisted diligence will actually
  surface," rehearsed while there's still 12–36 months to fix it. AI stays an
  *institutional reviewer* of narrative and evidence — it surfaces blind spots,
  it never grades.
- **From documents to a defensible corpus.** The evidence work stream (docs/19
  §4) trends toward a verified financial corpus (docs/09) that lets us refine
  multiples from our own book rather than generic comps — the substrate under
  every future analytic.
- **The Advisor Library as compounding firm IP (docs/20).** Each firm's playbooks,
  decision logic, and commentary accrue as institutional memory that gets more
  valuable and harder to leave. This is the retention flywheel.
- **Predictive advisory, last.** Only once calibration is real does AI-assisted
  preparation forecasting and firm benchmarking earn its place — and cross-firm
  benchmarking stays behind the explicit scope gate (see §7).

The ordering is deliberate: **evidence → outcomes → calibration → prediction.**
We do not build the predictive layer on self-reported data.

---

## 4. Integrating the business plan into the software

"Integrate its own business plan" means the plan stops living in a slide deck and
starts living in the system as **instrumented, self-updating truth**. Three moves.

### 4a. The moats *are* the business plan
Docs/09's three moats — outcome calibration, the verified financial corpus, the
engagement graph — are not just product defensibility; they are the company's
**financial thesis**. The pitch to a future investor is literally the calibration
readout: *we can predict exit outcomes from readiness because we have the paired
prediction/reality records to prove it.* So the business plan's core KPI is not
MRR alone — it is **the growth and predictive power of the calibration corpus**.
The plan should be expressed in the same terms the product already computes:
number of paired outcomes, within-range hit rate, EV variance, retrade rate
(`firmCalibration`, docs/09 build order). Fundraising milestones map to corpus
milestones.

### 4b. The company runs on its own metrics rail
Docs/38 already built a single event spine (`usage_events`, `billing_events`,
`llm_calls`, `engagements`/`assessments`/`firms`) rolled up into a service-role
`analytics` schema behind `GET /internal/metrics`. The vision is to treat that
endpoint as the **company's operating dashboard**, not just an ops dashboard:
activation funnel = the go-to-market plan's leading indicator; subscription
summary + Stripe = the revenue plan; `ai_cost_daily` = COGS in the unit
economics; `firm_overview` last-activity = the churn-risk book. The business plan
becomes a *readout of live tables*, refreshed continuously, instead of a
quarterly reconstruction. Adding a business metric is the docs/38 pattern: a new
view + a block in the gated endpoint — never a parallel pipeline, never a
loosened tenant policy.

### 4c. Dogfooding — ExitBlueprint as its own first tenant
The strongest form of integration: **we are a lower-middle-market business that
will one day raise or exit, so we should hold ourselves to our own readiness
rigor.** Not as a hard-coded feature, but as a discipline and an eventual internal
tenant: run our own company through the readiness lens, keep our own evidence
binder diligence-ready, name our own gaps, track our own trajectory. This is the
ultimate credibility artifact for a buyer of *our* narrative — and the tightest
possible feedback loop on the product, because our own advisors feel every rough
edge first. (Any such internal tenant lives under normal RLS and the superadmin
gate; it is a customer of the platform, not a backdoor around it.)

---

## 5. Integrating the internal systems

The internal systems are the company's nervous system; the vision is that they
**share one spine and one set of guardrails**, so operating the company can never
quietly weaken the product's promises.

- **One spine, many readouts (docs/38).** Infra, product, business, and security
  monitoring already derive from the tables the app writes during normal
  operation. Keep it that way: derived-from-code, not re-instrumented. New signal
  = new rows on the existing spine.
- **Provisioning and admin as code (CLAUDE.md, docs/30).** Firms and advisors are
  provisioned into Clerk by `scripts/admin.ts`; identity is Clerk, isolation is
  RLS. The internal-systems horizon is making the *operator* surface (superadmin
  metrics, seeding, calibration, subprocessor register) a coherent, gated console
  — `PLATFORM_SUPERADMIN_IDS`, never a firm role — rather than scattered scripts.
- **Calibration as an internal system, not just a product feature (docs/09).**
  The `deal_outcomes` → `firmCalibration` path is simultaneously a product
  capability *and* the company's core internal intelligence asset. It should be
  operated with the same seriousness as billing: monitored, backed up, quality-
  checked, and treated as the crown-jewel dataset it is.
- **Security posture as a sales asset (docs/13, 16).** The vendor-DD readiness we
  maintain for buyers of the platform is itself part of the business plan — SOC 2
  readiness (docs/19 §7) is the long pole on enterprise firm reviews, so it is a
  *revenue* dependency, not just a compliance chore. Integrate it into the plan's
  timeline accordingly.

---

## 6. The self-referential principle (the north star of this doc)

> **Eat your own cooking.** Every claim the product makes to an owner, the company
> should be able to make about itself, from its own systems, on demand.

Concretely, this is the test for whether the three loops have truly merged:

- Can we show our **own** readiness trajectory the way we show a client's? (§4c)
- Is our **business plan** a live readout of the same rails that run the product,
  or a separate document that drifts? (§4b)
- Does a **closed deal** — ours or a client's — improve the same calibration
  corpus that underwrites both the product's predictions and our valuation? (§4a)
- Can an operator answer "is the platform healthy?" and a board member answer "is
  the company healthy?" from **one instrumented spine**? (§2, §5)

When the answer to all four is yes, ExitBlueprint isn't just software that
prepares businesses for exit — it's a company that is itself the reference
implementation of what it sells.

---

## 7. Guardrails this vision must never cross

This is direction; it does not relax a single hard rule. Restating the ones a
"business integration" push is most likely to strain:

1. **Scoring stays deterministic and AI stays narrative-only** (`CLAUDE.md` §1–2).
   Nothing in the business/ops loop ever writes, adjusts, or lets AI influence a
   score. Calibration informs the *rubric* via a new version — never a live edit.
2. **Firm isolation is absolute** (`CLAUDE.md` §5, docs/38 §0). Company analytics
   and dogfooding run through the service-role/superadmin path and the walled
   `analytics` schema. "Good analytics for us" never loosens a tenant policy, and
   no PII crosses the trust boundary.
3. **Immutability and versioning hold** (`CLAUDE.md` §4, §6). The engagement is
   the unit; snapshots are immutable; corrections supersede.
4. **Cross-firm client-facing benchmarking stays out of scope** until Matthew
   explicitly requests it (`CLAUDE.md`, docs/09). Internal calibration ≠ a
   customer-facing benchmark. Consumer communication channels and owner self-
   signup remain out of scope.
5. **Build only the current slice; don't scaffold ahead** (docs/19 §8). This doc
   sets a horizon; it authorizes no code. Turning any horizon into work is a
   Matthew decision, sliced through docs/05.

---

## 8. Using this doc

- It's the **"why are we doing this at all"** frame for a reasoning session — the
  layer above docs/20's "what's the product strategy" and docs/38's "how do we
  watch it."
- When a proposed feature or ops change is ambiguous, test it against §6 (does it
  make the three loops *more* one system?) and §7 (does it respect every hard
  rule?). If it fails §7, stop. If it advances §6 and passes §7 and the docs/20
  framework, it's a candidate — for Matthew to schedule, not to auto-build.

---

*Source: horizon synthesis over the existing strategy (docs/20), moats (docs/09),
and internal-systems (docs/38) canon. Direction is Matthew-owned; this doc records
the frame, not a commitment to build.*
