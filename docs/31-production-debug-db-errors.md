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
  end to end. Note: this passes on the `role` claim alone, so it stays green even
  when the profile linkage below is broken.
- **Profile linkage** — reads your own `public.profiles` row **by the Clerk
  `sub`**. ❌ when no row is keyed to your `sub` — the second failure mode (see
  below). Shows your `role`/`firm_id`/`company_id` when found.
- **Firm-scoped read** — a real `companies` read under your firm scope, proving
  role/firm resolution actually resolves.

If "RLS role claim" is ❌, do the config fix above. If it's ✅ but "Profile
linkage" is ❌, it's the identity-mapping problem below.

## Code hardening shipped alongside this note

- **`.single()` → `.maybeSingle()`** in `src/lib/auth.tsx`. `.single()` returns
  HTTP 406 on 0 rows, and the first-sign-in provisioning retry loop fired up to
  five of them — a burst of red "database" errors in the console on every fresh
  login. `.maybeSingle()` returns `null` with no error.
- **Structured errors** — DB/auth failures now render through `ErrorState` /
  `describeError()` (`src/lib/errors.ts`) instead of raw Postgres strings; an
  RLS/permission-shaped failure shows the same config hint as above rather than a
  scary SQL message. See docs/26 §Loading & error states.

## Second failure mode: the profile isn't keyed to the Clerk `sub`

Clerk and Supabase are two separate user systems. Clerk owns identity; Supabase
RLS resolves your role/firm/company by joining the token's `sub` to
**`public.profiles.user_id`** (`app.user_role()` / `app.user_firm_id()` /
`app.user_company_id()`, all `where user_id = auth.jwt() ->> 'sub'`). Nothing
enforces that join at write time — it's a string convention.

So a token can be fully valid (`role: authenticated` present, third-party auth
working) and *still* read nothing firm-scoped, because there is **no `profiles`
row whose `user_id` equals your Clerk `sub`** (`user_2…`). The common cause: the
profile was created with a **UUID** `user_id` — by a seed script or the dev path
(`admin.ts` `provisionDevAdvisor` → `gen_random_uuid()`) — while your Clerk `sub`
is `user_2…`. Different id spaces, no match → `app.user_*` return NULL → every
firm-scoped policy denies. Only `scripts/admin.ts create-advisor` in **Clerk mode**
(or the provisioning webhook) keys the profile to the Clerk id.

`/health` → **Profile linkage** flags this directly. To confirm and fix:

```sql
-- Compare user_id to the `sub` shown on /health (Session token line).
select user_id, email, role, firm_id, company_id from public.profiles;
```

- **Re-key an existing, otherwise-correct profile** (right firm/role, wrong id):
  ```sql
  update public.profiles set user_id = 'user_2…'  -- the sub from /health
  where email = 'you@yourfirm.com';
  ```
- **Or re-provision cleanly** (Clerk mode, `CLERK_SECRET_KEY` set):
  ```
  npm run admin -- create-advisor --firm "Your Firm" --email you@yourfirm.com --role admin
  ```

Also confirm:

- **Third-party auth provider** actually added in Supabase (step 2) — without it
  Supabase rejects the token signature even with the right claim.
- **`firms.clerk_org_id`** links your Clerk org to the firm — the webhook resolves
  `firm_id` through it, so a missing link means no firm scope even with a profile.

## Third failure mode: role is `admin` (fixed in-repo)

If `/health` → **Profile linkage** shows `role admin` and **Firm-scoped read**
shows 0 while the linkage is otherwise fine, this was the cause: every firm-scoped
RLS policy used to gate on `advisor` (or `advisor`/`reviewer`) only, so an admin
admitted to the workspace by the frontend could read/write nothing firm-scoped.

`20260720000100_admin_firm_access.sql` fixes it: admins now get the same
firm-scoped access as advisors (additive `admin_*` policies, firm isolation
preserved — rls-test covers it). After deploying that migration an admin works
without changing their role. On a database that predates the migration, the
interim workaround is to set the profile to `advisor`:

```sql
update public.profiles set role = 'advisor' where user_id = 'user_2…';
```
