# Survivor Assessment — Assessment Platform Repo

**Position, stated up front:** This repo should be the **survivor**. It already implements the two things that are hardest to build and most dangerous to get wrong — a verified, byte-identical deterministic scoring engine and a correct immutable, versioned, multi-tenant engagement spine — and it implements them at production-leaning quality with a real test suite and CI. The dashboard/infrastructure repo is far more likely to hold portable *presentation and ops* pieces (dashboards, deploy config, richer UI shell) than to hold anything as load-bearing or as risky-to-recreate as what lives here. Port the dashboard repo's strengths *into* this base; do not rebuild this core inside the dashboard repo.

This position assumes the second repo is roughly what its description implies (dashboard + software infrastructure). If that repo turns out to also contain a second, divergent scoring implementation or its own engagement schema, that changes the merge mechanics but not this recommendation: **there must be exactly one scoring engine and one engagement schema, and they should be the ones already proven here.**

---

## Case FOR this repo as survivor (strongest arguments)

1. **The scoring engine is correct, verified, and the irreplaceable asset — and it's here.** All three fixtures pass **byte-identical** (verified by actual run: 82.6 / 16.1 / 52.0, and the Python reference matches the stored fixtures exactly). 32 sub-scores, 6-dimension weighting, tiers, ORI, 24 gap triggers, explain trace — all implemented and locked by 22 engine tests. Recreating this elsewhere risks silently changing a number, which destroys advisor credibility. The methodology IP (`reference_scorer.py` + seed) lives here too.

2. **The engagement-centric spine is already built — not a migration target, a fact.** Immutable, rubric-pinned assessments; `sequence_number` versioning; supersede-with-lineage corrections; `active_assessments` read path; computed cross-version deltas with an explicit incomparable marker; append-only outcome capture. These are the target's architectural *requirements*, and they exist and are tested.

3. **Multi-tenancy is enforced at the database and proven.** RLS on every table, `firm_id` spine, 16/16 isolation assertions passing against a live DB (cross-firm read+write denied, owner read-only + completed-only, append-only outcomes, unauthenticated = nothing). Retrofitting tenancy is the classic high-risk rework; here it's done.

4. **Engineering discipline is unusually high for a prototype.** A thorough CI (fresh DB → migrate → RLS → double-seed idempotency → demo seed self-validated against the reference → tests → build), 40 passing tests, a ~30-entry dated decision log, clean separation of pure/adapter code, correct secret hygiene, and a dev stack that runs with no Docker. This is a base you can build on, not clean up.

5. **The WM layer's hard primitives already exist.** Cross-version deltas (for the branded delta report), the business/owner split (for dual milestones), append-only events (a starting point for the activity log), and an isomorphic engine + narrative firewall (for interactive/branded reports) are all present. The WM work is additive on a sound base.

## Case AGAINST this repo as survivor (strongest arguments)

1. **No general server tier — only Supabase + 3 functions.** Anything that doesn't fit RLS/PostgREST (n8n webhooks, cadence triggers, branded PDF rendering, roadmap workflow) has nowhere natural to live. If the dashboard repo already has a real backend, that's a genuine point in its favor and this is net-new here.

2. **The production function tier isn't actually deployed in-repo.** `score/explain/generate` run via the Vite **dev emulator**; there are no checked-in edge-function entrypoints. Today's "it works" leans on dev middleware. Real deployment is unbuilt (small, but real).

3. **The product loop past scoring is thin.** Tasks/roadmap are inert (tables + templates, zero instantiation), content drip is unbuilt, the owner portal is RLS-only with no pages, and two of three document types throw "not implemented." If the dashboard repo has a mature task/roadmap/dashboard experience, this repo trails badly on that surface.

4. **Frontend is capable but prototype-tier at scale.** Per-page fetching, no data cache, one-engagement-per-company UI assumption. Fine now; the WM client experience will want more.

5. **Heavy coupling to Supabase specifics.** RLS-as-boundary and the emulator/shim tie the platform to Postgres/Supabase. If the org's infra direction (possibly embodied in the dashboard repo) is different, there's friction.

