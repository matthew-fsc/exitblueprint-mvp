# Path to Production v2 — Clerk auth, Stripe billing, and the remaining gaps

**Basis:** re-baseline of `docs/10-production-readiness.md` after PRs #16–#39.
**What's new since docs/10:** two decisions taken by Matthew (2026-07-18) move the
target beyond docs/10's "one real paying customer" line:

1. **Auth → Clerk** as the identity provider, integrated via **Supabase
   third-party auth** so the existing RLS model is preserved (not replaced).
2. **Billing → Stripe**, **per-firm subscription + seats** (the advisor firm is
   the paying customer). Billing was `out of scope` in CLAUDE.md until now; this
   request brings it in.

This document defines *what "production ready" means* against today's real state,
inventories every gap, and specs the Clerk and Stripe workstreams concretely.
Implementation proceeds in confirmed slices after this plan is blessed.

> **CLAUDE.md impact (do when Clerk lands, not before):** the stack line "Supabase
> (Postgres, Auth, RLS, Storage)" becomes "Supabase (Postgres, RLS, Storage) +
> Clerk (Auth)", and rule 5's isolation story gains "identity is Clerk; RLS
> validates Clerk JWTs via JWKS." Rules 1–4 and 6 are untouched. No scoring,
> rubric, or AI-layer change anywhere in this plan.

---

## 1. Current state (re-baseline — what is actually real today)

| Area | State today | Source |
|---|---|---|
| Compute layer | **Shipped.** `server/http.ts` serves every `/functions/v1/*` against real Postgres via service role, enforcing RLS through `asUser`. PDF in-process. Dockerized. | docs/10 execution log |
| Token verification | Already dual-mode: HS256 (`FUNCTIONS_JWT_SECRET`) **or asymmetric JWKS** (`makeVerifyToken({ jwksUrl })`). | `server/http.ts`, `server/auth-jwt.ts` |
| Auth | Supabase Auth. `src/lib/auth.tsx` = real `supabase.auth`; idle-timeout + MFA (TOTP/AAL2) gate for staff. Dev stack uses a fixed password. | `src/lib/auth.tsx`, `src/lib/mfa.ts` |
| Multi-tenancy | RLS on all tables, deny-by-default. Three security-definer helpers `app.user_role/user_firm_id/user_company_id` key on `auth.uid() = profiles.user_id`. **72 RLS checks** in `scripts/rls-test.ts`. | `20260707000200_rls.sql` |
| Identity column | `profiles.user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id)`. `usage_events.actor_user_id uuid`. | `20260707000100_schema.sql` |
| Invites | `server/invite.ts` inserts directly into `auth.users` (dev shortcut). Marked "PRODUCTION: replace with real invite." | `server/invite.ts` |
| Financials | Honest: manual/CSV entry stamped `document`/`self_reported`; the fake `DEFAULTS` was removed. Live QuickBooks/Xero OAuth is a shaped-but-unwired seam. | docs/10 log |
| Migrations | **23** applied cleanly in CI. | `supabase/migrations/` |
| CI | `ci.yml`: migrate → RLS test → seed ×2 → vitest → eval → build. **No deploy stage. No E2E.** | `.github/workflows/ci.yml` |
| Billing | **None.** No Stripe, no plans, no entitlements, no seat limits. | — |
| Ops | No error monitoring, no deploy automation, no documented backups/PITR, no custom domain wired. | docs/10 Phase 4 (open) |

**Net:** the engine, data model, RLS, and compute service are production-grade.
The gaps are (A) swapping the identity provider to Clerk, (B) building billing
from zero, and (C) the ops/observability/legal layer that docs/10 Phase 4 left open.

---

## 2. Definition of "production ready" (extends docs/10's DoD)

docs/10's checklist still holds. This plan adds:

**Auth (Clerk)**
- Login, signup, password reset, and MFA are all handled by Clerk — no dev
  password, no direct `auth.users` writes anywhere in the shipped path.
- Supabase RLS validates Clerk-issued JWTs via Clerk's JWKS; a foreign-firm read
  still returns 0 rows / 404 (the 72 RLS checks pass against Clerk-shaped `sub`).
- A brand-new firm can self-serve or be invited, get an owner invited by email,
  and each lands in the correct firm/company with the correct role — no manual DB.

**Billing (Stripe)**
- A firm cannot use paid features without an active subscription (enforced
  **server-side** in the authorize path, not just hidden in the UI).
