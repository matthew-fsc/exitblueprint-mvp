# Connecting the repo → Supabase → Render → Vercel (going live)

How to take this repo from the local dev emulator to a real, public website.
This is the concrete, click-by-click companion to `docs/archive/11-deploy-runbook.md`
(which explains the runtime choices) and `docs/archive/10-production-readiness.md`
(which explains why the architecture is shaped this way). Read those for the
"why"; this doc is the "how", for the specific case of **Vercel + Supabase +
GitHub**.

## The app is three pieces, not two

A common misconception is that "Vercel + Supabase" is the whole story. It
isn't — this app has a **third runtime piece**, a compute service:

```
                          ┌──────────────────────────┐
   Browser  ── auth+REST ─┤  Supabase                │
      │                   │  Postgres · Auth · RLS    │
      │                   └──────────────────────────┘
      │                                 ▲ service-role Postgres
      │  /functions/v1/*                │
      └──────────────────►  ┌───────────┴──────────────┐
   (VITE_FUNCTIONS_URL)     │  Compute service          │
                            │  server/http.ts (Docker)  │
   Static frontend          │  valuation · reports ·    │
   (Vite build on Vercel)   │  PDF (Chromium) · invites │
                            └───────────────────────────┘

   Frontend   → Vercel        (static build of the Vite app)
   Data/Auth  → Supabase      (Postgres + Auth + RLS)
   Compute    → Render        (Docker service, server/http.ts)
```

**Why the compute service can't just live on Vercel:** it serves every
`/functions/v1/*` call, and the report path renders PDFs with a real Chromium
shipped in `server/Dockerfile` (Playwright base image). That is a long-lived
container workload, not a serverless function — so it goes on a container host
(Render / Railway / Fly.io). This guide uses **Render**; Railway and Fly are
interchangeable (all three build the same `server/Dockerfile`).

Deploy order matters because of the URLs each piece needs from the others:
**Supabase → Render → Vercel**, then one CORS/redeploy pass to connect them.

---

## Step 1 — Supabase (data + auth)

