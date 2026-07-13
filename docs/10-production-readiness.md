# Production Readiness Plan
**Snapshot basis:** system audit dated 2026-07-13 (post PR #16–#21), see
`audit/STATE_OF_THE_SYSTEM.md`. **Goal:** run for one real, paying customer —
one real advisor and one real business owner — with no faked steps in their
path. **Team assumption:** 1–2 engineers, already familiar with the codebase.
**Optimization:** fastest safe path to customer #1, not full GA.

---

## How to read this

The audit's own punch list (§8) is the right set of items — this plan just
sequences it by dependency, cuts it down to what customer #1 actually needs, and
pushes everything else to "after launch." Two items are non-negotiable and on the
critical path (deploy the compute layer, real auth). Everything else is either
fast-and-cheap (do it anyway) or slow-and-external (start now, don't wait on it).

## Definition of done for "first paying customer"

A launch is real if all of these are true — no exceptions, no "it's fine for now":

- Frontend talks to a real Supabase project (`VITE_SUPABASE_URL` points at prod, not the dev emulator).
- Every `/functions/v1/*` call is served by deployed code, not Vite middleware.
- Login uses real Supabase Auth — no hard-coded dev password, no hard-coded JWT secret.
- Owner invites send a real email (magic link or `inviteUserByEmail`) — no `auth.users` insert with a printed dev password.
- The customer's financials are either (a) real QuickBooks/Xero data via a completed OAuth exchange, or (b) manually entered/uploaded data that is labeled as such in the UI. Never the hard-coded `DEFAULTS` block presented as "connected."
- Errors are visible to you (basic monitoring), and the database has automatic backups turned on.
- A deploy is a repeatable, scripted step — not a manual one you'll forget.

Anything short of this list is still a demo, however convincing.

---

## Phase 0 — Decisions before writing code (0.5–1 day)

Two architectural calls block Phase 1 and are cheap to get wrong if skipped:

1. **Compute layer target: Supabase Edge Functions vs. a small Node service.** Edge Functions (Deno) are the natural home for the scoring engine, valuation logic, ledger-oauth, and invite endpoints — they're pure/stateless. `server/pdf.ts` uses `playwright-core`, which needs a real Chromium binary; that's a poor fit for an edge runtime. Recommendation: Edge Functions for everything except PDF generation, which gets its own small Node service (Fly.io, Render, or Railway all work) that the Edge Functions call internally. This avoids re-architecting PDF rendering under time pressure.
2. **Ledger data for customer #1: wait on live QuickBooks/Xero, or ship manual entry first?** Getting a production Intuit/Xero app approved is an external process (see Phase 3) that can take 1–4 weeks and isn't in your control. Recommendation: don't block launch on it. Ship a manual/CSV financial entry path labeled `verified: manual` instead of the current fake `connected_ledger` simulation, and treat live OAuth as a fast-follow once Intuit approves the app.

Write these two down as decisions, then move on — don't let them become open-ended design docs.

---

## Phase 1 — Deploy the compute layer (critical path, ~6–9 engineer-days)

This is the item that determines whether the product exists outside the demo. Nothing else matters until this is done.

| Task | Effort | Notes |
|---|---|---|
| Stand up real Supabase project, run all 15 migrations against it | 0.5–1 day | Reuse existing migration scripts as-is; this is the easy part. |
| Re-run `scripts/rls-test.ts` (44 checks) against the real project | 0.5 day | Proves the RLS story holds outside the emulator — do not skip. |
| Port scoring engine + valuation endpoints to Edge Functions | 1–2 days | Pure functions, deterministic, already fixture-tested — lowest risk of the batch. |
| Port `ledger-oauth.ts` (begin/complete/disconnect) as Edge Functions | 1 day | Keep the dev-simulation path behind a flag for staging/demo use — don't delete it, gate it. |
| Port `invite.ts` as an Edge Function calling real Supabase Auth | 0.5 day | Depends on Phase 2 auth being wired first, or do together. |
| Port `narrative.ts` (rule-based + Claude path) as an Edge Function | 0.5 day | Both paths already exist in code; this is just relocation. |
| Stand up the PDF microservice (Node + Playwright + Chromium) | 1–2 days | New deployable, needs its own Dockerfile/buildpack with Chromium deps. |
| Wire frontend to real function URLs, remove Vite-middleware dependency for prod builds | 1 day | Confirm `dev/supabase-dev-server.ts` is dev-only and never reachable in the prod build. |

**Exit criteria:** every button in the app that currently hits the dev emulator hits a deployed function instead, against the real Supabase project.

---

## Phase 2 — Real auth and real invites (~2–3 engineer-days, can overlap Phase 1's tail)

- Point `src/lib/auth.tsx` (already real `supabase.auth` code) at the real project; remove the dev emulator's fixed password and hard-coded JWT secret from anything that ships.
- Configure Supabase Auth email templates and an SMTP provider (Supabase's built-in email works for low volume; Postmark/Resend if you want deliverability control later).
- Replace `invite.ts`'s direct `auth.users` insert with `inviteUserByEmail` or a magic-link flow.
- Manually walk through: advisor signs up → creates owner → owner receives real email → owner logs in with their own credentials → RLS still restricts them to their own firm/company. This is the single most important manual test in the whole plan.

**Exit criteria:** you can create a brand-new owner account today, by email, with no password you typed in for them.

---

## Phase 3 — Minimum real integrations (~1–2 engineer-days now, rest is external waiting)

- **AI narrative:** provision `ANTHROPIC_API_KEY` in the deployed function's environment, add one live smoke test. This is a half-day win — do it early, it's the cheapest way to turn a "simulated" row green.
- **Ledger financials — manual path:** build (or repurpose existing intake UI for) a manual entry/CSV upload flow that stamps `verified: manual`, replacing the current fake `DEFAULTS` fallback. This unblocks launch without waiting on Intuit/Xero.
- **Ledger financials — real OAuth (parallel-track, not blocking):** start the QuickBooks and/or Xero production app registration *today* — this is pure external lead time (developer account verification, app review) that can run 1–4 weeks in the background while Phases 1–4 happen. When approval lands: set the real env vars, and the existing `ledger-oauth.ts` token exchange/refresh/revoke code should mostly work as written — budget 2–3 days to actually test it against a live provider and fix whatever the sandbox didn't catch.

**Exit criteria:** customer #1's financials in the app are either real numbers they typed/uploaded, or real numbers pulled from their actual ledger — never the hard-coded defaults.

---

## Phase 4 — Minimum viable ops (~3–4 engineer-days, parallelizable with Phase 3)

| Task | Effort |
|---|---|
| Pick hosting: Supabase (DB/auth/functions) + Vercel or Netlify (frontend static) + Fly.io/Render (PDF service) | 1 day setup |
| Secrets into hosting provider env vars; confirm nothing is committed or logged | 0.5 day |
| Minimal error monitoring (Sentry or equivalent) on frontend + functions + PDF service | 0.5–1 day |
| Confirm Supabase backup/PITR is enabled on your plan tier | 0.5 day |
| Custom domain + SSL | 0.5 day |
| Add a deploy stage to existing CI (today's pipeline is migrate → RLS test → seed → tests → build, with nothing after) | 1 day |

**Exit criteria:** a `git push` to main results in a deployed change without anyone doing anything by hand, and if something breaks at 2am you find out from Sentry, not from the customer.

---

## Rough timeline

With 1–2 engineers working Phases 1–4 roughly in the order above (Phase 3's AI and manual-ledger pieces and Phase 4 can run alongside Phase 1's tail and Phase 2):

- **Week 1–2:** Phase 1 (deploy compute layer) + Phase 2 (real auth/invites).
- **Week 2–3:** Phase 3 (AI key + manual ledger path) + Phase 4 (hosting/monitoring/backups/CI deploy), in parallel.
- **~3 weeks to a defensible "running for one real customer" state**, assuming no surprises in the PDF service deploy or Supabase Auth email deliverability (the two most likely sources of a lost day or two).
- **QuickBooks/Xero live OAuth** lands whenever Intuit/Xero approval comes back — started week 1, likely lands weeks 3–6, does not block the above.

---

## Deliberately deferred (do not let these creep into the critical path)

- Live QuickBooks/Xero token exchange testing (blocked on external approval; code is already shaped for it per the audit).
- n8n webhook endpoints — build only when a specific scheduled workflow is actually needed, not speculatively.
- Browser/E2E test suite gated in CI — valuable, but the 83 existing tests + RLS checks are enough to launch on.
- Rate limiting / CSRF hardening beyond the existing OAuth state param.
- Formal accessibility audit.
- Numeric input formatting/validation polish (EV/EBITDA fields).
- Full GA multi-integration support — this plan gets you one customer running for real, not every integration built.

---

## Decisions Matthew needs to make (flagging, not deciding for you)

1. Confirm the Edge Functions + separate Node PDF-service split (Phase 0, item 1) — or say if there's a reason to keep everything in one runtime.
2. Confirm it's acceptable to launch customer #1 on manual/CSV ledger entry while live QuickBooks/Xero is still in provider review.
3. Pick an email provider for auth/invite emails (Supabase built-in vs. Postmark/Resend) — affects deliverability, not a blocker either way for launch.

## Immediate next 5 actions

1. Stand up the real Supabase project and run the 15 migrations against it.
2. Start the QuickBooks and Xero production app registrations today (external clock, zero cost to start early).
3. Decide and scaffold the PDF microservice's hosting target.
4. Port the scoring/valuation endpoints to Edge Functions first — lowest risk, builds momentum, and is fixture-tested already.
5. Provision `ANTHROPIC_API_KEY` in a real environment and flip the AI narrative path on — cheapest win on the list.

---

## Execution log (what has actually been done against this plan)

- **2026-07-13 — Phase 1 foundation (decision-independent):** extracted the
  function dispatch + authorization out of the Vite dev plugin into a portable
  module (`server/functions.ts`), so the exact same authorize→dispatch logic can
  be mounted by the dev emulator today and by a real production host (Edge
  Functions or a Node service) unchanged. This is the prerequisite step of "port
  the compute layer" and does not prejudge the Phase 0 runtime decision. Verified:
  full test suite + RLS + a live round-trip through the refactored dev emulator.