- Every Stripe webhook is signature-verified and idempotent; subscription state
  in our DB always reconciles to Stripe (Stripe is the source of truth for money,
  our DB is the cache the app reads).
- Seat count is enforced at invite time; an over-limit invite is refused with a
  clear upgrade path.
- A failed payment moves the firm to a defined grace/read-only state, not a hard
  lockout mid-engagement, and self-serve card update via the Stripe billing portal
  restores access.

**Ops / trust**
- Errors surface to Sentry (frontend + Node service). Backups/PITR confirmed on.
- `git push` to main deploys without manual steps. Custom domain + SSL.
- ToS, Privacy Policy, and a DPA exist and are linked (selling to businesses about
  their financials — table stakes for the vendor-DD posture in docs/15/16).

---

## 3. Gap inventory (everything between here and the DoD)

Severity: **P0** = blocks launch · **P1** = launch-week · **P2** = fast-follow.

### A — Identity / Clerk  (full design in §4)
- **A1 (P0)** Configure Supabase third-party auth to trust Clerk (JWKS).
- **A2 (P0)** Migration: `profiles.user_id` uuid→text; `usage_events.actor_user_id`
  uuid→text; drop `auth.users` FK; rewrite the 3 `app.user_*` helpers to read
  `auth.jwt()->>'sub'`; keep every policy that calls them unchanged.
- **A3 (P0)** Frontend: `@clerk/clerk-react` + `ClerkProvider`; rewrite
  `src/lib/auth.tsx` to source session/JWT from Clerk; map Clerk org → `firm_id`,
  org role → app role.
- **A4 (P0)** Server: point `makeVerifyToken` JWKS at Clerk; map claims
  (`sub`, `org_id`, org role) into `Claims`; feed `asUser`.
- **A5 (P0)** Invites: replace `invite.ts`'s `auth.users` insert with Clerk
  **organization invitations**; profile row is provisioned on first authenticated
  request (or via Clerk webhook `user.created`/`organizationMembership.created`).
- **A6 (P1)** MFA: retire `src/lib/mfa.ts` + the Supabase AAL gate; enforce MFA
  as a **Clerk org/session policy** instead. `RequireAdvisor`'s security gate
  collapses to "Clerk says MFA satisfied."
- **A7 (P1)** Update `scripts/rls-test.ts` harness to mint Clerk-shaped JWTs
  (text `sub`) so all 72 checks prove isolation under the new identity.
- **A8 (P2)** Data migration for existing accounts (today: dev/seed only → trivial;
  documented in case a real Supabase-Auth prod exists at cutover).

### B — Billing / Stripe  (full design in §5)
- **B1 (P0)** Migration: `plans`, `firm_subscriptions`, `billing_events`
  (idempotent webhook log); `stripe_customer_id` on `firms`; all firm-scoped, RLS
  read-only to staff, writes service-role only.
- **B2 (P0)** `server/stripe.ts`: create-checkout-session, create-billing-portal,
  and the **webhook handler** (signature verify + idempotency).
- **B3 (P0)** Webhook events handled: `checkout.session.completed`,
  `customer.subscription.created|updated|deleted`, `invoice.paid`,
  `invoice.payment_failed`. Each maps `customer` → `firm_id` and upserts
  subscription state.
- **B4 (P0)** Entitlement resolver + **server-side gate** in the `functions.ts`
  authorize path: no active subscription ⇒ paid functions refused.
- **B5 (P1)** Seat enforcement at invite (A5) — count firm profiles vs. plan seats.
- **B6 (P1)** Billing UI: a Settings → Billing panel (plan, seats, portal link,
  invoices), plus an upgrade/paywall state.
- **B7 (P1)** Grace/dunning: `payment_failed` → `past_due` grace window →
  read-only; portal card update → reconcile → restore.
- **B8 (P2)** Stripe Tax, coupons/trials, annual plans — flip on once the core loop works.

### C — Ops / deploy / observability  (docs/10 Phase 4 remainder)
- **C1 (P0)** Stand up the real Supabase project; run all 23 migrations; re-run the
  72 RLS checks against it.
- **C2 (P0)** Secrets into host env (Clerk keys, Stripe keys + webhook secret,
  `ANTHROPIC_API_KEY`, `EB_DOCUMENT_KEY`, `DATABASE_URL`); confirm none committed/logged.
- **C3 (P0)** Deploy the Node service (Fly/Render — Dockerfile exists) + frontend
  (Vercel/Netlify); wire `VITE_FUNCTIONS_URL`, Clerk publishable key.
