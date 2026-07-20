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

---

## Start here
| Doc | What it is | Status |
| --- | --- | --- |
| [00-product-brief](./00-product-brief.md) | The problem, the Assess→Diagnose→Prescribe→Educate→Re-assess loop, users, MVP bar | Reference |
| [05-build-plan](./05-build-plan.md) | **Roadmap.** MVP (S1–S15) shipped; current work is production hardening + beta | Reference |
| [28-architecture-map](./28-architecture-map.md) | The whole system at a glance (Mermaid): layers, request lifecycle, six engines | Canonical |
| `../CLAUDE.md` | Non-negotiable architecture rules — wins over every doc here | Canonical |

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

## Strategy & positioning
| Doc | What it is | Status |
| --- | --- | --- |
| [20-strategic-positioning](./20-strategic-positioning.md) | Apex strategy — intelligence layer above advisory workflows; 7-layer moat | Strategy |
| [09-moats](./09-moats.md) | The three data moats (outcome calibration, financial corpus, engagement graph) — the detail 20's moat list folds in | Strategy |
| [36-competitive-positioning-cfp](./36-competitive-positioning-cfp.md) | Competitive landscape + the CFP-planner go-to-market wedge (market facts are time-sensitive) | Strategy |

> These strategy docs overlap by design (20 is the apex; 09 is its moat detail; 18
> & 36 are the practitioner/go-to-market layer and overlap most with each other).
> They're cross-linked rather than merged so each keeps its own argument intact.

## Security & compliance
| Doc | What it is | Status |
| --- | --- | --- |
| [13-security-summary](./13-security-summary.md) | Customer one-pager of implemented controls (backs the `/security` page) | Reference |
| [16-vendor-security-dd](./16-vendor-security-dd.md) | Full vendor-security-DD questionnaire response + open-items list | Reference |
| [15-buyer-expectations-and-vendor-dd](./15-buyer-expectations-and-vendor-dd.md) | Analysis of real DD artifacts → rubric/data-room/vendor-DD work | Reference |

> ⚠️ **Known gap (needs Matthew sign-off):** the subprocessor register
> (`seed/subprocessors.csv`, surfaced by 13 & 16) predates the Clerk + Stripe +
> Render migration — it still credits Supabase for "authentication" and Vercel for
> "compute" and omits **Clerk**, **Render**, and **Stripe**. Tracked as roadmap
> item **P5.4** in [05-build-plan](./05-build-plan.md). Not edited here because it
> is customer-facing compliance language.

## Production & operations
| Doc | What it is | Status |
| --- | --- | --- |
| [24-production-readiness-clerk-stripe](./24-production-readiness-clerk-stripe.md) | The v2 master plan — Clerk + Stripe + remaining ops/legal gaps (re-baselines archived doc 10) | Reference |
| [29-exitblueprint-net-golive](./29-exitblueprint-net-golive.md) | The live go-live runbook for exitblueprint.net (auth steps → 30) | Runbook |
| [30-clerk-cutover-runbook](./30-clerk-cutover-runbook.md) | **Identity is Clerk.** The auth cutover + provisioning webhook | Runbook |
| [31-production-debug-db-errors](./31-production-debug-db-errors.md) | Troubleshooting Clerk↔Supabase RLS "database errors" | Runbook |
| [32-observability](./32-observability.md) | Sentry seam (frontend + compute); no-op until DSN set | Runbook |
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
