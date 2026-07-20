# 35 — Beta Readiness Assessment (2026-07)

**Question asked:** Can this application reliably support a financial/M&A advisor from the
beginning of a client engagement through completion **without developer intervention**?

**Method:** Multi-perspective audit (Product, Staff Engineering, QA, UX, Solutions
Architecture, Advisor-as-user, Beta Program). Every claim below is traced to the actual
implementation, not to feature existence. Test suite run locally; workflows traced through
frontend → hook → endpoint → query.

**Headline verdict:** This is **not** a prototype. It is a genuinely mature, well-architected
application at **Early Beta** maturity, **~72% complete** toward a self-serve beta and **~85%**
toward a *vendor-operated, comped pilot*. The deterministic core (scoring, tenancy, immutability,
versioning) is production-grade. The blockers are at the **edges**: self-serve provisioning,
live financial ingestion, document extraction, legal finalization, and prod-proving of the
auth/billing/observability layers that exist in code but have not been exercised under load.

---

## Phase 1 — The Product

- **Intended users:** M&A advisors / CEPAs / CFPs at boutique firms (the distribution channel),
  and the lower-middle-market business owners they serve (owner portal), 12–36 months pre-sale.
- **Core purpose:** Measure exit readiness (DRS + ORI), diagnose gaps, prescribe remediation
  playbooks, and educate owners across a long engagement.
- **Architecture:** React+Vite SPA (`src/`); a single portable function router (`server/functions.ts`
  → `server/registry.ts`, ~40 endpoints across six "engines"); Supabase/Postgres with RLS as the
  data plane; Clerk identity (JWT via JWKS); Anthropic for narrative only; Stripe billing; Sentry.
  Browser reads go **direct** to Postgres under RLS; all writes/compute go through the guarded
  router (`docs/28`). 28 migrations, 44 test files, 34 design/spec docs, a 128-entry decision log.
- **Status:** Core assess→report→roadmap→re-assess loop is complete and wired end-to-end.

### Feature inventory

| Area | Feature | Class | Evidence |
|---|---|---|---|
| Scoring | Deterministic DRS/ORI engine | **Complete** | `shared/scoring/engine.ts`, ports `seed/fixtures/reference_scorer.py`; `tests/engine.test.ts` asserts fixture parity |
| Scoring | Results + explain + interpretation | **Complete** | `ResultsPage.tsx`, `server/scoring.ts explainAssessment`, `shared/scoring/interpret.ts` |
| Assessment | Intake (all answer types, save/resume, provenance) | **Complete** | `IntakePage.tsx`, `src/lib/answerFields.tsx`, `answer_provenance` |
| Assessment | Scenario workbench (client-side what-if) | **Complete** | `WorkbenchPage.tsx` (byte-identical `explainFromAnswers`) |
| Engagement | Create company + engagement + agreement + consent | **Complete** | `DashboardPage.tsx:328-347`, `server/agreements.ts`, DB gate trigger |
| Engagement | Portfolio dashboard (delta, stale, sparkline) | **Complete** | `DashboardPage.tsx`, `src/lib/portfolio.ts` (+8 tests, cross-rubric guard) |
| Reports | Owner report (Claude **or** deterministic composer) + edit + PDF | **Complete** | `ReportPage.tsx`, `server/narrative.ts`, `server/pdf.ts` |
| Reports | Delta report, CIM | **Complete** | `DeltaReportPage.tsx`, `CimPage.tsx`, `render-*-pdf` |
| Roadmap | Gap→playbook task instantiation, 90-day sprints, manual tasks | **Complete** | `RoadmapPage.tsx`, `server/roadmap.ts`, `src/lib/practitioner.ts` |
| Valuation | Recast EBITDA × multiple, value/wealth gaps | **Complete** | `ValuationPage.tsx`, `server/valuation.ts` (deterministic) |
| Advisory | Buyer lens / library (CRUD, adapt, activate) | **Complete** | `BuyerLensPage.tsx`, `LibraryPage.tsx`, `server/advisory.ts` |
| Evidence | Data room readiness (37-item template) | **Complete** | `DataRoomPage`→`EvidencePage.tsx`, `server/data-room.ts` |
| Evidence | Document upload + manual review queue | **Mostly Complete** | `DocumentsPage`, `ReviewQueuePage`, `server/documents/*` — manual path only (see below) |
| Evidence | Verification / self-reported-vs-verified reconciliation | **Mostly Complete** | `VerificationPage.tsx`, `server/sellside.ts`, `server/review-queue.ts` |
| Owner portal | Home / plan / learn / documents / connect | **Complete** | `src/pages/owner/*` — all wired to live hooks |
| Financials | QuickBooks/Xero connect + sync | **Partial** | `server/ledger-oauth.ts`, `server/ledger.ts:51` — dev adapter/synthesized tokens unless provider apps configured; fills 6/10 inputs |
| Docs pipeline | Automated parsing/extraction | **Stub** | `server/documents/parser.ts:66-78` reducto/llamaparse **throw**; only Manual/Fixture adapters |
| Docs pipeline | Object storage + virus scan | **Stub** | `server/documents/storage.ts:53` throws for non-DB; `pipeline.ts:65` scan is a stub |
| Sell-side | score/match_findings/assemble/deliver pipeline steps | **Stub** | `server/pipeline/steps.ts:304-307` `NotImplementedError` (findings run standalone via `findings/run.ts`) |
| Billing | Stripe checkout/portal + entitlement gate | **Mostly Complete** | `server/stripe.ts`, `server/entitlements.ts` — gate is **default-off** (`BILLING_ENFORCED`) |
| Provisioning | Firm / advisor / agreement creation | **CLI-only** | `scripts/admin.ts` — no admin UI |
| Legal | Terms / Privacy / DPA | **Prototype** | `src/pages/legal/content.ts` — ~30 `COUNSEL_TODO`, `lastUpdated` unset |
| Security | MFA, encryption-at-rest, signed URLs, audit log, idle timeout | **Complete** | `src/lib/mfa.ts`, `server/documents/crypto.ts`, `server/audit.ts` |
| Ops | n8n continuous-eval webhooks (stale/stalled/re-assess) | **Complete** | `server/scheduled.ts` (read-only, shared-secret, cross-firm by design) |
| Calibration | Deal-outcome capture (prediction↔reality) | **Complete (capture)** | `server/outcomes.ts`; prediction-vs-actual *comparison UI* deliberately removed |