- **C4 (P1)** Sentry on frontend + Node service.
- **C5 (P1)** Confirm backups/PITR on the Supabase tier.
- **C6 (P1)** CI deploy stage after build; custom domain + SSL.
- **C7 (P2)** A thin Playwright E2E smoke (login → engagement → checkout) in CI.

### D — Security / compliance hardening
- **D1 (P0)** Stripe webhook signature verification (in B2 — the one endpoint that
  takes unauthenticated external POSTs; must be bulletproof).
- **D2 (P1)** Rate limiting on auth-adjacent + webhook endpoints; tighten
  `FUNCTIONS_ALLOWED_ORIGIN` off `*`.
- **D3 (P1)** Confirm `EB_DOCUMENT_KEY` set in prod (the http.ts warning must never fire).
- **D4 (P2)** Re-run the vendor-DD checklist (docs/16) against the Clerk+Stripe surface.

### E — Integrations / data
- **E1 (P1)** Provision `ANTHROPIC_API_KEY`; one live narrative smoke test.
- **E2 (P1)** Auth/billing transactional email (Clerk sends auth email; pick a
  provider for billing receipts if not using Stripe's).
- **E3 (P2)** Live QuickBooks/Xero OAuth (external approval clock — start early, non-blocking; unchanged from docs/10).

### F — Legal / trust
- **F1 (P0 for real customers)** ToS, Privacy Policy, DPA drafted and linked.
- **F2 (P1)** Data-retention + deletion policy (owner PII, financials, documents).

---

## 4. Clerk workstream — design

**Chosen model:** Clerk is the IdP; Supabase is configured to trust Clerk as a
third-party auth provider. Clerk **Organizations = firms**. This is RLS-preserving:
every existing policy calls `app.user_firm_id()` / `app.user_role()` — we only
change *what those three helpers read* and *what issues the JWT*.

### 4.1 The identity mapping
- Clerk `user.id` (`user_2ab…`, a **string**) becomes `profiles.user_id`.
- Clerk `organization.id` (`org_2xy…`) maps to a firm. Store it on `firms`
  (`clerk_org_id text unique`) so `firm_id` (our uuid) stays the internal key and
  FKs are unaffected. The session JWT carries `org_id`; the profile row ties
  `org_id → firm_id`.
- Clerk org **role** (`admin`/`basic_member`, or custom `advisor`/`reviewer`)
  maps to our `app_role`. Store the app role on the profile (source of truth for
  RLS via `app.user_role()`); Clerk role governs org management.

### 4.2 Supabase side (the RLS core — one migration)
```sql
-- widen identity columns to hold Clerk ids
alter table profiles alter column user_id type text;
alter table profiles drop constraint profiles_user_id_fkey;   -- no more auth.users FK
alter table usage_events alter column actor_user_id type text;
alter table firms add column clerk_org_id text unique;

-- the ONLY behavioral change: helpers read the Clerk subject, not auth.uid()
create or replace function app.user_firm_id() returns uuid
language sql stable security definer set search_path = public as $$
  select firm_id from public.profiles where user_id = auth.jwt()->>'sub'
$$;
-- (same one-line change for app.user_role() and app.user_company_id())
```
`auth.jwt()->>'sub'` is populated by Supabase from the verified Clerk token under
third-party auth. **No policy body changes** — this is the whole point of the model.
Ship it as `20260719000100_clerk_identity.sql` with a matching down-path documented.

### 4.3 Server side
- `server/http.ts` already builds `verifyToken` from a JWKS URL — point it at
  `https://<clerk-domain>/.well-known/jwks.json`. Keep HS256 only for local/CI if useful.
- `server/auth-jwt.ts` `Claims`: carry `sub` (Clerk user id, text), `org_id`, and
  role. `asUser` sets `request.jwt.claims` so `auth.jwt()->>'sub'` resolves in-DB.
- Reject a token whose `org_id` doesn't match the profile's firm (defense in depth).

### 4.4 Frontend
- Add `@clerk/clerk-react`; wrap the tree in `<ClerkProvider>`; `LoginPage` uses
  Clerk `<SignIn>` (or hosted pages). An **organization switcher** selects the
  active firm for multi-firm staff.
- Rewrite `src/lib/auth.tsx`: session + JWT come from Clerk (`getToken()` with a
  Supabase JWT template so the token has the claims Supabase/our service expect).
  The `profiles`/`firms` lookups stay the same. Keep the idle-timeout (or use
  Clerk session inactivity). Attach Clerk's token as the Bearer for `/functions/*`.

### 4.5 Invites & provisioning (replaces `invite.ts` auth.users insert)
- Owner invite → **Clerk organization invitation** (Clerk emails the link).
- Profile row provisioned deterministically on first authenticated request *or*
  via a Clerk webhook (`organizationMembership.created`) → a small
  `provision-profile` function that inserts the `profiles` row with `firm_id`
  (from `clerk_org_id`), role, and company scope. No fixed dev password anywhere.

### 4.6 MFA
Retire `src/lib/mfa.ts` + the Supabase-AAL gate; require MFA as a Clerk policy.
`RequireAdvisor` collapses to checking Clerk's MFA-satisfied signal. Net simpler.

### 4.7 Testing / cutover
- `scripts/rls-test.ts`: mint Clerk-shaped JWTs (text `sub`, `org_id`) instead of
  Supabase HS256; all **72 checks must stay green** — that's the proof RLS holds.
- Existing data: dev/seed only today → recreate under Clerk ids (trivial). If a
  real Supabase-Auth prod exists at cutover, map `auth.users.id → clerk user_id`
  by email in a one-shot backfill (documented, not built speculatively).

**Clerk DoD:** login/MFA/invite all Clerk; migration applied to a fresh DB; 72
RLS checks green under Clerk JWTs; a foreign-firm read still 404s; no `auth.users`
write in the shipped path.

---

## 5. Stripe workstream — design

**Chosen model:** per-firm subscription + seats. Firm = Stripe **Customer** =
Clerk **Organization**. Our DB caches subscription state; **Stripe is the source
of truth for money**.

### 5.1 Schema (`20260719000200_billing.sql`)
- `plans` — `code`, `name`, `stripe_price_id`, `seat_limit`, `features jsonb`,
  `active`. Seeded (e.g. Solo / Practice / Firm tiers — **pricing TBD by Matthew**).
- `firms.stripe_customer_id text unique`.
- `firm_subscriptions` — `firm_id` (unique), `stripe_subscription_id`, `plan_code`,
  `status` (`trialing|active|past_due|canceled`), `seats`, `current_period_end`,
  `cancel_at_period_end`. **One row per firm** (the cache).
- `billing_events` — `stripe_event_id text unique` (idempotency), `type`,
  `payload jsonb`, `processed_at`. Every webhook logs here first.
- RLS: all firm-scoped; **staff read their firm's** subscription; **writes are
  service-role only** (webhooks/checkout run server-side). No client ever writes billing.

### 5.2 `server/stripe.ts` (functions, mounted in the portable router)
- `create-checkout-session` — for the caller's firm; `mode: subscription`,
  the plan's `stripe_price_id`, `client_reference_id = firm_id`; returns the URL.
- `create-billing-portal-session` — self-serve card/plan/cancel; returns URL.
- **`stripe-webhook`** — the sensitive endpoint:
  1. **Verify signature** (`stripe.webhooks.constructEvent`, `STRIPE_WEBHOOK_SECRET`)
     on the **raw body** (http.ts must pass raw bytes for this route — no JSON pre-parse).
  2. **Idempotency**: insert `stripe_event_id`; if it exists, 200 and stop.
  3. Handle:
     - `checkout.session.completed` → set `stripe_customer_id` on the firm.
     - `customer.subscription.created|updated|deleted` → upsert `firm_subscriptions`
       (status, plan via price→plan map, seats, period end).
     - `invoice.paid` → `active`; `invoice.payment_failed` → `past_due`.
  4. Always 200 on handled/duplicate; 400 only on signature failure.

### 5.3 Entitlements (server-enforced)
- `resolveEntitlements(firmId)` → `{ status, plan, seats, features }` from the cache.
- **Gate in `functions.ts` authorize path**: paid functions (start assessment,
  generate report/PDF, valuation, etc. — **exact list = Matthew's call**) require
  `status in ('trialing','active')` — else `402`/`403` with an upgrade hint. Free
  reads (viewing existing data) stay open so a lapsed firm isn't locked out of its
  own records mid-engagement.
- **Seat check** folds into the invite path (A5): active profiles vs. `seat_limit`.

### 5.4 Frontend
- Settings → **Billing**: current plan, seat usage, "Manage billing" (portal),
  invoice history, upgrade CTA. A lightweight **paywall** state when a gated action
  is attempted without entitlement.

### 5.5 Dunning
`past_due` → grace window (config, e.g. 7 days, still writable) → read-only.
Portal card update → `invoice.paid` webhook → `active` → restore. No mid-engagement
hard lockout.

### 5.6 Local/testing
- Stripe **test mode** + Stripe CLI (`stripe listen --forward-to …/stripe-webhook`)
  for local webhook development.
- Unit-test the price→plan map, idempotency (same event twice = one state change),
  and each status transition. Add to CI (mocked Stripe, no live calls).

**Stripe DoD:** a firm with no subscription is refused a gated action server-side;
completing test checkout flips it to `active` and unblocks; `payment_failed` →
grace → read-only; portal card fix → restore; every webhook idempotent + signature-verified.

---

## 6. Sequencing & dependencies

Stripe keys off the firm/org identity, so **Clerk lands first** (or at least the
firm↔org mapping), but the billing *schema* (B1) can land in parallel.

| Phase | Work | Depends on | Rough effort |
|---|---|---|---|
| **P-A** | Real Supabase project + 23 migrations + 72 RLS checks (C1) | — | 1 day |
| **P-B** | Clerk: third-party auth, identity migration, server/frontend, invites, MFA, RLS-test update (A1–A7) | P-A | 5–8 days |
| **P-C** | Stripe: schema, service, webhooks, entitlement gate, seat check (B1–B5) | firm↔org from P-B (schema can start in parallel) | 5–7 days |
| **P-D** | Billing UI + dunning (B6–B7); paywall | P-C | 2–3 days |
| **P-E** | Ops: deploy both services, Sentry, backups, domain, CI deploy stage (C2–C6, D2–D3) | P-A | 3–4 days |
| **P-F** | AI key + email + legal (E1–E2, F1) | — (parallel) | 2–3 days |
| **P-G** | E2E smoke, Stripe Tax/trials, live ledger, vendor-DD re-review (C7, B8, E3, D4) | after core | fast-follow |

**~3–4 focused weeks** for P-A…P-F with 1–2 engineers, P-F/P-E overlapping the
Clerk/Stripe build. Longest single item is the Clerk identity migration + RLS proof.

---

## 7. Decisions still needed from Matthew (flagging, not deciding)

1. **Plan tiers & pricing** — how many tiers, seat limits, and price points (drives
   `plans` seed + Stripe Products/Prices). Monthly, annual, or both?
2. **Trial policy** — free trial (length, card-required?) or paid from day one?
3. **Gated-action list** — exactly which actions require an active subscription vs.
   stay free (view existing data is free; where's the line on start-assessment,
   report/PDF, valuation)?
4. **Grace window length** for `past_due` before read-only (default proposed: 7 days).
5. **Clerk org roles** — reuse Clerk's `admin`/`member`, or custom
   `advisor`/`reviewer`/`admin` roles in Clerk to mirror `app_role` 1:1?
6. **Owner accounts under Clerk** — owners in the *same* Clerk org as their advisor
   firm (scoped by role) or a separate org/instance? (Recommend: same org, `owner`
   role, company-scoped — matches today's profile model.)
7. **Existing prod users** — is there any real Supabase-Auth account to migrate, or
   is cutover greenfield (affects A8)?

---

## 8. Risks

- **RLS regression under new identity (highest).** Mitigated by keeping policy
  bodies unchanged and re-running all 72 checks with Clerk JWTs as the gate.
- **Webhook security/idempotency.** The one unauthenticated external endpoint —
  signature verify on raw body + `stripe_event_id` dedupe are mandatory.
- **Two sources of truth for "who's in a firm"** (Clerk org membership vs. `profiles`).
  Resolve by making `profiles` authoritative for RLS/roles and Clerk authoritative
  for auth/membership, synced one-way via invite + webhook provisioning.
- **Mid-engagement lockout on payment failure.** Mitigated by grace→read-only, never
  a hard cut, and free read of a firm's own records.

## 9. Immediate next actions (once plan is blessed)

1. Create the Clerk application + a Supabase project; wire Supabase third-party auth
   to Clerk (A1, C1).
2. Land `20260719000100_clerk_identity.sql` on a fresh DB; rewrite the 3 helpers;
   update `scripts/rls-test.ts` to Clerk JWTs; get 72/72 green. **This is the
   go/no-go gate for the whole auth swap.**
3. In parallel, land `20260719000200_billing.sql` + seed placeholder `plans`.
4. Wire `@clerk/clerk-react` + rewrite `src/lib/auth.tsx`; point the Node service's
   JWKS at Clerk.
5. Build `server/stripe.ts` checkout + webhook against Stripe test mode via the CLI.

---

## Execution log

- **2026-07-18 — Slice 1: DB foundation (A2 + B1) SHIPPED.** The verifiable,
  external-account-independent core of both workstreams, landed together because
  billing keys off firm identity.
  - **Clerk identity (A2):** `20260719000100_clerk_identity.sql` — drops the
    `profiles.user_id → auth.users` FK and widens `profiles.user_id`,
    `data_access_log.actor_user_id`, `usage_events.actor_user_id` uuid→text;
    adds `firms.clerk_org_id`; rewrites the three `app.user_*` helpers from
    `auth.uid()` to `auth.jwt() ->> 'sub'`; drops+recreates the one direct-`auth.uid()`
    policy (`own_profile_read`). `db/supabase-shim.sql` gains `auth.jwt()` so the
    migration runs on plain Postgres/CI. `scripts/rls-test.ts` now mints
    Clerk-shaped **text** subjects. Transitional cast in `server/invite.ts`
    (`u.id::text = p.user_id`) keeps the legacy invite path compiling until the
    Clerk invite slice (A5) replaces it.
  - **Billing schema (B1):** `20260719000200_billing.sql` — `plans` (seeded with
    the approved Solo/Practice/Firm tiers, seat/engagement limits, feature sets),
    `firms.stripe_customer_id`, `firm_subscriptions` (one cached row per firm),
    `billing_events` (idempotent webhook log). RLS: `plans` readable by any
    authenticated user; `firm_subscriptions` staff-read-own-firm only;
    `billing_events` service-role only (no authenticated grant).
  - **Go/no-go gate PASSED:** all RLS isolation checks green under Clerk-shaped
    identity — **80 passed / 0 failed** (77 prior + 3 new billing-isolation
    checks: reads own firm subscription only, reads the plan catalog, cannot read
    billing_events). Full CI-exact run on a fresh DB green: migrate → rls 80 →
    seed ×2 (idempotent) → seed:demo ×2 (idempotent) → vitest 202 → build →
    eval 8/8; tsc clean.
  - **Not yet built (need Clerk/Stripe accounts — next slices):** A1 Supabase↔Clerk
    third-party-auth config; A3/A4 frontend `@clerk/clerk-react` + server JWKS
    pointed at Clerk; A5 Clerk org invitations; A6 MFA via Clerk; B2/B3
    `server/stripe.ts` checkout + signature-verified idempotent webhooks; B4
    entitlement gate in the authorize path; B6/B7 billing UI + dunning.

- **2026-07-20 — Slice 2: Clerk auth wiring (A3 + A4, partial A5/A6) SHIPPED (code).** The frontend/server auth cutover, config-gated on `VITE_CLERK_PUBLISHABLE_KEY` so nothing changes until Clerk is provisioned (local dev, CI, and the Supabase-Auth beta are untouched). Added `@clerk/react` v6 (Core 3; `@clerk/clerk-react` is deprecated). **A3 frontend:** `src/lib/supabase.ts` gains `isClerkStack` + a pluggable access-token source wired to supabase-js's `accessToken` option (Supabase third-party auth) and the `/functions/*` Bearer; `src/lib/auth.tsx` now selects a Clerk-backed `AuthProvider` (session/JWT from Clerk's `useAuth().getToken`, profile/firm lookups unchanged) or the original Supabase provider by config, exposing a provider-agnostic `{ userId }` session; `src/main.tsx` wraps `<ClerkProvider>` when Clerk is on; `LoginPage` renders Clerk `<SignIn>`; `mfa.ts` satisfies the in-app AAL gate under Clerk (A6 — MFA becomes a Clerk policy). **A4 server:** `server/http.ts` adds `CLERK_JWKS_URL` (wins over the Supabase JWKS) using the existing asymmetric verifier. **A5 invites:** `server/invite.ts` sends a Clerk **organization invitation** (scope in `public_metadata`) when `CLERK_SECRET_KEY` is set; the membership-created provisioning webhook is specced (docs/30 §5) but needs the live Clerk app to build/verify. Config/docs: `.env.example`, `render.yaml` (`CLERK_JWKS_URL`, `CLERK_SECRET_KEY`), CLAUDE.md stack line updated, and **docs/30** is the provisioning + turn-on runbook. Verified without a Clerk account: `tsc -b` + `vite build` clean (validates Clerk API usage against real types), vitest 152 pass. **Needs the Clerk app to finish/verify:** Clerk org+role setup, Supabase third-party-auth config, env on Vercel/Render, and the provisioning webhook (docs/30). No scoring/rubric/schema/RLS-policy/AI change.
