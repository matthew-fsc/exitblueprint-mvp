# 05 - Build Plan / Roadmap

Rule: one session = one slice = one commit. Each slice ends with its acceptance
criteria demonstrated and a one-line entry in `docs/06-decisions.md` if a decision
was made. Do not scaffold ahead of the current slice.

> **Status (2026-07):** Phases 1–4 (the original S1–S15 MVP) are **all shipped**,
> and the product has moved well past the original plan — CIM generation, document
> upload + verification/review queue, valuation & comparables, ledger OAuth, MFA,
> external collaborators, entitlements, and observability all exist. The active
> work is **production hardening and beta launch** (Phase 5 below). The historical
> MVP slice list is kept at the bottom for provenance, corrected where the shipped
> reality diverged from the original wording (auth is **Clerk**, not Supabase Auth;
> the advisor brief shipped as **`delta_report.v1`**, not `advisor_brief.v1`).

## Where the source of truth now lives

The roadmap is no longer a greenfield S1→S15 walk. Current direction lives in the
purpose-built docs; this file just orients and tracks the remaining slices.

| Concern | Authoritative doc |
| --- | --- |
| Identity / auth (Clerk) | `docs/30-clerk-cutover-runbook.md` |
| Billing (Stripe) + production readiness plan | `docs/24-production-readiness-clerk-stripe.md` |
| Live deployment (exitblueprint.net) | `docs/29-exitblueprint-net-golive.md` |
| Environment variables | `.env.example` (canonical) + `docs/14-environment-keys.md` |
| Observability | `docs/32-observability.md` |
| Data model / scoring / methodology | `docs/02`, `docs/03`, `docs/07` |
| How to add a feature | `docs/27-engineering-patterns.md` + `templates/` |
| System at a glance | `docs/28-architecture-map.md` |
| Beta readiness snapshot (2026-07) | `docs/archive/35-beta-readiness-assessment-2026-07.md` |

## Phase 5 - Production hardening & beta launch (current)

These are the remaining slices before a comped beta can run without developer
involvement. They come from the open items surfaced in docs 24 / 29 / 32 and the
`[ratify]` / "draft, pending counsel" markers still in the codebase.

**P5.1 Billing enforcement path.** Stripe checkout, billing portal, entitlements,
and the gate all exist (`server/stripe.ts`, `server/entitlements.ts`) but run with
`BILLING_ENFORCED` off (comped beta). Slice: verify the enforced path end to end
(checkout → webhook → entitlement → gate refuses/permits) against a Stripe test
account, and document the flip in `docs/24`.
Accept: with `BILLING_ENFORCED=true` a non-entitled firm gets 402 on gated
functions; an entitled/comped firm passes.

**P5.2 Backups & recovery.** Enable Supabase scheduled backups + PITR on the
production project and write the restore runbook (the TODO in `docs/08` §Backups).
Accept: a documented, tested restore procedure exists before the first live client.

**P5.3 Legal & trust content sign-off.** The legal pages render "draft, pending
counsel" and `docs/08`'s data-handling one-pager carries `[ratify]` markers.
Slice (Matthew-owned): ratify the data-handling language and legal pages, then
drop the draft banners.
Accept: no user-facing page renders a "draft/pending counsel" banner in production.

**P5.4 Subprocessor & security-doc reconciliation.** The subprocessor register
(`seed/subprocessors.csv`, surfaced by `docs/13` and `docs/16`) predates the Clerk
+ Stripe + Render migration: it still lists Supabase for "authentication" and
Vercel for "compute," and omits **Clerk** (identity/MFA), **Render** (compute),
and **Stripe** (billing). Slice (Matthew-owned, customer-facing): reconcile the
register and the `docs/13`/`docs/16` security responses to the real vendor set.
Accept: `docs/13`, `docs/16`, and `seed/subprocessors.csv` name the same,
currently-accurate subprocessors.

**P5.5 Open security items.** Track the 🟡 items in `docs/16` to closure or an
explicit "post-beta" decision: SOC 2 path, penetration test, BCP test cadence,
breach-notification clause.
Accept: each open item is either closed or has a dated owner + target in `docs/16`.

## Later (not scheduled)

- **Accounting integration (owner self-serve).** Ledger OAuth is built server-side
  (`server/ledger-oauth.ts`), but the owner `/portal/connect` route is deliberately
  disabled (redirects to `/portal`) — "not offered yet." Promote when there's
  demand.
- Benchmarking analytics across firms, white-label theming, firm-admin console
  beyond the current platform-admin surface, external financial-data ingestion.
- Decision point on outside engineering help (e.g. real-time analytics) sits after
  meaningful assessment volume exists.

---

## Appendix — original MVP slice list (S1–S15, all shipped)

Kept for provenance. Every slice below is done; the "reality" column records where
the shipped implementation diverged from the original wording.

### Phase 1 — Foundation and scoring
- **S1. Repo + Supabase scaffold** — done. Vite/React/TS, migrations, health page.
- **S2. Schema migration + RLS** — done. Full schema + firm-isolation RLS test.
- **S3. Seed pipeline** — done. Idempotent seed of rubric/playbooks/content.
- **S4. Scoring engine + tests** — done. `shared/scoring/engine.ts` reproduces the
  `reference_scorer.py` fixtures exactly.

### Phase 2 — Intake and report (MVP)
- **S5. Auth + advisor shell** — done. **Reality: identity is Clerk** (RLS validates
  Clerk JWTs via JWKS), not the "Supabase auth email login" originally written, and
  a platform-admin surface now exists (`server/platform-admin.ts`).
- **S6. Assessment intake flow** — done.
- **S7. Score views** — done. DRS + ORI + composite shown distinctly.
- **S8. Narrative service + owner report** — done. `owner_report.v1`, numeral
  post-check, edit-before-finalize, PDF export.

### Phase 3 — Roadmap and advisor workspace
- **S9. Roadmap generator + task board** — done.
- **S10. Advisor dashboard** — done. Portfolio, deltas, stalled tasks.
- **S11. Advisor brief generation** — done. **Reality: shipped as `delta_report.v1`**
  (`prompts/delta_report.v1.md`, `DeltaReportPage.tsx`), not `advisor_brief.v1`.
- **S12. n8n webhook endpoints** — done (`server/scheduled.ts`).

### Phase 4 — Owner portal and education
- **S13. Owner auth + portal** — done (`src/pages/owner/*`, `/portal/*`).
- **S14. Content drip** — done. **Reality: shipped as "advisory education"**
  (`server/advisory.ts`, `education-modules`), not the `gap_content_map`/`drip_order`
  naming originally specced.
- **S15. Re-assessment + trend view** — done.

**MVP checkpoint (met):** an advisor can complete an intake and hand a client a
scored readiness report the same day, with no developer involvement.
