# Docs index

Start here. Docs are grouped by what you're trying to do. The **Status** column
says how to read each one:

- **Canonical** — the source of truth; read before building the thing it covers.
- **Reference** — durable, current background.
- **Strategy** — product/positioning reasoning (Matthew-owned); direction, not build spec.
- **Runbook** — ordered operational steps.
- **Log** — append-only history.

Point-in-time audits and superseded runbooks have been moved to
[`archive/`](./archive/) — see the bottom of this file.

> **Doc-numbering note.** Doc numbers are referenced from source code (top-of-file
> `// docs/NN` pointers, `render.yaml`, scripts), so numbers are stable and never
> reused. Archived docs keep their number under `archive/`.
>
> ⚠️ **Number collision — needs Matthew.** Two docs currently share number **41**:
> [`41-advisor-library-research-plan.md`](./41-advisor-library-research-plan.md)
> (registered as `docs/41` in the decisions log, 2026-07-21) and
> [`41-legal-counsel-talking-points.md`](./41-legal-counsel-talking-points.md)
> (added the same day with no decisions-log entry). Numbering is Matthew-owned —
> one of these needs a fresh, never-reused number assigned. Not resolved here.

---

## Start here
| Doc | What it is | Status |
| --- | --- | --- |
| [00-product-brief](./00-product-brief.md) | The problem, the Assess→Diagnose→Prescribe→Educate→Re-assess loop, users, MVP bar | Reference |
| [40-vision-and-business-integration](./40-vision-and-business-integration.md) | **Horizon.** Where the software goes + how the company runs its own business plan/internal systems on the same rails (the frame above 20/38) | Strategy |
| [05-build-plan](./05-build-plan.md) | **Roadmap.** MVP (S1–S15) shipped; current work is production hardening + beta | Reference |
| [28-architecture-map](./28-architecture-map.md) | The whole system at a glance (Mermaid): layers, request lifecycle, six engines | Canonical |
| `../CLAUDE.md` | Non-negotiable architecture rules — wins over every doc here | Canonical |

## Find the code fast — feature → where it lives

A developer index: the durable features and the files that own them. Pair with
[28-architecture-map](./28-architecture-map.md) (the visual module map) and
[27-engineering-patterns](./27-engineering-patterns.md) (how to add one).

