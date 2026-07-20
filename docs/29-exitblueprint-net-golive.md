# Go-live on exitblueprint.net — the exact runbook

The concrete, ordered checklist to host this app on **exitblueprint.net**, with
the domain split so the existing marketing site keeps the root. (The general/why
predecessors — `docs/archive/12` and `docs/archive/11` — are archived; this is the
live runbook.) Every account/dashboard step is yours to run — nothing here can be
provisioned from the repo.

> **Auth note (2026-07).** Identity is **Clerk**, not Supabase Auth. Wherever a
> step below sets up a Supabase JWT secret, Supabase auth redirects, or
> service-role owner-invite emails, follow **`docs/30-clerk-cutover-runbook.md`**
> instead — set `CLERK_JWKS_URL` / `CLERK_SECRET_KEY` / `CLERK_WEBHOOK_SIGNING_SECRET`
> on the compute service and `VITE_CLERK_PUBLISHABLE_KEY` on the frontend
> (see `docs/14` and `.env.example`). The Supabase-auth steps here are retained
> only for the legacy path.

Keep every secret in the host dashboards (Vercel/Render/Supabase) and your
shell. Never commit one.

---

## Domain topology (the decision)

```
   exitblueprint.net          → marketing site        (UNCHANGED — leave its DNS alone)
   app.exitblueprint.net      → Vercel   (static Vite frontend: auth + REST + UI)
   api.exitblueprint.net      → Render   (compute service: valuation · reports · PDF · invites)
   <ref>.supabase.co          → Supabase (Postgres + Auth + RLS)
```

The app is **three runtimes**, not two — the compute service (`server/http.ts`)
renders PDFs with a real Chromium and cannot live on Vercel's serverless
runtime. See the diagram in `docs/archive/12` for the request flow.

Deploy order is forced by the URLs each piece needs from the others:
**Supabase → Render → Vercel → DNS → connect**.

---

## Step 0 — Prereqs

- Access to the DNS zone for `exitblueprint.net` (your registrar or DNS host).
- A machine that can reach the Supabase database to run migrations. The
  **direct** connection is IPv6-only; if you're IPv4-only, use the **session
  pooler** string (see `docs/archive/11` §1). Running `npm run db:setup` from this
  repo checkout is the tested path.

---

## Step 1 — Supabase (data + auth)