---

## Phase 2 — Advisor Journey (mapped to the real product)

The generic advisor lifecycle maps onto: **provision → create engagement → intake →
financials → score → results → report → roadmap → evidence/verify → re-assess/delta → ongoing.**

| Stage | Verdict | Note / blocker |
|---|---|---|
| Firm/advisor onboarding | **Blocked (self-serve)** | `scripts/admin.ts` CLI + Clerk secret only; a developer must onboard each firm/advisor. Fine for a *vendor-provisioned* pilot; blocks open beta. |
| First login | **Works** | Clerk `<SignIn>` (prod) / dev emulator (local); MFA gate on staff. |
| Create engagement + company | **Works** | In-UI (`AddEngagementDialog`): pick/add company, accept agreement, capture consent → lands in engagement. Firms auto-seeded a default agreement on provisioning. |
| Invite owner | **Works** | `server/invite.ts` → Clerk org invitation + provisioning webhook. |
| Assessment intake | **Works** | Zero-friction intake, save/resume, unit affixes, "not tracked" toggles. |
| Financials | **Works-with-friction** | Manual entry fully works; "Import from QuickBooks" is a dev stand-in unless provider apps are configured, and covers only 6/10 inputs. Advisor must know the numbers. |
| Scoring → results | **Works** | Submit triggers deterministic scoring; results explain "why is this a 61". |
| Narrative report + PDF | **Works** | Auto-generates on first visit (composer if no API key), edit-before-finalize, branded PDF. |
| Roadmap | **Works** | Gap→task instantiation, editable due dates, sprints, manual tasks, catch-up for in-flight engagements. |
| Evidence / documents / verify | **Works-with-friction** | Upload + manual field review works; **no automated extraction** — every datapoint is hand-verified. |
| Re-assessment + delta | **Works** | Supersede pattern, same-rubric deltas, explicit "new rubric" incomparable marker. |
| Ongoing / continuous eval | **Works (needs n8n)** | Endpoints exist; the schedule lives in an external n8n instance this repo doesn't contain. |

**Top journey blockers:** (1) provisioning is CLI-only; (2) live financial verification is not
real; (3) automated document extraction is absent; (4) legal agreements are drafts.

---

## Phase 3 — Workflow Validation

The primary loop (**intake → score → results → report → roadmap → re-assess**) completes with
real persistence, validation (completeness gate at submit), loading/empty/error states, toasts,
audit logging (`data_access_log`), and correct permissions at every hop (`authorize()` resolves
firm from profile, never the body). **State management** is TanStack Query with a central key
registry and precise invalidation (`src/lib/queries.ts`). **Immutability** is DB-enforced:
completed assessments and their scored children reject UPDATE/DELETE on the untrusted JWT path
(`migrations/20260718000200`). Workflows that **cannot** complete unaided: automated financial
ingestion and document extraction (both seamed to manual), and the sell-side
score/assemble/deliver pipeline steps.

---

