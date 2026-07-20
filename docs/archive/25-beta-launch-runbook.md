# Beta launch runbook — getting a real test group in

**Goal:** a small group of real advisors (and, per advisor, a real owner) using the
product against a real deployment, with their own logins and no faked steps. Beta
testers are **comped** — billing must never block them.

This is the credential/infra checklist that turns the code (which is beta-ready)
into a running beta. It sits on top of `docs/archive/10` (compute layer — done) and
`docs/24` (Clerk + Stripe plan). Items marked **[you]** need an account/secret only
Matthew can provision; **[code]** is already built and verified.

---

## What's already beta-ready (code) — no further work to use it

- **[code]** Compute service (`server/http.ts`) serves every `/functions/v1/*`
  against real Postgres, verifying JWTs by **HS256 or JWKS** — so it accepts
  Supabase *or* Clerk tokens by config alone. Dockerized.
- **[code]** Identity schema is Clerk-ready and **backward-compatible with Supabase
  Auth** (the `sub`-as-text migration is a no-op under Supabase's uuid subjects) —
  so you can launch the beta on **Supabase Auth today** and cut over to Clerk later
  without another schema change.
- **[code]** Billing schema + **entitlement system**: comped firms are fully
  entitled; the feature gate is **off by default** (`BILLING_ENFORCED` unset), so a
  comped beta is unblocked and nothing is gated until you flip billing on for GA.
- **[code]** Honest financials (manual/CSV, provenance-stamped), RLS (80 checks),
  immutable assessments, audit log, idle-timeout.

---

## Path A — fastest beta (recommended): Supabase Auth now, Clerk later

Gets testers in with the least new surface. Clerk/Stripe become post-beta cutovers.

1. **[you] Real Supabase project.** Create it; set `DATABASE_URL` (service-role
   conn string) and run `npm run db:migrate` against it; then `npm run test:rls`
   to prove isolation on the real project. Enable **PITR/backups** on the tier.
2. **[you] Deploy the compute service** (Fly/Render — `server/Dockerfile` exists).
   Env: `DATABASE_URL`, `FUNCTIONS_JWT_SECRET` (the project's JWT secret),
   `ANTHROPIC_API_KEY`, `EB_DOCUMENT_KEY` (32-byte hex — **must** be set),
   `FUNCTIONS_ALLOWED_ORIGIN` (your frontend origin, not `*`).
3. **[you] Deploy the frontend** (Vercel/Netlify). Env: `VITE_SUPABASE_URL`,
   `VITE_SUPABASE_ANON_KEY`, `VITE_FUNCTIONS_URL` (the compute service URL).
4. **[you] Auth email.** Configure Supabase Auth email templates + SMTP (built-in
   is fine for a handful of testers).
5. **[code→you] Real invites.** Replace `invite.ts`'s dev `auth.users` insert with
   `inviteUserByEmail` (small change — flagged in the file). *(Can be a fast-follow
   if you provision the first testers via `scripts/admin.ts`.)*
6. **[you] Comp the beta firms.** For each tester firm:
   `insert into firm_subscriptions (firm_id, plan_code, comp) values ('<firm>', 'practice', true)`
   (or set `comp=true` on an existing row). They now have full access with no Stripe.
7. **[you] Provision advisors** with `scripts/admin.ts`; each advisor invites their
   owner (step 5). Walk one advisor→owner round trip end to end.
8. **[you] Error monitoring** (Sentry on frontend + compute service) and a
   **custom domain + SSL**.
9. **[you] Legal:** ToS + Privacy Policy linked (you're handling real financials).

**Beta is live when:** a tester logs in with their own email, runs an assessment,
sees a score/report, invites their owner, and the owner logs into the portal —
all against the deployed stack, RLS holding.

---

## Path B — beta on Clerk from day one (more setup, closer to GA)

Do Path A's infra (1–4, 8–9), then instead of Supabase Auth:

1. **[you] Clerk application** + a Supabase **third-party auth** integration
   pointing at Clerk (Clerk JWKS). Create **Organizations = firms**; set custom org
   roles `admin`/`advisor`/`reviewer`/`owner`.
2. **[code→you] Wire Clerk:** point the compute service's JWKS at Clerk (set
   `SUPABASE_URL`→ Clerk issuer, or add a `CLERK_JWKS_URL` env — `makeVerifyToken`
   already takes a JWKS URL); add `@clerk/clerk-react` + `ClerkProvider` and swap
   `src/lib/auth.tsx`'s session/token source to Clerk (Supabase JWT template).
   *(This is the next code slice; ~5–8 days per docs/24 A3–A6.)*
3. **[you] Map each tester** to a Clerk org (firm) and role; `profiles.user_id`
   stores the Clerk user id (schema already text).
4. Comp the firms (Path A step 6) — unchanged.

Clerk gives you org invitations + native MFA (retiring `src/lib/mfa.ts`), so steps
5/8-auth of Path A fold into Clerk.

---

## Turning billing on (after beta → GA) — not needed for the beta

1. **[you] Stripe account**; create Products/Prices for Solo/Practice/Firm; put the
   `stripe_price_id`s into the `plans` rows.
2. **[code — next slice] `server/stripe.ts`:** checkout + billing-portal sessions +
   the signature-verified idempotent webhook (raw body), mapping events →
   `firm_subscriptions`. Env: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.
3. **[you] Flip the gate on:** set `BILLING_ENFORCED=true` on the compute service.
   Comped firms stay in; everyone else needs an active/trialing subscription for the
   gated actions (`create-engagement`, `score-assessment`, `compute-valuation`,
   `generate-roadmap`, `generate-document`, `render-*-pdf`, `invite-owner`). Viewing
   existing data stays free.
4. Billing UI: Settings already shows plan/access; add the "Manage billing" portal
   link + upgrade/paywall states with the Stripe slice.

---

## Minimal beta blocker list (the short version)

1. Real Supabase project + migrations + RLS test **[you]**
2. Deploy compute service + frontend, env wired **[you]**
3. Real auth emails / invites **[you + small code]**
4. Comp the tester firms **[you, one SQL line each]**
5. Sentry + backups + domain + ToS/Privacy **[you]**

Everything else (Clerk cutover, Stripe billing) is post-beta and already planned.