1. Create a project at [supabase.com](https://supabase.com); pick a region near
   your users. Note the project **ref** (`<ref>` in `<ref>.supabase.co`).
2. **Grab the frontend keys** — Project Settings → API:
   - Project URL → `VITE_SUPABASE_URL` = `https://<ref>.supabase.co`
   - publishable / **anon** key → `VITE_SUPABASE_ANON_KEY`
3. **Grab the service-role key** — Project Settings → API → `service_role`
   (secret). This is `SUPABASE_SERVICE_ROLE_KEY` for the compute service
   (owner-invite emails). Never expose it to the browser.
4. **Check your JWT mode** — Project Settings → **JWT Keys**:
   - **Legacy secret** (HS256): copy the *JWT Secret* → `FUNCTIONS_JWT_SECRET`.
   - **Asymmetric keys** (ES256/RS256, default on new projects): nothing to
     copy — setting `SUPABASE_URL` on the compute service is enough.
5. **Apply schema + seed** (idempotent, one command):
   ```sh
   DATABASE_URL="postgresql://postgres:[PW]@db.<ref>.supabase.co:5432/postgres" \
     npm run db:setup
   ```
   Use the **direct** string (or the **session pooler** if IPv4-only). Never the
   transaction pooler (`:6543`) for migrations.
6. **Prove isolation** on the real project:
   ```sh
   DATABASE_URL="…same string…" npm run test:rls
   ```
7. Turn on **PITR / automatic backups** for your plan tier.

---

## Step 2 — Compute service on Render → api.exitblueprint.net

Fastest path is the committed **Blueprint** (`render.yaml`):

1. Render dashboard → **New → Blueprint** → pick
   `matthew-fsc/exitblueprint-mvp`. Render builds `server/Dockerfile`, wires the
   `/health` check, and pre-fills `FUNCTIONS_ALLOWED_ORIGIN` to
   `https://app.exitblueprint.net`. It prompts for the `sync:false` secrets:

   | Var | Value | Notes |
   |---|---|---|
   | `DATABASE_URL` | Session pooler string (`aws-0-<region>.pooler.supabase.com:5432`) | Long-lived service → pooler, not the direct string |
   | `SUPABASE_URL` | `https://<ref>.supabase.co` | Set for asymmetric JWT projects; also used by invite email |
   | `FUNCTIONS_JWT_SECRET` | Legacy JWT secret | Only if your project is on the legacy secret (Step 1.4). Set one of these two |
   | `EB_DOCUMENT_KEY` | 32-byte hex | **Required.** `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
   | `SUPABASE_SERVICE_ROLE_KEY` | service_role key (Step 1.3) | Enables real owner-invite emails; omit to skip email sends |
   | `ANTHROPIC_API_KEY` | Anthropic key | Optional — real Claude narrative |

   `FUNCTIONS_ALLOWED_ORIGIN` is already set to the app origin in `render.yaml`;
   no need to enter it.
2. Deploy. Verify the default URL: `GET https://<svc>.onrender.com/health` →
   `{ "ok": true }`.
3. **Custom domain** — Render → the service → **Settings → Custom Domains** →
   add `api.exitblueprint.net`. Render shows a CNAME target
   (`<svc>.onrender.com`). Add it in DNS (Step 4). Render provisions SSL once
   DNS resolves.

> Use a paid instance (the blueprint pins `standard`, ~2 GB) — the free tier
> spins down when idle and PDF rendering wants memory.

---

## Step 3 — Frontend on Vercel → app.exitblueprint.net

1. Vercel → **Add New → Project** → import `matthew-fsc/exitblueprint-mvp`.
   `vercel.json` already pins the build (`npm run build`), output (`dist`), and
   the SPA rewrite.
2. **Environment variables** (Production + Preview):

   | Var | Value |
   |---|---|
   | `VITE_SUPABASE_URL` | `https://<ref>.supabase.co` (Step 1.2) |
   | `VITE_SUPABASE_ANON_KEY` | anon key (Step 1.2) |
   | `VITE_FUNCTIONS_URL` | `https://api.exitblueprint.net` |

   These are inlined at **build time** — any change needs a **redeploy**, not a
   restart. **Never leave `VITE_FUNCTIONS_URL` unset in production.**
3. Deploy (this first build works off the `*.vercel.app` URL).
4. **Custom domain** — Vercel → Project → **Settings → Domains** → add
   `app.exitblueprint.net`. Vercel shows a CNAME target
   (`cname.vercel-dns.com`). Add it in DNS (Step 4); Vercel provisions SSL.

---

## Step 4 — DNS on exitblueprint.net

In the `exitblueprint.net` DNS zone, add **two subdomain records** and leave the
root (marketing) untouched:

| Host | Type | Value | For |
|---|---|---|---|
| `app` | CNAME | `cname.vercel-dns.com` (use the exact target Vercel shows) | Frontend |
| `api` | CNAME | `<svc>.onrender.com` (use the exact target Render shows) | Compute service |

Do **not** touch the root `@` / `www` records — the marketing site owns those.
DNS may take minutes to an hour; SSL is issued automatically by each host once
the record resolves. Confirm:

```sh
dig +short app.exitblueprint.net
dig +short api.exitblueprint.net
```

---

## Step 5 — Connect them (CORS + auth redirects)

1. **CORS** — the compute service already allows `https://app.exitblueprint.net`
   (baked into `render.yaml`). If you changed it, update
   `FUNCTIONS_ALLOWED_ORIGIN` on Render and let it redeploy. *(Note: the service
   matches a single exact origin — Vercel `*.vercel.app` preview URLs won't be
   allowed against production. Point previews at a separate service, or test
   previews against the dev emulator.)*
2. **Supabase auth redirects** — Authentication → **URL Configuration**:
   - **Site URL**: `https://app.exitblueprint.net`
   - **Redirect URLs**: add `https://app.exitblueprint.net/**`
   This makes magic-link / set-password links land back on the app.
3. **Auth email** — Authentication → Emails/SMTP: built-in SMTP is fine for low
   volume; wire Postmark/Resend for real send volume. The owner-invite email
   (Step 6) rides on this.
4. If you edited any `VITE_*` value after the first Vercel build, **redeploy** on
   Vercel so the new value is inlined.

---

## Step 6 — Owner-invite email (now wired)

`server/invite.ts` sends a real Supabase set-password invite when
`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are set (Step 2). The link
redirects to `FUNCTIONS_ALLOWED_ORIGIN` (`https://app.exitblueprint.net`) —
override with `OWNER_INVITE_REDIRECT_URL` if needed. With those unset it falls
back to the dev direct-insert path (no email). No code change required — just
provisioning.

---

## Step 7 — Smoke test (against the live domain)

1. `GET https://api.exitblueprint.net/health` → `{ "ok": true }`.
2. Sign in as an advisor at `https://app.exitblueprint.net` → portfolio loads
   (auth + REST + a `deal-calibration` call, end to end).
3. Open an engagement → valuation renders (`compute-valuation`).
4. Generate a report → download the PDF (Chromium path on Render).
5. Invite an owner → a real set-password email arrives; they sign in and see
   only their own company (auth + RLS on the live project).

If 1–2 pass but 3–5 fail, the frontend reached Supabase but not the compute
service — recheck `VITE_FUNCTIONS_URL` (Vercel), `FUNCTIONS_ALLOWED_ORIGIN`
(Render), and that you redeployed Vercel after setting env.

---

## Env var reference (who sets what)

| Variable | Set on | Value for this domain |
|---|---|---|
| `VITE_SUPABASE_URL` | Vercel | `https://<ref>.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | Vercel | anon key |
| `VITE_FUNCTIONS_URL` | Vercel | `https://api.exitblueprint.net` |
| `DATABASE_URL` | Render | service-role session-pooler string |
| `SUPABASE_URL` | Render | `https://<ref>.supabase.co` |
| `FUNCTIONS_JWT_SECRET` | Render | legacy JWT secret (or rely on `SUPABASE_URL`) |
| `FUNCTIONS_ALLOWED_ORIGIN` | Render (in `render.yaml`) | `https://app.exitblueprint.net` |
| `EB_DOCUMENT_KEY` | Render | 32-byte hex (required) |
| `SUPABASE_SERVICE_ROLE_KEY` | Render | service_role key (invite email) |
| `ANTHROPIC_API_KEY` | Render | optional |

---

## Remaining ops (post go-live)

- Error monitoring (Sentry) on frontend + compute service.
- ToS + Privacy Policy linked (real financial data).
- Comp the beta firms (`docs/archive/25` step 6) so billing never blocks testers.
- Add a deploy stage to CI (today it stops after build).