| Feature | Owns it (code) | Doc |
| --- | --- | --- |
| Compute gateway + function registry | `server/functions.ts`, `server/registry.ts` | 28 §2, 27 |
| Identity (Clerk) + RLS | `server/auth-jwt.ts`, `server/http.ts`, migrations | 30, 28 |
| Deterministic scoring (DRS/ORI) | `shared/scoring/engine.ts` · `seed/fixtures/reference_scorer.py` | 03, 07 |
| Assessment lifecycle (immutable) | `server/scoring.ts`, `supabase/migrations/*` | 02, 03 |
| Roadmap & tasks | `server/roadmap.ts` (auto-applies Plans; playbooks retired) | 02, 17 §2 |
| **Library** (atomic items: tasks · education · advisory) | `src/pages/LibraryPage.tsx` · `library_tasks`/`content_modules`/`advisory_library_items` | 37, 02 |
| **Plans** (bundles of Library items) | `server/plans.ts` · `src/pages/PlansPage.tsx` · `src/pages/owner/OwnerPlanPage.tsx` | **37**, 02 |
| **Deliverables studio** (owner report · delta · CIM) | `src/pages/DeliverablesPage.tsx` · `src/components/DocumentCurator.tsx` · `shared/documents/catalog.ts` · `server/documents/catalog.ts` | 17 §5 |
| CIM (readiness + generation) | `shared/cim/template.ts`, `server/cim.ts` | 17 §5 |
| **Market-cited deliverables** (CIM/teaser/mgmt-presentation ground on licensed market context — `retrieveCimMarketContext` → `marketSource`; the wired `citation_contract` on the AI path + cited market blocks in the composers; Bench `uncited_market_figure` source check) | `server/cim.ts` · `server/narrative.ts` (`generateCim/Teaser/Management*`) · `prompts/{cim,teaser,management_presentation}.v1.md` · `server/llm/evals/rubrics/{cim,teaser}.baseline.json` | sellside-ai/05 |
| Narrative (AI, draft-only) | `server/narrative.ts` | 04 |
| **Buyer lens + Diligence simulation** (institutional reviewer → ranked, persisted blind-spot report) | `server/institutional-review.ts` · `server/diligence-simulation.ts` · `prompts/diligence_simulation.v1.md` · `diligence_simulation_runs`/`_findings` · `src/pages/BuyerLensPage.tsx` | 20, 40 §3, 04 |
| Valuation & comparables | `server/valuation.ts`, `server/comparables.ts` | 17 §4 |
| **Market reference data** (groundwork: non-tenant `market` schema — licensed comps/multiples; deterministic `'market'` valuation multiple behind a disabled-by-default rules-version flag; NO retrieval/LLM yet) | `supabase/migrations/*_market_reference_schema.sql` · `shared/market-keys.ts` · `server/comparables.ts` (`marketMultiple`) · `shared/own-book.ts` (`selectValuationMultiple`) | sellside-ai/01 |
| **ExitBlueprint Bench** (two-axis deliverable eval — answer + source score; deterministic checks reuse `numeralPostCheck`; **`diligence_qa` rubric** = used-facts + citation-contract; **real versioned LLM-judge** for subjective criteria on the economy tier, secret-gated behind `AI_GATEWAY_API_KEY`+`RUN_LLM_JUDGE` so CI stays deterministic; judge axis persisted de-identified) | `server/llm/evals/bench.ts` · `server/llm/evals/judge.ts` · `server/llm/evals/ci.ts` · `server/llm/evals/rubrics/*` · `server/llm/evals/fixtures/judge_golden.json` · `prompts/bench_judge.v1.md` · `server/bench-metrics.ts` | sellside-ai/02 |
| **AgentSpec runtime** (groundwork: declarative spec naming the build-payload→narrative→persist shape; six existing agents as metadata) | `shared/agents/spec.ts` · `server/agents/registry.ts` | sellside-ai/03 |
| **Own-book valuation multiples** (moat 2: valuation draws a multiple from the firm's own closed deals alongside generic comps, versioned-config gated; cross-firm calibration view stays service-role-only) | `shared/own-book.ts` · `server/comparables.ts` (`ownBookMultiple`) · `server/valuation.ts` · `server/financial-corpus.ts` · `supabase/migrations/*_own_book_valuation_multiples.sql` · `src/pages/ValuationPage.tsx` | **09 §2**, 17 §4 |
| Evidence (data room · docs · verification) | `server/data-room.ts`, `server/documents/*`, `server/verification.ts` | 02, 17 §3 |
| **Answer extraction** (WS-EXTRACT: AI PROPOSES candidate answers into a staging queue; a human confirms them through the deterministic answer path — never writes to a scoring table) | `server/answer-extraction.ts` · `server/llm/models.ts` (`modelForTier`) · `prompt extract.answer_candidates.v1` · `answer_candidates` table · `src/components/AnswerCandidatesPanel.tsx` (Evidence › Review) | sellside-ai/WS-EXTRACT |
| Secure document storage + scan | `server/documents/{storage,scanner,crypto,signed-url}.ts` | 02 |
| Billing (Stripe) + entitlements gate | `server/stripe.ts`, `server/entitlements.ts` | 24 |
| **Org controls** (admin role · pro directory · assignment; sub-tabbed) | `server/organization.ts` · `src/pages/OrganizationPage.tsx` · `src/components/EngagementProfessionalsCard.tsx` | 02 |
| **Account menu** (avatar dropdown: Profile → Clerk account modal · Billing · Sign out; Organization is a nav tab, not a menu item) | `src/components/UserMenu.tsx` · `src/lib/clerkActions.ts` · `src/pages/BillingPage.tsx` (`/billing`) | 06 (log) |
| Advisor onboarding checklist | `src/components/GettingStarted.tsx` | 06 (log) |
| Mobile responsive pass | `src/styles.css` (Mobile section), `AppNav` | 06 (log) |
| Design system (tokens/components/format) | `src/components/ui/*`, `src/lib/format.ts` | 26 |
| Scheduled webhooks (n8n) | `server/scheduled.ts` | 08 |
| Observability (Sentry seam) | `server/observability.ts`, frontend seam | 32 |
| **Operating dashboard** (superadmin `analytics` rail: activation funnel · revenue plan · unit economics/COGS · churn book · moat KPIs) | `supabase/migrations/*_platform_analytics.sql` · `*_moat_kpis.sql` · `*_operating_dashboard.sql` · `server/platform-metrics.ts` · `server/moat-metrics.ts` · `src/lib/platformConsole.ts` · `src/pages/PlatformConsolePage.tsx` (gate `PLATFORM_SUPERADMIN_IDS`) | 38, **40 §4b** |
| **Dogfooding** (ExitBlueprint as its own firm-isolated tenant: firm/company/engagement scaffold + full self-run — advisor, DRS/ORI trajectory, plan, evidence, library) | `scripts/seed-internal-tenant.ts` (`npm run seed:internal`) · `scripts/dogfood.ts` (`npm run dogfood`) · `seed/dogfood/*.json` | 40 §4c/§6, 39 |
| **Outcome Calibration Engine** (the FICO moat: versioned DRS/ORI-band calibration artifact — close rate · multiple range · time-to-close · within-range hit rate · EV variance · retrade rate; de-identified cross-firm, superadmin `analytics` rail) | `shared/calibration/compute.ts` · `server/calibration.ts` · `supabase/migrations/*_calibration_engine.sql` (`analytics.calibration_versions`/`calibration_bands`) · `compute-calibration`/`read-calibration` in `server/registry.ts` · `src/pages/PlatformConsolePage.tsx` (DRS-calibration panel) | **09 §1**, 40 §3 |
| **Engagement graph** (moat 3: the longitudinal gaps→remediation→score-movement→outcome path read back as remediation-effectiveness + comparable-engagement intelligence; `deal_outcomes` capture closes the loop) | `server/engagement-graph.ts` (`engagement-graph` in `server/registry.ts`) · `server/outcomes.ts` (`deal_outcomes` / `record-deal-outcome`) | **09 §3**, 20 |

## Build canon (read before you change the matching thing)
| Doc | What it is | Status |
| --- | --- | --- |
| [02-data-model](./02-data-model.md) | Schema, enums, RLS model — read before any migration | Canonical |
| [03-scoring-engine-spec](./03-scoring-engine-spec.md) | `scoreAssessment` / `explainAssessment` / `compareAssessments` contract | Canonical |
| [07-drs-methodology](./07-drs-methodology.md) | DRS weights, tiers, sub-score benchmarks (Blueprint II) | Canonical |
| [04-ai-layer-spec](./04-ai-layer-spec.md) | Narrative-service boundary + prompt contracts (brief shipped as `delta_report.v1`) | Reference |
| [26-ui-system](./26-ui-system.md) | UI tokens, components, format helpers, page spine | Canonical |
| [27-engineering-patterns](./27-engineering-patterns.md) | The template + definition-of-done for each kind of change | Canonical |
| [01-architecture](./01-architecture.md) | Prose architecture (companion to 28) | Reference |

## Product & workstreams
| Doc | What it is | Status |
| --- | --- | --- |
| [17-sellside-workstreams-ux](./17-sellside-workstreams-ux.md) | The five sell-side work streams and the nav that groups them | Reference |
| [19-vision-workstreams-ux](./19-vision-workstreams-ux.md) | North-star: vision + methodology + work streams + IA in one place (superset of 17) | Strategy |
| [18-cfp-cepa-workflow-alignment](./18-cfp-cepa-workflow-alignment.md) | Maps CEPA / CFP workflows onto the product's work streams | Strategy |
| [37-plans](./37-programs-plans-design.md) | **Plans (shipped)** — reusable advisor-curated bundles of playbooks/tasks/education/milestones applied to an engagement; the design record **and** as-built reference | Reference |

## Strategy & positioning
| Doc | What it is | Status |
| --- | --- | --- |
| [40-vision-and-business-integration](./40-vision-and-business-integration.md) | Horizon frame above the apex — the three loops (product/business/ops) as one nervous system; dogfooding; moats as the financial thesis | Strategy |
| [20-strategic-positioning](./20-strategic-positioning.md) | Apex strategy — intelligence layer above advisory workflows; 7-layer moat | Strategy |
| [09-moats](./09-moats.md) | The three data moats (outcome calibration, financial corpus, engagement graph) — the detail 20's moat list folds in | Strategy |
| [36-competitive-positioning-cfp](./36-competitive-positioning-cfp.md) | Competitive landscape + the CFP-planner go-to-market wedge (market facts are time-sensitive) | Strategy |
| [41-advisor-library-research-plan](./41-advisor-library-research-plan.md) | **Content sourcing plan** — research topics, reputable LMM M&A sources, and a phased plan to fill the advisor-library/Plans/valuation seed (market facts are time-sensitive) | Strategy |
| [sellside-ai/](./sellside-ai/README.md) | **Harvey pattern → sell-side M&A** — three architecture writeups (market-intelligence RAG on paid data · ExitBlueprint Bench eval rubric · sell-side workflow agents); unnumbered folder, numbers Matthew-assigned if promoted | Strategy |

> These strategy docs overlap by design (20 is the apex; 09 is its moat detail; 18
> & 36 are the practitioner/go-to-market layer and overlap most with each other).
> They're cross-linked rather than merged so each keeps its own argument intact.

## Security & compliance
| Doc | What it is | Status |
| --- | --- | --- |
| [compliance/](./compliance/README.md) | **SOC 2 & pen-test readiness pack** — readiness/gap assessment, Trust Services Criteria control matrix, codebase security scan, the adopted InfoSec policy set (15 policies), risk register, and pen-test scope. The auditor-facing view (13/16/42 are the sales-facing view) | Canonical |
| [13-security-summary](./13-security-summary.md) | Customer one-pager of implemented controls (backs the `/security` page) | Reference |
| [16-vendor-security-dd](./16-vendor-security-dd.md) | Full vendor-security-DD questionnaire response + open-items list | Reference |
| [15-buyer-expectations-and-vendor-dd](./15-buyer-expectations-and-vendor-dd.md) | Analysis of real DD artifacts → rubric/data-room/vendor-DD work | Reference |
| [41-legal-counsel-talking-points](./41-legal-counsel-talking-points.md) | Briefing agenda for outside counsel — ToS, in-product disclaimers, trade-secret & trademark protection, privacy/DPA, AI, third-party data licensing, advisor-channel, go-live priority | Reference |
| [42-lwg-vendor-dd-response](./42-lwg-vendor-dd-response.md) | Completed LWG Vendor Due Diligence Questionnaire (L2) — form-shaped answers to the real packet; the specific instance of 16's generic pack | Reference |

> ✅ **Subprocessor register reconciled (P5.4 done).** `seed/subprocessors.csv`,
> 13, and 16 now name the same current vendor set — **Supabase** (Postgres/RLS/storage),
> **Clerk** (identity/MFA), **Render** (compute), **Vercel** (frontend), **Stripe**
> (billing), **Anthropic** (narrative) — with Supabase no longer credited for
> authentication. Keep the three in sync when the vendor set changes.

## Production & operations
| Doc | What it is | Status |
| --- | --- | --- |
| [24-production-readiness-clerk-stripe](./24-production-readiness-clerk-stripe.md) | The v2 master plan — Clerk + Stripe + remaining ops/legal gaps (re-baselines archived doc 10) | Reference |
| [29-exitblueprint-net-golive](./29-exitblueprint-net-golive.md) | The live go-live runbook for exitblueprint.net (auth steps → 30) | Runbook |
| [39-sales-demo-runbook](./39-sales-demo-runbook.md) | Stand up a hosted sales-demo tenant + advisor & owner logins (`npm run demo:sales`); plus the **Dogfooding** section — ExitBlueprint as its own tenant (`npm run dogfood`) | Runbook |
| [30-clerk-cutover-runbook](./30-clerk-cutover-runbook.md) | **Identity is Clerk.** The auth cutover + provisioning webhook | Runbook |
| [31-production-debug-db-errors](./31-production-debug-db-errors.md) | Troubleshooting Clerk↔Supabase RLS "database errors" | Runbook |
| [32-observability](./32-observability.md) | Sentry seam (frontend + compute); no-op until DSN set | Runbook |
| [38-platform-monitoring](./38-platform-monitoring.md) | Team-side monitoring plan — infra/product/business/security on one analytics rail (`analytics` schema + `/internal/metrics`) | Reference |
| [08-operations](./08-operations.md) | Environments, Clerk provisioning, secrets, backups | Reference |
| [14-environment-keys](./14-environment-keys.md) | Annotated env-var catalog (canonical list is `../.env.example`) | Reference |

## Log & assets
| Doc | What it is | Status |
| --- | --- | --- |
| [06-decisions](./06-decisions.md) | Append-only decision log — never edited retroactively | Log |
| [prompts/architecture-diagrams.md](./prompts/architecture-diagrams.md) | Supplemental architecture diagrams | Reference |
| [DRS-2.0-rubric-draft.xlsx](./DRS-2.0-rubric-draft.xlsx) | Draft next-gen rubric working file | Asset |

---

## Archive — [`archive/`](./archive/)

Point-in-time audits (their changes shipped) and superseded runbooks. Kept for
provenance and because code still cites some of them; not maintained.

| Doc | Why archived |
| --- | --- |
| [archive/10-production-readiness](./archive/10-production-readiness.md) | Superseded by 24 (re-baselined after the Clerk/Stripe work) |
| [archive/11-deploy-runbook](./archive/11-deploy-runbook.md) | Generic predecessor of the live runbook 29; auth section pre-Clerk |
| [archive/12-vercel-supabase-setup](./archive/12-vercel-supabase-setup.md) | Generic setup guide, superseded by 29 for the real deploy |
| [archive/25-beta-launch-runbook](./archive/25-beta-launch-runbook.md) | "Path A" (Supabase-Auth beta) is dead; "Path B" happened via 30 |
| [archive/21-mvp-strategic-audit](./archive/21-mvp-strategic-audit.md) | Point-in-time audit of 20 (as-built A/B/C/D buckets) |
| [archive/22-ux-review-consolidation](./archive/22-ux-review-consolidation.md) | Shipped UX consolidation pass (built 17's deferred progress rail) |
| [archive/23-posture-vs-vision-immutability](./archive/23-posture-vs-vision-immutability.md) | Point-in-time infra/immutability audit |
| [archive/33-design-review-2026-07](./archive/33-design-review-2026-07.md) | Dated design-polish audit; findings implemented in-pass (defers to 26) |
| [archive/34-product-experience-audit-2026-07](./archive/34-product-experience-audit-2026-07.md) | Dated workflow/usability audit; changes shipped |
| [archive/35-beta-readiness-assessment-2026-07](./archive/35-beta-readiness-assessment-2026-07.md) | Dated beta-readiness maturity audit (feature inventory snapshot) |