## What must be ported IN if this repo wins (likely from the dashboard repo)

- **A real server/backend tier** (or the pattern for one) to host n8n webhooks, cadence triggers, PDF/report rendering, and the WM roadmap workflow — the biggest structural gap here.
- **Deployed function/edge wrappers and deploy/IaC config** — CI here is strong but there's no evidence of production deployment plumbing.
- **A mature dashboard / advisor-portfolio experience** — cross-engagement views, task/roadmap boards, richer visualizations (this repo has one inline trajectory chart and per-assessment pages only).
- **Owner-portal UI** — the role is fully modeled in RLS but has no pages.
- **Notification/email infrastructure** and any content-drip delivery.
- Possibly a **front-end data/state layer** (caching, shared queries) if the dashboard repo has one worth keeping.

## What must be ported OUT if this repo loses (the irreplaceable pieces)

The extraction is **clean**, because the core was deliberately decoupled. In order of importance:

1. **The scoring engine (`shared/scoring/*`) + rubric parser (`shared/rubric-seed.ts`).** Pure functions of `(rubric, answers)` — **zero persistence or framework entanglement.** Lift the directory as-is. *One landmine to carry with it:* `pyRound` must be preserved exactly, or fixtures break.
2. **The fixtures + reference scorer (`seed/fixtures/*`, `reference_scorer.py`) and the full `/seed` methodology.** These are the regression guard and the domain IP. Non-negotiable; must remain byte-identical in the survivor.
3. **The engine test suite (`tests/engine.test.ts`, `tests/helpers.ts`).** The byte-identical contract, portable with the engine.
4. **The narrative service (`server/narrative.ts`) + prompt + interpretation layer (`shared/scoring/interpret.ts`).** The deterministic composer and numeral firewall are near-standalone (depend only on the explain trace + a `pg` client for I/O). Extract with light rewiring.
5. **The schema + RLS migrations and the server scoring adapter (`server/scoring.ts`).** More entangled (Postgres/Supabase-specific) but the *design* — immutable supersede spine, `active_assessments`, compare/delta semantics — is the reference even if re-expressed on another backend.

**Entanglement verdict:** the engine and fixtures are **fully decoupled** (trivial extraction). The persistence layer is **appropriately coupled to Postgres/RLS** — portable as a design, moderate to re-host on a different backend. Nothing critical is tangled into React or Vite.

---

## Readiness for the WM strategic layer

| WM capability | Rating | Why (one sentence) |
|---|---|---|
| **Branded client-facing delta report** | **NEEDS SCHEMA CHANGE** | The delta engine, narrative service, numeral firewall, and finalize/print path all exist and are reusable; only firm-branding fields (logo/palette/disclosures on `firms` or a `firm_branding` table) plus a branded template are missing. |
| **Dual-milestone roadmap (business + personal, advisor-entered)** | **NEEDS SCHEMA CHANGE** | The business/owner score split maps cleanly onto dual tracks, but advisor-entered milestones are a different shape than gap-derived `tasks` (which are also never instantiated) and require a new `roadmap_milestones` table + UI — no rearchitecture, just additive tables and CRUD. |
| **Touch-cadence event triggers** | **NEEDS REARCHITECTURE** | There is no general server tier and no n8n endpoints; `outcome_events` is deal-specific and advisor-append-only, so cadence rules + scheduled triggers need both a new event/trigger model and the missing backend surface to run them. |
| **Engagement activity log** | **NEEDS SCHEMA CHANGE** | Append-only immutable event capture is already an established, tested pattern (`outcome_events`); a general `engagement_events` table generalizing it (event_type, actor, occurred_at, payload) plus write-throughs from existing flows gets there without rearchitecture. |

**Overall WM readiness:** three of four are additive schema+UI on primitives that already exist; only cadence triggers need net-new infrastructure (a general server tier + scheduler/n8n), which is the same gap identified in the case-against. That single infrastructure investment unblocks the hardest WM item and should be the first thing ported in from the dashboard repo (if it has one) or built.
