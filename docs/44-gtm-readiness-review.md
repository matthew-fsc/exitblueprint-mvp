# 44 - GTM Readiness Review (2026-07)

**What this doc is.** A code-verified review of what stands between today's build and
a **first go-to-market**, and the motion to run. It answers three questions: what is
the GTM motion, what must be finished before a customer touches the product, and what
must be hidden or deferred. It sits beside the production-readiness master plan
(`docs/24`) and the beta-readiness snapshot (`docs/archive/35`); where those inventory
*everything*, this one is scoped to the **first** GTM and is opinionated about
sequencing.

> **Headline.** The deterministic core (DRS/ORI scoring, immutable versioned
> engagements, RLS multi-tenancy, the design system, the Deliverables studio) is
> production-grade. Everything still open is at the **edges**: a few prod config
> switches, legal finalization, and surfaces that are *already deliberately hidden*.
> The path to first GTM is an ops checklist, not a build phase. **~85% ready** is
> accurate — and it is the right 85%, because the biggest apparent gaps (self-serve
> signup, live financial ingestion, billing enforcement) are things the first motion
> should **not** turn on.

## 1. The GTM motion — hand-provisioned design-partner pilot

Sell **through advisory firms** (the firm is the buyer / distributor), lead with the
**CFP-led wedge** (`docs/36`) — planners who cannot bill AUM on their client's biggest
asset — with CEPA / M&A as adjacent expansion on the same engine.

| Dimension | The call |
|---|---|
| **Cohort** | 5–15 firms, comped, hand-selected as design partners. Not open self-serve. |
| **Onboarding** | Vendor-provisioned via `scripts/admin.ts` (or the Clerk org webhook). Hand-holding the first cohort is a feature of the motion, not a limitation. |
| **Commercials** | **Comped.** Keep `BILLING_ENFORCED=false`, *or* turn the paywall on and hand each firm an access code (see §2 / `docs/24 §5.7`). Design partners trade feedback + outcome data — which feeds the calibration moat (`docs/09`), the un-retrofittable asset. |
| **Demo assets (built)** | `npm run demo:sales` — a persistent demo tenant with a longitudinal Cascade client, a 15-company book, and advisor + owner logins (`docs/39`). `npm run dogfood` — ExitBlueprint run on ExitBlueprint ("we scored ourselves High Risk; here's our roadmap"). |
| **What you sell** | The **Deliverables studio** (owner report · delta · CIM) — the most mature surface — backed by the auditable deterministic score a fiduciary can put their name on. The wedge no black-box incumbent matches. |

## 2. Finish before the first customer (short, mostly config)

1. **Virus scanner — the one default-broken path.** In production
   (`NODE_ENV=production`) with no scanner configured, the document pipeline
   **fails closed**: every upload is `rejected` and bytes won't serve
   (`server/documents/pipeline.ts`). If documents are a launch feature, set
   `EB_SCANNER=clamav` + a running clamd, and verify `NODE_ENV` / `EB_SCANNER` in
   `render.yaml`. **This is the only thing that breaks by default on a normal click.**
2. **AI gateway key set *and funded*.** The AI layer routes through
   `AI_GATEWAY_API_KEY` (Vercel AI Gateway) — **not** `ANTHROPIC_API_KEY` (setting
   that one does nothing). Unfunded → deterministic composers take over. Invisible on
   the document surfaces (they read as intentionally rule-based) but the two **chat**
   surfaces (Copilot, Diligence Q&A) render a visible "AI synthesis unavailable"
   state that looks broken. Confirm the key is set and has credit before any demo.
3. **Legal: two visible placeholders + counsel sign-off.** The legal pages are real,
   conservative *beta* terms — but `src/pages/legal/content.ts` still renders two
   literal brackets: `[business mailing address]` and `[privacy & legal contact
   email]`. Fill both now (business facts — owner action). Counsel sign-off on the
   flagged items (liability cap, governing law/arbitration, retention, breach
   deadline) is required before **charging**, not before a comped pilot.
4. **Backup/restore drill.** `docs/08` has the runbook but with `[confirm]` markers —
   do the PITR + tested-restore drill before a real firm's financials land.

> If you **charge** in the pilot instead of comping: create Stripe Products/Prices and
> backfill `plans.stripe_price_id` (NULL today → checkout throws). Recommendation:
> comp the first cohort and use access codes (§2 above, `docs/24 §5.7`).

## 3. Hide for first GTM (mostly already hidden)

The team has gated the not-ready surfaces well; this is confirm-and-tidy, not new work.

| Surface | State | Action |
|---|---|---|
| AI Diligence Simulator (buyer lens) | Commented out with an explicit "not production-ready" note (`BuyerLensPage.tsx`) | Keep hidden ✅ |
| Institutional Review | Server endpoint only, no UI | Leave dark ✅ |
| QuickBooks/Xero connect | Owner `/portal/connect` redirects away; advisor card was dead | Hidden ✅ — **done this pass:** dead `AccountingCard`/`OwnerConnectPage`/`lib/ledger` deleted; the dev token-synthesis path now refuses to run in `NODE_ENV=production` (`server/ledger-oauth.ts`) |
| Answer-extraction panel | Confirm panel with no extraction trigger wired | **Done this pass:** the panel self-hides when there are no candidates (`AnswerCandidatesPanel.tsx`) instead of showing an orphaned "run extraction" card |
| `/sign-up` route | Public, dead-ends at "account isn't set up yet" | Low: onboarding is invitation-only by design; leave or hide |
| Sell-side "Run verification" | Reachable; parks unimplemented steps and returns success (0 fields with the manual parser) | Low: safe (never errors); soften the success copy until the parser/scoring steps land |

## 4. Defer — do NOT finish for the pilot

Building these before the pilot is scaffolding ahead of demand:

- **Self-serve firm signup** — the vendor provisions the cohort; that's the motion.
- **Automated document extraction** — manual review is the correct pilot posture.
- **Live QuickBooks/Xero ingestion** — manual/CSV entry works.
- **Billing enforcement & dunning** — comped pilot; leave off (or use access codes).

## 5. What this review shipped

The two-line tidies and the paywall/comp-code mechanism were built in the same pass
that produced this doc (see `docs/06` decision entry, `docs/24 §5.7`):

- **Answer-extraction panel** self-hides when empty.
- **Ledger dev-simulation** refuses to fabricate a "connected" record in production;
  the three dead ledger components removed.
- **Comp codes** — a redeemable access code that grants `firm_subscriptions.comp =
  true` without Stripe, so the paywall (`BILLING_ENFORCED=true`) can be on for GA while
  pilot firms get in free. Mint with `npm run admin -- create-comp-code …`; redeem on
  the Billing page. Code tables are service-role only (RLS-verified). Full spec:
  `docs/24 §5.7`.

## 6. The one-page launch checklist

1. Configure the virus scanner in prod (or uploads are dead).
2. Fund the `AI_GATEWAY_API_KEY`.
3. Fill the two bracketed legal fields; queue counsel review for GA.
4. Run a restore drill.
5. Provision the cohort (`scripts/admin.ts`); comp them, or turn on the paywall and
   hand out access codes.
6. Keep self-serve signup and live-ingestion off.

Do those and the pilot runs.