## Phase 4 — UI/UX

Genuinely **beta-grade to polished**, not rough. A token-driven design system
(`docs/26`, `src/components/ui`), composition spine (`PageSection`), consistent eyebrow labels,
tabular numerals, and a deliberate "institutional register" pass. Empty states distinguish
"empty book" from "filters excluded everything" (`DashboardPage.tsx:150-179`). Loading/error via
`LoadingState`/`ErrorState`; `DataTable` has `aria-sort` and keyboard support. Format helpers
prevent raw `snake_case`/integers leaking to the UI (`humanizeKey`, `formatFieldValue`).
Weak spots: dense domain vocabulary (DRS/ORI/CEPA gates) with limited first-run onboarding for a
brand-new advisor, and desktop-first density on some engagement tables.

---

## Phase 5 — Reliability

- **Tests:** local run **191 passed / 60 skipped** (skipped = DB-integration, need live Postgres).
  10 *suite* failures were **environment-only** — a broken `stripe` ESM install
  (`stripe/esm/apiVersion.js` missing) and a missing `@opentelemetry/instrumentation` transitive —
  **not product defects**; the decision log records 225+ green in proper CI with a DB.
- **Stubs (all cleanly seamed and loudly labeled, not silent):** parser adapters throw
  (`parser.ts:66`), non-DB storage throws (`storage.ts:53`), virus scan stub (`pipeline.ts:65`),
  live-OAuth `TODO` (`ledger.ts:51`), pipeline back-half `NotImplementedError` (`steps.ts:304`).
- **No rot:** only 8 intentional `console` calls in `src/`; no swallowed catch blocks; analytics
  are deliberately fire-and-forget.
- **Watch items:** synchronous PDF (headless Chromium) and LLM calls in the request path;
  data-URL logo storage; dependency fragility (Stripe/Sentry ESM) surfaced above.

---

## Phase 6 — Production Readiness

| Area | Verdict | Evidence |
|---|---|---|
| Authentication | **Adequate** | Clerk JWT verified via JWKS + HS256 (`server/auth-jwt.ts`); dev emulator gated by unset `VITE_CLERK_PUBLISHABLE_KEY` (`isDevStack`), never bundled in prod. |
| Authorization / tenancy | **Solid** | Per-scope `authorize()` gateway; RLS on every domain table; `scripts/rls-test.ts` (70+ assertions) is the regression gate; firm resolved from profile. |
| Data integrity | **Solid** | Immutable snapshots (triggers), rubric-in-data, `rubric_version`/`prompt_version`/`playbook_version`, reference-scorer parity in CI. |
| Billing | **Adequate** | Signature-verified webhook, entitlement resolver; **enforcement default-off** — correct for comped beta, unproven under real dunning. |
| Config / deploy | **Adequate** | `render.yaml` + `vercel.json` + `docs/archive/11-14`; three runtime pieces (Vercel/Supabase/Render); env matrix documented; `EB_DOCUMENT_KEY` prod warning. |
| Observability / audit | **Adequate** | Sentry wiring, `/health`, append-only `data_access_log`. |
| Recovery / backup / scale | **Weak/Unproven** | Relies on Supabase managed backups; no documented restore drill; no load test; synchronous compute path untested at volume. |

---

## Phase 7 — Advisor Experience Scores (1–10)

| Area | Score | Justification |
|---|---|---|
| Advisor usability | **7** | Core flows intuitive and well-composed; dense vocabulary, thin first-run onboarding. |
| Workflow completeness | **7** | Full assess→report→roadmap→re-assess loop; edges (ingest, self-serve) incomplete. |
| Reliability | **7** | 191 pure tests green + DB-enforced invariants; env-fragile deps, stubbed integrations. |
| Performance | **7** | Code-split, cached, tabular; sync PDF/LLM in request path is a scaling watch. |
| UX quality | **8** | Real design system, consistent states, institutional polish. |
| Feature completeness | **6** | Broad, but several headline features are seams/stubs (ledger, parser, pipeline). |
| Data integrity | **9** | The standout — immutability, versioning, rubric-in-data, reference parity, RLS. |
| Error handling | **7** | Real `ErrorState`/toasts, unwrapped edge errors, fail-open MFA; some silent analytics. |
| Maintainability | **9** | Patterns doc + templates + registry + pure-module/fixture tests + decision log. |
| Beta readiness | **6** | Yes for a controlled comped pilot; no for open self-serve. |
| Production readiness | **5** | Auth/RLS/billing/observability built but partly configured-not-proven; legal draft; manual provisioning. |

---

## Phase 8 — Critical Blocking Issues

