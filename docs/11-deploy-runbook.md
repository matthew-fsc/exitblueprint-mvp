# Deploy runbook — standing up for the first real customer

Companion to `docs/10-production-readiness.md`. Concrete, ordered steps to take
the app from the dev emulator to a real deployment. Chosen runtime: **one Node
compute service** (`server/http.ts`) + real Supabase (auth, REST, Postgres) +
a static frontend.

Keep every secret in your shell / the host's secret store — never in the repo.

---

## 1. Stand up the database (scripted)

The whole sequence — apply the 15 migrations, prove RLS isolation, seed the
methodology — is one command. It has been rehearsed against a fresh empty
database and matches what CI runs.

```sh
DATABASE_URL="postgresql://postgres:[PW]@db.<ref>.supabase.co:5432/postgres" \
  npm run db:setup
```

**Connection string — this matters:**

| Use | String (Supabase → Connect) | Port | Notes |
|---|---|---|---|
| Migrations / `db:setup` | Direct `db.<ref>.supabase.co` | 5432 | Full session; **IPv6-only** — unreachable from IPv4-only machines/CI. |
| Migrations (IPv4) | Session pooler `aws-0-<region>.pooler.supabase.com` | 5432 | IPv4, session mode — use this if the direct string won't connect. |
| Compute service runtime | Session pooler | 5432 | Long-lived Node service with a small pool; simplest and safe. |
| ❌ Not for migrations | Transaction pooler | 6543 | Can't run migrations (no session features). |

The migrate script auto-detects a real Supabase database (the `auth` schema is
present) and **skips** the local-dev shim; the `app.*` RLS helpers and everything
else are created by the migrations themselves. Run as the `postgres` user (the
connection string Supabase gives you) so `rls-test` can seed/roll-back auth rows.

Re-running `db:setup` is safe: migrations are tracked in `schema_migrations`,
`rls-test` rolls back, and the seed is idempotent.

---

## 2. Deploy the compute service (`server/http.ts`)

This serves every `/functions/v1/*` call. Deploy the repo with `server/Dockerfile`
(Playwright base image → ships the Chromium that PDF rendering needs) to Fly.io,
Render, or Railway.

Required env on the service:

- `DATABASE_URL` — service-role Postgres string (session pooler is fine).
- `FUNCTIONS_JWT_SECRET` — verifies Supabase access tokens. **See §2a.**
- `FUNCTIONS_ALLOWED_ORIGIN` — your frontend origin (CORS).
- `ANTHROPIC_API_KEY` — optional; turns on real Claude narrative.

Health check: `GET /health` → `{ "ok": true }`.

### 2a. JWT verification — confirm your project's mode

The service currently verifies **HS256** with a shared secret (`FUNCTIONS_JWT_SECRET`).
That works for projects using the **legacy JWT secret** (Dashboard → Project
Settings → API → *JWT Secret*).

Newer Supabase projects default to **asymmetric JWT signing keys** (ES256/RS256),
where tokens are verified against the project JWKS
(`https://<ref>.supabase.co/auth/v1/.well-known/jwks.json`), not a shared secret.
**If your project uses signing keys, the HS256 path won't validate real tokens** —
the service needs a small JWKS-verification addition (planned; ask and it's a
quick, unit-testable change). Check Dashboard → Project Settings → JWT Keys to see
which mode you're on before wiring this up.

---

## 3. Deploy the frontend

Static build (Vercel/Netlify/Cloudflare Pages) with:

- `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` — the real project (auth + REST).
- `VITE_FUNCTIONS_URL` — the compute service base URL from §2.

With `VITE_FUNCTIONS_URL` set, auth + REST go to Supabase and functions go to the
service. Unset, the app falls back to same-origin (the dev emulator) — so never
leave it unset in a production build.

---

## 4. Real auth + invites (Phase 2)

- The app already uses real `supabase.auth`; pointing `VITE_SUPABASE_URL` at the
  project makes login real. There is no dev password in the frontend.
- Configure Supabase Auth email (built-in SMTP for low volume, or Postmark/Resend).
- Replace `server/invite.ts`'s direct `auth.users` insert with Supabase Auth
  `inviteUserByEmail` (a service-role admin call) so owners get a real email. This
  is the one code change Phase 2 still needs; it belongs in the compute service.

---

## 5. Minimum ops (Phase 4)

- Turn on Supabase automatic backups / PITR for your plan tier.
- Add error monitoring (Sentry) to the frontend and the compute service.
- Custom domain + SSL on both surfaces.
- Add a deploy stage to CI (today it stops after build).

---

## Smoke test after deploy

1. `GET <service>/health` → `{ ok: true }`.
2. Sign in as a real advisor; the portfolio loads (proves auth + REST + a
   `deal-calibration` function call end-to-end).
3. Open an engagement; the valuation renders (proves `compute-valuation`).
4. Generate a report and download the PDF (proves the in-process PDF path).
5. Invite an owner; confirm a real email arrives and they can sign in and see
   only their own company (proves auth + RLS on the live project).