1. Create a project at [supabase.com](https://supabase.com). Pick a region
   near your users; note the project **ref** (the `<ref>` in
   `<ref>.supabase.co`).
2. **Get the two frontend keys** — Dashboard → Project Settings → API:
   - Project URL → `VITE_SUPABASE_URL` (e.g. `https://<ref>.supabase.co`)
   - The **publishable / anon** key → `VITE_SUPABASE_ANON_KEY`
     (browser-safe; supabase-js uses it as the anon key for auth + REST).
3. **Check your JWT mode** — Dashboard → Project Settings → **JWT Keys**. This
   determines what the compute service needs in Step 2:
   - **Legacy JWT secret** (HS256, shared secret): the compute service works
     as-is. Copy the *JWT Secret* → you'll set it as `FUNCTIONS_JWT_SECRET`.
   - **Asymmetric signing keys** (ES256/RS256, the default on newer projects):
     set `SUPABASE_URL` on the compute service (Step 2.4) and it verifies tokens
     against the project JWKS — no shared secret needed. Nothing to copy here.
4. **Apply the schema + seed** from your machine (one command, idempotent):
   ```sh
   DATABASE_URL="postgresql://postgres:[PW]@db.<ref>.supabase.co:5432/postgres" \
     npm run db:setup
   ```
   Use the **direct** connection string for migrations. If your machine/CI is
   IPv4-only and it won't connect, use the **session pooler** string
   (`aws-0-<region>.pooler.supabase.com:5432`). Never use the transaction
   pooler (`:6543`) for migrations. Details + the full connection-string table
   are in `docs/archive/11-deploy-runbook.md` §1.

---

## Step 2 — Compute service on Render (functions + PDF)

**Fastest path — the Blueprint:** the repo ships `render.yaml`. In the
[Render dashboard](https://render.com) → **New → Blueprint** → pick
`matthew-fsc/exitblueprint-mvp`. Render reads `render.yaml`, builds
`server/Dockerfile`, wires the health check, and prompts for the secret env
values below — skip to step 4. Or do it by hand:

1. **New → Web Service** → connect your GitHub and pick
   `matthew-fsc/exitblueprint-mvp`.
2. **Runtime: Docker.** Set **Dockerfile Path** to `server/Dockerfile` and
   **Docker Build Context Directory** to the repo root (`.`) — the image copies
   `server/`, `shared/`, and the lockfile from root.
3. **Health check path:** `/health` (the service returns `{ "ok": true }`).
   This is a **liveness** probe — it confirms the process is up and has **no
   database dependency**, so a slow/unreachable DB can never hang the request and
   time the deploy out. For a **readiness** signal (DB reachable) use `/ready`,
   which returns `{ "ok": true, "db": true }` (200) or `{ "ok": false, "db":
   false }` (503) and is bounded so it always responds quickly. Point Render's
   deploy health check at `/health`, not `/ready`.
   The service listens on `PORT` (default `8787`); Render injects `PORT`
   automatically, and the service already reads it.
4. **Environment variables:**

   | Var | Value | Required |
   |---|---|---|
   | `DATABASE_URL` | Service-role Postgres string — the **session pooler** (`aws-0-<region>.pooler.supabase.com:5432`) is the right choice for a long-lived service | ✅ |
   | `FUNCTIONS_JWT_SECRET` | The Supabase JWT secret from Step 1.3 — **only if your project uses the legacy secret** | one of these two |
   | `SUPABASE_URL` | `https://<ref>.supabase.co` — **if your project uses asymmetric signing keys** (Step 1.3). Tokens then verify against the project JWKS automatically | one of these two |
   | `FUNCTIONS_ALLOWED_ORIGIN` | Your Vercel URL — set it **after** Step 3 (start with a placeholder, then update) | ✅ |
   | `ANTHROPIC_API_KEY` | Enables real Claude narrative in reports; omit to ship without AI prose | optional |

   > **Which token var?** The service (`server/auth-jwt.ts`) verifies both HS256
   > and asymmetric tokens, routing per token by its `alg` header — set the one
   > that matches Step 1.3 (or both, if mid-rotation). It refuses to start if
   > neither is set.

5. Deploy. When it's live, copy the service URL
   (e.g. `https://exitblueprint-functions.onrender.com`) — that's
   `VITE_FUNCTIONS_URL` for Step 3. Verify: `GET <service-url>/health` →
   `{ "ok": true }`.

> Note on Render free tier: services **spin down when idle** and cold-start on
> the next request (a few seconds), and PDF rendering wants memory — use a paid
> instance for a real customer. Railway/Fly.io are fine substitutes; they build
> the same Dockerfile.

---

## Step 3 — Frontend on Vercel

1. In [Vercel](https://vercel.com) → **Add New → Project** → import
   `matthew-fsc/exitblueprint-mvp`. Vercel auto-detects Vite; `vercel.json` in
   the repo root already pins the build command (`npm run build`), output
   (`dist`), and the SPA rewrite (so deep links like `/health` and `/portal`
   don't 404 on refresh — every path falls through to `index.html` for the
   client router).
2. **Environment variables** (Project → Settings → Environment Variables), for
   the Production (and Preview) environments:

   | Var | Value |
   |---|---|
   | `VITE_SUPABASE_URL` | The Supabase project URL from Step 1.2 |
   | `VITE_SUPABASE_ANON_KEY` | The publishable / anon key from Step 1.2 |
   | `VITE_FUNCTIONS_URL` | The Render service URL from Step 2.5 |

   These are baked in at **build time** (Vite inlines `import.meta.env.*`), so a
   change to any of them requires a **redeploy**, not just a restart. With
   `VITE_FUNCTIONS_URL` set, auth + REST go to Supabase and `/functions/v1/*`
   go to Render. **Never leave `VITE_FUNCTIONS_URL` unset in a production
   build** — unset means "same-origin dev emulator", which doesn't exist in
   production.

   > **Using the Vercel↔Supabase integration?** It injects credentials under
   > Next.js/generic names (`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_URL`,
   > `SUPABASE_ANON_KEY`, …), but Vite only exposes `VITE_`-prefixed vars to the
   > browser. `vite.config.ts` **bridges** the two *public* values into the
   > `VITE_` names at build time, so with the integration connected you do **not**
   > need to add `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` by hand — only
   > `VITE_FUNCTIONS_URL` (the Render URL), which no integration can know. The
   > service-role key and JWT secret are never bridged to the client.
3. Deploy. Note the assigned URL (e.g.
   `https://exitblueprint-mvp.vercel.app`).

---

## Step 4 — Connect them (CORS + redeploy)

The frontend and compute service now know about each other, but the compute
service still has to *allow* the browser origin:

1. Back in **Render** → the service → set `FUNCTIONS_ALLOWED_ORIGIN` to the
   exact Vercel URL from Step 3.3 (e.g. `https://exitblueprint-mvp.vercel.app`,
   no trailing slash). Save — Render redeploys.
2. In **Supabase** → Authentication → URL Configuration → set the **Site URL**
   (and any additional redirect URLs) to your Vercel URL, so magic-link / auth
   redirects land back on the live site.
3. If you added or changed any `VITE_*` value after the first Vercel build,
   trigger a **redeploy** on Vercel so the new values are inlined.

### Custom domain (optional)
Add it in Vercel (Project → Domains); Vercel provisions SSL. Then update
`FUNCTIONS_ALLOWED_ORIGIN` (Render) and the Supabase Site URL to the custom
domain and redeploy the frontend.

---

## Environment variable reference (who reads what)

| Variable | Set on | Read by | Purpose |
|---|---|---|---|
| `VITE_SUPABASE_URL` | Vercel | frontend (`src/lib/supabase.ts`) | Supabase project for auth + REST |
| `VITE_SUPABASE_ANON_KEY` | Vercel | frontend | Browser anon/publishable key |
| `VITE_FUNCTIONS_URL` | Vercel | frontend | Base URL of the Render compute service |
| `DATABASE_URL` | Render | `server/http.ts` | Service-role Postgres (bypasses RLS) |
| `FUNCTIONS_JWT_SECRET` | Render | `server/auth-jwt.ts` | Verifies HS256 tokens (legacy secret) — set this **or** `SUPABASE_URL` |
| `SUPABASE_URL` | Render | `server/auth-jwt.ts` | Verifies asymmetric tokens via project JWKS — set this **or** `FUNCTIONS_JWT_SECRET` |
| `FUNCTIONS_ALLOWED_ORIGIN` | Render | `server/http.ts` | CORS allow-list = the Vercel origin |
| `ANTHROPIC_API_KEY` | Render | `server/http.ts` | Optional: real Claude narrative |

Secrets live only in the host dashboards (Vercel/Render) and your shell — never
in the repo. Local dev keeps them in `.env.local`, which `.gitignore` excludes.

---

## Smoke test after deploy

Run the full sequence in `docs/archive/11-deploy-runbook.md` (§ *Smoke test after
deploy*). The short version:

1. `GET <render-url>/health` → `{ "ok": true }`.
2. Sign in as an advisor on the Vercel URL → portfolio loads (auth + REST +
   a `deal-calibration` function call, end to end).
3. Open an engagement → the valuation renders (proves `compute-valuation`).
4. Generate a report and download the PDF (proves the Chromium PDF path on
   Render).
5. Invite an owner → they sign in and see only their own company (proves auth +
   RLS on the live project).

If steps 1–2 pass but 3–5 fail, the frontend reached Supabase but not the
compute service — recheck `VITE_FUNCTIONS_URL` (Vercel), `FUNCTIONS_ALLOWED_ORIGIN`
(Render), and that you redeployed the frontend after setting them.

## Known follow-ups before a real customer

- **Owner invite email** (`docs/archive/11-deploy-runbook.md` §4): swap
  `server/invite.ts`'s direct insert for Supabase `inviteUserByEmail`, and
  configure Supabase Auth email (SMTP or Postmark/Resend).
- **Ops** (`docs/archive/11-deploy-runbook.md` §5): Supabase backups/PITR, error
  monitoring (Sentry) on both surfaces, and a deploy stage in CI.