| # | Issue | Priority | Effort | Evidence |
|---|---|---|---|---|
| 1 | No self-serve/admin provisioning — firms, advisors, agreements are CLI + Clerk secret only | **Critical** (open beta) / High (pilot) | **L** | `scripts/admin.ts` |
| 2 | Legal agreements are `COUNSEL_TODO` drafts — cannot be relied on as binding | **Critical** | **M** (counsel-gated) | `src/pages/legal/content.ts` |
| 3 | Live financial verification is a dev stand-in; QB/Xero sync fills 6/10 inputs | **High** | **L–XL** | `server/ledger.ts:51`, `ledger-oauth.ts` |
| 4 | Automated document extraction absent — every field hand-verified | **High** | **XL** | `server/documents/parser.ts:66-78` |
| 5 | Billing enforcement unproven (default-off); no dunning/read-only cutover exercised | **Medium** | **M** | `server/entitlements.ts`, `BILLING_ENFORCED` |
| 6 | No restore drill / load test; sync PDF+LLM in request path | **Medium** | **M** | `server/pdf.ts`, `server/narrative.ts` |
| 7 | Dependency fragility (Stripe/Sentry ESM) breaks a clean install's suite | **Medium** | **S** | local run: `stripe/esm/apiVersion.js`, `@opentelemetry/instrumentation` |
| 8 | Sell-side pipeline back-half stubbed (score/assemble/deliver) | **Low** (findings run standalone) | **L** | `server/pipeline/steps.ts:304-307` |
| 9 | External n8n schedule not in-repo; continuous-eval nudges need that wiring | **Low** | **S** | `server/scheduled.ts` |

---

## Phase 9 — Missing Functionality (expected in a modern advisor platform)

- **Firm admin console** (invite/manage advisors, seats, roles) — today CLI-only; blocks scaling
  beyond hand-provisioned firms. *Recommend:* thin settings-scoped admin UI over the existing
  Clerk org + `profiles` model. **Priority: High.**
- **Real accounting integration** (Intuit/Xero apps live, full field coverage + refresh) — the UI
  promises "connect QuickBooks"; reality is a stand-in. *Recommend:* implement `pullLedgerFinancials`
  behind the existing seam, register the apps. **Priority: High.**
- **Automated document intelligence** (a real `ParserAdapter`, e.g. reducto/llamaparse) — manual
  review does not scale a diligence binder. **Priority: Medium.**
- **In-app scheduling/notifications** — nudges depend on an external n8n not in this repo; there is
  no in-product task/reminder surface. **Priority: Medium.**
- **Finalized legal + self-serve data export/purge** (named in `docs/16` as roadmap). **Priority: High.**
- **Backup/restore runbook + a load test** before real client data lands. **Priority: Medium.**

---

## Phase 10 — Final Verdict

- **Can one advisor use it today?** **Yes** — provided the vendor provisions their firm/advisor/agreement
  and they accept manual financial entry. The core engagement runs start-to-finish in the UI.
- **Can ten advisors use it?** **Technically yes** (multi-tenant, RLS regression-tested), but each firm
  is hand-provisioned and there is no admin console — operationally strained, not blocked.
- **Internal beta?** **Yes — launch it.** The core is solid and observable.
- **Customer beta?** **Yes, controlled** — a comped, hand-held pilot of ~5–15 firms. **Not** open self-serve.
- **Would you run your own advisory business on it?** **Nearly.** The scoring/data core is trustworthy
  today; what's missing is legal finalization, real financial verification, and self-serve operations.
- **What's preventing "fully yes":** blockers #1–#4 above.

**Maturity:** **Early Beta.** **Completion ≈ 72%** toward a self-serve beta; **≈ 85%** toward a
vendor-operated comped pilot.

### Roadmap to a stable beta

1. **Legal finalize** (blocker #2) — replace `COUNSEL_TODO`; wire acceptance/versioning. *[counsel + S]*
2. **Firm admin console** (#1) — invite advisors, seats, roles over the Clerk org model. *[L]*
3. **Live QuickBooks/Xero** (#3) — implement the pull seam + register apps; widen field coverage. *[L–XL]*
4. **Billing dry-run** (#5) — turn `BILLING_ENFORCED` on in staging; exercise dunning/read-only. *[M]*
5. **Ops hardening** (#6, #7) — pin/repair Stripe+Sentry deps; restore drill; a basic load test;
   move PDF/LLM off the request path (queue) if p95 warrants. *[M]*
6. **Document extraction** (#4) — a real `ParserAdapter` once manual-review volume justifies it. *[XL]*
7. **Package the pilot** — controlled-beta runbook (`docs/archive/25`) + in-repo n8n flow definitions (#9). *[S]*

Items 1–2 unblock a credible **customer** beta; 3–5 make it dependable for daily use; 6–7 scale it.
