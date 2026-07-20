# Production debug — "database errors" after go-live

Symptom seen right after `app.exitblueprint.net` went live: the app loads and you
can sign in through Clerk, but data reads fail or come back empty across the whole
app ("a lot of errors with the database").

## Root cause (almost always): the Clerk→Supabase `role` claim

Every RLS policy in this app targets the Postgres `authenticated` role
(`supabase/migrations/20260707000200_rls.sql`). Supabase PostgREST decides which
role to assume from the **`role` claim in the JWT**. Under Clerk third-party auth,
that claim is added by **Clerk's Supabase integration** — it is *not* in a vanilla
Clerk session token.

If the integration isn't enabled, a signed-in Clerk token has **no
`role: authenticated`**, so PostgREST runs every query as `anon`. Nothing has an
`anon` policy, so every firm-scoped read is denied → empty tables and permission
errors everywhere, even though "login works."

This is dashboard config, not code. The app code (`accessToken: () => getToken()`
in `src/lib/supabase.ts`) is already correct.

### Fix

1. **Clerk dashboard** → Configure → **Supabase** integration → enable it for this
   instance. That makes Clerk add `role: "authenticated"` (and the Supabase-shaped
   claims) to session tokens.
2. **Supabase dashboard** → Authentication → Sign In / Providers → **Third-Party
   Auth** → add **Clerk** with your Clerk domain/issuer (docs/30 §2).
3. Sign out and back in so a fresh token is issued.

## Confirm it from the browser: `/health`

`/health` (public route) is now a live auth-config diagnostic. Sign in, then open
`https://app.exitblueprint.net/health`. It decodes the **current session token**
and checks:

- **Identity provider** — Clerk / dev emulator / misconfigured.
- **Session token** — `sub` present, issuer shown.
- **RLS role claim** — ✅ when `role: authenticated` is present; ❌ (with the fix
  pointer) when it's missing. **This is the decisive check.**
- **Token expiry** — a stale token reads as "not signed in" to Supabase.
- **Authenticated read** — actually reads the methodology tables (a
  `to authenticated using (true)` policy). Green proves token → Supabase → RLS
  end to end.

If "RLS role claim" is ❌, do the fix above — that is the database-error cause.

## Code hardening shipped alongside this note

- **`.single()` → `.maybeSingle()`** in `src/lib/auth.tsx`. `.single()` returns
  HTTP 406 on 0 rows, and the first-sign-in provisioning retry loop fired up to
  five of them — a burst of red "database" errors in the console on every fresh
  login. `.maybeSingle()` returns `null` with no error.
- **Structured errors** — DB/auth failures now render through `ErrorState` /
  `describeError()` (`src/lib/errors.ts`) instead of raw Postgres strings; an
  RLS/permission-shaped failure shows the same config hint as above rather than a
  scary SQL message. See docs/26 §Loading & error states.

## If `/health` shows the role claim IS present but reads still fail

Then it's not the claim. Check, in order:

- **Third-party auth provider** actually added in Supabase (step 2) — without it
  Supabase rejects the token signature even with the right claim.
- **`profiles` row exists** for your Clerk `sub` (provisioning webhook ran) — RLS
  helpers resolve `firm_id`/`role` from it; no row → no firm scope → 0 rows. The
  Clerk webhook (`docs/30 §5`) writes it; `scripts/admin.ts` is the manual path.
- **`firms.clerk_org_id`** links your Clerk org to the firm.
