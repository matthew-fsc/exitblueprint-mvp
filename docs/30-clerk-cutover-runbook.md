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

## Config gate — Clerk is the standard

Identity is gated on one build-time var, but Clerk is now the **standard** for
every hosted deployment:

- **`VITE_CLERK_PUBLISHABLE_KEY` set** → Clerk is the identity provider (login,
  MFA, invites via Clerk). This is the production standard.
- **unset** → the **local dev emulator** only (`dev/supabase-dev-server.ts`,
  password `demo`), for local dev + CI. A *hosted* deployment without the key is
  unsupported and the login page says so.

The hosted **Supabase-Auth password login was removed** (frontend login form,
the `inviteUserByEmail` invite path, and the Supabase-admin provisioning note).
The compute service still accepts the dev HS256 secret for local/CI, and Clerk's
JWKS in production.

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

## Provisioning — automatic via `scripts/admin.ts`

With `CLERK_SECRET_KEY` (and `DATABASE_URL`) set, the admin CLI provisions Clerk
directly — no manual dashboard steps for firms/advisors:

```
# Creates the Clerk Organization and stores firms.clerk_org_id
npm run admin -- create-firm --name "Summit Exit Advisors"

# Creates/finds the Clerk user, adds the org membership, writes the profile
# keyed to the Clerk user id (no auth.users row — identity lives in Clerk)
npm run admin -- create-advisor --firm "Summit Exit Advisors" \
  --email jo@summit.com --role admin --name "Jo Advisor"
```

The advisor then signs in through Clerk (email code / password reset, per your
instance's enabled strategies). App role → Clerk org role: `admin` → `org:admin`,
everything else → `org:member`. `profiles.role` stays the source of truth for RLS.

Without `CLERK_SECRET_KEY` (local/CI), the same commands write `auth.users` +
`profiles` for the dev emulator, unchanged.

## What still needs your Clerk account to complete + verify

These can't be built/verified without a live Clerk app; steps below:

1. Create the Clerk application, enable Organizations, set roles.
2. Configure Supabase **third-party auth** to trust Clerk.
3. Set the env vars on Vercel + Render.
4. **Add the provisioning webhook** — point a Clerk webhook at
   `POST /webhooks/clerk` and set `CLERK_WEBHOOK_SIGNING_SECRET` so firms,
   advisors, and owners are provisioned automatically on Clerk events (built;
   see §5). `scripts/admin.ts` stays available for operator/one-off provisioning.

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
5. **Require Terms acceptance at signup ("usage agreement").** Clerk Dashboard →
   **Configure → Legal**: turn on "Require users to agree to your legal
   documents," and set the **Terms of Service URL** to
   `https://app.exitblueprint.net/legal/terms` and the **Privacy Policy URL** to
   `https://app.exitblueprint.net/legal/privacy`. Clerk's `<SignUp>` (rendered by
   `src/pages/SignUpPage.tsx`) then shows a **required, unchecked** "I agree…"
   checkbox — active opt-in, not pre-checked — and records acceptance on the
   Clerk user. (The *engagement* data-use consents are separate and pre-checked;
   see the New-engagement dialog in `src/pages/DashboardPage.tsx`.)
6. Note your Clerk **Frontend API / domain** — the JWKS is
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
| `CLERK_JWKS_URL` | Render | `https://<clerk-domain>/.well-known/jwks.json` (pinned in `render.yaml`) |
| `CLERK_SECRET_KEY` | Render | `sk_…` (enables org invitations) |
| `CLERK_WEBHOOK_SIGNING_SECRET` | Render | `whsec_…` (enables auto-provisioning, §5) |
| `OWNER_INVITE_REDIRECT_URL` | Render | optional; defaults to `FUNCTIONS_ALLOWED_ORIGIN` |

Keep `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` (REST still goes to Supabase).
On Render, `CLERK_JWKS_URL` supersedes the Supabase JWKS for token verification.

## Step 4 — Redeploy

Redeploy the frontend (Vite inlines `VITE_*` at build time) and the compute
service. Login now goes through Clerk.

---

## Step 5 — Automatic provisioning webhook (built)

Provisioning is hands-off — no one runs `scripts/admin.ts` for day-to-day
onboarding. `server/clerk-webhook.ts` is mounted at **`POST /webhooks/clerk`** on
the compute service (and the dev emulator). It:

1. **Verifies the Svix signature** (`CLERK_WEBHOOK_SIGNING_SECRET`) against the
   raw body, and rejects a stale timestamp (5-min tolerance) — see
   `verifyClerkWebhook`, unit-tested against Svix's published test vector.
2. **`organization.created`** → upserts the `firms` row and links
   `firms.clerk_org_id` (so a firm created in Clerk auto-appears; idempotent with
   `admin.ts create-firm`, which may have inserted it already).
3. **`organizationMembership.created`** → inserts the `profiles` row (idempotent
   `on conflict (user_id) do nothing`), resolving `firm_id` from
   `firms.clerk_org_id`. The app role + `company_id` come from the membership's
   `public_metadata` — which Clerk **copies from the accepted organization
   invitation** (`server/invite.ts` sets `app_role`/`company_id`/`firm_id`/
   `full_name`). With no metadata (a member added straight in Clerk) the app role
   is derived from the Clerk org role (`org:admin` → `admin`, else `advisor`).
4. Returns **200** on handled/duplicate, **400** on a bad signature/timestamp, and
   **5xx** on a transient miss (e.g. the firm's `organization.created` hasn't been
   processed yet) so Svix retries.

**Wire it up:** Clerk dashboard → **Webhooks** → add endpoint
`https://api.exitblueprint.net/webhooks/clerk`, subscribe to `organization.created`
and `organizationMembership.created`, and paste the signing secret into
`CLERK_WEBHOOK_SIGNING_SECRET` on Render. Local testing:
`clerk webhooks listen --forward-to http://localhost:5173/webhooks/clerk`.

`scripts/admin.ts` remains for one-off/operator provisioning (and works without
the webhook); the webhook is what makes ongoing onboarding automatic.

---

## Verify (against the live Clerk app)

1. Sign in at `app.exitblueprint.net` via Clerk → the portfolio loads (proves
   Clerk token → Supabase REST → RLS, and a `/functions/*` call end to end).
2. A foreign-firm read still returns 0 rows / 404 (RLS holds under Clerk `sub`).
3. Invite an owner → they receive a Clerk org invitation, accept, and see only
   their company (proves the webhook provisioning + owner scoping).
4. `scripts/rls-test.ts` stays 80/80 (already Clerk-shaped subjects).

## Rollback

Clerk is the standard; the hosted Supabase-Auth login is gone, so unsetting the
key on a hosted deployment no longer yields a working password login (the login
page reports "not configured"). To roll back, restore the pre-cutover build
(which still had the Supabase-Auth path) and redeploy. The DB identity columns
are text and provider-agnostic, so no schema rollback is needed. Local dev + CI
are unaffected either way — they run the dev emulator, not Clerk.

## Not in this slice

Stripe billing (`docs/24` §5) is a separate workstream. Clerk **billing** and the
custom-role automation beyond the mapping above are out of scope until requested.
