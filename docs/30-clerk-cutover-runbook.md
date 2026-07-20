# Clerk auth cutover — runbook

How to switch identity from Supabase Auth to **Clerk**, wiring it into the
existing RLS model rather than replacing it. This is the code-complete companion
to `docs/24` §4 (design) and picks up from its **Slice 1** (the DB identity
migration, already shipped: `profiles.user_id` is `text`, the `app.user_*`
helpers read `auth.jwt()->>'sub'`, `firms.clerk_org_id` exists, and rls-test is
green under Clerk-shaped subjects).

**Design in one line:** Clerk is the IdP; Supabase trusts Clerk via third-party
auth; Clerk **Organizations = firms**; the three RLS helpers and every policy
body are unchanged — only *what issues the JWT* changes.

## Config gate (nothing breaks until you flip it)

The whole cutover is gated on one build-time var:

- **`VITE_CLERK_PUBLISHABLE_KEY` set** → Clerk is the identity provider (login,
  MFA, invites via Clerk).
- **unset** → the app keeps the Supabase-Auth / dev-emulator path **unchanged**
  (local dev, CI, and the current beta are untouched).

So this can land and deploy without affecting the running beta; Clerk turns on
only where the key is present.

---

## What the code already does (this slice)

- **Frontend** (`src/lib/supabase.ts`, `src/lib/auth.tsx`, `src/main.tsx`,
  `src/pages/LoginPage.tsx`): when `VITE_CLERK_PUBLISHABLE_KEY` is set, the tree
  is wrapped in `<ClerkProvider>`, `LoginPage` renders Clerk `<SignIn>`, and
  `AuthProvider` sources the session + JWT from Clerk. Clerk's session token is
  registered as supabase-js's `accessToken` (third-party auth) and used as the
  Bearer for `/functions/*`. The `profiles`/`firms` lookups are unchanged.
- **Server** (`server/http.ts`): `CLERK_JWKS_URL` points token verification at
  Clerk's key set (`server/auth-jwt.ts` already verifies asymmetric JWTs).
- **Invites** (`server/invite.ts`): with `CLERK_SECRET_KEY` set, an owner invite
  sends a Clerk **organization invitation** carrying `{ app_role, company_id,
  firm_id }` in `public_metadata` (no `auth.users`/profile write here).
- **MFA** (`src/lib/mfa.ts`): the in-app Supabase-AAL gate is satisfied by
  definition under Clerk (MFA is a Clerk policy).

## What still needs your Clerk account to complete + verify

These can't be built/verified without a live Clerk app; steps below:

1. Create the Clerk application, Organizations, and roles.
2. Configure Supabase **third-party auth** to trust Clerk.
3. Set the env vars on Vercel + Render.
4. **Provisioning webhook** — the one piece of server code still to add once the
   Clerk app exists (spec in §5): on `organizationMembership.created`, insert the
   `profiles` row from the invitation's `public_metadata`. Until it exists,
   provision owner profiles manually (`scripts/admin.ts`).

---

## Step 1 — Clerk application

1. Create an app at [dashboard.clerk.com](https://dashboard.clerk.com). Copy the
   **Publishable key** (`pk_…`) and **Secret key** (`sk_…`).
2. Enable **Organizations**. Map **one Clerk Organization = one firm.** Store the
   org id on the firm: `update firms set clerk_org_id = 'org_…' where id = '…'`.
3. **Roles.** Reuse Clerk's `org:admin` / `org:member`, or add custom org roles
   mirroring `app_role` (`advisor`/`reviewer`/`admin`/`owner`). The app's own
   `profiles.role` stays the source of truth for RLS; the Clerk role governs org
   management. *(Confirm the role model with Matthew — `docs/24` §7.5/7.6.)*
4. Enable **MFA** as an org/session policy (replaces the Supabase-AAL gate).
5. Note your Clerk **Frontend API / domain** — the JWKS is
   `https://<clerk-domain>/.well-known/jwks.json`.

## Step 2 — Supabase third-party auth (trust Clerk)

Supabase → **Authentication → Sign In / Providers → Third-party Auth** → add
**Clerk** (provide Clerk's domain/issuer). This makes `supabase.from(...)` REST
calls validate the Clerk token and populate `auth.jwt()->>'sub'` with the Clerk
user id — which the RLS helpers already read. No JWT template is needed (the
legacy template integration was deprecated in 2025).

## Step 3 — Env vars

| Var | Set on | Value |
|---|---|---|
| `VITE_CLERK_PUBLISHABLE_KEY` | Vercel | `pk_…` (flips the frontend to Clerk) |
| `CLERK_JWKS_URL` | Render | `https://<clerk-domain>/.well-known/jwks.json` |
| `CLERK_SECRET_KEY` | Render | `sk_…` (enables org invitations) |
| `OWNER_INVITE_REDIRECT_URL` | Render | optional; defaults to `FUNCTIONS_ALLOWED_ORIGIN` |

Keep `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` (REST still goes to Supabase).
On Render, `CLERK_JWKS_URL` supersedes the Supabase JWKS for token verification.

## Step 4 — Redeploy

Redeploy the frontend (Vite inlines `VITE_*` at build time) and the compute
service. Login now goes through Clerk.

---

## Step 5 — Profile-provisioning webhook (remaining server code)

Because a Clerk user id doesn't exist until the owner accepts the invitation, the
profile row is created on membership, not at invite time. Add a Clerk webhook
(Clerk dashboard → Webhooks) → a new unauthenticated endpoint that:

1. **Verifies the Svix signature** (`CLERK_WEBHOOK_SECRET`) on the raw body.
2. On `organizationMembership.created`, reads `public_metadata`
   (`app_role`, `company_id`, `firm_id`) and the Clerk `user_id` + email, then:
   ```sql
   insert into profiles (user_id, firm_id, role, company_id, full_name, email)
   values ($clerk_user_id, $firm_id, $app_role, $company_id, $full_name, $email)
   on conflict (user_id) do nothing;
   ```
3. Returns 200 on handled/duplicate.

This mirrors the Stripe-webhook pattern already specced in `docs/24` §5.2 (raw
body, signature verify, idempotent). Until it's live, provision owner profiles
with `scripts/admin.ts`.

---

## Verify (against the live Clerk app)

1. Sign in at `app.exitblueprint.net` via Clerk → the portfolio loads (proves
   Clerk token → Supabase REST → RLS, and a `/functions/*` call end to end).
2. A foreign-firm read still returns 0 rows / 404 (RLS holds under Clerk `sub`).
3. Invite an owner → they receive a Clerk org invitation, accept, and see only
   their company (proves the webhook provisioning + owner scoping).
4. `scripts/rls-test.ts` stays 80/80 (already Clerk-shaped subjects).

## Rollback

Unset `VITE_CLERK_PUBLISHABLE_KEY` (frontend) and `CLERK_JWKS_URL` (compute
service) and redeploy — the app returns to Supabase Auth with no code change. The
DB identity columns are text and provider-agnostic, so no schema rollback is
needed.

## Not in this slice

Stripe billing (`docs/24` §5) is a separate workstream. Clerk **billing** and the
custom-role automation beyond the mapping above are out of scope until requested.
